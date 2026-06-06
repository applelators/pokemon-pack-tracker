import db, { getSetting } from "../db.js";

const BASE_URL = "https://api.pokemontcg.io/v2";

function headers() {
  const key = getSetting("pokemontcg_api_key");
  const h = { Accept: "application/json" };
  if (key && key.trim()) h["X-Api-Key"] = key.trim();
  return h;
}

async function apiGet(path) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: headers() });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`pokemontcg.io ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// Search sets by name. Returns lightweight set descriptors (not cached).
export async function searchSets(query) {
  const q = (query || "").trim();
  const param = q
    ? `q=${encodeURIComponent(`name:"*${q}*"`)}&`
    : "";
  const json = await apiGet(
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

// Fetch a set + its per-rarity base-set breakdown, then cache both in SQLite.
export async function importSet(setId) {
  const setJson = await apiGet(
    `/sets/${encodeURIComponent(setId)}?select=id,name,series,printedTotal,total,releaseDate`
  );
  const s = setJson.data;
  if (!s) throw new Error(`Set not found: ${setId}`);
  const printedTotal = s.printedTotal || 0;

  // Page through all cards collecting number + rarity.
  const rarityCounts = {};
  let page = 1;
  const pageSize = 250;
  for (;;) {
    const cardsJson = await apiGet(
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

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO sets (id, name, series, printed_total, total, release_date, fetched_at)
       VALUES (@id, @name, @series, @printed_total, @total, @release_date, @fetched_at)
       ON CONFLICT(id) DO UPDATE SET
         name=excluded.name, series=excluded.series, printed_total=excluded.printed_total,
         total=excluded.total, release_date=excluded.release_date, fetched_at=excluded.fetched_at`
    ).run({
      id: s.id,
      name: s.name,
      series: s.series || null,
      printed_total: printedTotal,
      total: s.total || null,
      release_date: s.releaseDate || null,
      fetched_at: new Date().toISOString(),
    });
    db.prepare("DELETE FROM set_rarities WHERE set_id = ?").run(s.id);
    const ins = db.prepare(
      "INSERT INTO set_rarities (set_id, rarity, count) VALUES (?, ?, ?)"
    );
    for (const [rarity, count] of Object.entries(rarityCounts)) {
      ins.run(s.id, rarity, count);
    }
  });
  tx();

  return getCachedSet(s.id);
}

export function getCachedSet(setId) {
  const set = db.prepare("SELECT * FROM sets WHERE id = ?").get(setId);
  if (!set) return null;
  const rarities = db
    .prepare("SELECT rarity, count FROM set_rarities WHERE set_id = ? ORDER BY count DESC")
    .all(setId);
  return { ...set, rarities };
}

export function listCachedSets() {
  return db.prepare("SELECT * FROM sets ORDER BY release_date DESC").all();
}
