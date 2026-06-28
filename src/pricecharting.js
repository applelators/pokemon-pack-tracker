// PriceCharting client — fetches the loose (sealed) booster-pack market price
// for a set. Requires a paid PriceCharting API token (stored in settings).
import { getRawSettings } from "./store.js";

const BASE = "https://www.pricecharting.com/api";

async function pcProducts(db, query) {
  const token = ((await getRawSettings(db)).pricecharting_api_key || "").trim();
  if (!token) throw new Error("No PriceCharting API key set — add it in Settings.");
  const url = `${BASE}/products?t=${encodeURIComponent(token)}&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    const b = await res.text().catch(() => "");
    throw new Error(`PriceCharting ${res.status}: ${b.slice(0, 120)}`);
  }
  const data = await res.json();
  return data.products || (data["product-name"] ? [data] : []);
}

function pickBoosterPack(products, setName) {
  const sn = (setName || "").toLowerCase();
  const norm = (p) => ({
    id: p.id,
    name: p["product-name"] || "",
    console: p["console-name"] || "",
    loose: p["loose-price"],
    neu: p["new-price"],
  });
  const list = (products || []).map(norm).filter((p) => p.console.toLowerCase().includes("pokemon"));
  // a single loose pack: name has "booster pack" but isn't a box/bundle/case/etc.
  const isPlainPack = (p) => /booster pack/i.test(p.name) && !/(box|bundle|case|sleeved|blister|tin|collection|elite)/i.test(p.name);
  const score = (p) => (isPlainPack(p) ? 2 : 0) + (p.console.toLowerCase().includes(sn) ? 1 : 0);
  list.sort((a, b) => score(b) - score(a));
  return list.find((p) => isPlainPack(p)) || list[0] || null;
}

// Multiple per-pack price points for a set: loose single, sleeved single, and
// per-pack derived from sealed box (÷36) and bundle (÷6).
export async function fetchPriceChartingPoints(db, setName) {
  const products = (await pcProducts(db, `pokemon ${setName} booster`)).map((p) => ({
    name: p["product-name"] || "",
    console: p["console-name"] || "",
    loose: p["loose-price"],
  }));
  const sn = setName.toLowerCase();
  let pool = products.filter((p) => p.console.toLowerCase().includes("pokemon"));
  const scoped = pool.filter((p) => p.console.toLowerCase().includes(sn));
  if (scoped.length) pool = scoped; // prefer products whose console names this set
  const dollars = (c) => (c != null ? Math.round(c) / 100 : null);
  const find = (re, notRe) => pool.find((p) => re.test(p.name) && !(notRe && notRe.test(p.name)));
  const loose = find(/booster pack/i, /(box|bundle|sleeved|case|blister)/i);
  const sleeved = find(/sleeved booster pack/i);
  const box = find(/booster box/i, /case/i);
  const bundle = find(/booster bundle/i);
  return {
    loose: loose ? dollars(loose.loose) : null,
    sleeved: sleeved ? dollars(sleeved.loose) : null,
    boxPerPack: box && box.loose ? Math.round((box.loose / 36)) / 100 : null,
    bundlePerPack: bundle && bundle.loose ? Math.round((bundle.loose / 6)) / 100 : null,
  };
}

// Returns { market, productName, consoleName, productId } or { market:null, note }.
export async function fetchPackPrice(db, setName) {
  const products = await pcProducts(db, `pokemon ${setName} booster pack`);
  const p = pickBoosterPack(products, setName);
  if (!p) return { market: null, note: `No PriceCharting match for "${setName} booster pack".` };
  const cents = p.loose != null ? p.loose : p.neu;
  const market = cents != null ? Math.round(cents) / 100 : null;
  return { market, productName: p.name, consoleName: p.console, productId: p.id };
}
