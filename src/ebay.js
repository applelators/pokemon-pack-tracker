// eBay Browse API — median asking price of single loose booster packs for a set.
// Needs a free eBay developer app: client id + secret in settings.
import { getRawSettings } from "./store.js";

async function appToken(db) {
  const s = await getRawSettings(db);
  const id = (s.ebay_client_id || "").trim();
  const secret = (s.ebay_client_secret || "").trim();
  if (!id || !secret) return null;
  const res = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + btoa(`${id}:${secret}`),
    },
    body: "grant_type=client_credentials&scope=" + encodeURIComponent("https://api.ebay.com/oauth/api_scope"),
  });
  if (!res.ok) {
    const b = await res.text().catch(() => "");
    throw new Error(`eBay auth ${res.status}: ${b.slice(0, 120)}`);
  }
  return (await res.json()).access_token;
}

// Median asking price of single-pack listings (filters out boxes/bundles/lots).
export async function fetchEbayPackPrice(db, setName) {
  const token = await appToken(db);
  if (!token) return null;
  const q = `pokemon ${setName} booster pack`;
  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&filter=buyingOptions:%7BFIXED_PRICE%7D&limit=50`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" },
  });
  if (!res.ok) {
    const b = await res.text().catch(() => "");
    throw new Error(`eBay ${res.status}: ${b.slice(0, 120)}`);
  }
  const items = (await res.json()).itemSummaries || [];
  const EXCLUDE = /(box|bundle|lot|case|etb|elite|collection|tin|booster\s*display|\bx\s?\d|\d+\s*pack)/i;
  const prices = items
    .filter((i) => /booster pack/i.test(i.title || "") && !EXCLUDE.test(i.title || ""))
    .map((i) => Number(i.price && i.price.value))
    .filter((v) => v > 0 && v < 1000);
  if (!prices.length) return null;
  prices.sort((a, b) => a - b);
  const m = Math.floor(prices.length / 2);
  const median = prices.length % 2 ? prices[m] : (prices[m - 1] + prices[m]) / 2;
  return { median: Math.round(median * 100) / 100, n: prices.length };
}
