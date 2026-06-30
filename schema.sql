-- D1 schema for the Pokémon Pack Tracker.
-- Apply locally:  npm run db:local
-- Apply remote:   npm run db:remote

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
  logo_url      TEXT,
  symbol_url    TEXT,
  fetched_at    TEXT NOT NULL,
  -- Loose-pack deal check (researched, editable; set-level not binder-level):
  pack_market_price  REAL,   -- aggregated median price of one loose pack
  pack_price_ceiling REAL,   -- "good deal under this" recommendation
  pack_msrp          REAL,   -- original retail per pack
  pack_price_note    TEXT,   -- sources + methodology
  pack_price_updated TEXT,   -- ISO date the price was last researched/edited
  art_json           TEXT    -- official art (hero + product renders) scraped on import
);

-- Upgrading an existing database? Columns added later — run once each:
--   ALTER TABLE sets ADD COLUMN logo_url TEXT;
--   ALTER TABLE sets ADD COLUMN symbol_url TEXT;
--   ALTER TABLE sets ADD COLUMN pack_market_price REAL;
--   ALTER TABLE sets ADD COLUMN pack_price_ceiling REAL;
--   ALTER TABLE sets ADD COLUMN pack_msrp REAL;
--   ALTER TABLE sets ADD COLUMN pack_price_note TEXT;
--   ALTER TABLE sets ADD COLUMN pack_price_updated TEXT;
--   ALTER TABLE sets ADD COLUMN art_json TEXT;

CREATE TABLE IF NOT EXISTS set_rarities (
  set_id TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
  rarity TEXT NOT NULL,
  count  INTEGER NOT NULL,
  PRIMARY KEY (set_id, rarity)
);

-- Rarity counts across the ENTIRE set (incl. secret rares above printedTotal),
-- used to know which chase rarities (IR/UR/SIR/MHR) the expansion actually has.
CREATE TABLE IF NOT EXISTS set_all_rarities (
  set_id    TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
  rarity    TEXT NOT NULL,
  count     INTEGER NOT NULL,
  avg_price REAL,                 -- avg TCGplayer market price of cards of this rarity (for EV)
  PRIMARY KEY (set_id, rarity)
);
-- Upgrading? Run once: ALTER TABLE set_all_rarities ADD COLUMN avg_price REAL;

CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id        TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
  purchase_date TEXT NOT NULL,
  tax_rate      REAL NOT NULL DEFAULT 0,
  note          TEXT,
  collection    TEXT NOT NULL DEFAULT 'mine',  -- 'mine' | 'shared' (separate binder)
  store         TEXT,                          -- e.g. 'Offcourt TCG', 'Target'
  discount_rate REAL NOT NULL DEFAULT 0        -- subtotal discount (e.g. 0.05 Target Circle); taxed after discount
);

-- Upgrading an existing database? These columns were added later. Run once each:
--   ALTER TABLE orders ADD COLUMN collection TEXT NOT NULL DEFAULT 'mine';
--   ALTER TABLE orders ADD COLUMN store TEXT;
--   ALTER TABLE orders ADD COLUMN discount_rate REAL NOT NULL DEFAULT 0;

-- Orders are MULTI-SET: one receipt can mix line items from different expansions,
-- so the set link lives on each line (order_items.set_id), not on the order. The
-- order's "sets" = the distinct set_ids across its lines; per-set spend/packs/orders
-- are derived live from these lines (see store.setTotals), never stored statically.
-- orders.set_id above is legacy (kept NOT NULL for old engines; set to the first
-- line's set on insert, but never read).
CREATE TABLE IF NOT EXISTS order_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id       INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  set_id         TEXT REFERENCES sets(id),
  product_type   TEXT NOT NULL,
  quantity       INTEGER NOT NULL,
  unit_price     REAL NOT NULL,
  packs_per_unit INTEGER NOT NULL
);

-- Upgrading an existing database? order_items.set_id was added later. The Worker
-- auto-applies this on first boot (see ensureMigrated in src/api.js), but to run it
-- by hand:
--   ALTER TABLE order_items ADD COLUMN set_id TEXT REFERENCES sets(id);
--   UPDATE order_items SET set_id = (SELECT o.set_id FROM orders o WHERE o.id = order_items.order_id) WHERE set_id IS NULL;

-- Secret (non-base-set) cards the user pulled from an order's packs, by rarity.
CREATE TABLE IF NOT EXISTS order_finds (
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  rarity   TEXT NOT NULL,
  count    INTEGER NOT NULL,
  PRIMARY KEY (order_id, rarity)
);

-- User-entered actuals per (set, collection): how many base-set cards they really
-- have, and how many of their bought packs they've actually opened. These override
-- the model's assumptions when present.
CREATE TABLE IF NOT EXISTS progress (
  set_id          TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
  collection      TEXT NOT NULL DEFAULT 'mine',
  packs_opened    INTEGER,
  cards_collected INTEGER,
  PRIMARY KEY (set_id, collection)
);

-- Specific secret cards the user tagged as pulled from an order (optional, for
-- thumbnails). Image/name denormalized so display needs no extra lookups.
CREATE TABLE IF NOT EXISTS order_pull_cards (
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  card_id     TEXT NOT NULL,
  name        TEXT,
  image_small TEXT,
  PRIMARY KEY (order_id, card_id)
);

-- Cached Monte-Carlo completion curve per set (keyed by a signature of
-- rarities + pack model + runs) so the dashboard doesn't re-simulate every load.
CREATE TABLE IF NOT EXISTS estimate_cache (
  set_id    TEXT PRIMARY KEY REFERENCES sets(id) ON DELETE CASCADE,
  signature TEXT NOT NULL,
  data      TEXT NOT NULL,
  updated   TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_set ON orders(set_id);
CREATE INDEX IF NOT EXISTS idx_pullcards_order ON order_pull_cards(order_id);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_set ON order_items(set_id);
CREATE INDEX IF NOT EXISTS idx_finds_order ON order_finds(order_id);

-- Default settings (only inserted if absent).
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('sales_tax_rate', '6.0'),
  ('pokemontcg_api_key', ''),
  ('pricecharting_api_key', ''),
  ('ebay_client_id', ''),
  ('ebay_client_secret', ''),
  ('monte_carlo_runs', '3000'),
  ('packs_per_product', '{"Booster Pack":1,"Sleeved Booster":1,"Booster Bundle":6,"Elite Trainer Box":9,"Mini Tin":2,"Regular Tin":3}'),
  ('pack_model', '{"slots":[{"name":"Common","count":4,"pool":["Common"]},{"name":"Uncommon","count":3,"pool":["Uncommon"]},{"name":"Reverse Holo","count":2,"pool":["Common","Uncommon","Rare"]},{"name":"Hit","count":1,"weights":{"Rare":0.66,"Double Rare":0.18,"Ultra Rare":0.06,"Illustration Rare":0.05,"ACE SPEC Rare":0.05}}]}'),
  ('chase_pull_rates', '{"Illustration Rare":0.111,"Ultra Rare":0.05,"Special Illustration Rare":0.0139,"Mega Hyper Rare":0.000794}');
