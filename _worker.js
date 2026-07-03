// Cloudflare Worker entrypoint.
// /api/* is handled by the D1-backed API; everything else falls through to the
// static assets in public/ (served via the ASSETS binding).
import { handleApi } from "./src/api.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      // Last-resort guard: never let an API error escape as an opaque CF 1101 page.
      try {
        const apiResponse = await handleApi(request, env, url);
        if (apiResponse) return apiResponse;
      } catch (e) {
        return new Response(JSON.stringify({ error: String((e && e.message) || e), transient: true }), {
          status: 503, headers: { "Content-Type": "application/json" },
        });
      }
    }
    return env.ASSETS.fetch(request);
  },
};
