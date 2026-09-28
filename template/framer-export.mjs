#!/usr/bin/env node
// Export a published Framer site into a self-contained static folder.
//
//   node framer-export.mjs https://yoursite.framer.website --out ./my-site
//
// It crawls every page it can find (sitemap.xml + in-page links), downloads
// every asset the pages, stylesheets and JS modules reference (images, fonts,
// videos, CSS, the Framer runtime and page chunks), and rewrites all of those
// URLs to local relative paths. Zero dependencies, Node 18+.

import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { parseArgs } from "node:util";

const HELP = `Usage: node framer-export.mjs <site-url> [options]

Options:
  --out <dir>          Output folder (default: ./<hostname>)
  --static             Strip all JavaScript. Pure HTML/CSS; no animations,
                       hover effects, menus, carousels or CMS search.
  --max-pages <n>      Stop after n pages (default 500)
  --concurrency <n>    Parallel downloads (default 8)
  --base-path <path>   Where the site will live on its new host (default: /)
  --extra-host <host>  Also treat this host as an asset CDN (repeatable)
  --keep-analytics     Keep Framer's analytics / editor-bar scripts
  -h, --help           Show this help
`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" },
    static: { type: "boolean", default: false },
    "max-pages": { type: "string", default: "500" },
    concurrency: { type: "string", default: "8" },
    "extra-host": { type: "string", multiple: true, default: [] },
    "base-path": { type: "string", default: "/" },
    "keep-analytics": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (opts.help || positionals.length !== 1) {
  process.stdout.write(HELP);
  process.exit(opts.help ? 0 : 1);
}

let siteUrl = positionals[0];
if (!/^https?:\/\//.test(siteUrl)) siteUrl = "https://" + siteUrl;
let SITE = new URL(siteUrl);
// Follow redirects first (e.g. example.com -> www.example.com) so every link
// on the site counts as same-origin.
try {
  const res = await fetch(SITE, { redirect: "follow" });
  if (res.url) SITE = new URL(res.url);
} catch {}
const ORIGIN = SITE.origin;
const OUT = path.resolve(opts.out || SITE.hostname);
const MAX_PAGES = Number(opts["max-pages"]);
const BASE_PATH = ("/" + opts["base-path"] + "/").replace(/\/+/g, "/");
const CONCURRENCY = Number(opts.concurrency);
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Hosts whose files get downloaded and served locally.
const ASSET_HOST_SUFFIXES = [
  "framerusercontent.com",
  "framerstatic.com",
  "framercdn.com",
  "fonts.gstatic.com",
  "fonts.googleapis.com",
  ...opts["extra-host"],
];
// Scripts that only make sense on Framer's hosting.
const DROP_SCRIPT_PATTERNS = [/events\.framer\.com/, /framer\.com\/edit/, /framer\.com\/m\/feedback/];

const isAssetHost = (host) =>
  ASSET_HOST_SUFFIXES.some((s) => host === s || host.endsWith("." + s));

// ---------------------------------------------------------------- state

/** url -> { local, kind, status, contentType, body?: string } */
const resources = new Map();
const pageQueue = [];
const assetQueue = [];
const failures = [];
let pageCount = 0;

const EXT_BY_TYPE = {
  "text/css": ".css",
  "text/html": ".html",
  "application/javascript": ".js",
  "text/javascript": ".js",
  "application/json": ".json",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/gif": ".gif",
  "image/svg+xml": ".svg",
  "image/x-icon": ".ico",
  "font/woff2": ".woff2",
  "font/woff": ".woff",
  "font/ttf": ".ttf",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
};

// ---------------------------------------------------------------- helpers

function normalizeUrl(raw, base) {
  try {
    const u = new URL(raw.replace(/&amp;/g, "&").replace(/\\\//g, "/"), base);
    u.hash = "";
    return u;
  } catch {
    return null;
  }
}

function pageLocalPath(u) {
  let p = decodeURIComponent(u.pathname).replace(/\/+$/, "");
  if (p === "") return "index.html";
  if (/\.html?$/.test(p)) return p.slice(1);
  return p.slice(1) + "/index.html";
}

function assetLocalPath(u, contentType) {
  let p = decodeURIComponent(u.pathname);
  if (p.endsWith("/")) p += "index";
  let ext = path.posix.extname(p);
  let stem = ext ? p.slice(0, -ext.length) : p;
  if (!ext && contentType) ext = EXT_BY_TYPE[contentType.split(";")[0].trim()] || "";
  if (u.search) stem += "__" + crypto.createHash("sha1").update(u.search).digest("hex").slice(0, 8);
  // Keep paths filesystem-safe.
  stem = stem.replace(/[^A-Za-z0-9._\-\/]/g, "_");
  return path.posix.join("assets", u.host.replace(/:/g, "_"), stem + ext);
}

// CSS url() resolves against the stylesheet, so it can use a relative path.
// Everything else is root-relative: URLs inside JS resolve against whatever
// page is showing, and Framer switches pages client-side without reloading.
function localRef(fromLocal, toLocal, kind) {
  if (kind !== "css") return BASE_PATH + toLocal;
  const r = path.posix.relative(path.posix.dirname(fromLocal), toLocal);
  return r.startsWith(".") ? r : "./" + r;
}

async function fetchWithRetry(url, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow" });
      if (res.status === 429 || res.status >= 500) throw new Error("HTTP " + res.status);
      return res;
    } catch (err) {
      if (i >= tries) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
}

const isTextType = (ct) => /text\/|javascript|json|xml|svg/.test(ct || "");

// ---------------------------------------------------------------- discovery

// Absolute URLs on asset hosts, including JSON-escaped ones (https:\/\/...).
const ABS_URL_RE =
  /https?:(?:\\?\/){2}([a-z0-9.-]+\.[a-z]{2,}(?::\d+)?)((?:\\?\/[A-Za-z0-9._~%@+\-]+)*\\?\/?)(\?[A-Za-z0-9._~%=&;+,:@|\-]*)?/gi;
// Relative module specifiers / file references inside JS and CSS.
const REL_SPEC_RE =
  /(["'`])(\.{1,2}\/[A-Za-z0-9._~%@+\-\/]+\.(?:m?js|json|css|wasm|woff2?|ttf|otf|png|jpe?g|webp|avif|gif|svg|mp4|webm))\1/g;
const CSS_URL_RE = /url\(\s*(["']?)([^"')]+)\1\s*\)/g;
const CSS_IMPORT_RE = /@import\s+(["'])([^"']+)\1/g;
// Framer CMS data: new URL(`./X.framercms`, `<module url>`).href.replace(`/modules/`, `/cms/`)
const CMS_URL_RE = /new URL\(`(\.\/[^`]+\.framercms)`,`([^`]+)`\)/g;
// Framer's client-side route table: page:…(()=>import(`./page.mjs`)),path:`/terms`
const ROUTE_PATH_RE = /(\)\),path:`)\/([^`]*)`/g;
const HTML_ATTR_RE = /\s(src|href|srcset|poster|content|data-src)\s*=\s*(["'])(.*?)\2/gis;

function looksLikeFile(u) {
  return /\.[a-z0-9]{2,5}$/i.test(u.pathname) || u.host.startsWith("fonts.googleapis");
}

function enqueueAsset(u, force = false) {
  if (!u || !/^https?:$/.test(u.protocol)) return;
  const key = u.href;
  if (resources.has(key)) return;
  const sameOrigin = u.origin === ORIGIN;
  if (!isAssetHost(u.hostname) && !sameOrigin) return;
  if (!force && !looksLikeFile(u) && !u.search) return; // bare prefixes like ".../images/"
  if (sameOrigin && /\.html?$/.test(u.pathname)) return;
  resources.set(key, { kind: "asset", local: null });
  assetQueue.push(key);
}

function enqueuePage(u) {
  if (!u || u.origin !== ORIGIN) return;
  u.search = "";
  const key = u.href.replace(/\/+$/, "") || u.href;
  if (resources.has(key)) return;
  if (looksLikeFile(u) && !/\.html?$/.test(u.pathname)) return enqueueAsset(u);
  if (pageCount >= MAX_PAGES) return;
  pageCount++;
  resources.set(key, { kind: "page", local: pageLocalPath(u) });
  pageQueue.push(key);
}

function discoverInText(text, baseUrl, kind) {
  for (const m of text.matchAll(ABS_URL_RE)) {
    const u = normalizeUrl(m[0], baseUrl);
    if (u && u.origin !== ORIGIN) enqueueAsset(u);
  }
  if (kind === "js" || kind === "css") {
    for (const m of text.matchAll(REL_SPEC_RE)) {
      // Bundles mention source paths like "./node_modules/x/index.js" that are never fetched.
      if (!m[2].includes("node_modules/")) enqueueAsset(normalizeUrl(m[2], baseUrl));
    }
  }
  if (kind === "js") {
    for (const m of text.matchAll(CMS_URL_RE)) {
      const u = normalizeUrl(m[1], m[2]);
      if (u) enqueueAsset(new URL(u.href.replace("/modules/", "/cms/")), true);
    }
  }
  if (kind === "css" || kind === "html") {
    for (const m of text.matchAll(CSS_URL_RE)) {
      if (!m[2].startsWith("data:")) enqueueAsset(normalizeUrl(m[2], baseUrl));
    }
    for (const m of text.matchAll(CSS_IMPORT_RE)) enqueueAsset(normalizeUrl(m[2], baseUrl));
  }
  if (kind === "html") {
    for (const m of text.matchAll(HTML_ATTR_RE)) {
      const [, attr, , value] = m;
      if (/^(data:|mailto:|tel:|javascript:|#)/i.test(value)) continue;
      if (attr === "srcset") {
        for (const part of value.split(",")) enqueueAsset(normalizeUrl(part.trim().split(/\s+/)[0], baseUrl));
        continue;
      }
      const u = normalizeUrl(value, baseUrl);
      if (!u) continue;
      if (attr === "href" && u.origin === ORIGIN && !looksLikeFile(u)) enqueuePage(u);
      else if (attr !== "content" || /^https?:|^\//.test(value)) enqueueAsset(u);
    }
  }
}

async function loadSitemap() {
  const seen = new Set();
  async function walk(url) {
    if (seen.has(url) || seen.size > 50) return;
    seen.add(url);
    try {
      const res = await fetchWithRetry(url);
      if (!res.ok) return;
      const xml = await res.text();
      for (const m of xml.matchAll(/<sitemap>\s*<loc>(.*?)<\/loc>/g)) await walk(m[1].trim());
      for (const m of xml.matchAll(/<url>\s*<loc>(.*?)<\/loc>/g)) {
        const u = normalizeUrl(m[1].trim(), ORIGIN);
        // Sitemaps often list the custom domain; map it onto the URL we crawl.
        if (u) enqueuePage(new URL(u.pathname, ORIGIN));
      }
    } catch {}
  }
  await walk(ORIGIN + "/sitemap.xml");
}

// ---------------------------------------------------------------- download

async function processPage(key) {
  const r = resources.get(key);
  try {
    const res = await fetchWithRetry(key);
    const ct = res.headers.get("content-type") || "";
    const isNotFoundPage = key === ORIGIN + "/404";
    if ((!res.ok && !isNotFoundPage) || !ct.includes("html")) {
      r.status = res.status;
      if (!isNotFoundPage) failures.push(`${key} (page, HTTP ${res.status})`);
      r.skip = true;
      return;
    }
    r.body = await res.text();
    r.contentType = ct;
    discoverInText(r.body, key, "html");
    log(`page  ${r.local}`);
  } catch (err) {
    failures.push(`${key} (page, ${err.message})`);
    r.skip = true;
  }
}

async function processAsset(key) {
  const r = resources.get(key);
  try {
    const res = await fetchWithRetry(key);
    if (!res.ok) {
      failures.push(`${key} (HTTP ${res.status})`);
      r.skip = true;
      return;
    }
    const ct = res.headers.get("content-type") || "";
    const u = new URL(key);
    r.contentType = ct;
    r.local = assetLocalPath(u, ct);
    // CMS data is binary even though the CDN labels it application/javascript.
    const kind = u.pathname.endsWith(".framercms") ? "binary"
      : /css/.test(ct) || u.pathname.endsWith(".css") ? "css"
      : /javascript/.test(ct) || /\.m?js$/.test(u.pathname) ? "js" : "other";
    r.assetKind = kind;
    if (kind !== "binary" && (isTextType(ct) || kind !== "other")) {
      r.body = await res.text();
      if (kind !== "other") discoverInText(r.body, key, kind);
      else discoverInText(r.body, key, "json");
    } else {
      r.bytes = Buffer.from(await res.arrayBuffer());
    }
  } catch (err) {
    failures.push(`${key} (${err.message})`);
    r.skip = true;
  }
}

async function drain() {
  const active = new Set();
  while (pageQueue.length || assetQueue.length || active.size) {
    while (active.size < CONCURRENCY && (pageQueue.length || assetQueue.length)) {
      const p = pageQueue.length ? processPage(pageQueue.shift()) : processAsset(assetQueue.shift());
      active.add(p);
      p.finally(() => active.delete(p));
    }
    if (active.size) await Promise.race(active);
    const done = [...resources.values()].filter((r) => r.local && (r.body || r.bytes || r.skip)).length;
    progress(`downloaded ${done} of ${resources.size} files`);
  }
}

// ---------------------------------------------------------------- rewrite

function rewriteText(text, fromLocal, baseUrl, kind) {
  const lookup = (raw) => {
    const u = normalizeUrl(raw, baseUrl);
    if (!u) return null;
    const r = resources.get(u.href);
    return r && r.local && !r.skip ? localRef(fromLocal, r.local, kind) : null;
  };

  text = text.replace(ABS_URL_RE, (m) => {
    const rel = lookup(m);
    if (!rel) return m;
    return m.includes("\\/") ? rel.replace(/\//g, "\\/") : rel;
  });

  if (kind === "js") {
    // A root-relative path isn't a valid URL base; resolve it against the page.
    text = text.replace(CMS_URL_RE, (m, rel, base) =>
      base.startsWith("/") ? `new URL(\`${rel}\`,new URL(\`${base}\`,location.href))` : m
    );
    // Framer's router matches and builds page URLs from these paths, so they
    // must include the base path or in-site links break on a subfolder host.
    if (BASE_PATH !== "/") {
      text = text.replace(ROUTE_PATH_RE, (m, head, rest) => `${head}${BASE_PATH}${rest}\``);
    }
  }

  if (kind === "css" || kind === "html") {
    text = text.replace(CSS_URL_RE, (m, q, v) => {
      const rel = v.startsWith("data:") ? null : lookup(v);
      return rel ? `url(${q}${rel}${q})` : m;
    });
  }

  if (kind === "html") {
    text = text.replace(HTML_ATTR_RE, (m, attr, q, value) => {
      if (/^(data:|mailto:|tel:|javascript:|#)/i.test(value)) return m;
      if (attr === "srcset") {
        const parts = value.split(",").map((part) => {
          const [src, ...rest] = part.trim().split(/\s+/);
          const rel = lookup(src);
          return [rel || src, ...rest].join(" ");
        });
        return ` ${attr}=${q}${parts.join(", ")}${q}`;
      }
      const u = normalizeUrl(value, baseUrl);
      if (!u) return m;
      // Same-origin page links (Framer writes them as "./about"): make them
      // root-relative so they resolve the same from /about and /about/.
      if (attr === "href" && u.origin === ORIGIN && !looksLikeFile(u)) {
        const hash = value.includes("#") ? value.slice(value.indexOf("#")) : "";
        return ` ${attr}=${q}${BASE_PATH.slice(0, -1)}${u.pathname}${u.search}${hash}${q}`;
      }
      const rel = lookup(value);
      return rel ? ` ${attr}=${q}${rel}${q}` : m;
    });
  }
  return text;
}

// Framer's CDN serves CMS data in byte slices (x.framercms?range=0-99,200-299).
// Static hosts ignore the query, so answer those requests from the whole file.
const CMS_RANGE_SHIM = `<script>(()=>{const f=window.fetch.bind(window),c=new Map;` +
  `window.fetch=async(i,o)=>{const u=new URL(i instanceof Request?i.url:String(i),location.href),r=u.searchParams.get("range");` +
  `if(!r||!u.pathname.endsWith(".framercms"))return f(i,o);u.searchParams.delete("range");const k=u.href;` +
  `if(!c.has(k))c.set(k,f(k).then(x=>{if(!x.ok)throw Error("HTTP "+x.status);return x.arrayBuffer()}).then(b=>new Uint8Array(b)));` +
  `let b;try{b=await c.get(k)}catch(e){c.delete(k);throw e}` +
  `const p=r.split(",").map(s=>s.split("-").map(Number)),out=new Uint8Array(p.reduce((n,[s,e])=>n+e-s+1,0));` +
  `let at=0;for(const[s,e]of p){out.set(b.subarray(s,e+1),at);at+=e-s+1}` +
  `return new Response(out,{status:200,headers:{"content-type":"application/octet-stream"}})}})()</script>`;

function cleanHtml(html) {
  if (!opts["keep-analytics"]) {
    html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (tag) =>
      DROP_SCRIPT_PATTERNS.some((re) => re.test(tag)) ? "" : tag
    );
  }
  if (!opts.static) {
    html = html.replace(/<head\b[^>]*>/i, (m) => m + CMS_RANGE_SHIM);
  }
  if (opts.static) {
    html = html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (tag) =>
        /type=["']application\/(ld\+)?json["']/.test(tag) ? tag : ""
      )
      .replace(/<link\b[^>]*rel=["']modulepreload["'][^>]*>/gi, "");
    // Framer hides "appear" animated elements until JS runs; show them instead.
    html = html.replace(/<[a-z][^>]*data-framer-appear-id[^>]*>/gi, (tag) =>
      tag.replace(/style=(["'])(.*?)\1/i, (m, q, css) => {
        const kept = css
          .split(";")
          .filter((d) => !/^\s*(opacity|transform|will-change)\s*:/i.test(d))
          .join(";");
        return `style=${q}${kept}${q}`;
      })
    );
  }
  return html;
}

async function writeOutput() {
  await rm(OUT, { recursive: true, force: true });
  let files = 0;
  for (const [url, r] of resources) {
    if (r.skip || !r.local) continue;
    // Static pages reference no scripts, so don't ship them.
    if (opts.static && r.assetKind === "js") continue;
    let data;
    if (r.kind === "page") {
      data = rewriteText(cleanHtml(r.body), r.local, url, "html");
    } else if (r.body !== undefined) {
      data = rewriteText(r.body, r.local, url, r.assetKind === "other" ? "json" : r.assetKind);
    } else {
      data = r.bytes;
    }
    const dest = path.join(OUT, r.local);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, data);
    files++;
  }
  // Framer serves /404 as the not-found page; most static hosts look for 404.html.
  const nf = resources.get(ORIGIN + "/404");
  if (nf && !nf.skip) {
    await writeFile(path.join(OUT, "404.html"), rewriteText(cleanHtml(nf.body), "404.html", ORIGIN + "/404", "html"));
  }
  const pages = [...resources.values()].filter((r) => r.kind === "page" && !r.skip).map((r) => r.local);
  const home = [...resources.values()].find((r) => r.kind === "page" && r.local === "index.html" && !r.skip);
  const framer = {
    ...framerInfo(home?.body || ""),
    cmsFiles: [...resources.keys()].filter((k) => new URL(k).pathname.endsWith(".framercms") && !resources.get(k).skip).length,
  };
  await writeFile(
    path.join(OUT, "export-report.json"),
    JSON.stringify(
      { source: ORIGIN, exportedAt: new Date().toISOString(), mode: opts.static ? "static" : "interactive", framer, pages, files, failures },
      null,
      2
    )
  );
  return { files, pages };
}

/** What Framer stamps into every published page: its build and when the site was published. */
function framerInfo(html) {
  const meta = html.match(/<meta\b[^>]*\bname=["']generator["'][^>]*>/i)?.[0] || "";
  const build = meta.match(/content=["']Framer\s+([0-9a-f]{5,})/i)?.[1] || null;
  const stamp = html.match(/Published:?\s+([A-Z][a-z]{2,8}\.?\s+\d{1,2},\s+\d{4}(?:,?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AP]M)?)?(?:\s+(?:UTC|GMT))?)/);
  let publishedAt = null;
  if (stamp) {
    const t = Date.parse(stamp[1].replace(/,(\s+\d{1,2}:)/, "$1").replace(/\.(\s)/, "$1"));
    if (!Number.isNaN(t)) publishedAt = new Date(t).toISOString();
  }
  return { build, publishedAt, published: stamp?.[1] || null };
}

// ---------------------------------------------------------------- main

let lastProgress = 0;
function progress(msg) {
  if (!process.stderr.isTTY) return;
  const now = Date.now();
  if (now - lastProgress < 150) return;
  lastProgress = now;
  process.stderr.write(`\r\x1b[K${msg}`);
}
function log(msg) {
  if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
  console.error(msg);
}

console.error(`Exporting ${ORIGIN} -> ${OUT}${opts.static ? " (static, no JS)" : ""}`);
enqueuePage(new URL(SITE.pathname, ORIGIN));
enqueuePage(new URL("/404", ORIGIN));
await loadSitemap();
await drain();
const { files, pages } = await writeOutput();
log(`\nDone: ${pages.length} pages, ${files} files written to ${OUT}`);
if (failures.length) {
  console.error(`${failures.length} downloads failed (listed in export-report.json):`);
  for (const f of failures.slice(0, 10)) console.error("  " + f);
}
console.error(`Preview it with:  npx serve "${OUT}"   (or any static web server)`);
