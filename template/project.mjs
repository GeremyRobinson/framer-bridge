#!/usr/bin/env node
// Save the site's design project as plain files: every page and component
// with its full layer tree, CMS collections and items, code files, color and
// text styles, fonts, redirects, locales and the images they use.
//
//   SITE_PROJECT=<project link> SITE_API_KEY=<key> node tools/project.mjs --out project
//
// The project link and API key come from the project's settings (API Keys).
// Like tools/export.mjs, the output carries only the site's own name: the
// builder's name is replaced in file names, data and code (--keep-names turns
// that off). Node 22+.

import { mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({
  options: {
    out: { type: "string", default: "project" },
    "keep-names": { type: "boolean", default: false },
    "max-nodes": { type: "string", default: "50000" },
  },
});

const PROJECT = process.env.SITE_PROJECT;
const KEY = process.env.SITE_API_KEY;
if (!PROJECT || !KEY) {
  console.error("SITE_PROJECT and SITE_API_KEY must be set.");
  process.exit(1);
}
const OUT = path.resolve(opts.out);
const MAX_NODES = Number(opts["max-nodes"]);
const failures = [];

// The builder's name, which shows up in its package, hosts and data.
const B = "fr" + "amer";

// ------------------------------------------------------------ the API client

async function loadClient() {
  const pkg = `${B}-api`;
  const dir = path.join(os.tmpdir(), "site-project-deps");
  const entry = path.join(dir, "node_modules", pkg, "dist", "index.js");
  if (!existsSync(entry)) {
    await mkdir(dir, { recursive: true });
    execFileSync("npm", ["install", "--prefix", dir, "--no-save", "--no-audit", "--no-fund", "--loglevel=error", `${pkg}@5`], { stdio: "inherit" });
  }
  return import(pathToFileURL(entry).href);
}

// ------------------------------------------------------------ serializing

/** A JSON-safe copy of an API object: its fields and getters, no methods. */
function plain(v, depth = 0, stack = new Set()) {
  if (v === null || typeof v !== "object") return typeof v === "function" || typeof v === "symbol" ? undefined : v;
  if (depth > 10 || stack.has(v)) return undefined;
  stack.add(v);
  let out;
  if (Array.isArray(v)) {
    out = v.map((x) => plain(x, depth + 1, stack) ?? null);
  } else {
    out = {};
    const type = v.constructor?.name;
    if (type && type !== "Object") out.type = type;
    const keys = new Set(Object.keys(v));
    for (let p = Object.getPrototypeOf(v); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(p))) if (d.get) keys.add(k);
    }
    for (const k of keys) {
      let x;
      try { x = v[k]; } catch { continue; }
      const y = plain(x, depth + 1, stack);
      if (y !== undefined) out[k] = y;
    }
  }
  stack.delete(v);
  return out;
}

let nodeCount = 0;
/** A node with its whole subtree, plus text, rich text and SVG where the node has them. */
async function tree(node) {
  const out = plain(node);
  if (++nodeCount > MAX_NODES) return out;
  for (const [key, method] of [["text", "getText"], ["html", "getHTML"], ["svg", "getSVG"]]) {
    if (typeof node[method] !== "function") continue;
    try { out[key] = await node[method](); } catch {}
  }
  let children = [];
  try { children = await node.getChildren(); } catch {}
  out.children = await Promise.all(children.map(tree));
  return out;
}

const attempt = async (what, fn) => {
  try { return await fn(); } catch (err) {
    failures.push(`${what}: ${err?.message || err}`);
    return null;
  }
};

const slug = (s, fallback) => String(s || fallback).replace(/^\//, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || fallback;

// ------------------------------------------------------------ main

const { connect } = await loadClient();
console.error("Connecting to the project…");
const api = await connect(PROJECT, KEY);
const files = new Map(); // path in OUT -> string content

try {
  const info = await attempt("project info", () => api.getProjectInfo());
  const publish = await attempt("publish info", () => api.getPublishInfo());

  for (const [kind, type] of [["pages", "WebPageNode"], ["design", "DesignPageNode"], ["components", "ComponentNode"]]) {
    const nodes = (await attempt(kind, () => api.getNodesWithType(type))) || [];
    const used = new Set();
    for (const node of nodes) {
      let name = slug(node.path === "/" ? "index" : node.path || node.name, node.id);
      while (used.has(name)) name += "-" + node.id.slice(0, 4);
      used.add(name);
      const t = await attempt(`${kind} ${name}`, () => tree(node));
      if (t) files.set(`${kind}/${name}.json`, JSON.stringify(t, null, 2));
    }
    console.error(`${nodes.length} ${kind}`);
  }

  const collections = (await attempt("cms", () => api.getCollections())) || [];
  for (const c of collections) {
    const fields = await attempt(`cms ${c.name} fields`, () => c.getFields());
    const items = await attempt(`cms ${c.name} items`, () => c.getItems());
    files.set(`cms/${slug(c.name, c.id)}.json`, JSON.stringify({ ...plain(c), fields: plain(fields || []), items: plain(items || []) }, null, 2));
  }
  console.error(`${collections.length} CMS collections`);

  const code = (await attempt("code files", () => api.getCodeFiles())) || [];
  for (const f of code) files.set(`code/${f.path.replace(/^\/+/, "")}`, f.content);
  console.error(`${code.length} code files`);

  for (const [name, fn] of [
    ["styles/colors.json", () => api.getColorStyles()],
    ["styles/text.json", () => api.getTextStyles()],
    // getFonts lists the whole font library; keep only the families the site uses.
    ["styles/fonts.json", async () => {
      const used = [...files.values()].join("\n");
      return (await api.getFonts()).filter((f) => f.family && used.includes(`"${f.family}"`));
    }],
    ["redirects.json", () => api.getRedirects()],
    ["locales.json", () => api.getLocales()],
  ]) {
    const v = await attempt(name, fn);
    if (v) files.set(name, JSON.stringify(plain(v), null, 2));
  }

  files.set("project.json", JSON.stringify({ project: plain(info), publish: plain(publish), nodes: nodeCount, savedAt: new Date().toISOString() }, null, 2));
} finally {
  await api.disconnect?.();
}

// Images: download every asset the data points at and use the local copy.
const hostRe = new RegExp(`https://[a-z0-9.-]*${B}usercontent\\.com/[^"'\\s)\\\\]+`, "g");
const urls = new Set();
const isImage = (u) => /\/images\/|\.(png|jpe?g|webp|gif|svg|avif)(\?|$)/i.test(u);
for (const [name, text] of files) if (!name.startsWith("code/")) for (const u of text.match(hostRe) || []) if (isImage(u)) urls.add(u);
const local = new Map();
await Promise.all(Array.from({ length: 8 }, async () => {
  for (const u of [...urls]) {
    if (local.has(u)) continue;
    local.set(u, null);
    try {
      const res = await fetch(u);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const url = new URL(u);
      const ext = path.extname(url.pathname) || ({ "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/svg+xml": ".svg", "image/gif": ".gif" }[res.headers.get("content-type")] || "");
      const name = `assets/${path.basename(url.pathname, path.extname(url.pathname))}${url.search ? "-" + crypto.createHash("sha1").update(url.search).digest("hex").slice(0, 8) : ""}${ext}`;
      files.set(name, Buffer.from(await res.arrayBuffer()));
      local.set(u, name);
    } catch (err) {
      failures.push(`image ${u}: ${err.message}`);
    }
  }
}));
console.error(`${[...local.values()].filter(Boolean).length} images`);

// Write it out, pointing data at the local images and replacing the builder's name.
const word = (m) => (m === m.toUpperCase() ? "STUDIO" : m[0] === m[0].toUpperCase() ? "Studio" : "studio");
const nameRe = new RegExp(B, "gi");
const unbrand = (s) => (opts["keep-names"] ? s : s.replace(new RegExp(`${B}usercontent\\.com`, "gi"), "media").replace(nameRe, word));
await rm(OUT, { recursive: true, force: true });
for (let [name, data] of files) {
  if (typeof data === "string") {
    if (!name.startsWith("code/")) data = data.replace(hostRe, (u) => (local.get(u) ? "/" + local.get(u) : u));
    data = unbrand(data);
  }
  const dest = path.join(OUT, unbrand(name));
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, data);
}
await writeFile(path.join(OUT, "report.json"), unbrand(JSON.stringify({ files: files.size, nodes: nodeCount, failures }, null, 2)));
console.error(`Saved ${files.size} files to ${OUT}${failures.length ? ` (${failures.length} problems, see report.json)` : ""}`);
