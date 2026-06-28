import {
  getSettings, updateSettings, getRawSettings,
  listSets, getCachedSet, setExists,
  listOrders, getOrder, createOrder, updateOrder, deleteOrder, orderExists,
  setTotals, getProgress, setProgress, setSetPricing,
  getEstimateCache, saveEstimateCache,
} from "./store.js";
import { searchSets, importSet, listSetCards } from "./pokemontcg.js";
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
    if (!it.product_type) return "Each item needs a product_type";
    if (!(Number(it.quantity) > 0)) return "Quantity must be > 0";
    if (!(Number(it.unit_price) >= 0)) return "Unit price must be >= 0";
    if (!(Number(it.packs_per_unit) >= 0)) return "packs_per_unit must be >= 0";
  }
  return null;
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

        // Diminishing returns × cumulative premium: the break-even pack count where
        // the cumulative premium over MSRP (linear: k·premium) overtakes the cumulative
        // value of the NEW base cards those k packs add (fwd flattens — diminishing
        // returns). At/below MSRP there's no premium (unbounded). Computed base-only
        // (strict) and all-in (also counting the constant chase upside per pack).
        const msrp = set.pack_msrp != null && set.pack_msrp > 0 ? set.pack_msrp : 5;
        const premium = Math.round(Math.max(0, price - msrp) * 100) / 100;
        const unlimited = premium <= 0;
        // Largest k≥0 where (fwd[opened+k]−fwd[opened])·avg + k·extra ≥ k·premium.
        // newCardValue(k) is concave-increasing, k·net is linear ⇒ single crossing.
        const breakEven = (extra) => {
          if (unlimited) return { unbounded: true, recommendedMore: Math.max(0, cap - opened) };
          const net = premium - extra;
          if (net <= 0) return { unbounded: true, recommendedMore: Math.max(0, cap - opened) };
          let best = 0;
          for (let k = 1; opened + k <= cap; k++) {
            const newVal = (fwd[opened + k] - fwd[opened]) * avg;
            if (newVal >= k * net) best = k; else break;
          }
          return { unbounded: false, recommendedMore: best };
        };
        const market = set.pack_market_price;
        const dr = {
          msrp: Math.round(msrp * 100) / 100,
          premiumPerPack: premium,
          unlimited,
          market: market != null && market > 0 ? Math.round(market * 100) / 100 : null,
          premiumVsMarket: market != null && market > 0 ? Math.round((price - market) * 100) / 100 : null,
          baseBreakEven: breakEven(0),         // premium vs new base-card value only
          allInBreakEven: breakEven(chaseEv),  // also counts ~chaseEv/pack chase upside
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
        const totals = await setTotals(db, setId, collection);
        const progress = await getProgress(db, setId, collection);
        // Actuals override assumptions: opened defaults to packs bought; collected is optional.
        const packsOpened = progress.packs_opened != null
          ? Math.min(progress.packs_opened, totals.totalPacks)
          : totals.totalPacks;
        const completion = await computeEstimate(db, set, packsOpened, progress.cards_collected);
        const chase = await computeChase(db, set);
        const packEv = await computeEV(db, set);
        return json({ set, ...totals, packsBought: totals.totalPacks, packsOpened, progress, completion, chase, packEv });
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

        // "Market" = the cheapest way to rip an equivalent REGULAR pack: the lowest of
        // loose single, box-per-pack, and bundle-per-pack across TCGplayer (via TCGCSV),
        // PriceCharting, and eBay loose singles. Sleeved is a premium SKU (same cards,
        // ~2× price) — shown for context but excluded so it can't inflate the deal check.
        const parts = [];
        const rip = []; // regular single-pack-equivalent rip prices
        const add = (label, v) => { if (v != null && v > 0) { rip.push(v); parts.push(`${label} $${v.toFixed(2)}`); } };
        add("TCG loose", tcg && tcg.loose);
        add("TCG box/pack", tcg && tcg.boxPerPack);
        add("TCG bundle/pack", tcg && tcg.bundlePerPack);
        add("PC loose", pc && pc.loose);
        add("PC box/pack", pc && pc.boxPerPack);
        add("PC bundle/pack", pc && pc.bundlePerPack);
        if (ebay && ebay.median != null) { rip.push(ebay.median); parts.push(`eBay ~$${ebay.median.toFixed(2)} (n=${ebay.n})`); }
        if (pc && pc.sleeved != null) parts.push(`sleeved $${pc.sleeved.toFixed(2)} (excluded)`);
        if (ev != null) parts.push(`EV $${ev.toFixed(2)}`);

        let market, basis;
        if (rip.length) { market = Math.min(...rip); basis = "cheapest rip"; }
        else if (pc && pc.sleeved != null) { market = pc.sleeved; basis = "sleeved only — no regular price"; }
        else if (ev != null) { market = ev; basis = "EV fallback — no sealed price"; }
        if (market == null) {
          return json({ error: "No market price found from any source (TCGCSV/PriceCharting/eBay/EV).", sources: { tcg, pc, ebay, ev } }, 404);
        }
        market = Math.round(market * 100) / 100;
        const saved = await setSetPricing(db, setId, {
          market_price: market,
          ceiling: market,
          note: `Cheapest rip $${market.toFixed(2)} (${basis}) · ${parts.join(" · ")}`,
        });
        return json({ ...saved, sources: { tcg, pc, ebay, ev, market, basis } });
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

    // /api/orders ...
    if (pathname === "/api/orders") {
      if (method === "GET") {
        return json(await listOrders(db, url.searchParams.get("set") || undefined, url.searchParams.get("collection") || undefined));
      }
      if (method === "POST") {
        const b = await body();
        if (!b.set_id) return json({ error: "set_id is required" }, 400);
        if (!b.purchase_date) return json({ error: "purchase_date is required" }, 400);
        if (!(await setExists(db, b.set_id))) return json({ error: "Unknown set_id (import it first)" }, 400);
        const err = validateItems(b.items);
        if (err) return json({ error: err }, 400);
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
