import {
  getSettings, updateSettings, getRawSettings,
  listSets, getCachedSet, setExists,
  listOrders, getOrder, createOrder, updateOrder, deleteOrder, orderExists,
  setTotals, getProgress, setProgress, setSetPricing,
  getEstimateCache, saveEstimateCache,
  setHasOrders, deleteSet,
} from "./store.js";
import { searchSets, importSet, listSetCards, searchCardsByName } from "./pokemontcg.js";
import { fetchPriceChartingPoints } from "./pricecharting.js";
import { fetchSealedRipPrices } from "./tcgcsv.js";
import { fetchEbayPackPrice } from "./ebay.js";
import { computeCurve, applyProgress, chaseEstimate } from "./estimator.js";

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) return "At least one line item is required";
  for (const it of items) {
    const hasAlloc = Array.isArray(it.set_packs) && it.set_packs.some((a) => Number(a.packs) > 0);
    if (!it.set_id && !hasAlloc) return "Each line needs a set (or a mixed-set pack allocation)";
    if (!it.product_type) return "Each item needs a product_type";
    if (!(Number(it.quantity) > 0)) return "Quantity must be > 0";
    if (!(Number(it.unit_price) >= 0)) return "Unit price must be >= 0";
    if (!(Number(it.packs_per_unit) >= 0)) return "packs_per_unit must be >= 0";
  }
  return null;
}

// All tracked set ids referenced by a set of items (primary set_id + allocations).
function collectSetIds(items) {
  const ids = new Set();
  for (const it of items || []) {
    if (it.set_id) ids.add(it.set_id);
    if (Array.isArray(it.set_packs)) for (const a of it.set_packs) if (a.set_id) ids.add(a.set_id);
  }
  return ids;
}

// One-time auto-migration: move the set link onto order_items so orders can span
// multiple expansions. Idempotent + cheap; guarded so it runs once per isolate.
let migrationPromise = null;
function ensureMigrated(db) {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      const info = await db.prepare("PRAGMA table_info(order_items)").all();
      const cols = (info.results || []).map((c) => c.name);
      if (!cols.includes("set_id")) {
        await db.prepare("ALTER TABLE order_items ADD COLUMN set_id TEXT REFERENCES sets(id)").run();
        await db.prepare(
          "UPDATE order_items SET set_id = (SELECT o.set_id FROM orders o WHERE o.id = order_items.order_id) WHERE set_id IS NULL"
        ).run();
        await db.prepare("CREATE INDEX IF NOT EXISTS idx_order_items_set ON order_items(set_id)").run();
      }
      // Mixed-set products: per-item JSON pack allocation across sets, e.g.
      // [{"set_id":"me4","packs":2},{"set_id":null,"packs":2}] (null = untracked/other).
      if (!cols.includes("set_packs")) {
        await db.prepare("ALTER TABLE order_items ADD COLUMN set_packs TEXT").run();
      }
      // Promo cards recorded on an order (from special products), separate from pack pulls.
      await db.prepare(
        "CREATE TABLE IF NOT EXISTS order_promos (order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, name TEXT NOT NULL, image_small TEXT, card_id TEXT)"
      ).run();
      await db.prepare("CREATE INDEX IF NOT EXISTS idx_promos_order ON order_promos(order_id)").run();
    })().catch((e) => { migrationPromise = null; throw e; });
  }
  return migrationPromise;
}

// Build the dashboard summary for one set (shared by /summary and /hub).
async function summaryFor(db, set, collection) {
  const totals = await setTotals(db, set.id, collection);
  const progress = await getProgress(db, set.id, collection);
  const packsOpened = progress.packs_opened != null
    ? Math.min(progress.packs_opened, totals.totalPacks)
    : totals.totalPacks;
  const completion = await computeEstimate(db, set, packsOpened, progress.cards_collected);
  const chase = await computeChase(db, set);
  const packEv = await computeEV(db, set);
  return { set, ...totals, packsBought: totals.totalPacks, packsOpened, progress, completion, chase, packEv, avgSingle: avgBaseSingle(set) };
}

// Cached completion curve for a set (re-simulate only when rarities/model/runs change).
async function getSetCurve(db, set) {
  const raw = await getRawSettings(db);
  let packModel;
  try { packModel = JSON.parse(raw.pack_model); } catch { packModel = { slots: [] }; }
  const runs = Number(raw.monte_carlo_runs) || 3000;
  const signature = JSON.stringify({ v: 2, r: set.rarities.map((x) => [x.rarity, x.count]), m: packModel, runs });
  let cc = await getEstimateCache(db, set.id, signature);
  if (!cc) {
    cc = computeCurve({ rarities: set.rarities, packModel, runs });
    await saveEstimateCache(db, set.id, signature, cc);
  }
  return cc;
}

async function computeEstimate(db, set, opened, collected = null) {
  if (!set.rarities || set.rarities.length === 0) return null;
  return applyProgress(await getSetCurve(db, set), opened, collected);
}

// Average price of one base-set card (weighted by rarity counts), or null.
function avgBaseSingle(set) {
  const priceByRar = {};
  for (const r of set.allRarities || []) priceByRar[r.rarity] = r.avg_price;
  let num = 0, den = 0;
  for (const r of set.rarities || []) {
    const p = priceByRar[r.rarity];
    if (p != null) { num += p * r.count; den += r.count; }
  }
  return den ? num / den : null;
}

// Expected value of one pack ($) from current single-card prices (pokemontcg.io).
// Bulk + a guaranteed rare-or-better hit + chase upside (per configured pull rates).
// Returns null if the set has no price data yet (new sets aren't priced).
async function computeEV(db, set) {
  const price = {};
  let any = false;
  for (const r of set.allRarities || []) {
    if (r.avg_price != null) { price[r.rarity] = r.avg_price; any = true; }
  }
  if (!any) return null;
  const p = (r) => price[r] || 0;
  let ev = 4 * p("Common") + 3 * p("Uncommon") + 2 * p("Common"); // commons, uncommons, 2 reverse ~common
  const dr = price["Double Rare"] != null ? p("Double Rare") : p("Rare");
  ev += 0.8 * p("Rare") + 0.2 * dr; // one guaranteed rare-or-better
  const raw = await getRawSettings(db);
  let rates = {};
  try { rates = JSON.parse(raw.chase_pull_rates); } catch { /* none */ }
  for (const [rarity, rate] of Object.entries(rates)) {
    const pr = Number(rate);
    if (pr > 0 && price[rarity] != null) ev += pr * price[rarity]; // chase upside
  }
  return Math.round(ev * 100) / 100;
}

async function computeChase(db, set) {
  const raw = await getRawSettings(db);
  let rates;
  try { rates = JSON.parse(raw.chase_pull_rates); } catch { return null; }
  const present = (set.allRarities && set.allRarities.length)
    ? new Set(set.allRarities.map((r) => r.rarity))
    : undefined;
  return chaseEstimate({ rates, presentRarities: present });
}

// Returns a Response for any /api/* route, or null if the path isn't an API route.
export async function handleApi(request, env, url) {
  const { pathname } = url;
  if (!pathname.startsWith("/api/")) return null;
  const db = env.DB;
  await ensureMigrated(db);
  const method = request.method;
  const seg = pathname.split("/").filter(Boolean); // ["api", ...]
  const body = async () => {
    try { return await request.json(); } catch { return {}; }
  };

  try {
    // /api/settings
    if (pathname === "/api/settings") {
      if (method === "GET") return json(await getSettings(db));
      if (method === "PUT") return json(await updateSettings(db, await body()));
    }

    // /api/sets ...
    if (pathname === "/api/sets" && method === "GET") {
      return json(await listSets(db));
    }
    // /api/hub — every tracked set with its live stats (one round trip for the hub).
    if (pathname === "/api/hub" && method === "GET") {
      const collection = url.searchParams.get("collection") || "mine";
      const sets = await listSets(db);
      const out = await Promise.all(sets.map(async (row) => {
        const set = await getCachedSet(db, row.id);
        if (!set) return null;
        return summaryFor(db, set, collection);
      }));
      return json(out.filter(Boolean));
    }
    if (pathname === "/api/sets/search" && method === "GET") {
      return json(await searchSets(db, url.searchParams.get("q"), url.searchParams.get("all") === "1"));
    }
    // /api/sets/:id  and  /api/sets/:id/import  and  /api/sets/:id/summary
    if (seg[0] === "api" && seg[1] === "sets" && seg[2]) {
      const setId = decodeURIComponent(seg[2]);
      if (seg.length === 3 && method === "GET") {
        const set = await getCachedSet(db, setId);
        return set ? json(set) : json({ error: "Set not imported" }, 404);
      }
      if (seg.length === 4 && seg[3] === "import" && method === "POST") {
        return json(await importSet(db, setId));
      }
      // GET /api/sets/:id/cards — live card list for the "tag pulls" picker
      if (seg.length === 4 && seg[3] === "cards" && method === "GET") {
        return json(await listSetCards(db, setId));
      }
      // GET /api/sets/:id/packvalue?price=&collection= — how many packs to buy at $price
      if (seg.length === 4 && seg[3] === "packvalue" && method === "GET") {
        const set = await getCachedSet(db, setId);
        if (!set || !set.rarities || !set.rarities.length) return json({ error: "Set not imported" }, 404);
        const price = Number(url.searchParams.get("price"));
        if (!(price > 0)) return json({ error: "Enter a positive pack price." }, 400);
        const avg = avgBaseSingle(set);
        if (!avg || avg <= 0) return json({ error: "No single-card price data for this set yet — re-import once pokemontcg.io has priced it." }, 400);
        const collection = url.searchParams.get("collection") || "mine";
        const totals = await setTotals(db, setId, collection);
        const progress = await getProgress(db, setId, collection);
        const opened = progress.packs_opened != null ? Math.min(progress.packs_opened, totals.totalPacks) : totals.totalPacks;
        const cc = await getSetCurve(db, set);
        const fwd = cc.fwd || [];
        const cap = fwd.length - 1;

        // Constant chase upside per pack (secret rarities; doesn't diminish with dupes).
        const raw = await getRawSettings(db);
        let rates = {};
        try { rates = JSON.parse(raw.chase_pull_rates); } catch { /* none */ }
        const priceByRar = {};
        for (const r of set.allRarities || []) priceByRar[r.rarity] = r.avg_price;
        let chaseEv = 0;
        for (const [rar, rate] of Object.entries(rates)) {
          const p = Number(rate), pr = priceByRar[rar];
          if (p > 0 && pr != null) chaseEv += p * pr;
        }

        // Stop point for a given per-pack threshold (min new base cards to be "worth it").
        const stopFor = (thr) => {
          if (thr <= 0) return cap; // every pack worth it -> unbounded (cap)
          let s = opened;
          for (let k = opened + 1; k <= cap; k++) { if (fwd[k] - fwd[k - 1] >= thr) s = k; else break; }
          return s;
        };
        const baseThr = price / avg;                          // base-set value only
        const allInThr = (price - chaseEv) / avg;             // base value + chase upside
        const stop = stopFor(baseThr);
        const allInUnbounded = allInThr <= 0;
        const stopAllIn = allInUnbounded ? cap : stopFor(allInThr);
        const nextMarginal = opened + 1 <= cap ? fwd[opened + 1] - fwd[opened] : 0;

        // Diminishing returns × cumulative premium, anchored to the CHEAPEST RIP.
        // Baseline = the cheapest way to rip an equivalent pack (market price) when we
        // know it, else the historical MSRP. Premium = overpay above that baseline.
        // Break-even = the pack count where cumulative premium (linear: k·premium)
        // overtakes the cumulative value of the NEW base cards those k packs add (fwd
        // flattens — diminishing returns). At/below baseline there's no premium → rip
        // freely. Chase EV is credited ONLY vs MSRP: the market price already embeds
        // chase value, so crediting it again vs market would double-count.
        const msrp = set.pack_msrp != null && set.pack_msrp > 0 ? set.pack_msrp : 5;
        const market = set.pack_market_price != null && set.pack_market_price > 0 ? set.pack_market_price : null;
        const baseline = market != null ? market : msrp;
        const baselineType = market != null ? "rip" : "msrp";
        const premium = Math.round(Math.max(0, price - baseline) * 100) / 100;
        // Treat a price within ~3% (min 10¢) of the cheapest rip as "at the rip" — a
        // few cents over shouldn't read as "rip cheaper elsewhere".
        const tol = Math.max(0.10, Math.round(baseline * 0.03 * 100) / 100);
        const unlimited = premium <= tol;
        const extra = baselineType === "msrp" ? chaseEv : 0; // avoid double-counting chase vs market
        // Largest k≥0 where (fwd[opened+k]−fwd[opened])·avg + k·extra ≥ k·premium.
        // newCardValue(k) is concave-increasing, k·net is linear ⇒ single crossing.
        const breakEvenFor = (ex) => {
          if (unlimited) return { unbounded: true, recommendedMore: Math.max(0, cap - opened) };
          const net = premium - ex;
          if (net <= 0) return { unbounded: true, recommendedMore: Math.max(0, cap - opened) };
          let best = 0;
          for (let k = 1; opened + k <= cap; k++) {
            const newVal = (fwd[opened + k] - fwd[opened]) * avg;
            if (newVal >= k * net) best = k; else break;
          }
          return { unbounded: false, recommendedMore: best };
        };
        const breakEven = breakEvenFor(extra);

        const dr = {
          baseline: Math.round(baseline * 100) / 100,
          baselineType,                       // "rip" (cheapest market rip) | "msrp" (fallback)
          msrp: Math.round(msrp * 100) / 100,
          premiumPerPack: premium,
          unlimited,
          creditsChase: extra > 0,
          market: market != null ? Math.round(market * 100) / 100 : null,
          premiumVsMarket: market != null ? Math.round((price - market) * 100) / 100 : null,
          breakEven,
        };

        return json({
          price,
          avgSingle: Math.round(avg * 100) / 100,
          chaseEv: Math.round(chaseEv * 100) / 100,
          dr,
          opened,
          recommendedMore: Math.max(0, stop - opened),
          stopAtPack: stop,
          recommendedMoreAllIn: Math.max(0, stopAllIn - opened),
          stopAtPackAllIn: stopAllIn,
          allInUnbounded,
          thresholdCardsPerPack: Math.round(baseThr * 100) / 100,
          costPerNewCardNext: nextMarginal > 0 ? Math.round((price / nextMarginal) * 100) / 100 : null,
          baseSetSize: cc.N,
        });
      }
      if (seg.length === 4 && seg[3] === "summary" && method === "GET") {
        const set = await getCachedSet(db, setId);
        if (!set) return json({ error: "Set not imported" }, 404);
        const collection = url.searchParams.get("collection") || "mine";
        return json(await summaryFor(db, set, collection));
      }
      // DELETE /api/sets/:id — untrack a set (blocked when it has orders/packs).
      if (seg.length === 3 && method === "DELETE") {
        if (!(await getCachedSet(db, setId))) return json({ error: "Set not imported" }, 404);
        if (await setHasOrders(db, setId)) {
          return json({ error: "This set has orders or packs — can't remove it. Delete its orders first." }, 409);
        }
        await deleteSet(db, setId);
        return json({ deleted: true });
      }
      // PUT /api/sets/:id/pricing — loose-pack deal pricing
      if (seg.length === 4 && seg[3] === "pricing" && method === "PUT") {
        if (!(await getCachedSet(db, setId))) return json({ error: "Set not imported" }, 404);
        const b = await body();
        return json(await setSetPricing(db, setId, b));
      }
      // POST /api/sets/:id/pricing/refresh — blended market price from multiple sources
      if (seg.length === 5 && seg[3] === "pricing" && seg[4] === "refresh" && method === "POST") {
        const set = await getCachedSet(db, setId);
        if (!set) return json({ error: "Set not imported" }, 404);

        let pc = null, ebay = null, tcg = null;
        try { tcg = await fetchSealedRipPrices(set.name, set.release_date); } catch (e) { tcg = { _err: e.message }; }
        try { pc = await fetchPriceChartingPoints(db, set.name); } catch (e) { pc = { _err: e.message }; }
        try { ebay = await fetchEbayPackPrice(db, set.name); } catch (e) { ebay = { _err: e.message }; }
        const ev = await computeEV(db, set);

        // Market = the TYPICAL going rate: TCGplayer's loose single-pack price (its daily
        // feed is the most current/accurate source we have — it matched manual research).
        // PriceCharting/eBay are shown for context and used only as fallbacks when
        // TCGplayer has no figure. Sleeved is a premium SKU (same cards ~2× price) — excluded.
        const parts = [];
        const px = (v) => (v != null && v > 0 ? v : null);
        const note = (label, v) => { if (px(v) != null) parts.push(`${label} $${v.toFixed(2)}`); };
        note("TCG loose", tcg && tcg.loose);
        note("TCG box/pack", tcg && tcg.boxPerPack);
        note("TCG bundle/pack", tcg && tcg.bundlePerPack);
        note("PC loose", pc && pc.loose);
        note("PC box/pack", pc && pc.boxPerPack);
        if (ebay && ebay.median != null) parts.push(`eBay ~$${ebay.median.toFixed(2)} (n=${ebay.n})`);
        if (pc && pc.sleeved != null) parts.push(`sleeved $${pc.sleeved.toFixed(2)} (excluded)`);
        if (ev != null) parts.push(`EV $${ev.toFixed(2)}`);

        let market, basis;
        if (px(tcg && tcg.loose) != null) { market = tcg.loose; basis = "TCGplayer loose"; }
        else if (px(pc && pc.loose) != null) { market = pc.loose; basis = "PriceCharting loose (no TCGplayer)"; }
        else if (px(tcg && tcg.boxPerPack) != null) { market = tcg.boxPerPack; basis = "TCGplayer box/pack (no loose)"; }
        else if (px(pc && pc.boxPerPack) != null) { market = pc.boxPerPack; basis = "PriceCharting box/pack"; }
        else if (px(pc && pc.sleeved) != null) { market = pc.sleeved; basis = "sleeved only — no regular price"; }
        else if (ev != null) { market = ev; basis = "EV fallback — no sealed price"; }
        if (market == null) {
          return json({ error: "No market price found from any source (TCGCSV/PriceCharting/eBay/EV).", sources: { tcg, pc, ebay, ev } }, 404);
        }
        // Good-deal line = the cheaper efficient rip (box-per-pack), never above market.
        const boxRate = px(tcg && tcg.boxPerPack) || px(pc && pc.boxPerPack);
        market = Math.round(market * 100) / 100;
        const ceiling = Math.round((boxRate != null ? Math.min(boxRate, market) : market) * 100) / 100;
        const saved = await setSetPricing(db, setId, {
          market_price: market,
          ceiling,
          note: `Market $${market.toFixed(2)} (${basis}) · good-deal ≤ $${ceiling.toFixed(2)} · ${parts.join(" · ")}`,
        });
        return json({ ...saved, sources: { tcg, pc, ebay, ev, market, ceiling, basis } });
      }
      // PUT /api/sets/:id/progress
      if (seg.length === 4 && seg[3] === "progress" && method === "PUT") {
        if (!(await getCachedSet(db, setId))) return json({ error: "Set not imported" }, 404);
        const collection = url.searchParams.get("collection") || "mine";
        const b = await body();
        const saved = await setProgress(db, setId, collection, {
          packs_opened: b.packs_opened,
          cards_collected: b.cards_collected,
        });
        return json(saved);
      }
    }

    // /api/estimate/:id
    if (seg[0] === "api" && seg[1] === "estimate" && seg[2] && method === "GET") {
      const set = await getCachedSet(db, decodeURIComponent(seg[2]));
      if (!set) return json({ error: "Set not imported" }, 404);
      const collection = url.searchParams.get("collection") || undefined;
      const opened = url.searchParams.has("opened")
        ? Number(url.searchParams.get("opened"))
        : (await setTotals(db, set.id, collection)).totalPacks;
      const completion = await computeEstimate(db, set, opened);
      if (!completion) return json({ error: "No rarity data for this set" }, 400);
      return json(completion);
    }

    // /api/cards/search?q= — card lookup for tagging promo cards (any set)
    if (pathname === "/api/cards/search" && method === "GET") {
      try { return json(await searchCardsByName(db, url.searchParams.get("q"))); }
      catch (e) { return json({ error: e.message }, 502); }
    }

    // /api/orders ...
    if (pathname === "/api/orders") {
      if (method === "GET") {
        return json(await listOrders(db, url.searchParams.get("set") || undefined, url.searchParams.get("collection") || undefined));
      }
      if (method === "POST") {
        const b = await body();
        if (!b.purchase_date) return json({ error: "purchase_date is required" }, 400);
        const err = validateItems(b.items);
        if (err) return json({ error: err }, 400);
        // Every referenced set (primary + allocations) must be imported.
        for (const sid of collectSetIds(b.items)) {
          if (!(await setExists(db, sid))) return json({ error: `Unknown set_id "${sid}" (import it first)` }, 400);
        }
        return json(await createOrder(db, b), 201);
      }
    }
    if (seg[0] === "api" && seg[1] === "orders" && seg[2]) {
      const id = Number(seg[2]);
      if (method === "GET") {
        const o = await getOrder(db, id);
        return o ? json(o) : json({ error: "Order not found" }, 404);
      }
      if (method === "PUT") {
        if (!(await orderExists(db, id))) return json({ error: "Order not found" }, 404);
        const b = await body();
        if (b.items !== undefined) {
          const err = validateItems(b.items);
          if (err) return json({ error: err }, 400);
          for (const sid of collectSetIds(b.items)) {
            if (!(await setExists(db, sid))) return json({ error: `Unknown set_id "${sid}" (import it first)` }, 400);
          }
        }
        return json(await updateOrder(db, id, b));
      }
      if (method === "DELETE") {
        const ok = await deleteOrder(db, id);
        return ok ? json({ deleted: true }) : json({ error: "Order not found" }, 404);
      }
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    return json({ error: err.message || "Internal error" }, 500);
  }
}
