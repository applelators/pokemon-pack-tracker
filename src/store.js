// D1-backed data access for settings, sets, and orders.

const JSON_KEYS = ["packs_per_product", "pack_model", "chase_pull_rates"];

export const DEFAULT_SETTINGS = {
  sales_tax_rate: "6.0",
  pokemontcg_api_key: "",
  pricecharting_api_key: "",
  ebay_client_id: "",
  ebay_client_secret: "",
  monte_carlo_runs: "3000",
  packs_per_product: '{"Booster Pack":1,"Sleeved Booster":1,"Booster Bundle":6,"Elite Trainer Box":9,"Mini Tin":2,"Regular Tin":3}',
  pack_model: '{"slots":[{"name":"Common","count":4,"pool":["Common"]},{"name":"Uncommon","count":3,"pool":["Uncommon"]},{"name":"Reverse Holo","count":2,"pool":["Common","Uncommon","Rare"]},{"name":"Hit","count":1,"weights":{"Rare":0.66,"Double Rare":0.18,"Ultra Rare":0.06,"Illustration Rare":0.05,"ACE SPEC Rare":0.05}}]}',
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
    .prepare("SELECT rarity, count, avg_price FROM set_all_rarities WHERE set_id = ? ORDER BY count DESC")
    .bind(id)
    .all();
  let art = null;
  if (set.art_json) { try { art = JSON.parse(set.art_json); } catch { art = null; } }
  return { ...set, rarities: results, allRarities: all, art };
}

export async function saveSet(db, set, rarityCounts, allRarityCounts = {}, allRarityPrices = {}, artJson = null) {
  const stmts = [
    db.prepare(
      `INSERT INTO sets (id, name, series, printed_total, total, release_date, logo_url, symbol_url, fetched_at, art_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, series=excluded.series, printed_total=excluded.printed_total,
         total=excluded.total, release_date=excluded.release_date,
         logo_url=excluded.logo_url, symbol_url=excluded.symbol_url, fetched_at=excluded.fetched_at,
         art_json=COALESCE(excluded.art_json, sets.art_json)`
    ).bind(set.id, set.name, set.series, set.printed_total, set.total, set.release_date, set.logo_url ?? null, set.symbol_url ?? null, set.fetched_at, artJson),
    db.prepare("DELETE FROM set_rarities WHERE set_id = ?").bind(set.id),
    db.prepare("DELETE FROM set_all_rarities WHERE set_id = ?").bind(set.id),
  ];
  for (const [rarity, count] of Object.entries(rarityCounts)) {
    stmts.push(
      db.prepare("INSERT INTO set_rarities (set_id, rarity, count) VALUES (?, ?, ?)").bind(set.id, rarity, count)
    );
  }
  for (const [rarity, count] of Object.entries(allRarityCounts)) {
    const avg = allRarityPrices[rarity] != null ? allRarityPrices[rarity] : null;
    stmts.push(
      db.prepare("INSERT INTO set_all_rarities (set_id, rarity, count, avg_price) VALUES (?, ?, ?, ?)").bind(set.id, rarity, count, avg)
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

// ---- cached completion curve (heavy Monte-Carlo result) ------------------
export async function getEstimateCache(db, setId, signature) {
  const row = await db.prepare("SELECT data FROM estimate_cache WHERE set_id = ? AND signature = ?").bind(setId, signature).first();
  if (!row) return null;
  try { return JSON.parse(row.data); } catch { return null; }
}

export async function saveEstimateCache(db, setId, signature, data) {
  await db
    .prepare(`INSERT INTO estimate_cache (set_id, signature, data, updated) VALUES (?, ?, ?, ?)
              ON CONFLICT(set_id) DO UPDATE SET signature=excluded.signature, data=excluded.data, updated=excluded.updated`)
    .bind(setId, signature, JSON.stringify(data), new Date().toISOString())
    .run();
}

// ---- orders --------------------------------------------------------------
function computeOrder(order, rawItems) {
  // Parse each item's mixed-set allocation (JSON string → array) once.
  const items = rawItems.map((i) => ({ ...i, set_packs: itemAlloc(i) }));
  const subtotal = items.reduce((a, i) => a + i.quantity * i.unit_price, 0);
  const discountRate = order.discount_rate || 0;
  const discount = subtotal * discountRate;       // e.g. Target Circle Card 5%
  const taxable = subtotal - discount;            // tax is applied AFTER the discount
  const tax = taxable * order.tax_rate;
  // An order's "sets" = the distinct expansions across its lines (incl. allocations).
  const sets = [...new Set(items.flatMap((i) => i.set_packs ? i.set_packs.map((a) => a.set_id) : [i.set_id]).filter(Boolean))];
  return {
    ...order,
    items,
    sets,
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
  const { results: pulls } = await db
    .prepare("SELECT card_id, name, image_small FROM order_pull_cards WHERE order_id = ?")
    .bind(id)
    .all();
  const { results: promos } = await db
    .prepare("SELECT name, image_small, card_id FROM order_promos WHERE order_id = ?")
    .bind(id)
    .all();
  const co = computeOrder(order, results);
  co.finds = Object.fromEntries(finds.map((f) => [f.rarity, f.count]));
  co.pullCards = pulls;
  co.promos = promos;
  return co;
}

export async function listOrders(db, setId, collection) {
  const where = [];
  const args = [];
  // setId now filters by line item (multi-set orders): keep any order that has at
  // least one line from this expansion. The order still carries ALL its lines.
  if (setId) { where.push("id IN (SELECT order_id FROM order_items WHERE set_id = ?)"); args.push(setId); }
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
  const { results: pulls } = await db
    .prepare(`SELECT * FROM order_pull_cards WHERE order_id IN (${placeholders})`)
    .bind(...ids)
    .all();
  const { results: promos } = await db
    .prepare(`SELECT * FROM order_promos WHERE order_id IN (${placeholders})`)
    .bind(...ids)
    .all();
  const byOrder = {};
  for (const it of items) (byOrder[it.order_id] ||= []).push(it);
  const findsByOrder = {};
  for (const f of finds) (findsByOrder[f.order_id] ||= {})[f.rarity] = f.count;
  const pullsByOrder = {};
  for (const p of pulls) (pullsByOrder[p.order_id] ||= []).push({ card_id: p.card_id, name: p.name, image_small: p.image_small });
  const promosByOrder = {};
  for (const p of promos) (promosByOrder[p.order_id] ||= []).push({ name: p.name, image_small: p.image_small, card_id: p.card_id });
  return orders.map((o) => {
    const co = computeOrder(o, byOrder[o.id] || []);
    co.finds = findsByOrder[o.id] || {};
    co.pullCards = pullsByOrder[o.id] || [];
    co.promos = promosByOrder[o.id] || [];
    return co;
  });
}

export async function createOrder(db, { set_id, purchase_date, tax_rate = 0, note = "", items, finds, collection = "mine", store = null, discount_rate = 0, pull_cards, promos }) {
  // orders.set_id is legacy/NOT NULL (never read — reads derive sets from the lines).
  // Satisfy it from any real set on the order: explicit, a line's set, a line's
  // allocation, else any imported set (setless "all-Other" orders would otherwise
  // violate the NOT NULL constraint).
  let legacySet = set_id || null;
  if (!legacySet && items) {
    for (const it of items) {
      if (it.set_id) { legacySet = it.set_id; break; }
      if (Array.isArray(it.set_packs)) { const a = it.set_packs.find((x) => x.set_id); if (a) { legacySet = a.set_id; break; } }
    }
  }
  if (!legacySet) { const any = await db.prepare("SELECT id FROM sets LIMIT 1").first(); legacySet = any ? any.id : null; }
  const res = await db
    .prepare("INSERT INTO orders (set_id, purchase_date, tax_rate, note, collection, store, discount_rate) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(legacySet, purchase_date, Number(tax_rate), note, collection === "shared" ? "shared" : "mine", store || null, Number(discount_rate) || 0)
    .run();
  const orderId = res.meta.last_row_id;
  await insertItems(db, orderId, items);
  await insertFinds(db, orderId, finds);
  await insertPullCards(db, orderId, pull_cards);
  await insertPromos(db, orderId, promos);
  return getOrder(db, orderId);
}

export async function updateOrder(db, id, { purchase_date, tax_rate, note, items, finds, collection, store, discount_rate, pull_cards, promos }) {
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
  if (pull_cards !== undefined) {
    await db.prepare("DELETE FROM order_pull_cards WHERE order_id = ?").bind(id).run();
    await insertPullCards(db, id, pull_cards);
  }
  if (promos !== undefined) {
    await db.prepare("DELETE FROM order_promos WHERE order_id = ?").bind(id).run();
    await insertPromos(db, id, promos);
  }
  return getOrder(db, id);
}

async function insertItems(db, orderId, items) {
  if (!items || !items.length) return;
  const stmts = items.map((it) => {
    const alloc = Array.isArray(it.set_packs) && it.set_packs.length
      ? it.set_packs.filter((a) => Number(a.packs) > 0).map((a) => ({ set_id: a.set_id || null, packs: Number(a.packs) }))
      : null;
    return db.prepare(
      "INSERT INTO order_items (order_id, set_id, product_type, quantity, unit_price, packs_per_unit, set_packs) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(orderId, it.set_id || null, it.product_type, Number(it.quantity), Number(it.unit_price), Number(it.packs_per_unit), alloc ? JSON.stringify(alloc) : null);
  });
  await db.batch(stmts);
}

// Parse an item's mixed-set allocation (JSON) into [{set_id, packs}] or null.
function itemAlloc(it) {
  if (!it.set_packs) return null;
  try { const a = JSON.parse(it.set_packs); return Array.isArray(a) && a.length ? a : null; } catch { return null; }
}

async function insertFinds(db, orderId, finds) {
  const entries = Object.entries(finds || {}).filter(([, c]) => Number(c) > 0);
  if (!entries.length) return;
  const stmts = entries.map(([rarity, count]) =>
    db.prepare("INSERT INTO order_finds (order_id, rarity, count) VALUES (?, ?, ?)").bind(orderId, rarity, Number(count))
  );
  await db.batch(stmts);
}

async function insertPullCards(db, orderId, cards) {
  const list = (cards || []).filter((c) => c && c.card_id);
  if (!list.length) return;
  const stmts = list.map((c) =>
    db.prepare("INSERT OR IGNORE INTO order_pull_cards (order_id, card_id, name, image_small) VALUES (?, ?, ?, ?)")
      .bind(orderId, String(c.card_id), c.name || null, c.image_small || c.image || null)
  );
  await db.batch(stmts);
}

async function insertPromos(db, orderId, promos) {
  const list = (promos || []).filter((p) => p && (p.name || "").trim());
  if (!list.length) return;
  const stmts = list.map((p) =>
    db.prepare("INSERT INTO order_promos (order_id, name, image_small, card_id) VALUES (?, ?, ?, ?)")
      .bind(orderId, String(p.name).trim(), p.image_small || p.image || null, p.card_id || null)
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
// Live per-set stats derived from multi-set orders: only the lines whose set_id
// matches count toward this set, but each line still carries its parent order's
// discount + tax. orderCount = orders that include at least one line from this set.
export async function setTotals(db, setId, collection) {
  // Scan all binder orders (not the SQL set filter) so mixed-set lines that touch
  // this set only via their JSON allocation are included too.
  const orders = await listOrders(db, undefined, collection);
  const breakdown = {};
  let totalSpent = 0;
  let totalPacks = 0;
  let orderCount = 0;
  for (const o of orders) {
    const factor = (1 - (o.discount_rate || 0)) * (1 + o.tax_rate);
    let touchesSet = false;
    for (const it of o.items) {
      // packs of THIS set per unit, and the total packs per unit (for spend split).
      const unitTotal = it.set_packs ? it.set_packs.reduce((s, a) => s + (Number(a.packs) || 0), 0) : it.packs_per_unit;
      let setPerUnit = 0;
      if (it.set_packs) { for (const a of it.set_packs) if (a.set_id === setId) setPerUnit += Number(a.packs) || 0; }
      else if (it.set_id === setId) setPerUnit = it.packs_per_unit;
      if (setPerUnit <= 0) continue;                 // this line doesn't touch this set
      touchesSet = true;
      const share = unitTotal > 0 ? setPerUnit / unitTotal : 1;   // proportional spend by packs
      const packs = it.quantity * setPerUnit;
      const spend = it.quantity * it.unit_price * share * factor;
      const b = (breakdown[it.product_type] ||= { quantity: 0, packs: 0, spend: 0 });
      b.quantity += it.quantity;
      b.packs += packs;
      b.spend += spend;
      totalPacks += packs;
      totalSpent += spend;
    }
    if (touchesSet) orderCount += 1;
  }
  for (const b of Object.values(breakdown)) b.spend = round2(b.spend);
  return { totalSpent: round2(totalSpent), totalPacks, orderCount, breakdown };
}

// True if any order line references this set — blocks untracking a set with data.
export async function setHasOrders(db, setId) {
  const row = await db.prepare("SELECT 1 FROM order_items WHERE set_id = ? LIMIT 1").bind(setId).first();
  return !!row;
}

// Untrack a set: remove the cached set + its rarities/estimate (cascade). Refuses
// when orders reference it — callers must guard with setHasOrders first.
export async function deleteSet(db, setId) {
  const res = await db.prepare("DELETE FROM sets WHERE id = ?").bind(setId).run();
  return res.meta.changes > 0;
}
