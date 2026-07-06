// Daily market-price snapshot (cron trigger, see _worker.js `scheduled`).
// Writes ONLY to price_history — the live deal price (sets.pack_market_price) still
// comes from manual ↻ Refresh, which blends PriceCharting/eBay on top of TCGplayer.
// TCGCSV only here: 2 subrequests per set + one groups lookup per UNCACHED set keeps
// a 16-set run well under the Worker's per-invocation subrequest limit.

import { listSets, recordPriceHistory } from "./store.js";
import { findGroupId, fetchSealedRipPrices } from "./tcgcsv.js";
import { CUSTOM_SETS } from "./customsets.js";

const CACHE_KEY = "tcgcsv_group_cache";

export async function snapshotAllPrices(db) {
  // The API's ensureMigrated normally creates this, but the cron can fire first.
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS price_history (set_id TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE, day TEXT NOT NULL, market REAL NOT NULL, basis TEXT, PRIMARY KEY (set_id, day))"
  ).run();
  const sets = (await listSets(db)).filter((s) => !CUSTOM_SETS[s.id]);
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(CACHE_KEY).first();
  let groups = {};
  try { if (row) groups = JSON.parse(row.value) || {}; } catch { /* rebuild */ }

  let dirty = false;
  const results = [];
  for (const s of sets) {
    try {
      if (!groups[s.id]) {
        groups[s.id] = await findGroupId(s.name, s.release_date);
        dirty = true;
      }
      if (!groups[s.id]) { results.push(`${s.id}: no TCGplayer group`); continue; }
      const p = await fetchSealedRipPrices(s.name, s.release_date, groups[s.id]);
      const market = p && (p.loose ?? p.boxPerPack ?? p.bundlePerPack);
      if (!(market > 0)) { results.push(`${s.id}: no price`); continue; }
      const basis = p.loose != null ? "daily snapshot — TCGplayer loose" : "daily snapshot — TCGplayer box/pack";
      await recordPriceHistory(db, s.id, market, basis);
      results.push(`${s.id}: $${market.toFixed(2)}`);
    } catch (e) {
      results.push(`${s.id}: ERR ${String((e && e.message) || e)}`);
    }
  }
  if (dirty) {
    await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(CACHE_KEY, JSON.stringify(groups)).run();
  }
  return results;
}
