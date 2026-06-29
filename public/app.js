// Pokémon Pack Tracker — hub-first redesign, wired to the Worker/D1 API.
// Ported from the `Pack Tracker.html` prototype; mock data replaced with live
// calls. Vanilla JS, no build step.

// ---- tiny helpers --------------------------------------------------------
const money = (n) => "$" + (Number(n) || 0).toFixed(2);
const round = (n) => Math.round(Number(n) || 0);
const on = (active) => (active ? " on" : "");
const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const todayISO = () => new Date().toISOString().slice(0, 10);
function fmtDate(iso) { try { return new Date(String(iso).slice(0, 10) + "T00:00:00").toLocaleString("en-US", { month: "short", day: "numeric" }); } catch (e) { return iso; } }
function daysSince(iso) { if (!iso) return Infinity; const t = Date.parse(String(iso).slice(0, 10)); return isNaN(t) ? Infinity : Math.floor((Date.now() - t) / 86400000); }

// Fallback packs-per-product (overridden by settings.packs_per_product).
const PPU_FALLBACK = { "Booster Pack": 1, "Sleeved Booster": 1, "Booster Bundle": 6, "Elite Trainer Box": 9, "Mini Tin": 2, "Regular Tin": 3 };
const QUICK_PRODUCTS = [["Booster Pack", "🎴"], ["Booster Bundle", "📦"], ["Elite Trainer Box", "🗃️"], ["Mini Tin", "🥫"]];

// Chase-rarity glyph + colour (keyed by abbr the estimator returns).
const CHASE_STYLE = {
  IR: { stars: "★", color: "#e6b54a" }, UR: { stars: "★★", color: "#c9d2e0" },
  SIR: { stars: "★★", color: "#e6b54a" }, MHR: { stars: "★★★", color: "#f0c987" },
  HR: { stars: "★★★", color: "#f0c987" },
};
const RARITY_GLYPH = {
  "Common": { g: "●", c: "#aeb7ca" }, "Uncommon": { g: "◆", c: "#aeb7ca" },
  "Rare": { g: "★", c: "#aeb7ca" }, "Double Rare": { g: "★★", c: "#cfd6e6" },
  "Illustration Rare": { g: "★", c: "#e6b54a" }, "Ultra Rare": { g: "★★", c: "#c9d2e0" },
  "Special Illustration Rare": { g: "★★", c: "#e6b54a" }, "Hyper Rare": { g: "★★★", c: "#f0c987" },
  "Mega Hyper Rare": { g: "★★★", c: "#f0c987" }, "ACE SPEC Rare": { g: "★", c: "#f76b6b" },
};
const RARITY_ABBR = {
  "Illustration Rare": "IR", "Special Illustration Rare": "SIR", "Ultra Rare": "UR",
  "Double Rare": "RR", "Hyper Rare": "HR", "Mega Hyper Rare": "MHR", "ACE SPEC Rare": "ACE",
  "Shiny Rare": "SR", "Shiny Ultra Rare": "SUR",
};
const secretAbbr = (r) => RARITY_ABBR[r] || r;
function rarityGlyph(rarity) { const r = RARITY_GLYPH[rarity] || { g: "●", c: "#7d889e" }; return `<span style="color:${r.c};letter-spacing:1px">${r.g}</span>`; }

// ---- API + toast ---------------------------------------------------------
async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const err = new Error(data.error || `Request failed (${res.status})`); err.status = res.status; throw err; }
  return data;
}
let toastTimer;
function toast(msg, isError = false) {
  const host = document.getElementById("toast-host");
  host.innerHTML = `<div class="toast${isError ? " error" : ""}"></div>`;
  host.firstChild.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { host.innerHTML = ""; }, isError ? 4200 : 2600);
}

// ---- set-shape helpers ---------------------------------------------------
// Every set is shown by its number (SV08, SV8.5, …) derived from the API id.
function setCode(id) { return String(id || "?").toUpperCase().replace(/PT(\d)/, ".$1"); }
function tintOf(id) { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 46% 42%)`; }
function isSpecialId(id) { return /pt\d/i.test(String(id)); }                // S&V .5 sets are the special subsets
function releaseSort(date) { if (!date) return 0; const m = String(date).match(/(\d{4})-(\d{2})/); return m ? Number(m[1]) * 100 + Number(m[2]) : 0; }
function fmtRelease(date) { if (!date) return ""; const d = new Date(String(date).replace(/\//g, "-")); return isNaN(d) ? date : d.toLocaleString("en-US", { month: "short", year: "numeric" }); }
function monthsOld(date) { const rs = releaseSort(date); if (!rs) return 0; const now = new Date(); return (now.getFullYear() - Math.floor(rs / 100)) * 12 + (now.getMonth() + 1 - (rs % 100)); }
function isOOP(date) { return monthsOld(date) > 24; }
const marketOf = (s) => s.marketEff;                                          // cheapest rip, floored at $5
const ppuOf = (product) => { const m = state.settings && state.settings.packs_per_product; return (m && m[product] != null ? m[product] : (PPU_FALLBACK[product] != null ? PPU_FALLBACK[product] : 1)); };
const bundlePacks = () => ppuOf("Booster Bundle") || 6;

// ---- state ---------------------------------------------------------------
function loadPrefs() { try { return JSON.parse(localStorage.getItem("ppt_v4")) || {}; } catch (e) { return {}; } }
const prefs = loadPrefs();
const state = {
  view: "hub",
  binder: prefs.binder === "shared" ? "shared" : "mine",
  showShared: !!prefs.showShared,
  setId: prefs.setId || null,
  settings: null,
  sets: [],            // enriched tracked (imported) sets
  setsById: {},
  allSets: null,       // every expansion (manage sheet); lazy
  orders: [],          // current binder's orders (all sets)
  dealTab: "loose",
  loosePrice: 5, bundlePrice: 30,
  hubPrice: {},
  hubAnimated: false,
  loading: true,
  cardsCache: {},      // setId -> card list (for the pulls picker)
  // sheets
  composerOpen: false, editingId: null, draft: null,
  setsOpen: false, importing: null,
  settingsOpen: false, settingsAdvanced: false,
  confirm: null,
  pullsOpen: false, pullsId: null, pullsFinds: {}, pullsTagged: [], pullsTagOpen: false, pullsCards: null,
};
function persistPrefs() { localStorage.setItem("ppt_v4", JSON.stringify({ binder: state.binder, showShared: state.showShared, setId: state.setId })); }

// ---- enrich a /api/hub summary into the prototype set shape --------------
function enrich(s) {
  const set = s.set;
  const market = set.pack_market_price != null && set.pack_market_price > 0 ? set.pack_market_price : null;
  const ev = s.packEv != null && s.packEv > 0 ? s.packEv : null;
  const ceiling = set.pack_price_ceiling != null && set.pack_price_ceiling > 0 ? set.pack_price_ceiling
    : (ev != null ? ev : (market != null ? market : 5));
  const evEff = ev != null ? ev : ceiling;
  const marketEff = Math.max(5, market != null ? market : evEff);
  const comp = s.completion || null;
  const collectedActual = s.progress && s.progress.cards_collected != null ? s.progress.cards_collected : null;
  const modelCollected = comp ? (comp.expectedCollectedAtOpened || 0) : 0;
  const collected = collectedActual != null ? collectedActual : modelCollected;
  const bp = bundlePacks();
  return {
    id: set.id, raw: set, name: set.name, series: set.series || "", code: setCode(set.id),
    tint: tintOf(set.id), special: isSpecialId(set.id), oop: isOOP(set.release_date),
    base: set.printed_total, total: set.total || set.printed_total,
    release: fmtRelease(set.release_date), releaseDate: set.release_date, rs: releaseSort(set.release_date),
    market, marketEff, ceiling, ev: evEff, msrp: set.pack_msrp,
    bundlePacks: bp, bundleMarket: round(marketEff * bp),
    drPacks: comp ? comp.diminishingReturnsPacks : null,
    lastRefresh: set.pack_price_updated ? set.pack_price_updated.slice(0, 10) : null,
    packsBought: s.totalPacks || 0, packsOpened: s.packsOpened || 0,
    collected, collectedActual, modelCollected,
    spent: s.totalSpent || 0, ordersCount: s.orderCount || 0,
    completion: comp, chase: s.chase, breakdown: s.breakdown || {}, packEv: s.packEv,
    rarities: set.rarities || [], allRarities: set.allRarities || [], art: set.art || null,
    heroArt: set.art && set.art.hero ? set.art.hero : null,
  };
}
const setById = (id) => state.setsById[id];

// ---- loaders -------------------------------------------------------------
async function loadSettings() { state.settings = await api("/settings"); }
async function loadHub() {
  const raw = await api(`/hub?collection=${state.binder}`);
  state.sets = raw.map(enrich).sort((a, b) => b.rs - a.rs);
  state.setsById = {};
  for (const s of state.sets) state.setsById[s.id] = s;
}
async function loadOrders() { state.orders = await api(`/orders?collection=${state.binder}`); }
async function loadAllSets() { state.allSets = await api("/sets/search?all=1"); }

async function reload() {
  try {
    await loadHub();
    if (state.view === "set") {
      if (!setById(state.setId) && state.sets.length) state.setId = state.sets[0].id;
      if (!setById(state.setId)) state.view = "hub";
      else await loadOrders();
    }
    render();
  } catch (err) { toast(err.message, true); }
}

// ---- deal math (verdict / recommendations) -------------------------------
function verdict(perPack, set) {
  const M = marketOf(set);
  if (perPack <= set.ceiling) return { word: "BUY", icon: "✓", color: "var(--good)", bg: "rgba(47,213,138,.10)", border: "rgba(47,213,138,.35)", tone: "good" };
  if (perPack >= M * 1.25) return { word: "PASS", icon: "✕", color: "var(--bad)", bg: "rgba(247,107,107,.10)", border: "rgba(247,107,107,.35)", tone: "bad" };
  return { word: "FAIR", icon: "~", color: "var(--fair)", bg: "rgba(255,176,32,.10)", border: "rgba(255,176,32,.35)", tone: "fair" };
}
function looseRec(perPack, set, v) {
  const M = marketOf(set);
  const rem = set.drPacks != null ? Math.max(0, set.drPacks - set.packsBought) : null;
  if (v.tone === "good") return { big: rem != null ? "Buy ~" + rem : "Buy", text: "value holds until diminishing returns kick in." };
  if (v.tone === "fair") { const over = Math.max(0, perPack - M); const n = over > 0 ? Math.max(1, Math.floor((Number(state.settings.fun_overpay_pool) || 6) / over)) : (rem != null ? rem : 5); return { big: "Buy ~" + n, text: "a few for fun — the premium adds up after that." }; }
  return { big: "Pass", text: "rip nearer " + money(M) + "/pack instead." };
}
function bundleRec(perPack, set, v) {
  if (v.tone === "good") return { big: "Grab it", text: money(perPack) + "/pack across " + set.bundlePacks + " packs — solid." };
  if (v.tone === "fair") return { big: "Maybe", text: money(perPack) + "/pack — fine if you want it sealed." };
  return { big: "Pass", text: money(perPack) + "/pack is above a fair rip." };
}

// ---- estimate / rarity / chase derived from live data --------------------
function estOf(set) {
  const c = set.completion;
  if (!c || !c.baseSetSize) return null;
  const opened = set.packsOpened || 0;
  const ms = c.setMilestones || {};
  const typical = c.collected != null && c.packsRemainingFromCards != null ? c.packsRemainingFromCards : (c.packsRemaining || 0);
  return {
    to95: Math.max(0, (ms.pct95 || 0) - opened),
    to50: Math.max(0, (ms.pct50 || 0) - opened),
    typical,
    unlucky: Math.max(0, (c.p90 || 0) - opened),
  };
}
let _weightedSlot = null;
function rarityProb(rarity) {
  if (rarity === "Common" || rarity === "Uncommon") return { guaranteed: true };
  const s = state.settings || {};
  const chase = s.chase_pull_rates || {};
  if (Number(chase[rarity]) > 0) return { p: Number(chase[rarity]) };
  const pm = s.pack_model || {};
  for (const slot of pm.slots || []) {
    if (slot.weights && slot.weights[rarity] != null) {
      const tot = Object.values(slot.weights).reduce((a, b) => a + Number(b), 0) || 1;
      return { p: (Number(slot.weights[rarity]) / tot) * (slot.count || 1) };
    }
  }
  return {};
}
function rarityProbLabel(rarity) {
  const r = rarityProb(rarity);
  if (r.guaranteed) return "guaranteed";
  if (r.p == null) return "";
  return r.p >= 0.1 ? `~${round(r.p * 100)}%/pack` : `1 in ${round(1 / r.p)}`;
}

// ---- order display helpers ----------------------------------------------
function pullsTotal(o) { return Object.values(o.finds || {}).reduce((a, b) => a + (Number(b) || 0), 0); }
function orderSets(o) { return (o.sets && o.sets.length) ? o.sets : [...new Set((o.items || []).map((i) => i.set_id).filter(Boolean))]; }
function orderItemsText(o) {
  const sets = orderSets(o), packs = o.packs;
  if (sets.length > 1) return sets.length + " sets · " + packs + " packs";
  if ((o.items || []).length === 1) { const i = o.items[0]; return i.quantity + "× " + i.product_type + " · " + packs + " packs"; }
  return (o.items || []).length + " lines · " + packs + " packs";
}
function secretRaritiesForSet(id) {
  const set = setById(id);
  if (!set) return [];
  const base = new Set((set.rarities || []).map((r) => r.rarity));
  return (set.allRarities || []).filter((r) => !base.has(r.rarity)).map((r) => r.rarity);
}
function binomAtLeast(K, p, m) { if (m <= 0) return 1; if (p <= 0 || K <= 0) return 0; let pmf = Math.pow(1 - p, K), lower = pmf; for (let k = 1; k <= m - 1; k++) { pmf *= ((K - k + 1) / k) * (p / (1 - p)); lower += pmf; } return Math.max(0, Math.min(1, 1 - lower)); }

// ---- header --------------------------------------------------------------
function headerHTML() {
  return `<div class="head">
    <div class="brand" data-act="gohub" style="cursor:pointer;">
      <svg viewBox="0 0 100 100" width="30" height="30"><circle cx="50" cy="50" r="46" fill="#fff" stroke="#0b0e16" stroke-width="6"/><path d="M5 50a45 45 0 0 1 90 0Z" fill="#ee1c25"/><rect x="5" y="46" width="90" height="8" fill="#0b0e16"/><circle cx="50" cy="50" r="15" fill="#fff" stroke="#0b0e16" stroke-width="6"/></svg>
      <span class="name disp">Pack Tracker</span>
    </div>
    <div style="display:flex;align-items:center;gap:10px;">
      ${state.showShared ? `<div class="seg"><button data-act="binder" data-v="mine" class="${on(state.binder === 'mine')}">Mine</button><button data-act="binder" data-v="shared" class="${on(state.binder === 'shared')}">Shared</button></div>` : ""}
      <button class="icon-btn" data-act="settings" title="Settings" style="width:38px;height:38px;border-radius:999px;font-size:16px;">⚙</button>
    </div>
  </div>`;
}

// ---- render entry --------------------------------------------------------
function render() {
  if (state.loading) { document.getElementById("app").innerHTML = headerHTML() + `<div class="loading">Loading your sets…</div>`; return; }
  if (state.view === "set" && setById(state.setId)) renderSetView();
  else { state.view = "hub"; renderHub(); }
}

// ---- HUB -----------------------------------------------------------------
function hubPriceOf(id) { if (state.hubPrice[id] == null) state.hubPrice[id] = round(marketOf(setById(id))); return state.hubPrice[id]; }
function hubStep(id, d) { state.hubPrice[id] = Math.max(0, hubPriceOf(id) + d); render(); }
function goHub() { state.view = "hub"; state.hubAnimated = false; persistPrefs(); render(); }
function openSetView(id) { const s = setById(id); if (!s) return; state.view = "set"; state.setId = id; state.dealTab = "loose"; state.loosePrice = round(marketOf(s)); state.bundlePrice = round(s.bundleMarket); persistPrefs(); loadOrders().then(render).catch((e) => { render(); toast(e.message, true); }); }

function renderHub() {
  const anim = !state.hubAnimated;
  const sets = state.sets;       // already newest-first
  const rows = sets.map((s, i) => {
    const price = hubPriceOf(s.id), v = verdict(price, s), stale = daysSince(s.lastRefresh) > 7;
    const comp = round(s.collected / s.base * 100);
    const drRem = s.drPacks != null ? Math.max(0, s.drPacks - s.packsBought) : null;
    const aStyle = anim ? `animation:rowIn .34s cubic-bezier(.22,1,.36,1) backwards;animation-delay:${i * 55}ms;` : "";
    const artBg = s.heroArt ? `background-image:url('${esc(s.heroArt)}')` : `background:linear-gradient(160deg, ${s.tint} 0%, #0e1422 80%)`;
    return `<div class="hubrow" style="${aStyle}">
      <div class="hub-art${s.special ? ' sp' : ''}" style="${artBg}"><span class="hub-code">${s.code}</span>${s.special ? '<span class="hub-sp">✦</span>' : ''}</div>
      <div class="hub-mid">
        <div class="hub-name">${esc(s.name)}${s.oop ? '<span class="oop">likely out of print</span>' : ''}</div>
        <div class="hub-sub">${esc(s.series)}${s.release ? ' · ' + s.release : ''}</div>
        <div class="hub-stats"><span><b>${comp}%</b> complete</span><span><b>${drRem != null ? drRem : '—'}</b> to DR</span><span><b>${money(s.spent)}</b> spent</span><span><b>${s.ordersCount}</b> orders</span></div>
        <div class="hub-acts"><button class="hub-open" data-act="opensetview" data-v="${s.id}">Open dashboard →</button><button class="hub-mini" data-act="hubaddorder" data-v="${s.id}">+ Order</button><button class="hub-mini" data-act="hubrefresh" data-v="${s.id}">↻ Refresh</button></div>
      </div>
      <div class="hub-deal" style="background:${v.bg};border-left:1px solid ${v.border}">
        <div class="hub-deal-top"><span class="hub-verdict" style="color:${v.color}">${v.word}</span><span style="font-size:18px">${v.icon}</span></div>
        <div class="hub-stepper"><button class="b1 sm" data-act="hubdec" data-v="${s.id}">−</button><span class="hub-price">${money(price)}</span><button class="b1 sm" data-act="hubinc" data-v="${s.id}">+</button></div>
        <div class="hub-rip">rip ${money(marketOf(s))}${s.lastRefresh ? ' · upd ' + fmtDate(s.lastRefresh) : ''}${stale ? ' · <span class="stale-dot"></span>refresh' : ''}</div>
      </div>
    </div>`;
  }).join("");
  state.hubAnimated = true;
  document.getElementById("app").innerHTML = headerHTML() + `
    <div class="hub-head"><div><div class="hub-title disp">Your sets</div><div class="hub-tagline">Pick a set to check deals &amp; log orders</div></div></div>
    <div class="hub-list">${rows}
      ${sets.length ? "" : `<div class="hub-empty">No sets tracked yet — import one to get started.</div>`}
      <button class="hub-import" data-act="addset" style="${anim ? `animation:rowIn .34s cubic-bezier(.22,1,.36,1) backwards;animation-delay:${sets.length * 55}ms;` : ''}"><span class="hub-import-plus">+</span><span>Import a set<small>browse expansions, newest first</small></span></button>
    </div>`;
}

// ---- SET VIEW ------------------------------------------------------------
function selectSet(id) { const s = setById(id); if (!s) return; state.setId = id; state.dealTab = "loose"; state.loosePrice = round(marketOf(s)); state.bundlePrice = round(s.bundleMarket); persistPrefs(); render(); }
function setTab(t) { state.dealTab = t; render(); }
function stepPrice(d) { if (state.dealTab === "loose") state.loosePrice = Math.max(0, state.loosePrice + d); else state.bundlePrice = Math.max(0, state.bundlePrice + d); render(); }

function renderSetView() {
  const set = setById(state.setId);
  const mobile = window.innerWidth <= 640;
  const showDesk = !mobile;
  const isLoose = state.dealTab === "loose";
  const rawPrice = isLoose ? state.loosePrice : state.bundlePrice;
  const perPack = isLoose ? state.loosePrice : (set.bundlePacks ? state.bundlePrice / set.bundlePacks : state.bundlePrice);
  const v = verdict(perPack, set);
  const rec = isLoose ? looseRec(perPack, set, v) : bundleRec(perPack, set, v);

  const bought = set.packsBought;
  const collected = set.collected;
  const drRem = set.drPacks != null ? Math.max(0, set.drPacks - bought) : null;
  const drFill = set.drPacks ? Math.min(100, round(bought / set.drPacks * 100)) : 0;
  const completion = round(collected / set.base * 100);
  const C = 2 * Math.PI * 52, gaugeDash = ((completion / 100) * C) + " " + C;
  const M = marketOf(set);
  const stale = daysSince(set.lastRefresh) > 7;

  const pills = state.sets.map((s) => `
    <button class="pill${on(s.id === state.setId)}" data-act="set" data-v="${s.id}">
      <span class="sym${s.special ? ' sp' : ''}" style="background:linear-gradient(160deg, ${s.tint} 0%, #10182a 80%)">${s.code}</span>
      <span class="col"><span class="pn">${esc(s.name)}</span><span class="pm">${s.base} base · ${s.total} total</span></span>
    </button>`).join("");

  const stats = [
    ["Spent", money(set.spent), ""],
    ["Packs bought", bought, ""],
    ["Complete", completion + "%", "color:var(--accent)"],
    ["Orders", set.ordersCount, ""],
  ].map(([k, val, st]) => `<div class="stat"><div class="k">${k}</div><div class="v" style="${st}">${val}</div></div>`).join("");

  const banner = `
    <div class="banner" style="background:linear-gradient(115deg, ${set.tint} 0%, #101626 70%)">
      ${set.heroArt ? `<div class="bart" style="background-image:url('${esc(set.heroArt)}')"></div>` : '<div class="stripe"></div>'}
      <div class="tag">key art · pokemontcg.io</div>
      <div class="bc"><div class="bs">${esc(set.series)}</div><div class="bn">${esc(set.name)}</div>
        <div class="bsub">${set.base}-card base set · ${set.total} total${set.release ? ' · released ' + set.release : ''}</div></div>
    </div>`;

  const bad = M * 1.25;
  const hiS = Math.max(bad * 1.25, perPack * 1.1, set.ev * 1.1, set.ceiling * 1.3);
  const posS = (x) => Math.min(100, Math.max(0, x / hiS * 100));
  const dealScaleHTML = `<div class="scale"><div class="scale-bar"><div class="z" style="background:rgba(47,213,138,.45);flex:${set.ceiling}"></div><div class="z" style="background:rgba(255,176,32,.4);flex:${Math.max(0.01, bad - set.ceiling)}"></div><div class="z" style="background:rgba(247,107,107,.4);flex:${Math.max(0.01, hiS - bad)}"></div><div class="scale-ptr" style="left:${posS(perPack)}%"><span class="scale-bub" style="color:${v.color};border-color:${v.border}">${money(perPack)}/pk</span></div></div><div class="scale-labels"><span style="color:var(--good)">Good deal ≤ ${money(set.ceiling)}</span><span style="color:var(--fair)">Fair</span><span style="color:var(--bad)">Overpriced ≥ ${money(bad)}</span></div><div class="scale-cap">Cheapest a single pack sells for elsewhere is about <b>${money(M)}</b> — the price to beat. The cards inside are worth about <b>${money(set.ev)}</b> on average.</div></div>`;

  const deskDetail = showDesk ? deskDetailHTML(set, collected, completion, gaugeDash) : "";

  const orders = ordersListHTML();

  document.getElementById("app").innerHTML = headerHTML() + `
    <button class="backchip" data-act="gohub">← All sets</button>
    <div class="eyebrow">Checking deals for</div>
    <div class="pills">${pills}<button class="pill add" data-act="addset">+ Add set</button></div>
    ${banner}
    <div class="hero">
      <div class="hero-top">
        <div style="display:flex;align-items:center;gap:10px;"><span class="hero-title disp">Should I grab it?</span><span class="hero-set">${esc(set.name)}</span></div>
        <div class="seg sq">
          <button data-act="tab" data-v="loose" class="${on(isLoose)}">Loose pack</button>
          <button data-act="tab" data-v="bundle" class="${on(!isLoose)}">Booster bundle</button>
        </div>
      </div>
      <div class="deal-grid">
        <div class="stepbox">
          <div class="uplabel" style="text-align:center;margin-bottom:14px;">${isLoose ? "Vendor's price per pack" : "Vendor's price per bundle"}</div>
          <div class="stepper">
            <button class="b5" data-act="step" data-v="-5">−5</button>
            <button class="b1" data-act="step" data-v="-1">−</button>
            <div class="price">${money(rawPrice)}</div>
            <button class="b1" data-act="step" data-v="1">+</button>
            <button class="b5" data-act="step" data-v="5">+5</button>
          </div>
          <div style="text-align:center;font-size:12px;color:var(--muted);margin-top:13px;">${isLoose ? ("that's " + money(perPack) + " per pack") : (money(perPack) + " per pack across " + set.bundlePacks)}</div>
        </div>
        <div class="verdict" style="background:${v.bg};border:1px solid ${v.border}">
          <div style="display:flex;align-items:center;gap:11px;"><span class="vword" style="color:${v.color}">${v.word}</span><span style="font-size:26px">${v.icon}</span></div>
          <div style="font-size:13.5px;color:#d6dcea;margin-top:9px;line-height:1.4;">${
            isLoose
              ? (v.tone === "good" ? ("At or under the " + money(set.ceiling) + " good-deal line for this set.") : v.tone === "bad" ? ("More than 25% over the " + money(M) + " cheapest rip.") : "Between the good-deal line and overpaying.")
              : (v.tone === "good" ? ("Per-pack price beats the " + money(set.ceiling) + " good-deal line.") : v.tone === "bad" ? "Per-pack price is well over a fair rip." : "Per-pack price sits in the fair range.")
          }</div>
          <div class="vrec"><span class="disp" style="font-weight:700;font-size:22px;">${rec.big}</span><span style="font-size:13px;color:#d6dcea;line-height:1.35;">${rec.text}</span></div>
        </div>
      </div>
      <div class="refs">
        <div class="refresh-wrap" style="margin-left:0;">
          <span class="refresh-meta${stale ? " stale" : ""}">${stale ? '<span class="dot"></span>' : ""}${set.lastRefresh ? "Updated " + fmtDate(set.lastRefresh) : "Not priced yet"}${stale && set.lastRefresh ? " · refresh recommended" : ""}</span>
          <button class="refresh${stale ? " rec" : ""}" data-act="refresh">↻ Refresh market</button>
        </div>
      </div>
      ${dealScaleHTML}
    </div>
    <div class="grid2">
      <div class="card">
        <div class="uplabel">Diminishing returns</div>
        <div style="display:flex;align-items:baseline;gap:8px;margin-top:8px;"><span class="drnum">${drRem != null ? drRem : '—'}</span><span style="font-size:14px;color:var(--soft)">more packs</span></div>
        <div style="font-size:13px;color:var(--soft);margin-top:4px;">to buy <b style="color:var(--text)">on top of the ${bought} you own</b> before each new pack adds &lt; 1 base card</div>
        <div class="bar"><i style="width:${drFill}%"></i></div>
        <div style="font-size:12px;color:var(--muted);margin-top:7px;">${bought}${set.drPacks != null ? ' of ~' + set.drPacks : ''} packs bought${set.drPacks != null ? ' (' + drFill + '%)' : ''}</div>
      </div>
      <div class="stats">${stats}</div>
    </div>
    ${deskDetail}
    <div class="sec-head"><div class="sec-title">${state.binder === "shared" ? "Shared binder orders" : "Recent orders"}</div><button class="btn-primary" data-act="addorder">+ Add order</button></div>
    ${orders}
  `;
}

function deskDetailHTML(set, collected, completion, gaugeDash) {
  const est = estOf(set);
  const chaseItems = (set.chase && set.chase.items) ? set.chase.items : [];
  const chase = chaseItems.map((c) => {
    const st = CHASE_STYLE[c.abbr] || { stars: "★", color: "#aeb7ca" };
    const odds = c.perPackProb > 0 ? "1 in " + round(1 / c.perPackProb) : "—";
    return `<div class="slot${c.present === false ? ' off' : ''}"><div style="display:flex;align-items:center;gap:7px;"><span class="stars" style="color:${st.color}">${st.stars}</span><span style="font-size:11px;font-weight:700;color:var(--soft)">${c.abbr}</span></div>
      <div class="pk">${c.present === false ? '—' : (c.avgPacks || '—')}<span style="font-size:11px;color:var(--muted);font-weight:500"> pks</span></div>
      <div style="font-size:11px;color:var(--muted)">${c.present === false ? 'not in set' : odds}</div></div>`;
  }).join("") || `<div style="font-size:12px;color:var(--muted);padding:6px 0;">No chase rates configured.</div>`;

  const bd = Object.entries(set.breakdown || {});
  const bdRows = bd.length ? bd.map(([prod, b]) => {
    const perPack = b.packs > 0 ? b.spend / b.packs : 0;
    let fl; if (perPack <= set.ceiling) fl = { l: "Good", c: "var(--good)" }; else if (perPack >= marketOf(set) * 1.25) fl = { l: "Over", c: "var(--bad)" }; else fl = { l: "Fair", c: "var(--fair)" };
    return `<div class="bd-row"><span class="bd-name">${esc(prod)}</span><span>${b.quantity}×</span><span>${b.packs} pk</span><span>${money(b.spend)}</span><span class="bd-pp">${money(perPack)}/pk</span><span style="color:${fl.c};font-weight:700;font-size:11.5px">${fl.l}</span></div>`;
  }).join("") : `<div style="font-size:13px;color:var(--muted);padding:6px 0;">No orders for this set in this binder yet.</div>`;

  const rarChips = (set.rarities || []).map((r) => {
    const pl = rarityProbLabel(r.rarity);
    return `<span class="rchip">${rarityGlyph(r.rarity)} ${esc(r.rarity)} <b>${r.count}</b>${pl ? ` <span class="rprob">${pl}</span>` : ""}</span>`;
  }).join("") || `<span class="rchip">No rarity data yet</span>`;

  const products = (set.art && set.art.products && set.art.products.length)
    ? set.art.products.map((p) => `<div class="art"><div class="ph" style="background-image:url('${esc(p.img)}')"></div><div class="cap">${esc(p.name)}</div></div>`).join("")
    : [["booster pack", "Booster Pack"], ["ETB", "Elite Trainer Box"], ["bundle", "Booster Bundle"], ["box", "Booster Box"]]
      .map(([kind, name]) => `<div class="art"><div class="ph" style="background:linear-gradient(160deg, ${set.tint} 0%, #10182a 75%)"><span>${kind}</span></div><div class="cap">${name}</div></div>`).join("");

  const delta = set.collectedActual != null ? (set.collectedActual - set.modelCollected) : null;
  const estCard = est ? `
      <div class="card">
        <div class="uplabel">Estimated to finish</div>
        <div style="display:flex;align-items:baseline;gap:8px;margin-top:8px;"><span class="disp" style="font-weight:700;font-size:38px;line-height:1;color:var(--good)">≈${est.to95}</span><span style="font-size:13px;color:var(--soft)">more packs to 95%</span></div>
        <div style="font-size:12.5px;color:var(--soft);margin-top:4px;">to reach 95% of the base set — the realistic finish line</div>
        <div style="display:flex;flex-wrap:wrap;gap:14px;margin-top:11px;font-size:12px;color:var(--muted)"><span>to 50%: <b class="disp" style="color:var(--text)">${est.to50}</b></span><span>to 100%: <b class="disp" style="color:var(--text)">${est.typical}</b></span><span>unlucky 100%: <b class="disp" style="color:var(--text)">${est.unlucky}</b></span></div>
        <div style="font-size:11px;color:var(--muted);margin-top:8px;">Monte-Carlo estimate from pull rates — real results vary.</div>
      </div>`
    : `<div class="card"><div class="uplabel">Estimated to finish</div><div style="font-size:13px;color:var(--muted);margin-top:10px;">No rarity data for this set yet — reimport it once pokemontcg.io has priced it.</div></div>`;

  return `
    <div class="grid2">
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;"><div class="uplabel">Set completion</div><div style="font-size:12px;color:var(--muted)">${collected} / ${set.base}</div></div>
        <div class="gauge-wrap">
          <div class="gauge"><svg viewBox="0 0 120 120" width="96" height="96"><circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="12"/><circle cx="60" cy="60" r="52" fill="none" stroke="var(--accent)" stroke-width="12" stroke-linecap="round" transform="rotate(-90 60 60)" stroke-dasharray="${gaugeDash}"/></svg><div class="g-c">${completion}%</div></div>
          <div style="flex:1;">
            <div style="font-size:13px;color:var(--soft);line-height:1.5;">${collected} of ${set.base} base-set cards — about ${Math.max(0, set.base - collected)} to go.</div>
            <label class="actual-wrap">Your real card count<input type="number" min="0" max="${set.base}" data-actual="${set.id}" value="${set.collectedActual != null ? set.collectedActual : ''}" placeholder="${set.modelCollected} (estimate)"></label>
            ${delta != null ? `<div style="font-size:11.5px;margin-top:6px;font-weight:600;color:${delta >= 0 ? 'var(--good)' : 'var(--fair)'}">${delta >= 0 ? '+' : '−'}${Math.abs(delta)} vs the ${set.modelCollected}-card estimate</div>` : ""}
          </div>
        </div>
      </div>
      ${estCard}
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;"><div class="uplabel">Chase cards</div><div style="font-size:12px;color:var(--muted)">avg packs to first hit</div></div>
        <div class="chase">${chase}</div>
      </div>
    </div>
    <div class="grid2">
      <div class="card"><div class="uplabel" style="margin-bottom:8px;">Product breakdown</div>${bdRows}</div>
      <div class="card"><div class="uplabel" style="margin-bottom:10px;">Base-set rarity counts</div><div class="rar-chips">${rarChips}</div></div>
    </div>
    <div class="card" style="margin-bottom:16px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:13px;"><div class="uplabel">Expansion art</div><span style="font-family:monospace;font-size:10px;color:#5f6a82">official renders · pokemontcg.io</span></div>
      <div class="art-row">${products}</div>
    </div>`;
}

function ordersListHTML() {
  const rows = state.orders.map((o) => {
    const packs = o.packs, perPack = packs > 0 ? o.total / packs : 0;
    const sets = orderSets(o);
    const known = sets.map((id) => setById(id)).filter(Boolean);
    const avgCeil = known.length ? known.reduce((m, s) => m + s.ceiling, 0) / known.length : null;
    const avgMkt = known.length ? known.reduce((m, s) => m + marketOf(s), 0) / known.length : null;
    let f;
    if (avgCeil != null && perPack <= avgCeil) f = { l: "Good deal", c: "var(--good)", bg: "rgba(47,213,138,.12)" };
    else if (avgMkt != null && perPack >= avgMkt * 1.25) f = { l: "Overpaid", c: "var(--bad)", bg: "rgba(247,107,107,.12)" };
    else f = { l: "Fair", c: "var(--fair)", bg: "rgba(255,176,32,.12)" };
    const chips = sets.map((id) => { const s = setById(id); return `<span class="setchip" style="color:${s ? s.tint : 'var(--soft)'}">${s ? s.code : setCode(id)}</span>`; }).join("");
    const np = pullsTotal(o);
    const vendor = o.note || o.store || "Order";
    return `<div class="order">
      <div class="o-meta">
        <div class="o-row1"><span class="o-date">${fmtDate(o.purchase_date)}</span><span class="o-vendor">${esc(vendor)}</span><span class="o-binder">${o.collection === "shared" ? "Shared" : "Mine"}</span>${o.store ? `<span class="o-binder">${esc(o.store)}</span>` : ""}</div>
        <div class="o-row2">${chips}<span class="o-items">${orderItemsText(o)}</span>${np > 0 ? `<span class="setchip" style="color:#e6b54a">🃏 ${np} pull${np > 1 ? 's' : ''}</span>` : ""}</div>
      </div>
      <div class="o-right">
        <div class="o-fig">
          <div><div class="k">Total</div><div class="v">${money(o.total)}</div></div>
          <div><div class="k">$/pack</div><div class="v">${money(perPack)}</div></div>
        </div>
        <span class="flag" style="color:${f.c};background:${f.bg}">${f.l}</span>
        <div class="order-acts">
          <button class="icon-btn" data-act="pulls" data-v="${o.id}" title="Tag secret cards pulled">🃏</button>
          <button class="icon-btn" data-act="editorder" data-v="${o.id}" title="Edit order">✎</button>
          <button class="icon-btn del" data-act="delorder" data-v="${o.id}" title="Delete order">🗑</button>
        </div>
      </div></div>`;
  }).join("");
  return rows || `<div style="color:var(--muted);font-size:13px;padding:8px 2px;">No orders in this binder yet.</div>`;
}

// ---- composer ------------------------------------------------------------
function freshDraft() { const sid = setById(state.setId) ? state.setId : (state.sets[0] && state.sets[0].id); return { date: todayISO(), vendor: "", store: "", circle: true, tax: state.settings.sales_tax_rate != null ? state.settings.sales_tax_rate : 0, binder: state.binder, lines: [{ id: 1, product: "Booster Pack", setId: sid, qty: 1, price: "" }] }; }
function openComposer() { if (!state.sets.length) { toast("Import a set first", true); openSetsModal(); return; } state.editingId = null; state.composerOpen = true; state.draft = freshDraft(); renderComposer(); }
function editOrder(id) {
  const o = state.orders.find((x) => x.id === id); if (!o) return;
  state.editingId = id; state.composerOpen = true;
  state.draft = {
    date: o.purchase_date, vendor: o.note || "", store: o.store || "", circle: (o.discount_rate || 0) > 0,
    tax: round((o.tax_rate || 0) * 1000) / 10, binder: o.collection || "mine",
    lines: o.items.map((l, i) => ({ id: i + 1, product: l.product_type, setId: l.set_id, qty: l.quantity, price: l.unit_price })),
  };
  renderComposer();
}
function closeComposer() { state.composerOpen = false; state.editingId = null; state.draft = null; renderComposer(); }
function addLine(product) { const d = state.draft; const nid = d.lines.reduce((m, l) => Math.max(m, l.id), 0) + 1; d.lines.push({ id: nid, product, setId: setById(state.setId) ? state.setId : d.lines[0].setId, qty: 1, price: "" }); renderLines(); recalc(); }
function removeLine(id) { const d = state.draft; if (d.lines.length > 1) d.lines = d.lines.filter((l) => l.id !== id); renderLines(); recalc(); }

function computeDraft(d) {
  let subtotal = 0, packs = 0;
  d.lines.forEach((l) => { const q = Number(l.qty) || 0, p = Number(l.price) || 0; subtotal += q * p; packs += q * ppuOf(l.product); });
  const discount = (d.store === "Target" && d.circle) ? subtotal * 0.05 : 0;
  const taxable = subtotal - discount;
  const tax = taxable * (Number(d.tax) || 0) / 100;
  return { subtotal, discount, tax, packs, total: taxable + tax };
}

async function saveOrder() {
  const d = state.draft, t = computeDraft(d);
  if (t.packs <= 0 && t.subtotal <= 0) { toast("Add a product line first", true); return; }
  const items = d.lines.map((l) => ({ set_id: l.setId, product_type: l.product, quantity: Number(l.qty) || 0, unit_price: Number(l.price) || 0, packs_per_unit: ppuOf(l.product) }));
  const payload = {
    purchase_date: d.date, tax_rate: (Number(d.tax) || 0) / 100, note: d.vendor || "",
    collection: d.binder, store: d.store || "", discount_rate: (d.store === "Target" && d.circle) ? 0.05 : 0, items,
  };
  try {
    if (state.editingId) { await api(`/orders/${state.editingId}`, { method: "PUT", body: payload }); toast("Order updated"); }
    else { const n = [...new Set(items.map((i) => i.set_id))].length; await api("/orders", { method: "POST", body: payload }); toast(n > 1 ? `Saved — ${n}-set order logged` : "Order saved"); }
    state.composerOpen = false; state.editingId = null; state.draft = null;
    renderComposer(); await reload();
  } catch (err) { toast(err.message, true); }
}

function renderComposer() {
  const host = document.getElementById("composer");
  if (!state.composerOpen) { host.innerHTML = ""; return; }
  const d = state.draft;
  const editing = !!state.editingId;
  const quick = QUICK_PRODUCTS.map(([l, i]) => `<button class="qchip" data-cact="add" data-v="${l}">${i} ${l}</button>`).join("");
  host.innerHTML = `
    <div class="scrim" data-cact="bg">
      <div class="sheet" data-cact="stop">
        <div class="sheet-head">
          <div><div class="disp" style="font-weight:700;font-size:18px;">${editing ? "Edit order" : "New order"}</div><div style="font-size:12px;color:var(--muted);margin-top:1px;">One receipt — mix as many sets as you bought</div></div>
          <button class="close" data-cact="close">✕</button>
        </div>
        <div class="sheet-body">
          <div class="metagrid">
            <label class="field">Date<input type="date" data-df="date" value="${d.date}"></label>
            <label class="field">Vendor<input type="text" data-df="vendor" value="${esc(d.vendor)}" placeholder="e.g. Anime Expo — Booth 412"></label>
            <label class="field">Store
              <select data-df="store">
                ${["", "Offcourt TCG", "Target", "Too Many Games", "Other"].map((o) => `<option value="${o}"${(d.store || "") === o ? " selected" : ""}>${o || "— none —"}</option>`).join("")}
              </select>
            </label>
            <label class="field">Sales tax %<input type="number" data-df="tax" step="0.001" min="0" value="${d.tax}"></label>
            <div class="field">Goes to binder
              <div class="seg sq fill" style="background:var(--panel2);">
                <button data-cact="dbinder" data-v="mine" class="${on(d.binder === 'mine')}">Mine</button>
                <button data-cact="dbinder" data-v="shared" class="${on(d.binder === 'shared')}">Shared</button>
              </div>
            </div>
          </div>
          ${d.store === "Target" ? `<button class="circle-toggle${d.circle ? ' on' : ''}" data-cact="circle">${d.circle ? "✓" : "○"} Target Circle Card — 5% off subtotal (before tax)</button>` : ""}
          <div class="uplabel" style="margin-bottom:9px;">Quick add</div>
          <div class="quick">${quick}</div>
          <div class="lines" id="lines"></div>
          <div class="totbar">
            <div class="totline">
              <div class="tot">Subtotal <b id="t-sub">$0.00</b></div>
              <div class="tot" id="t-disc" style="display:none;color:var(--good)">Circle 5% <b id="t-disc-v">-$0.00</b></div>
              <div class="tot">Tax <b id="t-tax">$0.00</b></div>
              <div class="tot">Packs <b id="t-packs">0</b></div>
              <div class="tot grand">Total <b id="t-total">$0.00</b></div>
            </div>
            <div class="acts"><button class="save" data-cact="save">${editing ? "Update order" : "Save order"}</button><button class="cancel" data-cact="close">Cancel</button></div>
          </div>
        </div>
      </div>
    </div>`;
  renderLines();
  recalc();
}

function renderLines() {
  const box = document.getElementById("lines");
  if (!box) return;
  const setOpts = (sel) => state.sets.map((s) => `<option value="${s.id}"${s.id === sel ? " selected" : ""}>${esc(s.name)}</option>`).join("");
  box.innerHTML = state.draft.lines.map((l) => {
    const ppu = ppuOf(l.product); const s = setById(l.setId) || state.sets[0];
    return `<div class="lrow" data-line="${l.id}">
      <div class="lart${s && s.special ? ' sp' : ''}" style="background:linear-gradient(160deg, ${s ? s.tint : '#333'} 0%, #10182a 80%)"><span>${s ? s.code : '—'}</span></div>
      <div class="lcol" style="flex:1 1 140px;min-width:120px;"><span class="lk">Set</span>
        <select data-lf="setId">${setOpts(l.setId)}</select></div>
      <div class="lcol" style="flex:1 1 130px;min-width:120px;"><span class="lk">${esc(l.product)}</span><span style="font-size:12px;color:var(--muted);padding:6px 0;">${ppu} pack${ppu > 1 ? "s" : ""}/unit</span></div>
      <div class="lcol" style="width:64px;"><span class="lk">Qty</span><input type="number" min="1" data-lf="qty" value="${l.qty}"></div>
      <div class="lcol" style="width:96px;"><span class="lk">Unit $</span><input type="number" min="0" step="0.01" data-lf="price" value="${l.price}" placeholder="0.00"></div>
      <div class="lcol" style="width:78px;text-align:right;"><span class="lk">Line</span><span class="lt" data-lt="${l.id}">$0.00</span></div>
      <button class="lrm" data-cact="rm" data-v="${l.id}">✕</button>
    </div>`;
  }).join("");
}

function recalc() {
  const t = computeDraft(state.draft);
  const sub = document.getElementById("t-sub"); if (!sub) return;
  sub.textContent = money(t.subtotal);
  document.getElementById("t-tax").textContent = money(t.tax);
  document.getElementById("t-packs").textContent = t.packs;
  document.getElementById("t-total").textContent = money(t.total);
  const disc = document.getElementById("t-disc");
  if (disc) { if (t.discount > 0) { disc.style.display = ""; document.getElementById("t-disc-v").textContent = "-" + money(t.discount); } else disc.style.display = "none"; }
  state.draft.lines.forEach((l) => { const el = document.querySelector('[data-lt="' + l.id + '"]'); if (el) el.textContent = money((Number(l.qty) || 0) * (Number(l.price) || 0)); });
}

// ---- sets (manage) modal -------------------------------------------------
async function openSetsModal() { state.setsOpen = true; renderSetsModal(); if (!state.allSets) { try { await loadAllSets(); } catch (e) { /* shown below */ } renderSetsModal(); } }
function closeSetsModal() { state.setsOpen = false; renderSetsModal(); }
async function importSet(id) {
  state.importing = id; renderSetsModal();
  try { const set = await api(`/sets/${id}/import`, { method: "POST" }); await reload(); if (state.allSets) await loadAllSets(); toast("Imported " + set.name); }
  catch (err) { toast(err.message, true); }
  finally { state.importing = null; renderSetsModal(); }
}
async function reimportSet(id) {
  state.importing = id; renderSetsModal();
  try { const set = await api(`/sets/${id}/import`, { method: "POST" }); await reload(); toast("Reimported " + set.name + " — art & prices refreshed"); }
  catch (err) { toast(err.message, true); }
  finally { state.importing = null; renderSetsModal(); }
}
async function removeSet(id) {
  const s = setById(id);
  try {
    await api(`/sets/${id}`, { method: "DELETE" });
    if (state.setId === id) { state.setId = state.sets.filter((x) => x.id !== id)[0] ? state.sets.filter((x) => x.id !== id)[0].id : null; if (!state.setId) state.view = "hub"; }
    await reload(); if (state.allSets) await loadAllSets(); renderSetsModal();
    toast(`Removed ${s ? s.name : "set"} (orders untouched)`);
  } catch (err) { toast(err.message, true); }
}

function renderSetsModal() {
  const host = document.getElementById("setsmodal");
  if (!state.setsOpen) { host.innerHTML = ""; return; }
  let body;
  if (!state.allSets) {
    body = `<div class="loading">Loading expansions…</div>`;
  } else {
    const list = state.allSets.slice().sort((a, b) => (releaseSort(b.releaseDate) - releaseSort(a.releaseDate)));
    const rows = list.map((s) => {
      const tracked = setById(s.id);
      const special = isSpecialId(s.id), oop = isOOP(s.releaseDate);
      const busy = state.importing === s.id;
      const lockedRemove = tracked && (tracked.ordersCount > 0 || tracked.packsBought > 0);
      const actions = tracked
        ? `<span class="badge">Tracked</span>
           <button class="icon-btn" data-mact="reimport" data-v="${s.id}" title="Reimport — refresh art & prices"${busy ? " disabled" : ""}>↻</button>
           <button class="icon-btn del${lockedRemove ? ' off' : ''}" ${lockedRemove ? '' : `data-mact="delset"`} data-v="${s.id}" title="${lockedRemove ? 'Has orders or packs — can’t remove' : 'Remove from tracked'}">✕</button>`
        : `<button class="btn-import" data-mact="import" data-v="${s.id}"${busy ? " disabled" : ""}>${busy ? "Importing…" : "Import"}</button>`;
      const badges = `${special ? '<span class="sp-chip">✦ Special</span>' : ''}${oop ? '<span class="oop">likely out of print</span>' : ''}`;
      let stats;
      if (tracked) {
        const drRem = tracked.drPacks != null ? Math.max(0, tracked.drPacks - tracked.packsBought) : null;
        stats = `Loose rip <b>${money(marketOf(tracked))}</b> · <b>${tracked.packsBought}${tracked.drPacks != null ? '/' + tracked.drPacks : ''}</b> packs bought${drRem != null ? ` · <b>${drRem}</b> to diminishing returns` : ''}`;
      } else {
        stats = `Loose rip <b>${s.market != null ? money(Math.max(5, s.market)) : '—'}</b> · not tracked yet`;
      }
      return `<div class="exp-row">
        <div class="exp-num${special ? ' sp' : ''}" style="background:linear-gradient(160deg, ${tintOf(s.id)} 0%, #10182a 80%)">${setCode(s.id)}</div>
        <div class="exp-info">
          <div class="exp-name">${esc(s.name)}${badges}</div>
          <div class="exp-meta">${esc(s.series || '')}${s.releaseDate ? ' · ' + fmtRelease(s.releaseDate) : ''} · ${s.printedTotal} cards</div>
          <div class="exp-stats">${stats}</div>
        </div>
        <div class="exp-actions">${actions}</div>
      </div>`;
    }).join("");
    body = `<div class="exp-grouphdr">All expansions · newest first</div><div class="exp-list">${rows}</div>`;
  }
  host.innerHTML = `
    <div class="scrim" data-mact="bg">
      <div class="sheet" data-mact="stop">
        <div class="sheet-head">
          <div><div class="disp" style="font-weight:700;font-size:18px;">Add or manage sets</div><div style="font-size:12px;color:var(--muted);margin-top:1px;">Newest first · import, reimport (refresh art &amp; prices), or remove</div></div>
          <button class="close" data-mact="close">✕</button>
        </div>
        <div class="sheet-body">${body}</div>
      </div>
    </div>`;
}

// ---- confirm dialog ------------------------------------------------------
function askConfirm(msg, detail, onYes) { state.confirm = { msg, detail, onYes }; renderConfirm(); }
function closeConfirm() { state.confirm = null; renderConfirm(); }
function renderConfirm() {
  const host = document.getElementById("confirm");
  if (!state.confirm) { host.innerHTML = ""; return; }
  const c = state.confirm;
  host.innerHTML = `<div class="scrim center" data-xact="bg"><div class="confirm-card" data-xact="stop">
    <h3>${esc(c.msg)}</h3><p>${esc(c.detail)}</p>
    <div class="confirm-acts"><button class="cancel" data-xact="no" style="flex:1">Cancel</button><button class="btn-danger" data-xact="yes">Delete</button></div>
  </div></div>`;
}
function requestDeleteOrder(id) {
  const o = state.orders.find((x) => x.id === id); if (!o) return;
  askConfirm("Delete this order?", fmtDate(o.purchase_date) + " · " + (o.note || o.store || "Order") + " · " + money(o.total) + " (" + o.packs + " packs). This can't be undone.", () => deleteOrder(id));
}
async function deleteOrder(id) {
  try { await api(`/orders/${id}`, { method: "DELETE" }); toast("Order deleted"); await reload(); }
  catch (err) { toast(err.message, true); }
}

// ---- settings sheet ------------------------------------------------------
function openSettings() { state.settingsOpen = true; renderSettings(); }
function closeSettings(save) { if (save) saveSettingsFromSheet(); state.settingsOpen = false; renderSettings(); }
function toggleAdvanced() { state.settingsAdvanced = !state.settingsAdvanced; renderSettings(); }

function renderSettings() {
  const host = document.getElementById("settings");
  if (!state.settingsOpen) { host.innerHTML = ""; return; }
  const s = state.settings;
  const pppRows = Object.entries(s.packs_per_product || {}).map(([k, v]) => `<div class="set-trow"><span class="nm">${esc(k)}</span><input type="number" min="0" data-spp="${esc(k)}" value="${v}"></div>`).join("");
  const chaseRows = Object.entries(s.chase_pull_rates || {}).map(([k, v]) => `<div class="set-trow"><span class="nm">${esc(k)}</span><input type="number" step="0.0001" min="0" data-scr="${esc(k)}" value="${v}"></div>`).join("");
  const adv = state.settingsAdvanced ? `
    <div class="set-section">
      <h4>API keys</h4>
      <label class="field" style="margin-bottom:10px;">pokemontcg.io API key<input type="text" data-sf="pokemontcg_api_key" value="${esc(s.pokemontcg_api_key)}" placeholder="optional"></label>
      <label class="field" style="margin-bottom:10px;">PriceCharting API key<input type="text" data-sf="pricecharting_api_key" value="${esc(s.pricecharting_api_key)}" placeholder="for live loose-pack prices"></label>
      <div class="metagrid" style="margin-bottom:0;">
        <label class="field">eBay Client ID<input type="text" data-sf="ebay_client_id" value="${esc(s.ebay_client_id)}"></label>
        <label class="field">eBay Client Secret<input type="text" data-sf="ebay_client_secret" value="${esc(s.ebay_client_secret)}"></label>
      </div>
    </div>
    <div class="set-section">
      <h4>Estimate model</h4>
      <label class="field" style="margin-bottom:14px;">Monte-Carlo runs<input type="number" min="200" step="100" data-sf="monte_carlo_runs" value="${s.monte_carlo_runs}"></label>
      <div class="uplabel" style="margin-bottom:8px;">Packs per product</div>
      <div class="set-table" style="margin-bottom:14px;">${pppRows}</div>
      <div class="uplabel" style="margin-bottom:8px;">Chase pull rates (per pack)</div>
      <div class="set-table" style="margin-bottom:14px;">${chaseRows}</div>
      <div class="uplabel" style="margin-bottom:8px;">Pull-rate model (JSON)</div>
      <textarea class="set-ta" data-sf="pack_model" spellcheck="false">${esc(JSON.stringify(s.pack_model, null, 2))}</textarea>
    </div>` : "";
  host.innerHTML = `
    <div class="scrim" data-gact="bg">
      <div class="sheet" data-gact="stop">
        <div class="sheet-head">
          <div><div class="disp" style="font-weight:700;font-size:18px;">Settings</div><div style="font-size:12px;color:var(--muted);margin-top:1px;">Everyday options up top · technical bits under Advanced</div></div>
          <button class="close" data-gact="close">✕</button>
        </div>
        <div class="sheet-body">
          <div class="set-section">
            <h4>General</h4>
            <div class="metagrid" style="margin-bottom:0;">
              <label class="field">Default sales tax %<input type="number" step="0.001" min="0" data-sf="sales_tax_rate" value="${s.sales_tax_rate}"></label>
              <label class="field">Overpay-for-fun budget $<input type="number" step="1" min="0" data-sf="fun_overpay_pool" value="${s.fun_overpay_pool}"></label>
            </div>
            <button class="set-toggle${state.showShared ? ' on' : ''}" data-gact="toggleshared" style="margin-top:12px;">${state.showShared ? "✓" : "○"} Show Shared binder<small>adds the Mine / Shared switch to the header</small></button>
          </div>
          <button class="adv-toggle" data-gact="adv"><span>⚙ Advanced — API keys, pull-rate model, packs per product</span><span style="color:var(--muted)">${state.settingsAdvanced ? "▴" : "▾"}</span></button>
          ${adv}
          <div class="totbar"><div class="acts"><button class="save" data-gact="done">Done</button></div></div>
        </div>
      </div>
    </div>`;
}

function saveSettingsFromSheet() {
  const host = document.getElementById("settings");
  if (!host.querySelector("[data-sf]")) return;        // sheet not mounted
  const val = (k) => { const el = host.querySelector(`[data-sf="${k}"]`); return el ? el.value : undefined; };
  const ppp = {}; host.querySelectorAll("[data-spp]").forEach((el) => { const n = Number(el.value); if (el.dataset.spp && n >= 0) ppp[el.dataset.spp] = n; });
  const chase = {}; host.querySelectorAll("[data-scr]").forEach((el) => { const n = Number(el.value); if (el.dataset.scr && n > 0) chase[el.dataset.scr] = n; });
  const body = {
    sales_tax_rate: Number(val("sales_tax_rate")) || 0,
    fun_overpay_pool: Number(val("fun_overpay_pool")) || 0,
    packs_per_product: ppp,
    chase_pull_rates: chase,
  };
  if (state.settingsAdvanced) {
    body.monte_carlo_runs = Number(val("monte_carlo_runs")) || 3000;
    body.pokemontcg_api_key = val("pokemontcg_api_key") || "";
    body.pricecharting_api_key = val("pricecharting_api_key") || "";
    body.ebay_client_id = val("ebay_client_id") || "";
    body.ebay_client_secret = val("ebay_client_secret") || "";
    const pmRaw = val("pack_model");
    if (pmRaw != null) { try { body.pack_model = JSON.parse(pmRaw); } catch (e) { toast("Pull-rate model isn't valid JSON — not saved", true); } }
  }
  api("/settings", { method: "PUT", body }).then((res) => { state.settings = res; reload(); }).catch((err) => toast(err.message, true));
}

// ---- pulls modal ---------------------------------------------------------
function openPulls(id) {
  const o = state.orders.find((x) => x.id === id); if (!o) return;
  state.pullsOpen = true; state.pullsId = id;
  state.pullsFinds = { ...(o.finds || {}) };
  state.pullsTagged = (o.pullCards || []).map((p) => ({ card_id: p.card_id, name: p.name, image_small: p.image_small }));
  state.pullsTagOpen = false; state.pullsCards = null;
  renderPulls();
}
function closePulls() { state.pullsOpen = false; renderPulls(); }
function pullsStep(rarity, d) { state.pullsFinds[rarity] = Math.max(0, (Number(state.pullsFinds[rarity]) || 0) + d); renderPulls(); }
function pullsTagPick(id) {
  const cards = state.pullsCards || [];
  const card = cards.find((c) => c.id === id); if (!card) return;
  const i = state.pullsTagged.findIndex((t) => t.card_id === id);
  if (i >= 0) state.pullsTagged.splice(i, 1);
  else state.pullsTagged.push({ card_id: id, name: card.name, image_small: card.image });
  renderPulls();
}
async function pullsTagToggle() {
  state.pullsTagOpen = !state.pullsTagOpen;
  if (state.pullsTagOpen && !state.pullsCards) { renderPulls(); await loadPullsCards(); }
  renderPulls();
}
async function loadPullsCards() {
  const o = state.orders.find((x) => x.id === state.pullsId); if (!o) return;
  const sets = orderSets(o);
  const secret = new Set(); sets.forEach((id) => secretRaritiesForSet(id).forEach((r) => secret.add(r)));
  const out = [];
  for (const sid of sets) {
    try {
      if (!state.cardsCache[sid]) state.cardsCache[sid] = await api(`/sets/${sid}/cards`);
      for (const c of state.cardsCache[sid]) if (secret.has(c.rarity) && c.image) out.push(c);
    } catch (e) { /* skip a set that fails to load */ }
  }
  state.pullsCards = out;
}
async function savePulls() {
  const finds = {}; for (const [r, c] of Object.entries(state.pullsFinds)) if (Number(c) > 0) finds[r] = Number(c);
  try { await api(`/orders/${state.pullsId}`, { method: "PUT", body: { finds, pull_cards: state.pullsTagged } }); toast("Pulls saved"); state.pullsOpen = false; renderPulls(); await reload(); }
  catch (err) { toast(err.message, true); }
}
function renderPulls() {
  const host = document.getElementById("pulls");
  if (!state.pullsOpen) { host.innerHTML = ""; return; }
  const o = state.orders.find((x) => x.id === state.pullsId); if (!o) { host.innerHTML = ""; return; }
  const packs = o.packs;
  const rates = state.settings.chase_pull_rates || {};
  const sets = orderSets(o);
  const secrets = []; const seen = new Set();
  sets.forEach((id) => secretRaritiesForSet(id).forEach((r) => { if (!seen.has(r)) { seen.add(r); secrets.push(r); } }));
  const list = secrets.length ? secrets : Object.keys(rates);
  const steps = list.map((r) => {
    const found = Number(state.pullsFinds[r]) || 0, p = Number(rates[r]) || 0, exp = p * packs, pn = binomAtLeast(packs, p, found + 1);
    return `<div class="sec-step${found > 0 ? ' has' : ''}">
      <div class="sec-tag">${rarityGlyph(r)} ${secretAbbr(r)}<span class="sec-odds">${packs > 0 && p > 0 ? `≈${exp.toFixed(exp < 1 ? 2 : 1)} expected · ${round(pn * 100)}% for ${found + 1}+` : (packs > 0 ? "no rate set" : "no packs in this order")}</span></div>
      <div class="sec-ctrl"><button class="sec-b" data-pact="dec" data-v="${esc(r)}"${found <= 0 ? " disabled" : ""}>−</button><span class="sec-n">${found}</span><button class="sec-b" data-pact="inc" data-v="${esc(r)}">+</button></div>
    </div>`;
  }).join("") || `<div style="font-size:13px;color:var(--muted);">No secret rarities known for this order's set(s).</div>`;

  let grid = "";
  if (state.pullsTagOpen) {
    if (!state.pullsCards) grid = `<div class="loading">Loading cards…</div>`;
    else if (!state.pullsCards.length) grid = `<div style="font-size:12px;color:var(--muted);margin-top:10px;">No secret-rarity card images for this set yet.</div>`;
    else {
      const taggedIds = new Set(state.pullsTagged.map((t) => t.card_id));
      grid = `<div class="tag-grid">${state.pullsCards.map((c) => `<button class="tagcard${taggedIds.has(c.id) ? ' on' : ''}" data-pact="pick" data-v="${esc(c.id)}"><img src="${esc(c.image)}" loading="lazy" alt="${esc(c.name)}"><span class="tnum">${esc(secretAbbr(c.rarity))} ${esc(c.number || '')}</span></button>`).join("")}</div>`;
    }
  }
  host.innerHTML = `<div class="scrim" data-pact="bg"><div class="sheet" data-pact="stop">
    <div class="sheet-head"><div><div class="disp" style="font-weight:700;font-size:18px;">Tag pulls</div><div style="font-size:12px;color:var(--muted);margin-top:1px;">${fmtDate(o.purchase_date)} · ${esc(o.note || o.store || "Order")} · ${packs} packs opened</div></div><button class="close" data-pact="close">✕</button></div>
    <div class="sheet-body">
      <div class="uplabel" style="margin-bottom:9px;">Secret cards pulled this order</div>
      <div class="sec-steps">${steps}</div>
      <button class="qchip" data-pact="tagtoggle" style="margin-top:14px;">🃏 Tag the exact cards you pulled${state.pullsTagged.length ? ` · ${state.pullsTagged.length} tagged` : ""}</button>
      ${grid}
      <div class="totbar"><div class="acts"><button class="save" data-pact="save">Save pulls</button><button class="cancel" data-pact="close">Cancel</button></div></div>
    </div>
  </div></div>`;
}

// ---- actions: binder / refresh / progress --------------------------------
function setBinder(b) { if (b !== "mine" && b !== "shared") return; state.binder = b; persistPrefs(); reload(); }
async function refreshMarket(id) {
  const set = setById(id); if (!set) return;
  const btn = document.querySelector('[data-act="refresh"]');
  if (btn) { btn.disabled = true; btn.textContent = "↻ Refreshing…"; }
  try { const r = await api(`/sets/${id}/pricing/refresh`, { method: "POST" }); toast(`Cheapest rip: ${money(r.pack_market_price)}/pack`); await reload(); }
  catch (err) { toast(err.message, true); if (btn) { btn.disabled = false; btn.textContent = "↻ Refresh market"; } }
}
async function hubRefresh(id) {
  try { const r = await api(`/sets/${id}/pricing/refresh`, { method: "POST" }); const s = setById(id); state.hubPrice[id] = round(Math.max(5, r.pack_market_price || 5)); toast(`Refreshed ${s ? s.name : "set"} — rip ${money(r.pack_market_price)}`); await reload(); }
  catch (err) { toast(err.message, true); }
}
const _actualTimer = {};
function saveActual(id, raw) {
  const v = String(raw).trim();
  const cards_collected = (v === "" || isNaN(Number(v))) ? null : Math.max(0, round(Number(v)));
  clearTimeout(_actualTimer[id]);
  _actualTimer[id] = setTimeout(async () => {
    try { await api(`/sets/${id}/progress?collection=${state.binder}`, { method: "PUT", body: { cards_collected } }); await reload(); }
    catch (err) { toast(err.message, true); }
  }, 500);
}

// ---- event wiring --------------------------------------------------------
document.getElementById("app").addEventListener("click", (e) => {
  const b = e.target.closest("[data-act]"); if (!b) return;
  const act = b.dataset.act, v = b.dataset.v;
  if (act === "binder") setBinder(v);
  else if (act === "set") selectSet(v);
  else if (act === "tab") setTab(v);
  else if (act === "step") stepPrice(Number(v));
  else if (act === "refresh") refreshMarket(state.setId);
  else if (act === "addorder") openComposer();
  else if (act === "addset") openSetsModal();
  else if (act === "settings") openSettings();
  else if (act === "pulls") openPulls(Number(v));
  else if (act === "gohub") goHub();
  else if (act === "opensetview") openSetView(v);
  else if (act === "hubinc") hubStep(v, 1);
  else if (act === "hubdec") hubStep(v, -1);
  else if (act === "hubaddorder") { state.setId = v; openComposer(); }
  else if (act === "hubrefresh") hubRefresh(v);
  else if (act === "editorder") editOrder(Number(v));
  else if (act === "delorder") requestDeleteOrder(Number(v));
});
document.getElementById("app").addEventListener("change", (e) => {
  const t = e.target; if (t.dataset.actual === undefined) return;
  saveActual(t.dataset.actual, t.value);
});

document.getElementById("composer").addEventListener("click", (e) => {
  const b = e.target.closest("[data-cact]"); if (!b) return;
  const act = b.dataset.cact, v = b.dataset.v;
  if (act === "bg" || act === "close") closeComposer();
  else if (act === "stop") e.stopPropagation();
  else if (act === "add") addLine(v);
  else if (act === "rm") removeLine(Number(v));
  else if (act === "dbinder") { state.draft.binder = v; renderComposer(); }
  else if (act === "circle") { state.draft.circle = !state.draft.circle; renderComposer(); }
  else if (act === "save") saveOrder();
});
document.getElementById("composer").addEventListener("input", (e) => {
  const t = e.target;
  if (t.dataset.df) { state.draft[t.dataset.df] = t.value; if (t.dataset.df === "store") renderComposer(); else recalc(); }
  else if (t.dataset.lf) {
    const row = t.closest("[data-line]"); const id = Number(row.dataset.line);
    const line = state.draft.lines.find((l) => l.id === id);
    if (line) { line[t.dataset.lf] = t.value; if (t.dataset.lf === "setId") renderLines(); recalc(); }
  }
});

document.getElementById("setsmodal").addEventListener("click", (e) => {
  const b = e.target.closest("[data-mact]"); if (!b) return;
  const act = b.dataset.mact, v = b.dataset.v;
  if (act === "bg" || act === "close") closeSetsModal();
  else if (act === "stop") e.stopPropagation();
  else if (act === "import") importSet(v);
  else if (act === "reimport") reimportSet(v);
  else if (act === "delset") removeSet(v);
});

document.getElementById("confirm").addEventListener("click", (e) => {
  const b = e.target.closest("[data-xact]"); if (!b) return;
  const a = b.dataset.xact;
  if (a === "bg" || a === "no") closeConfirm();
  else if (a === "stop") e.stopPropagation();
  else if (a === "yes") { const fn = state.confirm && state.confirm.onYes; closeConfirm(); if (fn) fn(); }
});

document.getElementById("settings").addEventListener("click", (e) => {
  const b = e.target.closest("[data-gact]"); if (!b) return;
  const a = b.dataset.gact;
  if (a === "bg" || a === "close") closeSettings(true);
  else if (a === "done") closeSettings(true);
  else if (a === "stop") e.stopPropagation();
  else if (a === "adv") toggleAdvanced();
  else if (a === "toggleshared") { state.showShared = !state.showShared; if (!state.showShared && state.binder !== "mine") { state.binder = "mine"; reload(); } persistPrefs(); renderSettings(); render(); }
});

document.getElementById("pulls").addEventListener("click", (e) => {
  const b = e.target.closest("[data-pact]"); if (!b) return;
  const a = b.dataset.pact, v = b.dataset.v;
  if (a === "bg" || a === "close") closePulls();
  else if (a === "stop") e.stopPropagation();
  else if (a === "inc") pullsStep(v, 1);
  else if (a === "dec") pullsStep(v, -1);
  else if (a === "tagtoggle") pullsTagToggle();
  else if (a === "pick") pullsTagPick(v);
  else if (a === "save") savePulls();
});

let rzt; window.addEventListener("resize", () => { clearTimeout(rzt); rzt = setTimeout(() => { if (state.view === "set") render(); }, 150); });

// ---- go ------------------------------------------------------------------
(async function init() {
  render();   // loading
  try {
    await loadSettings();
    await loadHub();
  } catch (err) {
    state.loading = false;
    document.getElementById("app").innerHTML = headerHTML() + `<div class="loading">Couldn't reach the API: ${esc(err.message)}</div>`;
    return;
  }
  state.loading = false;
  state.view = "hub";   // hub-first on every load
  render();
})();
