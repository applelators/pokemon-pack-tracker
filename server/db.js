import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "..", "data");
mkdirSync(dataDir, { recursive: true });

const db = new Database(join(dataDir, "tracker.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sets (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    series        TEXT,
    printed_total INTEGER NOT NULL,
    total         INTEGER,
    release_date  TEXT,
    fetched_at    TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS set_rarities (
    set_id TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
    rarity TEXT NOT NULL,
    count  INTEGER NOT NULL,
    PRIMARY KEY (set_id, rarity)
  );

  CREATE TABLE IF NOT EXISTS orders (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    set_id        TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
    purchase_date TEXT NOT NULL,
    tax_rate      REAL NOT NULL DEFAULT 0,
    note          TEXT
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_type  TEXT NOT NULL,
    quantity      INTEGER NOT NULL,
    unit_price    REAL NOT NULL,
    packs_per_unit INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_orders_set ON orders(set_id);
  CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
`);

// ---- Default settings ----------------------------------------------------
// Pull-rate / pack-slot model: a modern Scarlet & Violet booster (2026) holds 10
// game cards — 4 commons, 3 uncommons, 2 reverse holos, and 1 "hit" slot (a Rare
// or better, whose probability is divided across the higher rarities in the set).
// An Illustration/Special Illustration Rare normally upgrades a reverse-holo slot;
// since those are usually secret rares above the base-set checklist they don't
// affect base-set completion, so the reverse-holo slots stay on common/uncommon/rare.
const DEFAULT_SETTINGS = {
  sales_tax_rate: "6.0",
  pokemontcg_api_key: "",
  packs_per_product: JSON.stringify({
    "Booster Pack": 1,
    "Booster Bundle": 6,
    "Elite Trainer Box": 9,
    "Mini Tin": 2,
    "Regular Tin": 3,
  }),
  pack_model: JSON.stringify({
    slots: [
      { name: "Common", count: 4, pool: ["Common"] },
      { name: "Uncommon", count: 3, pool: ["Uncommon"] },
      // Reverse-holo slot: any base-set card can appear; modeled across the
      // common/uncommon/rare tiers it most often hits.
      { name: "Reverse Holo", count: 2, pool: ["Common", "Uncommon", "Rare"] },
      // The single "hit" slot — probabilities for the rarities that exist in the
      // base set. Any base-set rarity not listed here is folded in proportionally.
      {
        name: "Hit",
        count: 1,
        weights: {
          "Rare": 0.7,
          "Double Rare": 0.18,
          "Ultra Rare": 0.06,
          "Illustration Rare": 0.06,
        },
      },
    ],
  }),
  monte_carlo_runs: "3000",
};

const insertSetting = db.prepare(
  "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)"
);
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);

// Migration: the original default pack model had a single reverse-holo slot, but a
// real 2026 booster has two. Upgrade existing databases that still carry the old
// default verbatim (leaves user-customized models untouched).
const OLD_PACK_MODEL_V1 =
  '{"slots":[{"name":"Common","count":4,"pool":["Common"]},{"name":"Uncommon","count":3,"pool":["Uncommon"]},{"name":"Reverse Holo","count":1,"pool":["Common","Uncommon","Rare"]},{"name":"Hit","count":1,"weights":{"Rare":0.7,"Double Rare":0.18,"Ultra Rare":0.06,"Illustration Rare":0.06}}]}';
{
  const current = db.prepare("SELECT value FROM settings WHERE key = 'pack_model'").get();
  if (current && current.value === OLD_PACK_MODEL_V1) {
    db.prepare("UPDATE settings SET value = ? WHERE key = 'pack_model'").run(
      DEFAULT_SETTINGS.pack_model
    );
  }
}

export default db;

// ---- Settings helpers ----------------------------------------------------
export function getAllSettings() {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  const out = {};
  for (const { key, value } of rows) out[key] = value;
  return out;
}

export function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : undefined;
}

export function setSetting(key, value) {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, String(value));
}
