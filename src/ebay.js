// eBay Browse API — median asking price of single loose booster packs for a set.
// Needs a free eBay developer app: client id + secret in settings.
import { getRawSettings } from "./store.js";

export async function ebayAppToken(db) { return appToken(db); }

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

// Junk listings that poison a product-price median regardless of product type.
const JUNK = /(japanese|korean|chinese|empty|no\s*packs?|opened|resealed|damaged|custom|proxy|repack|box only|art only|read desc|\blots?\b|bulk)/i;
// For single-pack queries, also reject anything bigger than one pack (x10 lots,
// boxes, bundles…) — same guard fetchEbayPackPrice uses. Only applied when the
// query itself ends in "booster pack", so "3 Pack Blister" queries stay unharmed.
const MULTI = /(box|bundle|case|etb|elite|collection|tin|display|blister|\bx\s*\d|\d+\s*(packs?|ct|count)\b)/i;

// Median asking price for ONE sealed product (query = product name). Asking ≠ sold:
// callers must label this "ask". Returns { median, n } or null when nothing usable.
export async function fetchEbayAskPrice(token, query) {
  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent("pokemon " + query)}&filter=buyingOptions:%7BFIXED_PRICE%7D&limit=25`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" },
  });
  if (!res.ok) throw new Error(`eBay ${res.status}`);
  const items = (await res.json()).itemSummaries || [];
  // Require the product's most distinctive tokens in the title (words ≥ 4 chars,
  // ignoring brackets/punctuation) so "Chaos Rising ETB" hits don't count for packs.
  const need = (query.toLowerCase().match(/[a-z]{4,}/g) || []).slice(0, 4);
  const singlePack = /booster pack$/i.test(query.trim());
  const prices = items
    .filter((i) => {
      const t = (i.title || "").toLowerCase();
      return !JUNK.test(t) && !(singlePack && MULTI.test(t)) && need.every((w) => t.includes(w));
    })
    .map((i) => Number(i.price && i.price.value))
    .filter((v) => v > 2 && v < 5000);
  if (!prices.length) return null;
  prices.sort((a, b) => a - b);
  const m = Math.floor(prices.length / 2);
  const median = prices.length % 2 ? prices[m] : (prices[m - 1] + prices[m]) / 2;
  return { median: Math.round(median * 100) / 100, n: prices.length };
}

// One listing by its public item number (the number in an ebay.com/itm/ URL).
export async function fetchEbayItem(db, legacyId) {
  const token = await appToken(db);
  if (!token) return { error: "eBay keys not configured" };
  const res = await fetch(`https://api.ebay.com/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${encodeURIComponent(legacyId)}`, {
    headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" },
  });
  const d = await res.json();
  if (!res.ok) return { error: `eBay ${res.status}`, detail: d.errors };
  return {
    title: d.title, price: d.price, condition: d.condition,
    seller: d.seller && { username: d.seller.username, feedbackPercentage: d.seller.feedbackPercentage, feedbackScore: d.seller.feedbackScore },
    shipping: (d.shippingOptions || []).map((o) => o.shippingCost && o.shippingCost.value),
    location: d.itemLocation, returnsAccepted: d.returnTerms && d.returnTerms.returnsAccepted,
    topRated: d.topRatedBuyingExperience, availability: d.estimatedAvailabilities,
    shortDescription: d.shortDescription, itemWebUrl: d.itemWebUrl,
  };
}

// Raw fixed-price search results incl. seller reputation (deal-scan tooling).
export async function fetchEbaySearch(db, q, limit = 50) {
  const token = await appToken(db);
  if (!token) return { error: "eBay keys not configured" };
  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&filter=${encodeURIComponent("buyingOptions:{FIXED_PRICE},itemLocationCountry:US")}&limit=${limit}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" } });
  const d = await res.json();
  if (!res.ok) return { error: `eBay ${res.status}`, detail: d.errors };
  return {
    total: d.total,
    items: (d.itemSummaries || []).map((i) => ({
      title: i.title, price: i.price && Number(i.price.value),
      shipping: i.shippingOptions && i.shippingOptions[0] && i.shippingOptions[0].shippingCost ? Number(i.shippingOptions[0].shippingCost.value) : null,
      condition: i.condition,
      seller: i.seller && { username: i.seller.username, pct: Number(i.seller.feedbackPercentage), score: i.seller.feedbackScore },
      itemId: i.legacyItemId, url: i.itemWebUrl,
    })),
  };
}

// A seller's current fixed-price listings (for "is anything in this store a deal?").
export async function fetchEbaySellerListings(db, username, q) {
  const token = await appToken(db);
  if (!token) return { error: "eBay keys not configured" };
  const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q || "pokemon")}&filter=${encodeURIComponent(`sellers:{${username}},buyingOptions:{FIXED_PRICE}`)}&limit=200`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" } });
  const d = await res.json();
  if (!res.ok) return { error: `eBay ${res.status}`, detail: d.errors };
  return {
    total: d.total,
    items: (d.itemSummaries || []).map((i) => ({
      title: i.title, price: i.price && i.price.value, shipping: i.shippingOptions && i.shippingOptions[0] && i.shippingOptions[0].shippingCost && i.shippingOptions[0].shippingCost.value,
      condition: i.condition, itemId: i.legacyItemId, url: i.itemWebUrl,
    })),
  };
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
