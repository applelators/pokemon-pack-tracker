// Cloudflare Worker entrypoint.
// /api/* is handled by the D1-backed API; everything else falls through to the
// static assets in public/ (served via the ASSETS binding).
import { handleApi } from "./src/api.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const apiResponse = await handleApi(request, env, url);
    if (apiResponse) return apiResponse;
    return env.ASSETS.fetch(request);
  },
};
