#!/usr/bin/env node
// Turn the exported site (tools/export.mjs output) into a standalone React
// project: one component per page, the site's own CSS and assets, and a small
// client-side router. The result has no builder runtime in it; it is plain
// React you can edit, build with Vite and host anywhere.
//
//   node tools/react.mjs --site site --out app [--base /repo/react/]
//
// --base is where the React build will be served (default: where the
// exported site is served). Images and fonts keep pointing at the exported
// site's assets/ folder, which is also copied into the project.
//
// Pages are rebuilt from the published markup, which already holds every
// breakpoint, so the React version looks the same at every screen size.
// What the builder's runtime added on top (appear animations, code
// components, CMS search) is not part of this first version. Node 22+.

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
  },
});
const SITE = path.resolve(opts.site);
const OUT = path.resolve(opts.out);

// ------------------------------------------------------------ parser

async function loadParser() {
  const dir = path.join(os.tmpdir(), "site-react-deps");
  const entry = path.join(dir, "node_modules", "parse5", "dist", "index.js");
  if (!existsSync(entry)) {
    await mkdir(dir, { recursive: true });
    execFileSync("npm", ["install", "--prefix", dir, "--no-save", "--no-audit", "--no-fund", "--loglevel=error", "parse5@7"], { stdio: "inherit" });
  }
  return import(pathToFileURL(entry).href);
}
const { parse } = await loadParser();

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
  routes.push({ route: route === "/404/" ? "*" : route, name, title, description: meta("description") || "", css: styles.join("\n"), body: main.childNodes.map((c) => jsx(c, 3)).filter(Boolean).join("\n") });
}

// ------------------------------------------------------------ write the project

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
  files[`src/pages/${r.name}.jsx`] = `import css from "./${r.name}.css?inline";

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

console.error(`React project with ${routes.length} pages written to ${OUT} (base ${BASE})`);
