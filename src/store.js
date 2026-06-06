// D1-backed data access for settings, sets, and orders.

const JSON_KEYS = ["packs_per_product", "pack_model", "chase_pull_rates"];

export const DEFAULT_SETTINGS = {
  sales_tax_rate: "6.0",
  pokemontcg_api_key: "",
  monte_carlo_runs: "3000",
  packs_per_product: '{"Booster Pack":1,"Booster Bundle":6,"Elite Trainer Box":9,"Mini Tin":2,"Regular Tin":3}',
  pack_model: '{"slots":[{"name":"Common","count":4,"pool":["Common"]},{"name":"Uncommon","count":3,"pool":["Uncommon"]},{"name":"Reverse Holo","count":2,"pool":["Common","Uncommon","Rare"]},{"name":"Hit","count":1,"weights":{"Rare":0.7,"Double Rare":0.18,"Ultra Rare":0.06,"Illustration Rare":0.06}}]}',
  chase_pull_rates: '{"Illustration Rare":0.111,"Ultra Rare":0.05,"Special Illustration Rare":0.0139,"Mega Hyper Rare":0.000794}',
};

export function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// ---- settings ------------------------------------------------------------
export async function getRawSettings(db) {
  const { results } = await db.prepare("SELECT key, value FROM settings").all();
  const raw = { ...DEFAULT_SETTINGS };
  for (const r of results) raw[r.key] = r.value;
  return raw;
}

export function shapeSettings(raw) {
  const out = { ...raw };
  for (const k of JSON_KEYS) {
    if (typeof out[k] === "string") {
      try { out[k] = JSON.parse(out[k]); } catch { /* leave as-is */ }
    }
  }
  if (out.sales_tax_rate !== undefined) out.sales_tax_rate = Number(out.sales_tax_rate);
  if (out.monte_carlo_runs !== undefined) out.monte_carlo_runs = Number(out.monte_carlo_runs);
  return out;
}

export async function getSettings(db) {
  return shapeSettings(await getRawSettings(db));
}

export async function updateSettings(db, body) {
  const stmts = [];
  for (const [key, value] of Object.entries(body)) {
    const v = JSON_KEYS.includes(key) && typeof value !== "string"
      ? JSON.stringify(value)
      : String(value);
    stmts.push(
      db.prepare(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).bind(key, v)
    );
  }
  if (stmts.length) await db.batch(stmts);
  return getSettings(db);
}

// ---- sets ----------------------------------------------------------------
export async function listSets(db) {
  const { results } = await db
    .prepare("SELECT * FROM sets ORDER BY release_date DESC")
    .all();
  return results;
}

export async function getCachedSet(db, id) {
  const set = await db.prepare("SELECT * FROM sets WHERE id = ?").bind(id).first();
  if (!set) return null;
  const { results } = await db
    .prepare("SELECT rarity, count FROM set_rarities WHERE set_id = ? ORDER BY count DESC")
    .bind(id)
    .all();
  const { results: all } = await db
    .prepare("SELECT rarity, count FROM set_all_rarities WHERE set_id = ? ORDER BY count DESC")
    .bind(id)
    .all();
  return { ...set, rarities: results, allRarities: all };
}

export async function saveSet(db, set, rarityCounts, allRarityCounts = {}) {
  const stmts = [
    db.prepare(
      `INSERT INTO sets (id, name, series, printed_total, total, release_date, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, series=excluded.series, printed_total=excluded.printed_total,
         total=excluded.total, release_date=excluded.release_date, fetched_at=excluded.fetched_at`
    ).bind(set.id, set.name, set.series, set.printed_total, set.total, set.release_date, set.fetched_at),
    db.prepare("DELETE FROM set_rarities WHERE set_id = ?").bind(set.id),
    db.prepare("DELETE FROM set_all_rarities WHERE set_id = ?").bind(set.id),
  ];
  for (const [rarity, count] of Object.entries(rarityCounts)) {
    stmts.push(
      db.prepare("INSERT INTO set_rarities (set_id, rarity, count) VALUES (?, ?, ?)").bind(set.id, rarity, count)
    );
  }
  for (const [rarity, count] of Object.entries(allRarityCounts)) {
    stmts.push(
      db.prepare("INSERT INTO set_all_rarities (set_id, rarity, count) VALUES (?, ?, ?)").bind(set.id, rarity, count)
    );
  }
  await db.batch(stmts);
}

// ---- orders --------------------------------------------------------------
function computeOrder(order, items) {
  const subtotal = items.reduce((a, i) => a + i.quantity * i.unit_price, 0);
  return {
    ...order,
    items,
    subtotal: round2(subtotal),
    tax: round2(subtotal * order.tax_rate),
    total: round2(subtotal + subtotal * order.tax_rate),
    packs: items.reduce((a, i) => a + i.quantity * i.packs_per_unit, 0),
  };
}

export async function getOrder(db, id) {
  const order = await db.prepare("SELECT * FROM orders WHERE id = ?").bind(id).first();
  if (!order) return null;
  const { results } = await db
    .prepare("SELECT * FROM order_items WHERE order_id = ? ORDER BY id")
    .bind(id)
    .all();
  return computeOrder(order, results);
}

export async function listOrders(db, setId) {
  const orders = setId
    ? (await db.prepare("SELECT * FROM orders WHERE set_id = ? ORDER BY purchase_date DESC, id DESC").bind(setId).all()).results
    : (await db.prepare("SELECT * FROM orders ORDER BY purchase_date DESC, id DESC").all()).results;
  if (orders.length === 0) return [];
  const ids = orders.map((o) => o.id);
  const placeholders = ids.map(() => "?").join(",");
  const { results: items } = await db
    .prepare(`SELECT * FROM order_items WHERE order_id IN (${placeholders}) ORDER BY id`)
    .bind(...ids)
    .all();
  const byOrder = {};
  for (const it of items) (byOrder[it.order_id] ||= []).push(it);
  return orders.map((o) => computeOrder(o, byOrder[o.id] || []));
}

export async function createOrder(db, { set_id, purchase_date, tax_rate = 0, note = "", items }) {
  const res = await db
    .prepare("INSERT INTO orders (set_id, purchase_date, tax_rate, note) VALUES (?, ?, ?, ?)")
    .bind(set_id, purchase_date, Number(tax_rate), note)
    .run();
  const orderId = res.meta.last_row_id;
  await insertItems(db, orderId, items);
  return getOrder(db, orderId);
}

export async function updateOrder(db, id, { purchase_date, tax_rate, note, items }) {
  await db
    .prepare("UPDATE orders SET purchase_date = COALESCE(?, purchase_date), tax_rate = COALESCE(?, tax_rate), note = COALESCE(?, note) WHERE id = ?")
    .bind(
      purchase_date ?? null,
      tax_rate !== undefined ? Number(tax_rate) : null,
      note ?? null,
      id
    )
    .run();
  if (items !== undefined) {
    await db.prepare("DELETE FROM order_items WHERE order_id = ?").bind(id).run();
    await insertItems(db, id, items);
  }
  return getOrder(db, id);
}

async function insertItems(db, orderId, items) {
  if (!items || !items.length) return;
  const stmts = items.map((it) =>
    db.prepare(
      "INSERT INTO order_items (order_id, product_type, quantity, unit_price, packs_per_unit) VALUES (?, ?, ?, ?, ?)"
    ).bind(orderId, it.product_type, Number(it.quantity), Number(it.unit_price), Number(it.packs_per_unit))
  );
  await db.batch(stmts);
}

export async function deleteOrder(db, id) {
  const res = await db.prepare("DELETE FROM orders WHERE id = ?").bind(id).run();
  return res.meta.changes > 0;
}

export async function orderExists(db, id) {
  return !!(await db.prepare("SELECT 1 FROM orders WHERE id = ?").bind(id).first());
}

export async function setExists(db, id) {
  return !!(await db.prepare("SELECT 1 FROM sets WHERE id = ?").bind(id).first());
}

// ---- aggregate totals for a set -----------------------------------------
export async function setTotals(db, setId) {
  const orders = await listOrders(db, setId);
  const breakdown = {};
  let totalSpent = 0;
  let totalPacks = 0;
  for (const o of orders) {
    totalSpent += o.total;
    totalPacks += o.packs;
    for (const it of o.items) {
      const b = (breakdown[it.product_type] ||= { quantity: 0, packs: 0, spend: 0 });
      b.quantity += it.quantity;
      b.packs += it.quantity * it.packs_per_unit;
      b.spend += it.quantity * it.unit_price * (1 + o.tax_rate);
    }
  }
  for (const b of Object.values(breakdown)) b.spend = round2(b.spend);
  return { totalSpent: round2(totalSpent), totalPacks, orderCount: orders.length, breakdown };
}
