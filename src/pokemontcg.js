// pokemontcg.io client. Runs inside the Worker; caches results into D1 via store.
import { getRawSettings, saveSet, getCachedSet } from "./store.js";

const BASE_URL = "https://api.pokemontcg.io/v2";

async function apiGet(db, path) {
  const settings = await getRawSettings(db);
  const headers = { Accept: "application/json" };
  const key = (settings.pokemontcg_api_key || "").trim();
  if (key) headers["X-Api-Key"] = key;

  const res = await fetch(`${BASE_URL}${path}`, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`pokemontcg.io ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
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

export async function importSet(db, setId) {
  const setJson = await apiGet(
    db,
    `/sets/${encodeURIComponent(setId)}?select=id,name,series,printedTotal,total,releaseDate`
  );
  const s = setJson.data;
  if (!s) throw new Error(`Set not found: ${setId}`);
  const printedTotal = s.printedTotal || 0;

  const rarityCounts = {};
  let page = 1;
  const pageSize = 250;
  for (;;) {
    const cardsJson = await apiGet(
      db,
      `/cards?q=${encodeURIComponent(`set.id:${setId}`)}&select=id,number,rarity&page=${page}&pageSize=${pageSize}`
    );
    const cards = cardsJson.data || [];
    for (const c of cards) {
      if (!isBaseSetNumber(c.number, printedTotal)) continue;
      const rarity = c.rarity || "Unknown";
      rarityCounts[rarity] = (rarityCounts[rarity] || 0) + 1;
    }
    const total = cardsJson.totalCount ?? cards.length;
    if (page * pageSize >= total || cards.length === 0) break;
    page += 1;
  }

  await saveSet(
    db,
    {
      id: s.id,
      name: s.name,
      series: s.series || null,
      printed_total: printedTotal,
      total: s.total || null,
      release_date: s.releaseDate || null,
      fetched_at: new Date().toISOString(),
    },
    rarityCounts
  );

  return getCachedSet(db, s.id);
}
