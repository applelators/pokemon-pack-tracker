// pokemontcg.io client. Runs inside the Worker; caches results into D1 via store.
import { getRawSettings, saveSet, getCachedSet } from "./store.js";

const BASE_URL = "https://api.pokemontcg.io/v2";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiGet(db, path) {
  const settings = await getRawSettings(db);
  const headers = { Accept: "application/json" };
  const key = (settings.pokemontcg_api_key || "").trim();
  if (key) headers["X-Api-Key"] = key;

  // Retry transient throttles (429) and upstream blips (5xx) with backoff.
  const MAX_ATTEMPTS = 4;
  let lastStatus = 0, lastBody = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(`${BASE_URL}${path}`, { headers });
    if (res.ok) return res.json();

    lastStatus = res.status;
    lastBody = await res.text().catch(() => "");
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt === MAX_ATTEMPTS) break;

    // Honor Retry-After if given, else exponential backoff (0.6s, 1.4s, 3s).
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : [600, 1400, 3000][attempt - 1] || 3000;
    await sleep(waitMs);
  }

  if (lastStatus === 429) {
    throw new Error("pokemontcg.io is rate-limiting requests (429). Add a free API key in Settings for much higher limits, or try again in a moment.");
  }
  throw new Error(`pokemontcg.io ${lastStatus}: ${lastBody.slice(0, 160)}`);
}

// Live list of a set's cards (id, name, number, rarity, small image) for the
// "tag pulled cards" picker. Uses the API key when set.
export async function listSetCards(db, setId) {
  const out = [];
  let page = 1;
  const pageSize = 250;
  for (;;) {
    const json = await apiGet(
      db,
      `/cards?q=${encodeURIComponent(`set.id:${setId}`)}&select=id,name,number,rarity,images&orderBy=number&page=${page}&pageSize=${pageSize}`
    );
    const cards = json.data || [];
    for (const c of cards) {
      out.push({ id: c.id, name: c.name, number: c.number, rarity: c.rarity || "Unknown", image: c.images?.small || null });
    }
    const total = json.totalCount ?? cards.length;
    if (page * pageSize >= total || cards.length === 0) break;
    page += 1;
  }
  return out;
}

export async function searchSets(db, query) {
  const q = (query || "").trim();
  const param = q ? `q=${encodeURIComponent(`name:"*${q}*"`)}&` : "";
  const json = await apiGet(
    db,
    `/sets?${param}orderBy=-releaseDate&pageSize=50&select=id,name,series,printedTotal,total,releaseDate`
  );
  return (json.data || []).map((s) => ({
    id: s.id,
    name: s.name,
    series: s.series,
    printedTotal: s.printedTotal,
    total: s.total,
    releaseDate: s.releaseDate,
  }));
}

// True only for plain numbered base-set cards (e.g. "12", not "TG01" / "GG05").
function isBaseSetNumber(number, printedTotal) {
  if (!/^\d+$/.test(String(number))) return false;
  const n = parseInt(number, 10);
  return n >= 1 && n <= printedTotal;
}

// Representative market price for a card = highest market/mid across its variants.
function repMarketPrice(tcg) {
  const prices = tcg && tcg.prices;
  if (!prices) return 0;
  let best = 0;
  for (const v of Object.values(prices)) {
    const m = (v && (v.market || v.mid)) || 0;
    if (m > best) best = m;
  }
  return best;
}

export async function importSet(db, setId) {
  const setJson = await apiGet(
    db,
    `/sets/${encodeURIComponent(setId)}?select=id,name,series,printedTotal,total,releaseDate,images`
  );
  const s = setJson.data;
  if (!s) throw new Error(`Set not found: ${setId}`);
  const printedTotal = s.printedTotal || 0;

  const rarityCounts = {};     // base-set cards only (number <= printedTotal)
  const allRarityCounts = {};  // every card in the set, incl. secret rares
  const priceSum = {}, priceN = {};  // per-rarity TCGplayer market price totals (for EV)
  let page = 1;
  const pageSize = 250;
  for (;;) {
    const cardsJson = await apiGet(
      db,
      `/cards?q=${encodeURIComponent(`set.id:${setId}`)}&select=id,number,rarity,tcgplayer&page=${page}&pageSize=${pageSize}`
    );
    const cards = cardsJson.data || [];
    for (const c of cards) {
      const rarity = c.rarity || "Unknown";
      allRarityCounts[rarity] = (allRarityCounts[rarity] || 0) + 1;
      const price = repMarketPrice(c.tcgplayer);
      if (price > 0) { priceSum[rarity] = (priceSum[rarity] || 0) + price; priceN[rarity] = (priceN[rarity] || 0) + 1; }
      if (!isBaseSetNumber(c.number, printedTotal)) continue;
      rarityCounts[rarity] = (rarityCounts[rarity] || 0) + 1;
    }
    const total = cardsJson.totalCount ?? cards.length;
    if (page * pageSize >= total || cards.length === 0) break;
    page += 1;
  }
  const allRarityPrices = {};  // rarity -> avg market price
  for (const r of Object.keys(priceN)) allRarityPrices[r] = priceSum[r] / priceN[r];

  await saveSet(
    db,
    {
      id: s.id,
      name: s.name,
      series: s.series || null,
      printed_total: printedTotal,
      total: s.total || null,
      release_date: s.releaseDate || null,
      logo_url: s.images?.logo || null,
      symbol_url: s.images?.symbol || null,
      fetched_at: new Date().toISOString(),
    },
    rarityCounts,
    allRarityCounts,
    allRarityPrices
  );

  return getCachedSet(db, s.id);
}
