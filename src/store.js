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
      `INSERT INTO sets (id, name, series, printed_total, total, release_date, logo_url, symbol_url, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, series=excluded.series, printed_total=excluded.printed_total,
         total=excluded.total, release_date=excluded.release_date,
         logo_url=excluded.logo_url, symbol_url=excluded.symbol_url, fetched_at=excluded.fetched_at`
    ).bind(set.id, set.name, set.series, set.printed_total, set.total, set.release_date, set.logo_url ?? null, set.symbol_url ?? null, set.fetched_at),
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

// Loose-pack deal pricing (set-level). Null/blank fields are left unchanged.
export async function setSetPricing(db, setId, { market_price, ceiling, msrp, note }) {
  const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
  await db
    .prepare(`UPDATE sets SET
        pack_market_price  = COALESCE(?, pack_market_price),
        pack_price_ceiling = COALESCE(?, pack_price_ceiling),
        pack_msrp          = COALESCE(?, pack_msrp),
        pack_price_note    = COALESCE(?, pack_price_note),
        pack_price_updated = ?
      WHERE id = ?`)
    .bind(num(market_price), num(ceiling), num(msrp), note ?? null, new Date().toISOString(), setId)
    .run();
  return getCachedSet(db, setId);
}

// ---- orders --------------------------------------------------------------
function computeOrder(order, items) {
  const subtotal = items.reduce((a, i) => a + i.quantity * i.unit_price, 0);
  const discountRate = order.discount_rate || 0;
  const discount = subtotal * discountRate;       // e.g. Target Circle Card 5%
  const taxable = subtotal - discount;            // tax is applied AFTER the discount
  const tax = taxable * order.tax_rate;
  return {
    ...order,
    items,
    subtotal: round2(subtotal),
    discount: round2(discount),
    tax: round2(tax),
    total: round2(taxable + tax),
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
  const { results: finds } = await db
    .prepare("SELECT rarity, count FROM order_finds WHERE order_id = ?")
    .bind(id)
    .all();
  const co = computeOrder(order, results);
  co.finds = Object.fromEntries(finds.map((f) => [f.rarity, f.count]));
  return co;
}

export async function listOrders(db, setId, collection) {
  const where = [];
  const args = [];
  if (setId) { where.push("set_id = ?"); args.push(setId); }
  if (collection) { where.push("collection = ?"); args.push(collection); }
  const sql = `SELECT * FROM orders ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY purchase_date DESC, id DESC`;
  const orders = (await db.prepare(sql).bind(...args).all()).results;
  if (orders.length === 0) return [];
  const ids = orders.map((o) => o.id);
  const placeholders = ids.map(() => "?").join(",");
  const { results: items } = await db
    .prepare(`SELECT * FROM order_items WHERE order_id IN (${placeholders}) ORDER BY id`)
    .bind(...ids)
    .all();
  const { results: finds } = await db
    .prepare(`SELECT * FROM order_finds WHERE order_id IN (${placeholders})`)
    .bind(...ids)
    .all();
  const byOrder = {};
  for (const it of items) (byOrder[it.order_id] ||= []).push(it);
  const findsByOrder = {};
  for (const f of finds) (findsByOrder[f.order_id] ||= {})[f.rarity] = f.count;
  return orders.map((o) => {
    const co = computeOrder(o, byOrder[o.id] || []);
    co.finds = findsByOrder[o.id] || {};
    return co;
  });
}

export async function createOrder(db, { set_id, purchase_date, tax_rate = 0, note = "", items, finds, collection = "mine", store = null, discount_rate = 0 }) {
  const res = await db
    .prepare("INSERT INTO orders (set_id, purchase_date, tax_rate, note, collection, store, discount_rate) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(set_id, purchase_date, Number(tax_rate), note, collection === "shared" ? "shared" : "mine", store || null, Number(discount_rate) || 0)
    .run();
  const orderId = res.meta.last_row_id;
  await insertItems(db, orderId, items);
  await insertFinds(db, orderId, finds);
  return getOrder(db, orderId);
}

export async function updateOrder(db, id, { purchase_date, tax_rate, note, items, finds, collection, store, discount_rate }) {
  await db
    .prepare("UPDATE orders SET purchase_date = COALESCE(?, purchase_date), tax_rate = COALESCE(?, tax_rate), note = COALESCE(?, note), collection = COALESCE(?, collection), store = COALESCE(?, store), discount_rate = COALESCE(?, discount_rate) WHERE id = ?")
    .bind(
      purchase_date ?? null,
      tax_rate !== undefined ? Number(tax_rate) : null,
      note ?? null,
      collection === "mine" || collection === "shared" ? collection : null,
      store !== undefined ? store : null,
      discount_rate !== undefined ? Number(discount_rate) : null,
      id
    )
    .run();
  if (items !== undefined) {
    await db.prepare("DELETE FROM order_items WHERE order_id = ?").bind(id).run();
    await insertItems(db, id, items);
  }
  if (finds !== undefined) {
    await db.prepare("DELETE FROM order_finds WHERE order_id = ?").bind(id).run();
    await insertFinds(db, id, finds);
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

async function insertFinds(db, orderId, finds) {
  const entries = Object.entries(finds || {}).filter(([, c]) => Number(c) > 0);
  if (!entries.length) return;
  const stmts = entries.map(([rarity, count]) =>
    db.prepare("INSERT INTO order_finds (order_id, rarity, count) VALUES (?, ?, ?)").bind(orderId, rarity, Number(count))
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

// ---- per (set, collection) progress (user-entered actuals) ---------------
export async function getProgress(db, setId, collection = "mine") {
  const row = await db
    .prepare("SELECT packs_opened, cards_collected FROM progress WHERE set_id = ? AND collection = ?")
    .bind(setId, collection)
    .first();
  return {
    packs_opened: row && row.packs_opened != null ? row.packs_opened : null,
    cards_collected: row && row.cards_collected != null ? row.cards_collected : null,
  };
}

export async function setProgress(db, setId, collection, { packs_opened, cards_collected }) {
  const po = packs_opened === null || packs_opened === undefined ? null : Math.max(0, Math.round(Number(packs_opened)));
  const cc = cards_collected === null || cards_collected === undefined ? null : Math.max(0, Math.round(Number(cards_collected)));
  await db
    .prepare(`INSERT INTO progress (set_id, collection, packs_opened, cards_collected)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(set_id, collection) DO UPDATE SET
                packs_opened = excluded.packs_opened, cards_collected = excluded.cards_collected`)
    .bind(setId, collection || "mine", po, cc)
    .run();
  return getProgress(db, setId, collection || "mine");
}

// ---- aggregate totals for a set -----------------------------------------
export async function setTotals(db, setId, collection) {
  const orders = await listOrders(db, setId, collection);
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
      // distribute the order's discount + tax proportionally across its line items
      b.spend += it.quantity * it.unit_price * (1 - (o.discount_rate || 0)) * (1 + o.tax_rate);
    }
  }
  for (const b of Object.values(breakdown)) b.spend = round2(b.spend);
  return { totalSpent: round2(totalSpent), totalPacks, orderCount: orders.length, breakdown };
}
