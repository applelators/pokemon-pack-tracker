import {
  getSettings, updateSettings, getRawSettings,
  listSets, getCachedSet, setExists,
  listOrders, getOrder, createOrder, updateOrder, deleteOrder, orderExists,
  setTotals, getProgress, setProgress, setSetPricing,
} from "./store.js";
import { searchSets, importSet, listSetCards } from "./pokemontcg.js";
import { fetchPackPrice } from "./pricecharting.js";
import { estimate, chaseEstimate } from "./estimator.js";

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

async function computeEstimate(db, set, opened, collected = null) {
  if (!set.rarities || set.rarities.length === 0) return null;
  const raw = await getRawSettings(db);
  let packModel;
  try { packModel = JSON.parse(raw.pack_model); } catch { packModel = { slots: [] }; }
  const runs = Number(raw.monte_carlo_runs) || 3000;
  return estimate({ rarities: set.rarities, packModel, opened, runs, collected });
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
      // POST /api/sets/:id/pricing/refresh — pull live market price from PriceCharting
      if (seg.length === 5 && seg[3] === "pricing" && seg[4] === "refresh" && method === "POST") {
        const set = await getCachedSet(db, setId);
        if (!set) return json({ error: "Set not imported" }, 404);
        let r;
        try { r = await fetchPackPrice(db, set.name); }
        catch (e) { return json({ error: e.message }, 400); }
        if (r.market == null) return json({ error: r.note || "No PriceCharting price found", matched: r }, 404);
        const saved = await setSetPricing(db, setId, {
          market_price: r.market,
          ceiling: r.market,
          note: `PriceCharting: ${r.consoleName} · ${r.productName}`,
        });
        return json({ ...saved, matched: r });
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
