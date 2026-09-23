// Cloudflare Pages Function — serve WGB game bundles from an R2 bucket.
//
// A WGB is a store-only ZIP read by random access, so the guest issues HTTP Range
// reads: partial responses (206) + `Accept-Ranges` are mandatory, or streaming breaks.
//
// The responses are CORS-enabled and carry `Cross-Origin-Resource-Policy: cross-origin`
// so a bundle can be fetched by a BottleShip instance on ANOTHER origin. The app page is
// cross-origin isolated (COOP/COEP `require-corp`, needed for SharedArrayBuffer), and
// under `require-corp` a cross-origin subresource must opt in through CORP or CORS —
// without these headers the fetch fails with no useful error. `Range` is not a
// CORS-safelisted request header, so a cross-origin range read preflights: OPTIONS is
// answered below.
//
// Setup: bind an R2 bucket to the Pages project as `APPS`
// (Settings → Bindings → R2 bucket). Object keys are the bundle filenames from
// the catalog's wgbUrl, e.g. `/apps/re-volt-demo.wgb` → R2 key `re-volt-demo.wgb`.
//
// Access control (optional): set the Pages secret `APPS_TOKEN`. With it set, every
// request must present that token, as `?token=<value>` or `Authorization: Bearer
// <value>`; without it the bucket stays public, which is what the open deployment
// wants. The query form is what the emulator can actually use end-to-end — the loader
// fetches the URL it was given, and the token rides along through redirects, Range
// reads and the OPFS cache key (which ignores the query string).

interface Env {
  APPS: R2Bucket;
  /** Shared access token. Unset = public bucket. */
  APPS_TOKEN?: string;
}

/** Early-exit-free comparison, so a wrong token can't be recovered one character at a time. */
function secretEquals(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function presentedToken(request: Request, url: URL): string | null {
  const query = url.searchParams.get("token");
  if (query) return query;
  const auth = request.headers.get("Authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return bearer ? bearer[1]! : null;
}

/** Headers every response carries, including the errors (else the browser reports a CORS failure instead of the 401). */
function baseHeaders(): Headers {
  const headers = new Headers();
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Cross-Origin-Resource-Policy", "cross-origin");
  headers.set("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range, ETag");
  return headers;
}

export const onRequest: PagesFunction<Env> = async ({ params, request, env }) => {
  const headers = baseHeaders();

  if (request.method === "OPTIONS") {
    headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Range, Authorization");
    headers.set("Access-Control-Max-Age", "86400");
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    headers.set("Allow", "GET, HEAD, OPTIONS");
    return new Response("Method Not Allowed", { status: 405, headers });
  }

  const url = new URL(request.url);

  if (env.APPS_TOKEN) {
    const token = presentedToken(request, url);
    if (!token || !secretEquals(token, env.APPS_TOKEN)) {
      headers.set("WWW-Authenticate", 'Bearer realm="bottleship-apps"');
      // A token-gated bucket must not confirm which bundles exist, so this is the same
      // response for a wrong token and a missing object.
      return new Response("Unauthorized", { status: 401, headers });
    }
    // A gated bundle is per-recipient: keep it out of shared caches.
    headers.set("Cache-Control", "private, max-age=3600");
  } else {
    headers.set("Cache-Control", "public, max-age=3600");
  }

  const segments = Array.isArray(params.path) ? params.path : [params.path];
  const key = segments.join("/");

  headers.set("Accept-Ranges", "bytes");

  // HEAD — metadata only (a range source probes the total size first).
  if (request.method === "HEAD") {
    const meta = await env.APPS.head(key);
    if (!meta) return new Response(null, { status: 404, headers });
    meta.writeHttpMetadata(headers);
    headers.set("Content-Length", String(meta.size));
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/octet-stream");
    return new Response(null, { status: 200, headers });
  }

  // Single-range parse: `bytes=start-end`, `bytes=start-`, `bytes=-suffix`.
  const rangeHeader = request.headers.get("Range");
  const m = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
  let range: R2Range | undefined;
  if (m && !(m[1] === "" && m[2] === "")) {
    range = m[1] === ""
      ? { suffix: Number(m[2]) }
      : { offset: Number(m[1]), length: m[2] === "" ? undefined : Number(m[2]) - Number(m[1]) + 1 };
  }

  const obj = await env.APPS.get(key, range ? { range } : undefined);
  if (!obj) return new Response("Not found", { status: 404, headers });

  obj.writeHttpMetadata(headers);
  if (!headers.has("Content-Type")) headers.set("Content-Type", "application/octet-stream");
  headers.set("ETag", obj.httpEtag);

  const total = obj.size; // full object size (not the served slice)
  const served = obj.range as { offset?: number; length?: number; suffix?: number } | undefined;
  if (range && served) {
    const offset = served.offset ?? total - (served.suffix ?? 0);
    const length = served.length ?? total - offset;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${total}`);
    headers.set("Content-Length", String(length));
    return new Response(obj.body, { status: 206, headers });
  }

  headers.set("Content-Length", String(total));
  return new Response(obj.body, { status: 200, headers });
};
