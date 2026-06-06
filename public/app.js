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
  editingOrderId: null,
};

// ---- init ----------------------------------------------------------------
async function init() {
  setupTabs();
  setupModal();
  setupOrderForm();
  setupSettingsForm();
  await loadSettings();
  await loadTrackedSets();
  $("#setSelect").addEventListener("change", (e) => selectSet(e.target.value));
  if (state.currentSetId) {
    $("#setSelect").value = state.currentSetId;
  }
  refreshActiveSet();
}

function setupTabs() {
  $$("nav#tabs button").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$("nav#tabs button").forEach((b) => b.classList.remove("active"));
      $$(".tab").forEach((t) => t.classList.remove("active"));
      btn.classList.add("active");
      $("#" + btn.dataset.tab).classList.add("active");
    });
  });
}

// ---- sets ----------------------------------------------------------------
async function loadTrackedSets() {
  state.trackedSets = await api("/sets");
  const sel = $("#setSelect");
  const current = sel.value;
  sel.innerHTML = '<option value="">— none —</option>' +
    state.trackedSets
      .map((s) => `<option value="${s.id}">${s.name} (${s.printed_total} cards)</option>`)
      .join("");
  sel.value = state.currentSetId || current || "";
}

function selectSet(id) {
  state.currentSetId = id;
  localStorage.setItem("currentSetId", id);
  refreshActiveSet();
}

function refreshActiveSet() {
  const has = !!state.currentSetId;
  $("#dashEmpty").classList.toggle("hidden", has);
  $("#dashContent").classList.toggle("hidden", !has);
  $("#ordersEmpty").classList.toggle("hidden", has);
  $("#ordersContent").classList.toggle("hidden", !has);
  if (has) {
    loadDashboard();
    loadOrders();
  }
}

// ---- import set modal ----------------------------------------------------
function setupModal() {
  $("#manageSetsBtn").addEventListener("click", () => $("#setModal").classList.remove("hidden"));
  $("#closeModal").addEventListener("click", () => $("#setModal").classList.add("hidden"));
  $("#setSearchBtn").addEventListener("click", runSetSearch);
  $("#setSearch").addEventListener("keydown", (e) => { if (e.key === "Enter") runSetSearch(); });
}

async function runSetSearch() {
  const q = $("#setSearch").value.trim();
  const box = $("#setResults");
  box.innerHTML = '<div class="muted">Searching…</div>';
  try {
    const sets = await api("/sets/search?q=" + encodeURIComponent(q));
    if (!sets.length) { box.innerHTML = '<div class="muted">No sets found.</div>'; return; }
    box.innerHTML = sets.map((s) => `
      <div class="result-row">
        <div>
          <div><b>${s.name}</b></div>
          <div class="meta">${s.series || ""} · base set ${s.printedTotal} · released ${s.releaseDate || "?"}</div>
        </div>
        <button data-import="${s.id}">Import</button>
      </div>`).join("");
    box.querySelectorAll("[data-import]").forEach((btn) => {
      btn.addEventListener("click", () => importSet(btn.dataset.import, btn));
    });
  } catch (err) {
    box.innerHTML = `<div class="muted">Error: ${err.message}</div>`;
  }
}

async function importSet(id, btn) {
  btn.disabled = true; btn.textContent = "Importing…";
  try {
    const set = await api(`/sets/${id}/import`, { method: "POST" });
    toast(`Imported ${set.name}`);
    await loadTrackedSets();
    $("#setSelect").value = id;
    selectSet(id);
    $("#setModal").classList.add("hidden");
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false; btn.textContent = "Import";
  }
}

// ---- dashboard -----------------------------------------------------------
async function loadDashboard() {
  try {
    const s = await api(`/sets/${state.currentSetId}/summary`);
    $("#statSpent").textContent = money(s.totalSpent);
    $("#statPacks").textContent = s.totalPacks;
    $("#statOrders").textContent = s.orderCount;
    $("#statBaseSet").textContent = s.set.printed_total;

    const c = s.completion;
    if (c) {
      $("#estRemaining").textContent = c.packsRemaining;
      $("#estTotal").textContent = c.expectedTotalPacks;
      $("#estP50").textContent = c.p50;
      $("#estP90").textContent = c.p90;
      const opened = c.opened || 0;
      const more = (threshold) => (threshold == null ? null : Math.max(0, threshold - opened));
      const setDR = (moreEl, atEl, threshold) => {
        const m = more(threshold);
        if (m == null) { $(moreEl).textContent = "—"; $(atEl).textContent = ""; return; }
        $(moreEl).textContent = m;
        $(atEl).textContent = m === 0
          ? `(already past it — reached around pack ${threshold})`
          : `(at ~${threshold} packs total; you've opened ${opened})`;
      };
      setDR("#estDRmild", "#estDRmildAt", c.diminishingReturnsPacks);
      setDR("#estDRsteep", "#estDRsteepAt", c.diminishingReturnsPacksSteep);
      const ms = c.setMilestones || {};
      const fmt = (v) => (v == null ? "—" : v);
      $("#estPct50").textContent = fmt(ms.pct50);
      $("#estPct90").textContent = fmt(ms.pct90);
      $("#estPct95").textContent = fmt(ms.pct95);
      const pct = Math.min(100, c.expectedPctAtOpened);
      $("#estProgressFill").style.width = pct + "%";
      $("#estProgressText").textContent =
        `Estimated ~${c.expectedCollectedAtOpened} of ${c.baseSetSize} base-set cards collected (${c.expectedPctAtOpened}%) after ${c.opened} packs.`;
    } else {
      $("#estRemaining").textContent = "–";
      $("#estProgressText").textContent = "No rarity data for this set.";
    }

    renderChase(s.chase);

    const tbody = $("#breakdownTable tbody");
    const entries = Object.entries(s.breakdown);
    tbody.innerHTML = entries.length
      ? entries.map(([p, b]) => `<tr><td data-label="Product">${p}</td><td data-label="Qty">${b.quantity}</td><td data-label="Packs">${b.packs}</td><td data-label="Spend">${money(b.spend)}</td></tr>`).join("")
      : '<tr><td colspan="4" class="muted">No purchases yet.</td></tr>';

    $("#rarityList").innerHTML = (s.set.rarities || [])
      .map((r) => `<span class="chip">${raritySymbol(r.rarity)} ${r.rarity} <b>${r.count}</b></span>`)
      .join("") || '<span class="muted">—</span>';
  } catch (err) {
    toast(err.message, true);
  }
}

function renderChase(chase) {
  const tbody = $("#chaseTable tbody");
  if (!chase || !chase.items || !chase.items.length) {
    $("#chaseAny").textContent = "–";
    tbody.innerHTML = '<tr><td colspan="4" class="muted">No chase pull rates configured.</td></tr>';
    return;
  }
  $("#chaseAny").textContent = chase.anyAvgPacks ?? "–";
  tbody.innerHTML = chase.items.map((it) => {
    const odds = it.perPackProb > 0 ? `~1 in ${Math.round(1 / it.perPackProb)}` : "—";
    return `<tr style="${it.present ? "" : "opacity:.5"}">
      <td data-label="Chase rarity">${raritySymbol(it.rarity)} ${it.abbr} · ${it.rarity}</td>
      <td data-label="Per-pack odds">${odds}</td>
      <td data-label="Avg packs to first"><b>${it.avgPacks}</b></td>
      <td data-label="In this set?">${it.present ? "✓" : "not in set"}</td>
    </tr>`;
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
  const taxRate = Number($("#orderTax").value || 0) / 100;
  $("#formSubtotal").textContent = money(subtotal);
  $("#formTax").textContent = money(subtotal * taxRate);
  $("#formTotal").textContent = money(subtotal * (1 + taxRate));
  $("#formPacks").textContent = packs;
}

function setupOrderForm() {
  $("#addLineBtn").addEventListener("click", () => addLineRow());
  $("#orderTax").addEventListener("input", recalcForm);
  $("#orderCancel").addEventListener("click", resetOrderForm);
  $("#orderForm").addEventListener("submit", submitOrder);
}

function resetOrderForm() {
  state.editingOrderId = null;
  $("#lineItems").innerHTML = "";
  $("#orderNote").value = "";
  $("#orderDate").value = new Date().toISOString().slice(0, 10);
  $("#orderTax").value = state.settings.sales_tax_rate ?? 0;
  $("#orderSubmit").textContent = "Save order";
  $("#orderCancel").classList.add("hidden");
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
    items,
  };
  try {
    if (state.editingOrderId) {
      await api(`/orders/${state.editingOrderId}`, { method: "PUT", body: payload });
      toast("Order updated");
    } else {
      await api("/orders", { method: "POST", body: payload });
      toast("Order saved");
    }
    resetOrderForm();
    loadOrders();
    loadDashboard();
  } catch (err) {
    toast(err.message, true);
  }
}

async function loadOrders() {
  const list = $("#ordersList");
  try {
    const orders = await api("/orders?set=" + encodeURIComponent(state.currentSetId));
    if (!orders.length) { list.innerHTML = '<div class="muted">No orders yet.</div>'; return; }
    list.innerHTML = orders.map((o) => `
      <div class="order-card">
        <div class="order-head">
          <div>
            <span class="order-date">${o.purchase_date}</span>
            ${o.note ? `<span class="order-meta"> · ${o.note}</span>` : ""}
            <div class="order-meta">${o.packs} packs · subtotal ${money(o.subtotal)} · tax ${money(o.tax)} · <b>${money(o.total)}</b></div>
          </div>
          <div class="order-actions">
            <button class="link" data-edit="${o.id}">Edit</button>
            <button class="link" data-del="${o.id}" style="color:var(--danger)">Delete</button>
          </div>
        </div>
        <ul>${o.items.map((i) => `<li>${i.quantity}× ${i.product_type} @ ${money(i.unit_price)} (${i.packs_per_unit} packs ea.)</li>`).join("")}</ul>
      </div>`).join("");
    list.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => editOrder(orders.find((o) => o.id == b.dataset.edit))));
    list.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => deleteOrder(b.dataset.del)));
  } catch (err) {
    toast(err.message, true);
  }
}

function editOrder(order) {
  state.editingOrderId = order.id;
  $("#orderDate").value = order.purchase_date;
  $("#orderTax").value = (order.tax_rate * 100).toFixed(3).replace(/\.?0+$/, "");
  $("#orderNote").value = order.note || "";
  $("#lineItems").innerHTML = "";
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
  $("#setRuns").value = s.monte_carlo_runs ?? 3000;
  const tbody = $("#packsPerProduct tbody");
  tbody.innerHTML = Object.entries(s.packs_per_product || {})
    .map(([p, n]) => `<tr><td>${p}</td><td><input type="number" min="0" data-product="${p}" value="${n}" /></td></tr>`)
    .join("");
  const chaseBody = $("#chaseRates tbody");
  chaseBody.innerHTML = Object.entries(s.chase_pull_rates || {})
    .map(([r, p]) => chaseRateRow(r, p))
    .join("");
  $("#setPackModel").value = JSON.stringify(s.pack_model, null, 2);
}

function chaseRateRow(rarity = "", prob = "") {
  return `<tr>
    <td><input type="text" class="cr-rarity" value="${rarity}" placeholder="Illustration Rare" /></td>
    <td><input type="number" class="cr-prob" step="0.0001" min="0" value="${prob}" placeholder="0.111" /></td>
    <td><button type="button" class="ghost cr-remove">✕</button></td>
  </tr>`;
}

function setupSettingsForm() {
  $("#settingsForm").addEventListener("submit", saveSettings);
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
  $$("#packsPerProduct input[data-product]").forEach((i) => {
    packsPerProduct[i.dataset.product] = Number(i.value);
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
