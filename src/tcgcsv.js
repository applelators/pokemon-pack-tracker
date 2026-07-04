// TCGCSV client — tcgcsv.com is a free, no-key, daily mirror of TCGplayer's own
// pricing API. We use it to fill per-rarity single-card prices when pokemontcg.io
// hasn't priced a set yet (it lags weeks–months behind on brand-new sets). Same
// underlying source as pokemontcg.io's prices (TCGplayer), just fresher.

const BASE = "https://tcgcsv.com/tcgplayer";
const POKEMON_CATEGORY = 3; // TCGplayer categoryId for Pokemon

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const isoDay = (s) => (s ? String(s).replace(/\//g, "-").slice(0, 10) : null);

// TCGCSV rejects requests without a browser-like User-Agent (401 otherwise).
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": UA } });
  if (!res.ok) throw new Error(`tcgcsv ${res.status} for ${url}`);
  const j = await res.json();
  return Array.isArray(j) ? j : j.results || [];
}

// Group names look like "ME04: Chaos Rising" — compare the part after the colon
// against the pokemontcg.io set name.
function afterColon(name) {
  const n = name || "";
  const i = n.indexOf(":");
  return i >= 0 ? n.slice(i + 1) : n;
}

// Find the Pokemon group (set) best matching a pokemontcg set name + release date.
// Scores each group on name overlap AND release-date match, so short/odd set names
// (e.g. "151" → "SV: Scarlet & Violet 151") still resolve. Exact name still wins.
export async function findGroupId(name, releaseDate) {
  const groups = await getJson(`${BASE}/${POKEMON_CATEGORY}/groups`);
  const target = norm(name);
  if (!target) return null;
  const day = isoDay(releaseDate);

  const scored = [];
  for (const g of groups) {
    const ac = afterColon(g.name);
    const acN = norm(ac), fullN = norm(g.name);
    const exact = acN === target || fullN === target;
    const contains = target.length >= 3 && (acN.includes(target) || fullN.includes(target) || target.includes(acN));
    const dateMatch = !!(day && isoDay(g.publishedOn) === day);
    if (!exact && !contains && !dateMatch) continue;
    const score = (exact ? 4 : 0) + (dateMatch ? 2 : 0) + (contains ? 1 : 0);
    scored.push({ g, score, nameSignal: exact || contains, dateMatch, aclen: ac.length });
  }
  if (!scored.length) return null;
  // Highest score wins; tie-break toward the shorter post-colon name (the base set).
  scored.sort((a, b) => b.score - a.score || a.aclen - b.aclen);
  const top = scored[0];
  // A date-only match (no name overlap) is risky — only trust it if the date is unique.
  if (!top.nameSignal) {
    const dateHits = scored.filter((s) => s.dateMatch);
    return dateHits.length === 1 ? dateHits[0].g.groupId : null;
  }
  return top.g.groupId;
}

// Representative market price for a product = highest market across its print
// subtypes (Normal / Holofoil / Reverse Holofoil), mirroring the pokemontcg path.
function repMarket(rows) {
  let best = 0;
  for (const r of rows) {
    const m = Number(r.marketPrice) || 0;
    if (m > best) best = m;
  }
  return best;
}

// Cheapest-rip per-pack price points for a set's REGULAR sealed products, via TCGCSV
// (TCGplayer market). Returns { loose, boxPerPack, bundlePerPack } in USD (nulls when
// a product isn't listed). Sleeved is intentionally ignored — it's a premium SKU.
export async function fetchSealedRipPrices(name, releaseDate, groupIdOverride) {
  const groupId = groupIdOverride || (await findGroupId(name, releaseDate));
  if (!groupId) return null;
  const [products, prices] = await Promise.all([
    getJson(`${BASE}/${POKEMON_CATEGORY}/${groupId}/products`),
    getJson(`${BASE}/${POKEMON_CATEGORY}/${groupId}/prices`),
  ]);
  const priceRows = {};
  for (const p of prices) (priceRows[p.productId] = priceRows[p.productId] || []).push(p);
  const mkt = (id) => repMarket(priceRows[id] || []);
  const byName = (re, notRe) =>
    products.find((p) => re.test(p.name || "") && !(notRe && notRe.test(p.name || "")));
  const loose = byName(/booster pack/i, /(sleeved|box|bundle|case|blister)/i);
  const box = byName(/booster box/i, /(case|enhanced)/i); // plain 36-pack box
  const bundle = byName(/booster bundle/i); // 6 packs
  const round2 = (x) => (x && x > 0 ? Math.round(x * 100) / 100 : null);
  return {
    groupId,
    loose: loose ? round2(mkt(loose.productId)) : null,
    boxPerPack: box ? round2(mkt(box.productId) / 36) : null,
    bundlePerPack: bundle ? round2(mkt(bundle.productId) / 6) : null,
  };
}

// All sealed products for one group with pack counts (for the Sealed Deals view).
// Pattern order matters; null = skip (cases/displays/seller lots/unknown collections).
const SEALED_PACKS = [
  [/case\b|display\b|art bundle|set of|lot\b|bundle \+/i, null],
  [/booster bundle/i, 6],
  [/pokemon center.*elite|elite.*pokemon center/i, 11],
  [/elite trainer/i, 9],
  [/enhanced booster box|half booster box/i, null],
  [/booster box/i, 36],
  [/sleeved booster pack$/i, 1],
  [/booster pack$/i, 1],
  [/3[- ]pack blister|three[- ]booster/i, 3],
  [/2[- ]pack blister/i, 2],
  [/1[- ]pack blister|checklane/i, 1],
  [/mini tin/i, 2],
  [/poster collection/i, 3],
  [/tech sticker/i, 3],
  [/binder collection/i, 5],
  [/super.premium|ultra.premium/i, 16],
  [/surprise box/i, 4],
  [/premium figure/i, 11],
  [/accessory pouch/i, 5],
  [/pin collection/i, 5],
  [/special illustration collection/i, 5],
  [/illustration collection/i, 4],
  [/ex collection\b/i, 4],
  [/ex box\b/i, 4],
  [/build & battle stadium/i, null],
  [/build & battle/i, 4],
  [/stacking tin/i, 3],
  [/\btin\b/i, 3],
  [/collection|deck|kit|pouch|album|figure/i, null],
];
export async function fetchSealedList(groupId) {
  const [products, prices] = await Promise.all([
    getJson(`${BASE}/${POKEMON_CATEGORY}/${groupId}/products`),
    getJson(`${BASE}/${POKEMON_CATEGORY}/${groupId}/prices`),
  ]);
  const pm = {};
  for (const r of prices) pm[r.productId] = Math.max(pm[r.productId] || 0, r.marketPrice || 0);
  const out = [];
  for (const p of products) {
    const n = p.name || "";
    if ((p.extendedData || []).some((e) => e.name === "Rarity")) continue; // cards, not sealed
    if (/^code card/i.test(n)) continue;
    const v = pm[p.productId];
    if (!v || v < 3) continue;
    let packs;
    for (const [rx, c] of SEALED_PACKS) { if (rx.test(n)) { packs = c; break; } }
    if (!packs) continue;
    out.push({ name: n, market: Math.round(v * 100) / 100, packs });
  }
  return out;
}

// Loose-pack + booster-box market prices for one group (for the tier list).
export async function fetchPackBox(groupId) {
  const [products, prices] = await Promise.all([
    getJson(`${BASE}/${POKEMON_CATEGORY}/${groupId}/products`),
    getJson(`${BASE}/${POKEMON_CATEGORY}/${groupId}/prices`),
  ]);
  const pm = {};
  for (const r of prices) pm[r.productId] = Math.max(pm[r.productId] || 0, r.marketPrice || 0);
  let pack = null, box = null;
  for (const p of products) {
    const n = p.name || "";
    if (/booster pack$/i.test(n) && !/sleeved|code|blister|art/i.test(n)) pack = pm[p.productId] || pack;
    if (/booster box$/i.test(n) && !/case|enhanced|half/i.test(n)) box = pm[p.productId] || box;
  }
  return { pack: pack || null, box: box || null };
}

// Per-rarity average market price (USD) for a set's singles, via TCGCSV. Rarity
// strings ("Illustration Rare", "Mega Hyper Rare", …) match pokemontcg.io's, so
// the result drops straight into set_all_rarities.avg_price.
// Returns { groupId, prices: { rarity -> avgPrice } } or null if nothing usable.
export async function fetchRarityPrices(name, releaseDate, groupIdOverride) {
  const groupId = groupIdOverride || (await findGroupId(name, releaseDate));
  if (!groupId) return null;
  const [products, prices] = await Promise.all([
    getJson(`${BASE}/${POKEMON_CATEGORY}/${groupId}/products`),
    getJson(`${BASE}/${POKEMON_CATEGORY}/${groupId}/prices`),
  ]);

  const priceRows = {}; // productId -> [price rows]
  for (const p of prices) (priceRows[p.productId] = priceRows[p.productId] || []).push(p);
  const ext = (p, key) => {
    for (const e of p.extendedData || []) if (e.name === key) return e.value;
    return null;
  };

  const sum = {}, n = {};
  for (const prod of products) {
    const rarity = ext(prod, "Rarity");
    if (!rarity) continue; // skip sealed / non-card products (no Rarity)
    const rows = priceRows[prod.productId];
    if (!rows) continue;
    const m = repMarket(rows);
    if (m > 0) { sum[rarity] = (sum[rarity] || 0) + m; n[rarity] = (n[rarity] || 0) + 1; }
  }
  const out = {};
  for (const r of Object.keys(n)) out[r] = sum[r] / n[r];
  return { groupId, prices: Object.keys(out).length ? out : null };
}
