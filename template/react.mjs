#!/usr/bin/env node
// Turn the exported site (tools/export.mjs output) into a standalone React
// project: one component per page, the site's own CSS and assets, and a small
// client-side router. The result has no builder runtime in it; it is plain
// React you can edit, build with Vite and host anywhere.
//
//   node tools/react.mjs --site site --out app [--project project] [--base /repo/react/]
//
// --base is where the React build will be served (default: where the
// exported site is served). Images and fonts keep pointing at the exported
// site's assets/ folder, which is also copied into the project.
//
// Pages are rebuilt from the published markup, which already holds every
// breakpoint, so the React version looks the same at every screen size.
// With --project (default: project/, saved by tools/project.mjs), the site's
// own code components are copied to src/code/ and rendered live where the
// pages use them. Appear animations and CMS search aren't rebuilt. Node 22+.

import { readFile, writeFile, mkdir, rm, cp, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values: opts } = parseArgs({
  options: {
    site: { type: "string", default: "site" },
    out: { type: "string", default: "app" },
    base: { type: "string" },
    project: { type: "string" },
  },
});
const SITE = path.resolve(opts.site);
const OUT = path.resolve(opts.out);
// The saved design project (tools/project.mjs); its code/ folder holds the
// site's own components, which are brought back to life where they're used.
const PROJECT = path.resolve(opts.project || "project");
const CODE = path.join(PROJECT, "code");

// ------------------------------------------------------------ parser

async function loadDeps() {
  const dir = path.join(os.tmpdir(), "site-react-deps");
  const mod = (name, file) => path.join(dir, "node_modules", name, "dist", file);
  const entries = [mod("parse5", "index.js"), mod("acorn", "acorn.mjs"), mod("acorn-walk", "walk.mjs")];
  if (!entries.every(existsSync)) {
    await mkdir(dir, { recursive: true });
    execFileSync("npm", ["install", "--prefix", dir, "--no-save", "--no-audit", "--no-fund", "--loglevel=error", "parse5@7", "acorn@8", "acorn-walk@8"], { stdio: "inherit" });
  }
  return Promise.all(entries.map((e) => import(pathToFileURL(e).href)));
}
const [{ parse }, acorn, walk] = await loadDeps();

// ------------------------------------------------------------ naming

/** Shorter, neutral names for the export's generated class names and data attributes. */
const tidy = (s) => s.replace(/data-studio-/g, "data-").replace(/\bstudio-/g, "s-");

const componentName = (route) => {
  if (route === "/") return "Home";
  if (route === "/404") return "NotFound";
  const name = route.split("/").filter(Boolean).map((p) => p.replace(/[^A-Za-z0-9]+/g, " ").replace(/(^|\s)(\w)/g, (_, __, c) => c.toUpperCase()).replace(/\s/g, "")).join("");
  return /^\d/.test(name) ? "Page" + name : name;
};

// ------------------------------------------------------------ HTML -> JSX

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const BOOLEAN = new Set(["hidden", "disabled", "checked", "muted", "autoplay", "loop", "playsinline", "controls", "async", "defer", "required", "readonly", "multiple", "selected", "novalidate", "allowfullscreen", "open"]);
const ATTR = {
  class: "className", for: "htmlFor", tabindex: "tabIndex", srcset: "srcSet", crossorigin: "crossOrigin",
  fetchpriority: "fetchPriority", autoplay: "autoPlay", playsinline: "playsInline", readonly: "readOnly",
  maxlength: "maxLength", minlength: "minLength", colspan: "colSpan", rowspan: "rowSpan",
  contenteditable: "contentEditable", spellcheck: "spellCheck", allowfullscreen: "allowFullScreen",
  frameborder: "frameBorder", referrerpolicy: "referrerPolicy", enterkeyhint: "enterKeyHint",
  inputmode: "inputMode", autocomplete: "autoComplete", novalidate: "noValidate", datetime: "dateTime",
  "http-equiv": "httpEquiv", "accept-charset": "acceptCharset", "xlink:href": "xlinkHref", "xml:space": "xmlSpace",
  "xmlns:xlink": "xmlnsXlink", srcdoc: "srcDoc", formaction: "formAction", usemap: "useMap", itemprop: "itemProp",
};
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

function styleObject(css) {
  const out = [];
  let depth = 0, start = 0;
  const decls = [];
  for (let i = 0; i <= css.length; i++) {
    const c = css[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if ((c === ";" && depth === 0) || i === css.length) { decls.push(css.slice(start, i)); start = i + 1; }
  }
  for (const d of decls) {
    const at = d.indexOf(":");
    if (at < 0) continue;
    let prop = d.slice(0, at).trim();
    const value = d.slice(at + 1).trim();
    if (!prop) continue;
    if (!prop.startsWith("--")) prop = camel(prop.replace(/^-ms-/, "ms-").replace(/^-(webkit|moz)-/, (_, v) => v[0].toUpperCase() + v.slice(1) + "-"));
    out.push(`${JSON.stringify(prop)}: ${JSON.stringify(value)}`);
  }
  return `{{ ${out.join(", ")} }}`;
}

function attrs(node) {
  const svg = node.namespaceURI === "http://www.w3.org/2000/svg";
  const parts = [];
  for (let { name, value } of node.attrs) {
    // Hydration and build bookkeeping only the builder's runtime reads.
    if (/^data-(hydrate|ssr|page-optimized|generated-page|appear-|breakpoint|css-ssr|html-style|font-css)/.test(name)) continue;
    if (name === "style") {
      // The runtime fades "appear" elements in; without it they must start visible.
      if (node.attrs.some((a) => a.name.startsWith("data-appear-id"))) value = value.split(";").filter((d) => !/^\s*(opacity|transform|will-change)\s*:/.test(d)).join(";");
      if (value.trim()) parts.push(`style=${styleObject(value)}`);
      continue;
    }
    let key = ATTR[name] || name;
    if (svg && !ATTR[name] && !/^(data|aria)-/.test(name)) key = camel(name);
    if (BOOLEAN.has(name) && (value === "" || value === name)) { parts.push(key); continue; }
    if (name === "href" && node.tagName === "a") value = pageLink(value);
    parts.push(`${key}=${JSON.stringify(value)}`);
  }
  return parts.length ? " " + parts.join(" ") : "";
}

function text(value) {
  if (!value) return "";
  // Plain words can go in as-is; anything with JSX-special characters or
  // meaningful whitespace goes in as a string literal so it renders exactly.
  if (/^[^{}<>&\n\r\t"]*$/.test(value) && value === value.trim() && value) return value;
  if (!value.trim()) return /\n/.test(value) ? "" : `{${JSON.stringify(value)}}`;
  return `{${JSON.stringify(value)}}`;
}

function jsx(node, depth) {
  const pad = "  ".repeat(depth);
  if (node.nodeName === "#text") {
    const t = text(node.value);
    return t ? pad + t : "";
  }
  if (node.nodeName === "#comment" || !node.tagName) return "";
  const tag = node.tagName;
  if (tag === "script" || tag === "noscript") return "";
  if (tag === "link" && node.attrs.some((a) => a.name === "rel" && a.value === "modulepreload")) return "";
  if (tag === "style") {
    const css = node.childNodes.map((c) => c.value || "").join("");
    return `${pad}<style>{${JSON.stringify(css)}}</style>`;
  }
  const open = `<${tag}${attrs(node)}`;
  const island = islandFor(node);
  if (island) return `${pad}${open}>\n${pad}  ${island}\n${pad}</${tag}>`;
  const kids = (node.content || node).childNodes || [];
  if (VOID.has(tag) || !kids.length) return `${pad}${open} />`;
  const inner = kids.map((c) => jsx(c, depth + 1)).filter(Boolean);
  if (!inner.length) return `${pad}${open} />`;
  if (inner.length === 1 && !inner[0].trim().startsWith("<") && inner[0].length < 100) return `${pad}${open}>${inner[0].trim()}</${tag}>`;
  return `${pad}${open}>\n${inner.join("\n")}\n${pad}</${tag}>`;
}

const find = (node, test) => {
  if (test(node)) return node;
  for (const c of node.childNodes || []) {
    const r = find(c, test);
    if (r) return r;
  }
  return null;
};

// ------------------------------------------------------------ live components
//
// The published pages were rendered once on a server, so the site's own code
// components (a clock, a cart button, charts) are frozen in the markup. Here
// each one is found in the published scripts: which of the project's code
// files it is, where it sits on the page, and the settings it was given
// (including values bound to a CMS item). The page then renders the real
// component from src/code/ in its place.

async function filesUnder(dir, test, out = []) {
  if (!existsSync(dir)) return out;
  for (const f of await readdir(dir)) {
    const p = path.join(dir, f);
    if ((await stat(p)).isDirectory()) await filesUnder(p, test, out);
    else if (test(f)) out.push(p);
  }
  return out;
}

/** Prop names a component function reads from its props, from its source. */
function propKeys(list) {
  const keys = [];
  let depth = 0, cur = "";
  for (const c of list + ",") {
    if ("{[(".includes(c)) depth++;
    if ("}])".includes(c)) depth--;
    if (c === "," && depth === 0) {
      const k = cur.trim().match(/^([A-Za-z_$][\w$]*)/)?.[1];
      if (k && !cur.trim().startsWith("...")) keys.push(k);
      cur = "";
    } else cur += c;
  }
  return keys;
}

/** Every exported function component in the project's code files, with the props it reads. */
async function codeComponents() {
  const out = [];
  for (const file of await filesUnder(CODE, (f) => /\.(t|j)sx?$/.test(f))) {
    const src = await readFile(file, "utf8");
    const rel = path.relative(CODE, file).split(path.sep).join("/");
    for (const m of src.matchAll(/export\s+(default\s+)?function\s+([A-Z][\w$]*)\s*\(\s*(\{[^)]*\}|[\w$]+)/g)) {
      let keys;
      if (m[3].startsWith("{")) keys = propKeys(m[3].slice(1, m[3].lastIndexOf("}")));
      else {
        const body = src.slice(m.index);
        const d = body.match(new RegExp(`(?:const|let)\\s*\\{([^]*?)\\}\\s*=\\s*${m[3].replace("$", "\\$")}\\b`));
        keys = d ? propKeys(d[1]) : [];
      }
      out.push({ file: rel, name: m[2], isDefault: !!m[1], keys: new Set(keys) });
    }
  }
  return out;
}

const DYN = Symbol("dynamic");
/** A literal's value, or DYN when it depends on anything at run time. */
function literal(n) {
  switch (n?.type) {
    case "Literal": return n.value;
    case "TemplateLiteral": return n.expressions.length ? DYN : n.quasis[0].value.cooked;
    case "UnaryExpression":
      if (n.operator === "!" && n.argument.type === "Literal") return !n.argument.value;
      if (n.operator === "-") { const v = literal(n.argument); return typeof v === "number" ? -v : DYN; }
      return DYN;
    case "ArrayExpression": { const a = n.elements.map(literal); return a.includes(DYN) ? DYN : a; }
    case "ObjectExpression": {
      const o = {};
      for (const p of n.properties) {
        if (p.type !== "Property" || p.computed) return DYN;
        const v = literal(p.value);
        if (v === DYN) return DYN;
        o[p.key.name ?? p.key.value] = v;
      }
      return o;
    }
  }
  return DYN;
}
const propOf = (obj, k) => obj.properties.find((p) => p.type === "Property" && !p.computed && (p.key.name ?? p.key.value) === k);

/** Where each code component is used in the published scripts. */
async function findIslands() {
  const components = await codeComponents();
  if (!components.length) return new Map();
  const modules = new Map();
  for (const file of await filesUnder(path.join(SITE, "assets"), (f) => f.endsWith(".mjs"))) {
    try { modules.set(file, acorn.parse(await readFile(file, "utf8"), { ecmaVersion: "latest", sourceType: "module" })); } catch {}
  }

  // The function behind a name, following imports between the scripts.
  const resolve = (file, name, depth = 0) => {
    const ast = modules.get(file);
    if (!ast || depth > 5) return null;
    for (const st of ast.body) {
      if (st.type === "ImportDeclaration") {
        const spec = st.specifiers.find((x) => x.local.name === name);
        if (spec) {
          const target = path.resolve(path.dirname(file), st.source.value);
          const exported = spec.type === "ImportDefaultSpecifier" ? "default" : spec.imported.name;
          const tast = modules.get(target);
          if (!tast) return null;
          for (const ts of tast.body) {
            if (ts.type === "ExportNamedDeclaration" && !ts.declaration) {
              const e = ts.specifiers.find((x) => (x.exported.name ?? x.exported.value) === exported);
              if (e) return resolve(target, e.local.name, depth + 1);
            }
          }
          return null;
        }
      }
    }
    let fn = null;
    walk.simple(ast, {
      FunctionDeclaration(n) { if (n.id?.name === name) fn ??= n; },
      VariableDeclarator(n) { if (n.id.name === name && /Function/.test(n.init?.type)) fn ??= n.init; },
    });
    return fn;
  };
  // The prop names a (minified) function destructures from its first argument.
  const fnKeys = (fn) => {
    const p = fn?.params[0];
    if (!p) return null;
    const pat = (o) => new Set(o.properties.filter((x) => x.type === "Property").map((x) => x.key.name ?? x.key.value));
    if (p.type === "ObjectPattern") return pat(p);
    let keys = null;
    walk.simple(fn.body, { VariableDeclarator(n) { if (!keys && n.id.type === "ObjectPattern" && n.init?.type === "Identifier" && n.init.name === p.name) keys = pat(n.id); } });
    return keys;
  };
  const match = (keys, hint) => {
    if (!keys?.size) return null;
    let best = null, score = 0;
    for (const c of components) {
      const inter = [...keys].filter((k) => c.keys.has(k)).length;
      let s = inter / new Set([...keys, ...c.keys]).size;
      if (hint && c.file.replace(/\.\w+$/, "").split("/").pop() === hint) s += 0.2;
      if (s > score) { score = s; best = c; }
    }
    return score >= 0.6 ? best : null;
  };

  const islands = new Map(); // container class -> island
  for (const [file, ast] of modules) {
    walk.ancestor(ast, {
      CallExpression(n, _, ancestors) {
        const o = n.arguments[1];
        if (o?.type !== "ObjectExpression" || !propOf(o, "isAuthoredByUser")) return;
        const cls = literal(propOf(o, "className")?.value);
        const child = propOf(o, "children")?.value;
        if (typeof cls !== "string" || !cls.endsWith("-container") || child?.type !== "CallExpression" || child.arguments[0]?.type !== "Identifier") return;

        const fnName = child.arguments[0].name;
        const imp = ast.body.find((st) => st.type === "ImportDeclaration" && st.specifiers.some((x) => x.local.name === fnName));
        const hint = imp && path.basename(imp.source.value).split(".")[0];
        const keys = fnKeys(resolve(file, fnName));
        const component = match(keys, hint);
        if (process.env.REACT_DEBUG) console.error("instance", cls, fnName, hint, keys && [...keys].join(","), "->", component?.file, component?.name);
        if (!component) return;

        // CMS-bound values: `{fieldId: local = item.fieldId ?? fallback}` in an enclosing function.
        const fields = new Map();
        for (const a of ancestors) {
          if (!/Function/.test(a.type)) continue;
          walk.simple(a.body, { ObjectPattern(p) {
            for (const x of p.properties) {
              if (x.type !== "Property" || x.computed) continue;
              const v = x.value.type === "AssignmentPattern" ? x.value.left : x.value;
              if (v.type === "Identifier" && /^[A-Za-z0-9_]{9}$/.test(x.key.name ?? "")) fields.set(v.name, x.key.name);
            }
          } });
        }
        const props = {}, bound = {};
        let ok = true;
        for (const p of child.arguments[1]?.properties || []) {
          if (p.type !== "Property" || p.computed) { ok = false; continue; }
          const k = p.key.name ?? p.key.value;
          if (["id", "layoutId", "name", "width", "height"].includes(k)) continue;
          const v = literal(p.value);
          if (v !== DYN) { props[k] = v; continue; }
          let field = p.value.type === "Identifier" ? fields.get(p.value.name) : null;
          // e.g. an enum lookup, enums.fieldId?.(item, locale)
          if (!field) walk.simple(p.value, { MemberExpression(m) { if (!field && /^[A-Za-z0-9_]{9}$/.test(m.property.name ?? "")) field = m.property.name; } });
          if (field) bound[k] = field;
          else ok = false;
        }
        if (process.env.REACT_DEBUG) console.error("  bound", JSON.stringify(bound), "ok", ok);
        if (!ok) return;
        const key = tidy(cls);
        if (islands.has(key) && JSON.stringify(islands.get(key).props) !== JSON.stringify(props)) { islands.get(key).ambiguous = true; return; }
        islands.set(key, { component, props, bound });
      },
    });
  }
  for (const [k, v] of islands) if (v.ambiguous) islands.delete(k);
  return islands;
}

/** CMS items by slug, with their field values by field id. */
async function cmsItems() {
  const bySlug = new Map();
  for (const file of await filesUnder(path.join(PROJECT, "cms"), (f) => f.endsWith(".json"))) {
    const c = JSON.parse(await readFile(file, "utf8"));
    for (const item of c.items || []) {
      const values = Object.fromEntries(Object.entries(item.fieldData || {}).map(([id, f]) => [id, f?.value]));
      (bySlug.get(item.slug) || bySlug.set(item.slug, []).get(item.slug)).push(values);
    }
  }
  return bySlug;
}

const ISLANDS = await findIslands();
const CMS = ISLANDS.size ? await cmsItems() : new Map();
let page = { slug: "", uses: new Map() }; // the page being converted
const componentId = (c) => "Live" + c.name;

/** The live component to render inside a component container, if this is one. */
function islandFor(node) {
  const cls = node.attrs?.find((a) => a.name === "class")?.value.split(/\s+/) || [];
  const island = cls.map((c) => ISLANDS.get(c)).find(Boolean);
  if (!island) return null;
  const props = { ...island.props };
  const fieldIds = Object.values(island.bound);
  if (fieldIds.length) {
    const item = (CMS.get(page.slug) || []).find((v) => fieldIds.every((id) => id in v));
    if (!item) return null; // not on an item page: leave the rendered markup as it is
    for (const [k, id] of Object.entries(island.bound)) props[k] = item[id];
  }
  page.uses.set(componentId(island.component), island.component);
  return `<${componentId(island.component)} {...${JSON.stringify(props)}} />`;
}

// ------------------------------------------------------------ pages

const report = JSON.parse(await readFile(path.join(SITE, "export-report.json"), "utf8"));
const firstPage = await readFile(path.join(SITE, "index.html"), "utf8");
// Where the exported site lives (its links and assets use this prefix) and
// where the React build will live.
const SITE_BASE = firstPage.match(/(?:href|src)="(\/[^"]*?)assets\//)?.[1] || "/";
const BASE = opts.base || SITE_BASE;
const pageLink = (href) => href.startsWith(SITE_BASE) && !href.startsWith(SITE_BASE + "assets/") ? BASE + href.slice(SITE_BASE.length) : href;

const routes = [];
let globalCss = null;
for (const file of [...report.pages, ...(existsSync(path.join(SITE, "404.html")) ? [] : [])]) {
  const html = tidy(await readFile(path.join(SITE, file), "utf8"));
  const doc = parse(html);
  const head = find(doc, (n) => n.tagName === "head");
  const main = find(doc, (n) => n.attrs?.some((a) => a.name === "id" && a.value === "main"));
  if (!main) continue;
  const route = "/" + file.replace(/(^|\/)index\.html$/, "$1").replace(/\.html$/, "");
  const styles = [];
  const shared = [];
  for (const n of head.childNodes.filter((c) => c.tagName === "style")) {
    const css = n.childNodes.map((c) => c.value || "").join("");
    const names = n.attrs.map((a) => a.name);
    // Fonts and document-wide rules are the same on every page.
    if (names.includes("data-font-css") || names.includes("data-html-style") || !names.length) shared.push(css);
    else styles.push(css);
  }
  globalCss ??= shared.join("\n");
  const meta = (name) => find(head, (n) => n.tagName === "meta" && n.attrs.some((a) => (a.name === "name" || a.name === "property") && a.value === name))?.attrs.find((a) => a.name === "content")?.value;
  const title = find(head, (n) => n.tagName === "title")?.childNodes[0]?.value?.trim() || "";
  const name = componentName(route === "/404/" ? "/404" : route.replace(/\/$/, "") || "/");
  if (routes.some((r) => r.name === name)) continue;
  page = { slug: route.split("/").filter(Boolean).pop() || "", uses: new Map() };
  const body = main.childNodes.map((c) => jsx(c, 3)).filter(Boolean).join("\n");
  routes.push({ route: route === "/404/" ? "*" : route, name, title, description: meta("description") || "", css: styles.join("\n"), body, uses: page.uses });
}

// ------------------------------------------------------------ write the project

// What the code files import from the design tool, as plain functions: the
// property controls only matter inside the editor.
const STUDIO_SHIM = `// Stand-ins for the design tool's helpers that the components in src/code/
// import. Property controls only mean something inside the editor, so here
// they do nothing; the rest are small working versions.
import { useSyncExternalStore } from "react";

export function addPropertyControls() {}

/** ControlType.Color === "color", and so on. */
export const ControlType = new Proxy({}, { get: (_, key) => String(key).toLowerCase() });

/** Always false: this is the live site, never a static render. */
export const useIsStaticRenderer = () => false;

export const RenderTarget = {
  canvas: "CANVAS", export: "EXPORT", thumbnail: "THUMBNAIL", preview: "PREVIEW",
  current: () => "PREVIEW",
  hasRestrictions: () => false,
};

/** A tiny shared store: const useStore = createStore({...}); const [state, setState] = useStore(). */
export function createStore(initial) {
  let state = initial;
  const listeners = new Set();
  const set = (next) => {
    state = { ...state, ...(typeof next === "function" ? next(state) : next) };
    listeners.forEach((l) => l());
  };
  const subscribe = (l) => (listeners.add(l), () => listeners.delete(l));
  return function useStore() {
    return [useSyncExternalStore(subscribe, () => state, () => state), set];
  };
}

export const randomColor = () => "#" + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
`;

await rm(OUT, { recursive: true, force: true });
await mkdir(path.join(OUT, "src", "pages"), { recursive: true });

const files = {
  ".gitignore": "node_modules/\ndist/\n",
  "package.json": JSON.stringify({
    name: path.basename(path.resolve(OUT, "..")) || "site",
    private: true,
    type: "module",
    scripts: { dev: "vite", build: "vite build && cp dist/index.html dist/404.html", preview: "vite preview" },
    dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
    devDependencies: { vite: "^6.0.0", "@vitejs/plugin-react": "^4.3.0" },
  }, null, 2) + "\n",
  "vite.config.js": `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: ${JSON.stringify(BASE)},
  plugins: [react()],
});
`,
  "index.html": `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width">
  <title>${routes.find((r) => r.route === "/")?.title || ""}</title>
</head>
<body>
  <div id="main"></div>
  <script type="module" src="/src/main.jsx"></script>
</body>
</html>
`,
  "src/main.jsx": `import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./global.css";

createRoot(document.getElementById("main")).render(<App />);
`,
  "src/global.css": globalCss + "\n",
  "src/App.jsx": `import { lazy, Suspense, useEffect, useState } from "react";

// Each page loads on first visit.
${routes.map((r) => `const ${r.name} = lazy(() => import("./pages/${r.name}.jsx"));`).join("\n")}

const BASE = import.meta.env.BASE_URL;
const ROUTES = {
${routes.filter((r) => r.route !== "*").map((r) => `  ${JSON.stringify(r.route)}: { page: ${r.name}, title: ${JSON.stringify(r.title)}, description: ${JSON.stringify(r.description)} },`).join("\n")}
};
const NOT_FOUND = ${routes.find((r) => r.route === "*") ? `{ page: NotFound, title: ${JSON.stringify(routes.find((r) => r.route === "*").title)}, description: "" }` : "null"};

/** The route for the current address, e.g. "/shop/kyo/". */
function current() {
  let p = location.pathname.startsWith(BASE) ? "/" + location.pathname.slice(BASE.length) : location.pathname;
  p = p.replace(/index\\.html$/, "");
  if (!p.endsWith("/")) p += "/";
  return p;
}

export default function App() {
  const [route, setRoute] = useState(current);

  useEffect(() => {
    const onPop = () => setRoute(current());
    // Links inside the site switch pages without reloading.
    const onClick = (e) => {
      const a = e.target.closest?.("a[href]");
      if (!a || a.target === "_blank" || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      const url = new URL(a.getAttribute("href"), location.href);
      if (url.origin !== location.origin || !url.pathname.startsWith(BASE)) return;
      e.preventDefault();
      if (url.pathname !== location.pathname) history.pushState(null, "", url.pathname + url.search + url.hash);
      setRoute(current());
      if (!url.hash) scrollTo(0, 0);
    };
    addEventListener("popstate", onPop);
    document.addEventListener("click", onClick);
    return () => {
      removeEventListener("popstate", onPop);
      document.removeEventListener("click", onClick);
    };
  }, []);

  const entry = ROUTES[route] || NOT_FOUND;
  useEffect(() => {
    if (!entry) return;
    document.title = entry.title;
    let meta = document.querySelector('meta[name="description"]');
    if (!meta) meta = Object.assign(document.head.appendChild(document.createElement("meta")), { name: "description" });
    meta.content = entry.description;
  }, [entry]);

  if (!entry) return null;
  const Page = entry.page;
  return (
    <Suspense fallback={null}>
      <Page />
    </Suspense>
  );
}
`,
  "README.md": `# React version

This is the website as a plain React project: one component per page in
\`src/pages/\`, each with its own stylesheet, the shared fonts and document
styles in \`src/global.css\`, and images and fonts in \`public/assets/\`.

    npm install
    npm run dev      # local preview
    npm run build    # production build in dist/

It is generated from the exported site in \`site/\` by \`tools/react.mjs\` and
overwritten on every sync until you decide to take it over by hand.
`,
};
for (const r of routes) {
  files[`src/pages/${r.name}.css`] = r.css + "\n";
  const imports = [...r.uses].map(([id, c]) => `import ${c.isDefault ? id : `{ ${c.name} as ${id} }`} from "../code/${c.file}";\n`).join("");
  files[`src/pages/${r.name}.jsx`] = `${imports}import css from "./${r.name}.css?inline";

export default function ${r.name}() {
  return (
    <>
      <style>{css}</style>
${r.body}
    </>
  );
}
`;
}
// The project's code files, with the builder's module swapped for src/studio.js.
const usesMotion = [];
for (const file of await filesUnder(CODE, (f) => /\.(t|j)sx?$/.test(f))) {
  const rel = path.relative(CODE, file).split(path.sep).join("/");
  const shim = "../".repeat(rel.split("/").length) + "studio.js";
  let src = (await readFile(file, "utf8"))
    .replace(/from\s+["']studio["']/g, `from "${shim}"`)
    .replace(/from\s+["']https:\/\/studio\.com\/m\/[^"']+["']/g, `from "${shim}"`);
  if (/from\s+["']studio-motion["']/.test(src)) { src = src.replace(/from\s+["']studio-motion["']/g, `from "motion/react"`); usesMotion.push(rel); }
  files[`src/code/${rel}`] = src;
}
if (Object.keys(files).some((f) => f.startsWith("src/code/"))) {
  files["src/studio.js"] = STUDIO_SHIM;
  if (usesMotion.length) {
    const pkg = JSON.parse(files["package.json"]);
    pkg.dependencies.motion = "^12.0.0";
    files["package.json"] = JSON.stringify(pkg, null, 2) + "\n";
  }
}

for (const [name, data] of Object.entries(files)) {
  await mkdir(path.dirname(path.join(OUT, name)), { recursive: true });
  await writeFile(path.join(OUT, name), data);
}

// Images, fonts and other media; the builder's scripts and data files stay behind.
async function copyAssets(from, to) {
  for (const f of await readdir(from)) {
    const src = path.join(from, f), dest = path.join(to, f);
    if ((await stat(src)).isDirectory()) await copyAssets(src, dest);
    else if (!/\.(m?js|json|map)$|cms$/i.test(f)) {
      await mkdir(to, { recursive: true });
      await cp(src, dest);
    }
  }
}
if (existsSync(path.join(SITE, "assets"))) await copyAssets(path.join(SITE, "assets"), path.join(OUT, "public", "assets"));

const live = new Set(routes.flatMap((r) => [...r.uses.keys()]));
console.error(`React project with ${routes.length} pages written to ${OUT} (base ${BASE})${live.size ? `, live components: ${[...live].join(", ")}` : ""}`);
