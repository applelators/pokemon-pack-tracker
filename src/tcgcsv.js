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
export async function findGroupId(name, releaseDate) {
  const groups = await getJson(`${BASE}/${POKEMON_CATEGORY}/groups`);
  const target = norm(name);
  if (!target) return null;
  const day = isoDay(releaseDate);

  // 1) exact match on the post-colon name (distinguishes a base set from its
  //    "... Promo" / "... Energies" siblings that share a release date).
  const exact = groups.filter((g) => norm(afterColon(g.name)) === target);
  // 2) else fall back to a contains-match (needs a reasonably specific name).
  let pool = exact.length
    ? exact
    : groups.filter((g) => target.length >= 4 && norm(afterColon(g.name)).includes(target));
  if (!pool.length) return null;

  // Disambiguate remaining ties by release date, then by shortest name (base set).
  if (pool.length > 1 && day) {
    const byDate = pool.filter((g) => isoDay(g.publishedOn) === day);
    if (byDate.length) pool = byDate;
  }
  pool.sort((a, b) => afterColon(a.name).length - afterColon(b.name).length);
  return pool[0].groupId;
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
