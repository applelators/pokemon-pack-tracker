// ---- tiny helpers --------------------------------------------------------
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const money = (n) => "$" + (Number(n) || 0).toFixed(2);

// Official-style rarity symbols (S&V era): circle/diamond/stars + colour.
const RARITY_SYMBOL = {
  "Common": { glyph: "●", count: 1, cls: "r-black" },            // ●
  "Uncommon": { glyph: "◆", count: 1, cls: "r-black" },          // ◆
  "Rare": { glyph: "★", count: 1, cls: "r-black" },              // ★
  "Double Rare": { glyph: "★", count: 2, cls: "r-black" },       // ★★
  "Ultra Rare": { glyph: "★", count: 2, cls: "r-silver" },      // ★★ foil
  "Illustration Rare": { glyph: "★", count: 1, cls: "r-gold" },  // ★ gold
  "Special Illustration Rare": { glyph: "★", count: 2, cls: "r-gold" }, // ★★ gold
  "Hyper Rare": { glyph: "★", count: 3, cls: "r-gold" },         // ★★★ gold
  "Mega Hyper Rare": { glyph: "★", count: 3, cls: "r-mhr" },     // ★★★ etched gold
  "ACE SPEC Rare": { glyph: "★", count: 1, cls: "r-ace" },       // red
};

function raritySymbol(rarity) {
  const r = RARITY_SYMBOL[rarity] || { glyph: "●", count: 1, cls: "r-muted" };
  return `<span class="rsym ${r.cls}" title="${rarity}">${r.glyph.repeat(r.count)}</span>`;
}

// Small inline product glyphs (stroke = currentColor) for the breakdown table.
const SVG = (inner) => `<span class="prod-icon"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round">${inner}</svg></span>`;
const PRODUCT_ICON = {
  "Booster Pack": SVG('<rect x="4.5" y="2.5" width="7" height="11" rx="1.2"/><path d="M4.5 5.2h7"/>'),
  "Booster Bundle": SVG('<rect x="2.5" y="4.5" width="6.5" height="9" rx="1"/><rect x="7" y="2.5" width="6.5" height="9" rx="1"/>'),
  "Elite Trainer Box": SVG('<rect x="2.5" y="5" width="11" height="8.5" rx="1"/><path d="M2.5 7.4h11"/><rect x="6.3" y="3" width="3.4" height="2.2" rx="0.6"/>'),
  "Mini Tin": SVG('<rect x="5" y="4" width="6" height="9.5" rx="3"/>'),
  "Regular Tin": SVG('<rect x="3.5" y="3" width="9" height="10.5" rx="3.6"/><path d="M3.5 6h9"/>'),
  _default: SVG('<rect x="3" y="3.5" width="10" height="9" rx="1.2"/>'),
};
function productIcon(name) {
  return PRODUCT_ICON[name] || PRODUCT_ICON._default;
}

// Short tags for the inline secret-card steppers on order cards.
const RARITY_ABBR = {
  "Illustration Rare": "IR", "Special Illustration Rare": "SIR", "Ultra Rare": "UR",
  "Double Rare": "RR", "Hyper Rare": "HR", "Mega Hyper Rare": "MHR",
  "ACE SPEC Rare": "ACE", "Shiny Rare": "SR", "Shiny Ultra Rare": "SUR",
};
const secretAbbr = (r) => RARITY_ABBR[r] || r;

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 3200);
}

// ---- app state -----------------------------------------------------------
const state = {
  settings: null,
  trackedSets: [],
  currentSetId: localStorage.getItem("currentSetId") || "",
  currentCollection: localStorage.getItem("currentCollection") || "mine",
  editingOrderId: null,
  summary: null,
  orders: [],
  formPulls: [],     // cards tagged as pulled in the order form
  cardsCache: {},    // setId -> card list (for the picker)
};

// ---- collection (binder) toggles -----------------------------------------
function setToggle(el, c) {
  if (!el) return;
  el.querySelectorAll(".ct-btn").forEach((b) => b.classList.toggle("active", b.dataset.collection === c));
}
function getToggle(el) {
  const b = el && el.querySelector(".ct-btn.active");
  return b && b.dataset.collection === "shared" ? "shared" : "mine";
}
function collectionLabel(c) {
  return c === "shared" ? "Shared" : "Mine";
}

function setupCollectionToggle() {
  setToggle($("#collectionToggle"), state.currentCollection);
  $("#collectionToggle").addEventListener("click", (e) => {
    const b = e.target.closest(".ct-btn");
    if (b) selectCollection(b.dataset.collection);
  });
  // Order-form toggle: local selection only (which binder this order goes to).
  $("#orderCollection").addEventListener("click", (e) => {
    const b = e.target.closest(".ct-btn");
    if (b) setToggle($("#orderCollection"), b.dataset.collection);
  });
}

function selectCollection(c) {
  if (c !== "mine" && c !== "shared") return;
  state.currentCollection = c;
  localStorage.setItem("currentCollection", c);
  setToggle($("#collectionToggle"), c);
  refreshActiveSet();
}

// ---- init ----------------------------------------------------------------
async function init() {
  setupTabs();
  setupModal();
  setupSetSwitcher();
  setupCollectionToggle();
  setupProgressInputs();
  setupDealCard();
  setupBrowse();
  setupOrderForm();
  setupSettingsForm();
  await loadSettings();
  await loadTrackedSets();
  refreshActiveSet();
}

function setupTabs() {
  $$("nav#tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$("nav#tabs button").forEach((b) => b.classList.remove("active"));
      $$(".tab").forEach((t) => t.classList.remove("active"));
      btn.classList.add("active");
      $("#" + btn.dataset.tab).classList.add("active");
      if (btn.dataset.tab === "browse") loadBrowse();
    });
  });
}

// ---- sets ----------------------------------------------------------------
async function loadTrackedSets() {
  state.trackedSets = await api("/sets");
  renderSetMenu();
  updateSetTrigger();
}

// Build the dropdown list of tracked sets (each with mini set symbol + counts).
function renderSetMenu() {
  const list = $("#setMenuList");
  if (!state.trackedSets.length) {
    list.innerHTML = '<div class="set-menu-empty muted">No sets tracked yet.</div>';
    return;
  }
  list.innerHTML = state.trackedSets.map((s) => {
    const active = s.id === state.currentSetId;
    const sym = s.symbol_url
      ? `<img class="sm-sym" src="${s.symbol_url}" alt="" />`
      : `<span class="sm-sym sm-ph">${(s.name || "?").slice(0, 1)}</span>`;
    return `<button type="button" class="set-menu-item${active ? " active" : ""}" role="menuitemradio" aria-checked="${active}" data-set="${s.id}">
        ${sym}
        <span class="sm-text">
          <span class="sm-name">${s.name}</span>
          <span class="sm-meta">${s.series ? s.series + " \u00b7 " : ""}${s.printed_total} cards</span>
        </span>
        <span class="sm-check" aria-hidden="true">${active ? "\u2713" : ""}</span>
      </button>`;
  }).join("");
}

// Update the header trigger chip to reflect the current set.
function updateSetTrigger() {
  const set = state.trackedSets.find((s) => s.id === state.currentSetId);
  const symEl = $("#stSym");
  const nameEl = $("#stName");
  if (set) {
    nameEl.textContent = set.name;
    symEl.classList.remove("hidden", "ph");
    if (set.symbol_url) { symEl.innerHTML = `<img src="${set.symbol_url}" alt="" />`; }
    else { symEl.textContent = (set.name || "?").slice(0, 1); symEl.classList.add("ph"); }
  } else {
    nameEl.textContent = "Select a set";
    symEl.innerHTML = "";
    symEl.classList.add("hidden");
  }
}

function openSetMenu(open) {
  const menu = $("#setMenu");
  const show = (open === undefined) ? menu.classList.contains("hidden") : open;
  menu.classList.toggle("hidden", !show);
  $("#setTrigger").setAttribute("aria-expanded", show ? "true" : "false");
}

function setupSetSwitcher() {
  $("#setTrigger").addEventListener("click", (e) => { e.stopPropagation(); openSetMenu(); });
  $("#setMenuList").addEventListener("click", (e) => {
    const item = e.target.closest(".set-menu-item");
    if (!item) return;
    openSetMenu(false);
    if (item.dataset.set !== state.currentSetId) selectSet(item.dataset.set);
  });
  $("#setMenuAdd").addEventListener("click", () => { openSetMenu(false); $("#setModal").classList.remove("hidden"); runSetSearch(); });
  document.addEventListener("click", (e) => { if (!e.target.closest("#setSwitcher")) openSetMenu(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") openSetMenu(false); });
}

function selectSet(id) {
  state.currentSetId = id;
  localStorage.setItem("currentSetId", id);
  renderSetMenu();
  updateSetTrigger();
  refreshActiveSet();
}

async function refreshActiveSet() {
  const has = !!state.currentSetId;
  $("#dashEmpty").classList.toggle("hidden", has);
  $("#dashContent").classList.toggle("hidden", !has);
  $("#ordersEmpty").classList.toggle("hidden", has);
  $("#ordersContent").classList.toggle("hidden", !has);
  if (has) {
    await loadDashboard();   // sets state.summary
    await loadOrders();      // sets state.orders
    resetOrderForm();        // rebuilds form incl. secret-card inputs + prediction
  }
}

// ---- import set modal ----------------------------------------------------
function setupModal() {
  $("#closeModal").addEventListener("click", () => $("#setModal").classList.add("hidden"));
  $("#setSearchBtn").addEventListener("click", runSetSearch);
  $("#setSearch").addEventListener("keydown", (e) => { if (e.key === "Enter") runSetSearch(); });
  $("#setResults").addEventListener("click", onSetTableClick);
}

// Shared rich expansion table (symbol · logo · name · cards · release · abbr),
// grouped by series. Used in both the Add-a-set modal and the Browse tab.
function renderSetTable(sets) {
  if (!sets.length) return '<div class="muted">No sets found.</div>';
  const groups = [];
  const idx = {};
  for (const s of sets) {
    const g = s.series || "Other";
    if (!(g in idx)) { idx[g] = groups.length; groups.push([g, []]); }
    groups[idx[g]][1].push(s);
  }
  const row = (s) => {
    const tracked = state.trackedSets.some((t) => t.id === s.id);
    const cards = `${s.printedTotal}${s.secret > 0 ? ` <span class="muted">+${s.secret}</span>` : ""}`;
    return `<tr class="set-row" data-id="${s.id}" title="${tracked ? "Open" : "Import"} ${s.name}">
      <td class="sr-sym">${s.symbol ? `<img src="${s.symbol}" loading="lazy" alt="" />` : ""}</td>
      <td class="sr-logo">${s.logo ? `<img src="${s.logo}" loading="lazy" alt="${s.name}" />` : ""}</td>
      <td class="sr-name">${s.name}${tracked ? ' <span class="coll-badge mine">tracked</span>' : ""}</td>
      <td>${cards}</td>
      <td>${s.releaseDate || "—"}</td>
      <td>${s.abbr || "—"}</td>
    </tr>`;
  };
  return groups.map(([series, list]) => `
    <div class="set-group">
      <h4 class="set-series">${series}</h4>
      <table class="set-table">
        <thead><tr><th>Sym</th><th>Logo</th><th>Name</th><th>Cards</th><th>Released</th><th>Abbr</th></tr></thead>
        <tbody>${list.map(row).join("")}</tbody>
      </table>
    </div>`).join("");
}

async function onSetTableClick(e) {
  const row = e.target.closest(".set-row");
  if (!row) return;
  const id = row.dataset.id;
  row.style.opacity = "0.5";
  if (state.trackedSets.some((t) => t.id === id)) {
    selectSet(id);
    $("#setModal").classList.add("hidden");
    document.querySelector('nav#tabs button[data-tab="dashboard"]').click();
  } else {
    await importSet(id);
  }
  row.style.opacity = "";
}

async function runSetSearch() {
  const q = $("#setSearch").value.trim();
  const box = $("#setResults");
  box.innerHTML = '<div class="muted">Searching…</div>';
  try {
    box.innerHTML = renderSetTable(await api("/sets/search?q=" + encodeURIComponent(q)));
  } catch (err) {
    box.innerHTML = `<div class="muted">Error: ${err.message}</div>`;
  }
}

async function importSet(id) {
  toast("Importing…");
  try {
    const set = await api(`/sets/${id}/import`, { method: "POST" });
    toast(`Imported ${set.name}`);
    await loadTrackedSets();
    if (state.browseSets) renderBrowse();   // refresh "tracked" badges
    selectSet(id);
    $("#setModal").classList.add("hidden");
    document.querySelector('nav#tabs button[data-tab="dashboard"]').click();
  } catch (err) {
    toast(err.message, true);
  }
}

// ---- Browse tab ----------------------------------------------------------
async function loadBrowse() {
  if (state.browseSets) return;            // load once
  const box = $("#browseResults");
  try {
    state.browseSets = await api("/sets/search?all=1");
    renderBrowse();
  } catch (err) {
    box.innerHTML = `<div class="muted">Couldn't load expansions: ${err.message}</div>`;
  }
}

function renderBrowse() {
  const q = $("#browseSearch").value.trim().toLowerCase();
  let sets = state.browseSets || [];
  if (q) sets = sets.filter((s) =>
    (s.name || "").toLowerCase().includes(q) ||
    (s.series || "").toLowerCase().includes(q) ||
    (s.abbr || "").toLowerCase().includes(q));
  $("#browseResults").innerHTML = renderSetTable(sets);
}

function setupBrowse() {
  $("#browseResults").addEventListener("click", onSetTableClick);
  $("#browseSearch").addEventListener("input", renderBrowse);
}

// ---- dashboard -----------------------------------------------------------
// Set-banner: live logo + faint symbol watermark from pokemontcg.io.
function populateBanner(set) {
  $("#sbName").textContent = set.name || "—";
  $("#sbSeries").textContent = set.series || "";
  $("#sbSub").textContent = `${set.printed_total}-card base set`
    + (set.release_date ? ` · released ${set.release_date}` : "");
  const logo = $("#sbLogo");
  if (set.logo_url) { logo.src = set.logo_url; logo.classList.remove("hidden"); }
  else { logo.removeAttribute("src"); logo.classList.add("hidden"); }
  const art = $("#sbArt");
  art.style.backgroundImage = set.symbol_url ? `url("${set.symbol_url}")` : "";
  art.classList.toggle("has-symbol", !!set.symbol_url);
  // Theme the browser tab icon with the active set's symbol.
  const fav = $("#favicon");
  if (fav && set.symbol_url) fav.href = set.symbol_url;
}

// ---- Loose-pack deal check -----------------------------------------------
// Reference price lines for a set: good-deal ceiling, typical market, bad-deal line.
function dealRefs(s) {
  const set = s.set || {};
  const ev = s.packEv;
  const ceiling = set.pack_price_ceiling != null ? set.pack_price_ceiling : ev; // good-deal line
  const market = set.pack_market_price != null ? set.pack_market_price : ev;     // typical market
  const bad = market != null ? Math.round(market * 1.25 * 100) / 100 : null;     // ~25% over market = overpaying
  return { ceiling, market, bad, ev };
}

// Classify a per-pack price against the references.
function dealFlag(perPack, refs) {
  if (perPack == null || (refs.ceiling == null && refs.bad == null)) return { label: "—", cls: "" };
  if (refs.ceiling != null && perPack <= refs.ceiling) return { label: "Good deal", cls: "deal-good" };
  if (refs.bad != null && perPack >= refs.bad) return { label: "Overpaid", cls: "deal-bad" };
  return { label: "Fair", cls: "deal-fair" };
}

function renderDealCard(s) {
  const set = s.set;
  const ev = s.packEv;
  const c = set.pack_price_ceiling, m = set.pack_market_price, msrp = set.pack_msrp;
  const refs = dealRefs(s);
  const effCeiling = c != null ? c : ev;  // default the good-deal line to EV when no manual ceiling
  $("#dealCeiling").textContent = effCeiling != null ? money(effCeiling) : "—";
  $("#dealEv").textContent = ev != null ? money(ev) : "no price data yet";
  $("#dealMarket").textContent = m != null ? money(m) : "—";
  $("#dealBad").textContent = refs.bad != null ? money(refs.bad) : "—";
  $("#dealMsrp").textContent = msrp != null ? money(msrp) : "—";
  const note = $("#dealNote");
  if (set.pack_price_note || set.pack_price_updated) {
    const date = set.pack_price_updated ? set.pack_price_updated.slice(0, 10) : "";
    note.textContent = (set.pack_price_note || "") + (date ? ` · as of ${date}` : "");
  } else if (ev != null) {
    note.textContent = "Good-deal line = pack value (EV from current single-card prices). Set a market ceiling below to override.";
  } else {
    note.textContent = "No price data yet (pokemontcg.io hasn't priced this set) — set a market ceiling below, or ask Claude.";
  }
  if (document.activeElement !== $("#dealMarketInput")) $("#dealMarketInput").value = m != null ? m : "";
  if (document.activeElement !== $("#dealCeilingInput")) $("#dealCeilingInput").value = c != null ? c : "";
}

function setupDealCard() {
  $("#dealSave").addEventListener("click", async () => {
    const market = $("#dealMarketInput").value.trim();
    const ceiling = $("#dealCeilingInput").value.trim();
    try {
      await api(`/sets/${state.currentSetId}/pricing`, {
        method: "PUT",
        body: {
          market_price: market === "" ? null : Number(market),
          ceiling: ceiling === "" ? null : Number(ceiling),
          note: "Manually entered",
        },
      });
      toast("Pack price saved");
      loadDashboard();
    } catch (err) { toast(err.message, true); }
  });
  $("#dealRefresh").addEventListener("click", async (e) => {
    const btn = e.target;
    btn.disabled = true; btn.textContent = "↻ Refreshing…";
    try {
      const r = await api(`/sets/${state.currentSetId}/pricing/refresh`, { method: "POST" });
      toast(`Market price: ${money(r.pack_market_price)} (${r.matched ? r.matched.productName : "PriceCharting"})`);
      loadDashboard();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false; btn.textContent = "↻ Refresh from PriceCharting";
    }
  });
}

// ---- "Your collection" actuals (feed the model) --------------------------
function renderProgressInputs(s) {
  const N = s.set.printed_total;
  const bought = s.packsBought != null ? s.packsBought : s.totalPacks;
  const cc = s.progress ? s.progress.cards_collected : null;
  const opened = s.packsOpened != null ? s.packsOpened : bought;
  const expected = s.completion ? s.completion.expectedCollectedAtOpened : 0;

  $("#cardsTotal").textContent = N;
  $("#packsBought").textContent = bought;
  // Don't clobber a value the user is mid-typing.
  if (document.activeElement !== $("#cardsCollected")) $("#cardsCollected").value = cc != null ? cc : "";
  $("#cardsCollected").placeholder = expected ? String(expected) : "0";
  $("#cardsCollected").max = N;
  if (document.activeElement !== $("#packsOpened")) $("#packsOpened").value = opened;
  $("#packsOpened").max = bought;

  const shown = cc != null ? cc : expected;
  $("#cardsFill").style.width = N ? Math.min(100, Math.round((shown / N) * 100)) + "%" : "0%";
  $("#cardsSub").textContent = cc != null
    ? `${cc} of ${N} (${Math.round((cc / N) * 100)}%) — drives the gauge + remaining estimate.`
    : `Blank = model estimate (~${expected}). Enter your real count to override.`;
  $("#openedFill").style.width = bought ? Math.min(100, Math.round((opened / bought) * 100)) + "%" : "0%";
  $("#openedSub").textContent = `${opened} of ${bought} bought packs opened — drives diminishing returns + odds.`;
}

const _progressTimer = { t: null };
function queueProgressSave() {
  clearTimeout(_progressTimer.t);
  _progressTimer.t = setTimeout(async () => {
    const ccRaw = $("#cardsCollected").value.trim();
    const payload = {
      cards_collected: ccRaw === "" ? null : Math.max(0, Math.round(Number(ccRaw))),
      packs_opened: Math.max(0, Math.round(Number($("#packsOpened").value) || 0)),
    };
    try {
      await api(`/sets/${state.currentSetId}/progress?collection=${state.currentCollection}`, { method: "PUT", body: payload });
      await loadDashboard(); // recompute estimate with the new actuals
    } catch (err) {
      toast(err.message, true);
    }
  }, 500);
}

function setupProgressInputs() {
  $("#cardsCollected").addEventListener("input", queueProgressSave);
  $("#packsOpened").addEventListener("input", queueProgressSave);
  $("#opMinus").addEventListener("click", () => { stepPacksOpened(-1); });
  $("#opPlus").addEventListener("click", () => { stepPacksOpened(1); });
}

function stepPacksOpened(delta) {
  const bought = state.summary ? (state.summary.packsBought ?? state.summary.totalPacks) : 0;
  const cur = Math.max(0, Math.round(Number($("#packsOpened").value) || 0));
  const next = Math.max(0, Math.min(bought, cur + delta));
  $("#packsOpened").value = next;
  $("#openedFill").style.width = bought ? Math.min(100, Math.round((next / bought) * 100)) + "%" : "0%";
  queueProgressSave();
}

// Completion gauge ring (r = 86 → circumference ≈ 540.35).
function setGauge(pct, collected, baseSize) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const C = 2 * Math.PI * 86;
  $("#gaugeArc").setAttribute("stroke-dasharray", `${(p / 100) * C} ${C}`);
  $("#estPctBig").textContent = Math.round(p) + "%";
  $("#estFrac").innerHTML = (collected != null && baseSize) ? `<b>${collected}</b> / ${baseSize}` : "";
}

async function loadDashboard() {
  try {
    const s = await api(`/sets/${state.currentSetId}/summary?collection=${state.currentCollection}`);
    state.summary = s;
    populateBanner(s.set);
    renderDealCard(s);
    $("#statSpent").textContent = money(s.totalSpent);
    $("#statPacks").textContent = s.totalPacks;
    $("#statOrders").textContent = s.orderCount;
    $("#statBaseSet").textContent = s.set.printed_total;

    $("#statPacks").textContent = s.packsOpened != null ? s.packsOpened : s.totalPacks;

    const c = s.completion;
    if (c) {
      const hasCards = c.collected != null;
      $("#estRemaining").textContent = hasCards ? c.packsRemainingFromCards : c.packsRemaining;
      $("#estTotal").textContent = c.expectedTotalPacks;
      $("#estP50").textContent = c.p50;
      $("#estP90").textContent = c.p90;
      const opened = c.opened || 0;
      const ms = c.setMilestones || {};
      renderProgressInputs(s);

      // Packs-based breakpoint: packs still needed + bar of opened/threshold.
      const setPackBP = (numEl, fillEl, subEl, threshold, name) => {
        if (threshold == null) { $(numEl).textContent = "—"; $(fillEl).style.width = "0%"; $(subEl).textContent = ""; return; }
        const left = Math.max(0, threshold - opened);
        const fill = Math.min(100, Math.round((opened / threshold) * 100));
        $(numEl).textContent = left;
        $(fillEl).style.width = fill + "%";
        $(subEl).textContent = left === 0
          ? `Reached — ${name} kicks in around pack ${threshold} (you've opened ${opened}).`
          : `Opened ${opened} of ~${threshold} packs (${fill}%).`;
      };
      setPackBP("#bpMildNum", "#bpMildFill", "#bpMildSub", c.diminishingReturnsPacks, "diminishing returns");
      setPackBP("#bpSteepNum", "#bpSteepFill", "#bpSteepSub", c.diminishingReturnsPacksSteep, "steep diminishing returns");

      const fmt = (v) => (v == null ? "—" : v);
      $("#estPct50").textContent = fmt(ms.pct50);
      $("#estPct95").textContent = fmt(ms.pct95);
      if (hasCards) {
        setGauge(c.actualPct, c.collected, c.baseSetSize);
        $("#estProgressText").textContent =
          `You have ${c.collected} of ${c.baseSetSize} base-set cards (${c.actualPct}%) — about ${c.cardsRemaining} to go, ~${c.packsRemainingFromCards} more packs based on your collection.`;
      } else {
        setGauge(c.expectedPctAtOpened, c.expectedCollectedAtOpened, c.baseSetSize);
        $("#estProgressText").textContent =
          `Estimated ~${c.expectedCollectedAtOpened} of ${c.baseSetSize} base-set cards (${c.expectedPctAtOpened}%) after ${opened} packs opened. Enter your actual count above to sharpen this.`;
      }
    } else {
      $("#estRemaining").textContent = "–";
      setGauge(0, 0, s.set.printed_total);
      renderProgressInputs(s);
      $("#estProgressText").textContent = "No rarity data for this set.";
    }

    renderChase(s.chase);

    const tbody = $("#breakdownTable tbody");
    const entries = Object.entries(s.breakdown);
    const refs = dealRefs(s);
    tbody.innerHTML = entries.length
      ? entries.map(([p, b]) => {
          const perPack = b.packs > 0 ? b.spend / b.packs : null;
          const f = dealFlag(perPack, refs);
          return `<tr><td data-label="Product">${productIcon(p)}${p}</td><td data-label="Qty">${b.quantity}</td><td data-label="Packs">${b.packs}</td><td data-label="Spend">${money(b.spend)}</td><td data-label="$/pack">${perPack != null ? money(perPack) : "—"}</td><td data-label="Deal"><span class="${f.cls}">${f.label}</span></td></tr>`;
        }).join("")
      : '<tr><td colspan="6" class="muted">No purchases yet.</td></tr>';

    $("#rarityList").innerHTML = (s.set.rarities || [])
      .map((r) => `<span class="chip">${raritySymbol(r.rarity)} ${r.rarity} <b>${r.count}</b></span>`)
      .join("") || '<span class="muted">—</span>';
  } catch (err) {
    toast(err.message, true);
  }
}

function renderChase(chase) {
  const box = $("#chaseSlots");
  if (!chase || !chase.items || !chase.items.length) {
    $("#chaseAny").textContent = "–";
    box.innerHTML = '<div class="muted small">No chase pull rates configured (Settings).</div>';
    return;
  }
  $("#chaseAny").textContent = chase.anyAvgPacks ?? "–";
  box.innerHTML = chase.items.map((it) => {
    const odds = it.perPackProb > 0 ? `1 in ${Math.round(1 / it.perPackProb)}` : "—";
    const cls = (it.abbr || "").toLowerCase().replace(/[^a-z]/g, "");
    return `<div class="slot ${cls}${it.present ? "" : " off"}">
      <div class="slot-top">${raritySymbol(it.rarity)}<span class="slot-tag">${it.abbr}</span></div>
      <div class="slot-full">${it.rarity}</div>
      ${it.present
        ? `<div class="slot-pk">${it.avgPacks}<small> pks</small></div><div class="slot-od">${odds} / pack</div>`
        : `<div class="slot-pk muted">—</div><div class="slot-od">not in this set</div>`}
    </div>`;
  }).join("");
}

// ---- orders --------------------------------------------------------------
function productOptions(selected) {
  const products = Object.keys(state.settings.packs_per_product || {});
  return products.map((p) => `<option value="${p}" ${p === selected ? "selected" : ""}>${p}</option>`).join("");
}

function addLineRow(item = {}) {
  const tbody = $("#lineItems");
  const tr = document.createElement("tr");
  const product = item.product_type || Object.keys(state.settings.packs_per_product)[0];
  const ppu = item.packs_per_unit ?? state.settings.packs_per_product[product] ?? 1;
  tr.innerHTML = `
    <td data-label="Product"><select class="li-product">${productOptions(product)}</select></td>
    <td data-label="Qty"><input class="li-qty" type="number" min="1" value="${item.quantity ?? 1}" /></td>
    <td data-label="Unit price ($)"><input class="li-price" type="number" min="0" step="0.01" value="${item.unit_price ?? ""}" placeholder="0.00" /></td>
    <td data-label="Packs/unit"><input class="li-ppu" type="number" min="0" value="${ppu}" /></td>
    <td data-label="Line total" class="li-total muted">$0.00</td>
    <td data-label="" class="li-remove-cell"><button type="button" class="ghost li-remove">Remove line</button></td>`;
  tbody.appendChild(tr);

  const prodSel = tr.querySelector(".li-product");
  prodSel.addEventListener("change", () => {
    tr.querySelector(".li-ppu").value = state.settings.packs_per_product[prodSel.value] ?? 1;
    recalcForm();
  });
  tr.querySelectorAll("input").forEach((i) => i.addEventListener("input", recalcForm));
  tr.querySelector(".li-remove").addEventListener("click", () => { tr.remove(); recalcForm(); });
  recalcForm();
}

function readLineItems() {
  return $$("#lineItems tr").map((tr) => ({
    product_type: tr.querySelector(".li-product").value,
    quantity: Number(tr.querySelector(".li-qty").value),
    unit_price: Number(tr.querySelector(".li-price").value || 0),
    packs_per_unit: Number(tr.querySelector(".li-ppu").value || 0),
  }));
}

function recalcForm() {
  const items = readLineItems();
  let subtotal = 0, packs = 0;
  $$("#lineItems tr").forEach((tr, i) => {
    const line = items[i].quantity * items[i].unit_price;
    tr.querySelector(".li-total").textContent = money(line);
    subtotal += line;
    packs += items[i].quantity * items[i].packs_per_unit;
  });
  const store = $("#orderStore").value;
  $("#targetCircleWrap").classList.toggle("hidden", store !== "Target");
  const rate = currentDiscountRate();
  const discount = subtotal * rate;
  const taxable = subtotal - discount;
  const taxRate = Number($("#orderTax").value || 0) / 100;
  const tax = taxable * taxRate;

  $("#formSubtotal").textContent = money(subtotal);
  const discRow = $("#formDiscountRow");
  if (discount > 0) { discRow.classList.remove("hidden"); $("#formDiscount").textContent = "-" + money(discount); }
  else discRow.classList.add("hidden");
  $("#formTax").textContent = money(tax);
  $("#formTotal").textContent = money(taxable + tax);
  $("#formPacks").textContent = packs;
  updateSecretPrediction(packs);
}

// Subtotal discount rate for the current form (Target Circle Card = 5%).
function currentDiscountRate() {
  return ($("#orderStore").value === "Target" && $("#targetCircle").checked) ? 0.05 : 0;
}

// ---- secret (non-base-set) cards -----------------------------------------
// The set's secret rarities = those present in the full set but not the base set.
function setSecretRarities() {
  const set = state.summary && state.summary.set;
  if (!set) return [];
  const base = new Set((set.rarities || []).map((r) => r.rarity));
  return (set.allRarities || []).filter((r) => !base.has(r.rarity)).map((r) => r.rarity);
}

function renderFindsInputs(finds = {}) {
  const rarities = setSecretRarities();
  const section = $("#secretSection");
  const box = $("#secretInputs");
  if (!rarities.length) { section.classList.add("hidden"); box.innerHTML = ""; return; }
  section.classList.remove("hidden");
  box.innerHTML = rarities.map((r) => secretStepMarkup(r, finds[r], 'data-form="1"')).join("");
}

// Stepper handler for the order FORM — adjusts the local count only; values are
// collected by readFinds() on submit (no persistence until the order is saved).
function onFormSecretStep(e) {
  const btn = e.target.closest(".os-btn");
  if (!btn) return;
  const step = btn.closest(".os-step");
  const countEl = step.querySelector(".os-count");
  const c = Math.max(0, (Number(countEl.textContent) || 0) + (btn.classList.contains("os-inc") ? 1 : -1));
  countEl.textContent = c;
  step.classList.toggle("has", c > 0);
  step.querySelector(".os-dec").disabled = c <= 0;
  setStepOdds(step, Number($("#formPacks").textContent) || 0);
}

// ---- "tag pulled cards" picker -------------------------------------------
async function loadSetCards(setId) {
  if (state.cardsCache[setId]) return state.cardsCache[setId];
  const cards = await api(`/sets/${setId}/cards`);
  state.cardsCache[setId] = cards;
  return cards;
}

async function openCardPicker() {
  const grid = $("#pullGrid");
  if (!grid.classList.contains("hidden")) { grid.classList.add("hidden"); return; }
  grid.classList.remove("hidden");
  grid.innerHTML = '<div class="muted small">Loading cards…</div>';
  try {
    const cards = await loadSetCards(state.currentSetId);
    const secret = new Set(setSecretRarities());
    const picks = cards.filter((c) => secret.has(c.rarity) && c.image);
    if (!picks.length) { grid.innerHTML = '<div class="muted small">No secret-rarity card images for this set yet.</div>'; return; }
    const selected = new Set(state.formPulls.map((p) => p.card_id));
    grid.innerHTML = picks.map((c) => `
      <button type="button" class="pull-card${selected.has(c.id) ? " selected" : ""}" data-id="${c.id}"
        data-name="${(c.name || "").replace(/"/g, "&quot;")}" data-img="${c.image}" title="${c.name} · ${c.rarity}">
        <img src="${c.image}" loading="lazy" alt="${c.name}" />
      </button>`).join("");
  } catch (err) {
    grid.innerHTML = `<div class="muted small">Couldn't load cards: ${err.message}</div>`;
  }
}

function togglePull(btn) {
  const id = btn.dataset.id;
  const i = state.formPulls.findIndex((p) => p.card_id === id);
  if (i >= 0) { state.formPulls.splice(i, 1); btn.classList.remove("selected"); }
  else { state.formPulls.push({ card_id: id, name: btn.dataset.name, image_small: btn.dataset.img }); btn.classList.add("selected"); }
  renderPullSelected();
}

function renderPullSelected() {
  const el = $("#pullSelected");
  if (!el) return;
  if (!state.formPulls.length) { el.innerHTML = ""; return; }
  el.innerHTML = state.formPulls.map((p) => `<img class="pull-thumb" src="${p.image_small}" title="${p.name}" alt="${p.name}" />`).join("")
    + ` <span class="muted small">${state.formPulls.length} tagged</span>`;
}

function readFinds() {
  const finds = {};
  $$("#secretInputs .os-step").forEach((step) => {
    const c = Number(step.querySelector(".os-count").textContent) || 0;
    if (c > 0) finds[step.dataset.rarity] = c;
  });
  return finds;
}

// Model probability of >=1 secret in `packs` packs, from chase pull rates.
function secretModel(packs) {
  const rates = state.settings.chase_pull_rates || {};
  let probNonePerPack = 1, expPerPack = 0, rated = 0;
  for (const r of setSecretRarities()) {
    const p = Number(rates[r]);
    if (p > 0) { probNonePerPack *= 1 - p; expPerPack += p; rated++; }
  }
  if (!rated) return null;
  return {
    pAtLeastOne: packs > 0 ? 1 - Math.pow(probNonePerPack, packs) : 0,
    expected: expPerPack * packs,
  };
}

// Empirical estimate from the user's recorded finds across this set's orders.
function secretEmpirical(packs) {
  const secret = new Set(setSecretRarities());
  let obsSecrets = 0, obsPacks = 0;
  for (const o of state.orders || []) {
    const f = o.finds || {};
    if (!Object.keys(f).length) continue; // only orders the user has logged
    obsPacks += o.packs;
    for (const [r, c] of Object.entries(f)) if (secret.has(r)) obsSecrets += Number(c) || 0;
  }
  if (obsPacks <= 0) return null;
  const lambda = obsSecrets / obsPacks; // secrets per pack (Poisson rate)
  return {
    obsSecrets, obsPacks,
    pAtLeastOne: packs > 0 ? 1 - Math.exp(-lambda * packs) : 0,
    expected: lambda * packs,
  };
}

function updateSecretPrediction(packs) {
  applyRarityOdds($("#secretInputs"), packs);
  const el = $("#secretPrediction");
  if (!el) return;
  if (!setSecretRarities().length) { el.textContent = ""; return; }
  if (!(packs > 0)) { el.innerHTML = "Add packs to estimate your odds of a secret card."; return; }
  const m = secretModel(packs);
  const e = secretEmpirical(packs);
  if (!m) { el.textContent = "No pull-rate data for this set's secret rarities (set them in Settings)."; return; }
  let html = `Model: <b>${Math.round(m.pAtLeastOne * 100)}%</b> chance of ≥1 secret in ${packs} packs (≈${m.expected.toFixed(1)} expected).`;
  if (e) {
    html += `<br>Your pulls so far: ${e.obsSecrets} secret${e.obsSecrets === 1 ? "" : "s"} in ${e.obsPacks} packs → <b>${Math.round(e.pAtLeastOne * 100)}%</b> for this order (≈${e.expected.toFixed(1)} expected).`;
  }
  el.innerHTML = html;
}

function setupOrderForm() {
  $("#addLineBtn").addEventListener("click", () => addLineRow());
  $("#orderTax").addEventListener("input", recalcForm);
  $("#orderStore").addEventListener("change", recalcForm);
  $("#targetCircle").addEventListener("change", recalcForm);
  $("#orderCancel").addEventListener("click", resetOrderForm);
  $("#orderForm").addEventListener("submit", submitOrder);
  $("#ordersList").addEventListener("click", onSecretStep);
  $("#secretInputs").addEventListener("click", onFormSecretStep);
  $("#tagCardsBtn").addEventListener("click", openCardPicker);
  $("#pullGrid").addEventListener("click", (e) => {
    const b = e.target.closest(".pull-card");
    if (b) togglePull(b);
  });
}

function resetOrderForm() {
  state.editingOrderId = null;
  $("#lineItems").innerHTML = "";
  $("#orderNote").value = "";
  $("#orderDate").value = new Date().toISOString().slice(0, 10);
  $("#orderTax").value = state.settings.sales_tax_rate ?? 0;
  $("#orderSubmit").textContent = "Save order";
  $("#orderCancel").classList.add("hidden");
  setToggle($("#orderCollection"), state.currentCollection);
  $("#orderStore").value = "";
  $("#targetCircle").checked = true;
  state.formPulls = [];
  $("#pullGrid").classList.add("hidden");
  renderPullSelected();
  renderFindsInputs();
  addLineRow();
  recalcForm();
}

async function submitOrder(e) {
  e.preventDefault();
  const items = readLineItems();
  if (!items.length) return toast("Add at least one product line", true);
  const payload = {
    set_id: state.currentSetId,
    purchase_date: $("#orderDate").value,
    tax_rate: Number($("#orderTax").value || 0) / 100,
    note: $("#orderNote").value,
    collection: getToggle($("#orderCollection")),
    store: $("#orderStore").value,
    discount_rate: currentDiscountRate(),
    items,
    finds: readFinds(),
    pull_cards: state.formPulls,
  };
  try {
    if (state.editingOrderId) {
      await api(`/orders/${state.editingOrderId}`, { method: "PUT", body: payload });
      toast("Order updated");
    } else {
      await api("/orders", { method: "POST", body: payload });
      toast("Order saved");
    }
    await loadOrders();
    await loadDashboard();
    resetOrderForm();
  } catch (err) {
    toast(err.message, true);
  }
}

// Shared markup for one secret-rarity stepper pill (used by order cards AND
// the order form). `attrs` is an extra attribute string for the buttons
// (e.g. data-order="3" on a saved card, data-form="1" in the form).
function secretStepMarkup(rarity, count, attrs) {
  const c = Number(count) || 0;
  return `<div class="os-step${c > 0 ? " has" : ""}" data-rarity="${rarity}" title="${rarity}">
      <div class="os-info">
        <span class="os-tag">${raritySymbol(rarity)}<span class="os-abbr">${secretAbbr(rarity)}</span></span>
        <span class="os-odds hidden"><span class="os-exp"></span><span class="os-next"></span></span>
      </div>
      <div class="os-ctrl">
        <button type="button" class="os-btn os-dec" ${attrs} data-rarity="${rarity}" aria-label="Remove one ${rarity}"${c <= 0 ? " disabled" : ""}>−</button>
        <span class="os-count">${c}</span>
        <button type="button" class="os-btn os-inc" ${attrs} data-rarity="${rarity}" aria-label="Add one ${rarity}">+</button>
      </div>
    </div>`;
}

// Per-rarity model: chance of pulling >=1 of `rarity` across `packs` packs.
function rarityChance(rarity, packs) {
  const p = Number((state.settings.chase_pull_rates || {})[rarity]);
  if (!(p > 0) || !(packs > 0)) return null;
  return { p, pAtLeastOne: 1 - Math.pow(1 - p, packs), expected: p * packs };
}

function rarityRate(rarity) {
  const p = Number((state.settings.chase_pull_rates || {})[rarity]);
  return p > 0 ? p : null;
}

// P(X >= m) for X ~ Binomial(K, p) — number of that rarity across K packs
// (each pack independently yields it with prob p, at most one per pack).
function binomAtLeast(K, p, m) {
  if (m <= 0) return 1;
  if (m > K || p <= 0) return 0;
  let pmf = Math.pow(1 - p, K); // P(X = 0)
  let lower = pmf;              // cumulative P(X <= m-1)
  for (let k = 1; k <= m - 1; k++) {
    pmf *= ((K - k + 1) / k) * (p / (1 - p));
    lower += pmf;
  }
  return Math.max(0, Math.min(1, 1 - lower));
}

// Update one stepper's tiles from its CURRENT logged count:
//   • expected quantity of that rarity in the order  (≈ p · packs)
//   • chance of pulling at least ONE MORE than logged — the cumulative
//     Binomial probability P(X >= found + 1). Recalculates on every +/−.
function setStepOdds(step, packs) {
  const el = step.querySelector(".os-odds");
  if (!el) return;
  const p = rarityRate(step.dataset.rarity);
  if (!p || !(packs > 0)) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden");
  const found = Number(step.querySelector(".os-count").textContent) || 0;
  const expected = p * packs;
  const pNext = binomAtLeast(packs, p, found + 1); // P(at least found+1 total)
  const pct = Math.round(pNext * 100);
  const expEl = el.querySelector(".os-exp");
  const nextEl = el.querySelector(".os-next");
  if (expEl) expEl.textContent = `≈${expected.toFixed(expected < 1 ? 2 : 1)} expected`;
  if (nextEl) nextEl.textContent = `${pct}% for ${found + 1}+`;
  el.title = `≈${expected.toFixed(2)} ${step.dataset.rarity} expected across ${packs} packs · `
    + `${pct}% chance of pulling at least ${found + 1} (you've logged ${found})`;
}

function applyRarityOdds(root, packs) {
  if (!root) return;
  root.querySelectorAll(".os-step").forEach((step) => setStepOdds(step, packs));
}

// Inline secret-card steppers on a saved order card — adjust counts without
// entering edit mode. Falls back to read-only chips if the set has no known
// secret rarities.
function orderSecretLine(o) {
  const secrets = setSecretRarities();
  const finds = o.finds || {};
  const m = secretModel(o.packs);
  const predicted = m ? `~${Math.round(m.pAtLeastOne * 100)}% predicted (≈${m.expected.toFixed(1)})` : "";

  if (!secrets.length) {
    const found = Object.entries(finds);
    if (!found.length) return "";
    const chips = found.map(([r, c]) => `${raritySymbol(r)} ${c}× ${r}`).join(" · ");
    return `<div class="order-secrets"><span class="os-label">Secrets pulled:</span> ${chips}</div>`;
  }

  const total = Object.values(finds).reduce((a, c) => a + (Number(c) || 0), 0);
  const steppers = secrets.map((r) => secretStepMarkup(r, finds[r], `data-order="${o.id}"`)).join("");
  const hasRated = secrets.some((r) => rarityChance(r, o.packs));
  const caption = hasRated
    ? `<div class="os-caption muted small">Each tile shows the <b>expected number</b> of that rarity in this order's ${o.packs} packs, and your <b>chance of at least one more</b> than you've logged.</div>`
    : "";

  return `<div class="order-secrets">
      <div class="os-head">
        <span class="os-label">Secrets pulled</span>
        <span class="os-summary muted">${secretSummaryText(total, predicted)}</span>
      </div>
      ${caption}
      <div class="os-steppers">${steppers}</div>
    </div>`;
}

function secretSummaryText(total, predicted) {
  const base = total > 0 ? `${total} logged` : "tap + to log a pull";
  return predicted ? `${base} · ${predicted}` : base;
}

// Debounced per-order persistence so rapid taps don't hammer the API.
const _findsSaveTimers = {};
function queueFindsSave(orderId, finds) {
  clearTimeout(_findsSaveTimers[orderId]);
  _findsSaveTimers[orderId] = setTimeout(async () => {
    try {
      await api(`/orders/${orderId}`, { method: "PUT", body: { finds } });
    } catch (err) {
      toast(err.message, true);
      loadOrders(); // resync on failure
    }
  }, 400);
}

// Click handler (delegated) for the +/− stepper buttons on order cards.
function onSecretStep(e) {
  const btn = e.target.closest(".os-btn");
  if (!btn) return;
  const orderId = Number(btn.dataset.order);
  const rarity = btn.dataset.rarity;
  const order = (state.orders || []).find((o) => o.id === orderId);
  if (!order) return;

  const finds = { ...(order.finds || {}) };
  const next = Math.max(0, (Number(finds[rarity]) || 0) + (btn.classList.contains("os-inc") ? 1 : -1));
  if (next === 0) delete finds[rarity]; else finds[rarity] = next;
  order.finds = finds;

  // Targeted DOM update — no full re-render, no flicker.
  const step = btn.closest(".os-step");
  step.querySelector(".os-count").textContent = next;
  step.classList.toggle("has", next > 0);
  step.querySelector(".os-dec").disabled = next <= 0;
  setStepOdds(step, order.packs); // recompute "chance of another" for the new count

  const card = btn.closest(".order-card");
  const total = Object.values(finds).reduce((a, c) => a + (Number(c) || 0), 0);
  const m = secretModel(order.packs);
  const predicted = m ? `~${Math.round(m.pAtLeastOne * 100)}% predicted (≈${m.expected.toFixed(1)})` : "";
  const sum = card && card.querySelector(".os-summary");
  if (sum) sum.textContent = secretSummaryText(total, predicted);

  queueFindsSave(orderId, finds);
}

async function loadOrders() {
  const list = $("#ordersList");
  try {
    const orders = await api("/orders?set=" + encodeURIComponent(state.currentSetId) + "&collection=" + state.currentCollection);
    state.orders = orders;
    if (!orders.length) { list.innerHTML = '<div class="muted">No orders yet.</div>'; return; }
    list.innerHTML = orders.map((o) => `
      <div class="order-card">
        <div class="order-head">
          <div>
            <span class="order-date">${o.purchase_date}</span>
            <span class="coll-badge ${o.collection === "shared" ? "shared" : "mine"}">${collectionLabel(o.collection)}</span>
            ${o.store ? `<span class="order-meta"> · ${o.store}</span>` : ""}
            ${o.note ? `<span class="order-meta"> · ${o.note}</span>` : ""}
            <div class="order-meta">${o.packs} packs · subtotal ${money(o.subtotal)}${o.discount > 0 ? ` · <span class="discount">Target Circle −${money(o.discount)}</span>` : ""} · tax ${money(o.tax)} · <b>${money(o.total)}</b></div>
          </div>
          <div class="order-actions">
            <button class="link" data-edit="${o.id}">Edit</button>
            <button class="link" data-del="${o.id}" style="color:var(--danger)">Delete</button>
          </div>
        </div>
        <ul>${o.items.map((i) => `<li>${i.quantity}× ${i.product_type} @ ${money(i.unit_price)} (${i.packs_per_unit} packs ea.)</li>`).join("")}</ul>
        ${orderSecretLine(o)}
        ${o.pullCards && o.pullCards.length ? `<div class="order-pulls">${o.pullCards.map((p) => `<img class="pull-thumb" src="${p.image_small}" title="${p.name}" alt="${p.name}" />`).join("")}</div>` : ""}
      </div>`).join("");
    list.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => editOrder(orders.find((o) => o.id == b.dataset.edit))));
    list.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => deleteOrder(b.dataset.del)));
    $$("#ordersList .order-card").forEach((card, idx) => applyRarityOdds(card, orders[idx].packs));
  } catch (err) {
    toast(err.message, true);
  }
}

function editOrder(order) {
  state.editingOrderId = order.id;
  $("#orderDate").value = order.purchase_date;
  $("#orderTax").value = (order.tax_rate * 100).toFixed(3).replace(/\.?0+$/, "");
  $("#orderNote").value = order.note || "";
  setToggle($("#orderCollection"), order.collection || "mine");
  $("#orderStore").value = order.store || "";
  $("#targetCircle").checked = (order.discount_rate || 0) > 0;
  state.formPulls = (order.pullCards || []).map((p) => ({ card_id: p.card_id, name: p.name, image_small: p.image_small }));
  $("#pullGrid").classList.add("hidden");
  renderPullSelected();
  $("#lineItems").innerHTML = "";
  renderFindsInputs(order.finds || {});
  order.items.forEach((i) => addLineRow(i));
  $("#orderSubmit").textContent = "Update order";
  $("#orderCancel").classList.remove("hidden");
  recalcForm();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function deleteOrder(id) {
  if (!confirm("Delete this order?")) return;
  try {
    await api(`/orders/${id}`, { method: "DELETE" });
    toast("Order deleted");
    loadOrders();
    loadDashboard();
  } catch (err) {
    toast(err.message, true);
  }
}

// ---- settings ------------------------------------------------------------
async function loadSettings() {
  state.settings = await api("/settings");
  renderSettings();
}

function renderSettings() {
  const s = state.settings;
  $("#setTax").value = s.sales_tax_rate ?? 0;
  $("#setApiKey").value = s.pokemontcg_api_key ?? "";
  $("#setPcKey").value = s.pricecharting_api_key ?? "";
  $("#setRuns").value = s.monte_carlo_runs ?? 3000;
  const tbody = $("#packsPerProduct tbody");
  tbody.innerHTML = Object.entries(s.packs_per_product || {})
    .map(([p, n]) => ppRow(p, n))
    .join("");
  const chaseBody = $("#chaseRates tbody");
  chaseBody.innerHTML = Object.entries(s.chase_pull_rates || {})
    .map(([r, p]) => chaseRateRow(r, p))
    .join("");
  $("#setPackModel").value = JSON.stringify(s.pack_model, null, 2);
}

function ppRow(name = "", packs = "") {
  return `<tr>
    <td><input type="text" class="pp-name" value="${name}" placeholder="Sleeved Booster" /></td>
    <td><input type="number" class="pp-packs" min="0" value="${packs}" placeholder="1" /></td>
    <td><button type="button" class="ghost pp-remove">✕</button></td>
  </tr>`;
}

function chaseRateRow(rarity = "", prob = "") {
  return `<tr>
    <td><input type="text" class="cr-rarity" value="${rarity}" placeholder="Illustration Rare" /></td>
    <td><input type="number" class="cr-prob" step="any" min="0" value="${prob}" placeholder="0.111" /></td>
    <td><button type="button" class="ghost cr-remove">✕</button></td>
  </tr>`;
}

function setupSettingsForm() {
  $("#settingsForm").addEventListener("submit", saveSettings);
  $("#addProduct").addEventListener("click", () => {
    $("#packsPerProduct tbody").insertAdjacentHTML("beforeend", ppRow());
  });
  $("#packsPerProduct").addEventListener("click", (e) => {
    if (e.target.classList.contains("pp-remove")) e.target.closest("tr").remove();
  });
  $("#addChaseRate").addEventListener("click", () => {
    $("#chaseRates tbody").insertAdjacentHTML("beforeend", chaseRateRow());
  });
  $("#chaseRates").addEventListener("click", (e) => {
    if (e.target.classList.contains("cr-remove")) e.target.closest("tr").remove();
  });
}

async function saveSettings(e) {
  e.preventDefault();
  let packModel;
  try {
    packModel = JSON.parse($("#setPackModel").value);
  } catch {
    return toast("Pull-rate model is not valid JSON", true);
  }
  const packsPerProduct = {};
  $$("#packsPerProduct tbody tr").forEach((tr) => {
    const name = tr.querySelector(".pp-name").value.trim();
    const packs = Number(tr.querySelector(".pp-packs").value);
    if (name && packs >= 0) packsPerProduct[name] = packs;
  });
  const chaseRates = {};
  $$("#chaseRates tbody tr").forEach((tr) => {
    const name = tr.querySelector(".cr-rarity").value.trim();
    const prob = Number(tr.querySelector(".cr-prob").value);
    if (name && prob > 0) chaseRates[name] = prob;
  });
  try {
    state.settings = await api("/settings", {
      method: "PUT",
      body: {
        sales_tax_rate: Number($("#setTax").value || 0),
        pokemontcg_api_key: $("#setApiKey").value,
        pricecharting_api_key: $("#setPcKey").value,
        monte_carlo_runs: Number($("#setRuns").value || 3000),
        packs_per_product: packsPerProduct,
        chase_pull_rates: chaseRates,
        pack_model: packModel,
      },
    });
    renderSettings();
    toast("Settings saved");
    if (state.currentSetId) loadDashboard();
  } catch (err) {
    toast(err.message, true);
  }
}

// ---- go ------------------------------------------------------------------
init().then(() => {
  if (state.settings) resetOrderForm();
});
