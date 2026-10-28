#!/usr/bin/env node
// Prototype: design project (tools/project.mjs output) -> Bridge format -> HTML/CSS.
//
//   node convert.mjs <project dir> <page file> <out dir>
//
// Stage 1 reads the builder's layer tree and writes bridge.json: a neutral
// description of the page (boxes, text, images, layout, tokens, breakpoints)
// with nothing builder-specific left in it. Stage 2 writes index.html +
// style.css from bridge.json alone.

import { readFile, writeFile, mkdir, cp } from "node:fs/promises";
import path from "node:path";

const [PROJECT, PAGE, OUT] = process.argv.slice(2);
const load = async (f) => JSON.parse(await readFile(path.join(PROJECT, f), "utf8"));

// ------------------------------------------------------------ stage 1: builder -> Bridge

const slug = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "x";

function tokens(colors, textStyles) {
  const color = {};
  for (const c of colors) color[slug(c.name)] = { light: c.light, dark: c.dark };
  const fonts = new Map();
  const text = {};
  for (const s of textStyles) {
    for (const f of [s.font, s.boldFont, s.italicFont, s.boldItalicFont]) if (f?.url) fonts.set(`${f.family}|${f.weight}|${f.style}`, { family: f.family, weight: f.weight, style: f.style, src: f.url });
    const base = (b) => ({
      fontSize: b.fontSize, lineHeight: b.lineHeight, letterSpacing: b.letterSpacing,
      align: b.alignment, transform: b.transform, decoration: b.decoration,
    });
    text[slug(s.name)] = {
      tag: s.tag,
      family: s.font?.family, weight: s.font?.weight, style: s.font?.style,
      color: s.color ? { token: slug(s.color.name) } : null,
      balance: !!s.balance,
      ...base(s),
      breakpoints: (s.breakpoints || []).map((b) => ({ minWidth: b.minWidth, ...base(b) })),
    };
  }
  return { color, text, fonts: [...fonts.values()] };
}

/** A builder size ("1fr", "fit-content", "200px", "50%") as a Bridge size. */
function size(v) {
  if (v == null) return null;
  if (v === "fit-content") return { fit: "content" };
  if (v === "fit-image") return { fit: "image" };
  const fr = /^([\d.]+)fr$/.exec(v);
  if (fr) return { fill: Number(fr[1]) };
  return { fixed: v };
}

const colorRef = (c) => (c == null ? null : typeof c === "string" ? { value: c } : { token: slug(c.name) });

/** The parts of a layer that can differ between breakpoints. */
function props(n) {
  const p = {
    hidden: n.visible === false,
    width: size(n.width), height: size(n.height),
    minWidth: n.minWidth, maxWidth: n.maxWidth, minHeight: n.minHeight, maxHeight: n.maxHeight,
    aspectRatio: n.aspectRatio,
    opacity: n.opacity ?? 1, rotation: n.rotation || 0, zIndex: n.zIndex,
    overflow: n.overflow, radius: n.borderRadius,
    fill: colorRef(n.backgroundColor),
    gradient: n.backgroundGradient ? n.backgroundGradient : null,
    border: n.border || null,
    place: n.position === "absolute"
      ? { mode: "absolute", top: n.top, right: n.right, bottom: n.bottom, left: n.left, centerX: n.centerX, centerY: n.centerY }
      : { mode: "flow" },
    span: n.gridItemColumnSpan > 1 ? { columns: n.gridItemColumnSpan } : null,
  };
  if (n.gridItemRowSpan > 1) p.span = { ...p.span, rows: n.gridItemRowSpan };
  if (n.layout === "stack") {
    p.layout = {
      type: "stack", direction: n.stackDirection, distribute: n.stackDistribution,
      align: n.stackAlignment, wrap: !!n.stackWrapEnabled, gap: n.gap, padding: n.padding,
    };
  } else if (n.layout === "grid") {
    p.layout = {
      type: "grid", columns: n.gridColumnCount, rows: n.gridRowCount,
      columnSizing: n.gridColumnWidthType, columnWidth: n.gridColumnWidth, columnMin: n.gridColumnMinWidth,
      rowSizing: n.gridRowHeightType, rowHeight: n.gridRowHeight, align: n.gridAlignment,
      gap: n.gap, padding: n.padding,
    };
  }
  for (const k of Object.keys(p)) if (p[k] == null) delete p[k];
  return p;
}

function element(n) {
  const el = { id: n.id, name: n.name || null };
  if (n.type === "TextNode") {
    el.kind = "text";
    el.text = n.text ?? null;
    el.style = n.inlineTextStyle ? slug(n.inlineTextStyle.name) : null;
  } else if (n.type === "FrameNode") {
    el.kind = "box";
    if (n.backgroundImage) el.image = { src: n.backgroundImage.url, alt: n.backgroundImage.altText || "" };
  } else {
    el.kind = "unsupported";
    el.source = n.type;
  }
  if (n.link) el.link = { href: n.link, newTab: !!n.linkOpenInNewTab };
  el.props = props(n);
  el.children = (n.children || []).map(element);
  return el;
}

/** Breakpoint frames -> one tree with per-breakpoint overrides. */
function page(webPage) {
  const frames = webPage.children.filter((f) => f.isBreakpoint);
  const primary = frames.find((f) => f.isPrimaryBreakpoint) || frames[0];
  const tree = element(primary);
  const byId = new Map();
  (function index(el) { byId.set(el.id, el); el.children.forEach(index); })(tree);
  const breakpoints = [{ name: primary.name, width: parseFloat(primary.width) }];
  const skipped = [];
  for (const f of frames.filter((f) => f !== primary)) {
    breakpoints.push({ name: f.name, width: parseFloat(f.width) });
    (function walk(n) {
      const target = byId.get(n.id === f.id ? primary.id : n.originalId);
      if (!target) { skipped.push(`${f.name}: ${n.name || n.id} only exists at this size`); return; }
      const mine = props(n), base = target.props;
      const diff = {};
      for (const k of new Set([...Object.keys(mine), ...Object.keys(base)])) {
        if (JSON.stringify(mine[k]) !== JSON.stringify(base[k])) diff[k] = mine[k] ?? null;
      }
      if (Object.keys(diff).length) (target.at ||= {})[f.name] = diff;
      (n.children || []).forEach(walk);
    })(f);
  }
  breakpoints.sort((a, b) => b.width - a.width);
  // The page frame fills the window rather than its design width.
  tree.props.width = { fill: 1 };
  delete tree.props.place;
  for (const o of Object.values(tree.at || {})) { delete o.width; delete o.place; }
  return { route: webPage.path, breakpoints, root: tree, notes: skipped };
}

const bridge = {
  format: "bridge/0.1",
  tokens: tokens(await load("styles/colors.json"), await load("styles/text.json")),
  pages: [page(await load(PAGE))],
};

// ------------------------------------------------------------ stage 2: Bridge -> HTML/CSS

const css = [];
const used = new Map();
const className = (el) => {
  let base = el.kind === "text" && (!el.name || el.name.length > 24 || el.name === el.text) ? "text" : slug(el.name || el.kind);
  const n = (used.get(base) || 0) + 1;
  used.set(base, n);
  return n === 1 ? base : `${base}-${n}`;
};
const color = (c) => (c?.token ? `var(--${c.token})` : c?.value);

/** CSS declarations for one element at one breakpoint, given its parent's layout. */
function decls(el, p, parent) {
  const d = {};
  const layout = p.layout;
  d.display = p.hidden ? "none" : layout?.type === "stack" ? "flex" : layout?.type === "grid" ? "grid" : el.kind === "box" ? "block" : null;
  if (layout?.type === "stack") {
    d["flex-direction"] = layout.direction === "horizontal" ? "row" : "column";
    d["justify-content"] = { start: "flex-start", center: "center", end: "flex-end", "space-between": "space-between", "space-around": "space-around", "space-evenly": "space-evenly" }[layout.distribute] || "flex-start";
    d["align-items"] = { start: "flex-start", center: "center", end: "flex-end" }[layout.align] || "stretch";
    d["flex-wrap"] = layout.wrap ? "wrap" : "nowrap";
  }
  if (layout?.type === "grid") {
    const count = layout.columns === "auto-fill" ? "auto-fill" : layout.columns || 1;
    const col = layout.columnSizing === "fixed" ? `${layout.columnWidth}px` : `minmax(${layout.columnMin ?? 0}px, 1fr)`;
    d["grid-template-columns"] = `repeat(${count}, ${col})`;
    d["grid-auto-rows"] = layout.rowSizing === "fixed" ? `${layout.rowHeight}px` : layout.rowSizing === "fit" ? "1fr" : "min-content";
    // The alignment places the whole grid; cells sit at the top of their row.
    d["justify-content"] = { start: "start", center: "center", end: "end" }[layout.align] || "start";
    d["align-items"] = "start";
  }
  if (layout) {
    d.gap = layout.gap;
    d.padding = layout.padding;
  }
  // Size depends on what the parent does with "fill".
  const pl = parent?.layout;
  for (const [axis, prop] of [["horizontal", "width"], ["vertical", "height"]]) {
    const s = p[prop];
    if (!s) continue;
    const main = pl?.type === "stack" && (pl.direction === "horizontal") === (axis === "horizontal");
    if (s.fixed) d[prop] = s.fixed;
    else if (s.fit === "content") d[prop] = prop === "width" ? "fit-content" : "auto";
    else if (s.fit === "image") d[prop] = "auto";
    else if (s.fill != null) {
      if (main) { d.flex = `${s.fill} 0 0px`; d[`min-${prop}`] = "0"; }
      else if (pl?.type === "stack") d["align-self"] = "stretch";
      else d[prop] = "100%";
    }
  }
  for (const [k, c] of [["minWidth", "min-width"], ["maxWidth", "max-width"], ["minHeight", "min-height"], ["maxHeight", "max-height"]]) if (p[k]) d[c] = p[k];
  if (p.aspectRatio) d["aspect-ratio"] = p.aspectRatio;
  if (p.place?.mode === "absolute") {
    d.position = "absolute";
    const pl = p.place;
    for (const k of ["top", "right", "bottom", "left"]) if (pl[k]) d[k] = pl[k];
    const t = [];
    if (pl.centerX) { d.left = pl.centerX; t.push("translateX(-50%)"); }
    if (pl.centerY) { d.top = pl.centerY; t.push("translateY(-50%)"); }
    if (t.length) d.transform = t.join(" ");
  } else if (el.kind === "box") d.position = "relative";
  if (p.span?.columns) d["grid-column"] = `span ${p.span.columns}`;
  if (p.span?.rows) d["grid-row"] = `span ${p.span.rows}`;
  if (p.opacity !== 1) d.opacity = p.opacity;
  if (p.rotation) d.rotate = `${p.rotation}deg`;
  if (p.zIndex != null) d["z-index"] = p.zIndex;
  if (p.overflow && p.overflow !== "visible") d.overflow = p.overflow;
  if (p.radius) d["border-radius"] = p.radius;
  if (p.fill) d.background = color(p.fill);
  if (p.border) d.border = `${p.border.width} ${p.border.style} ${color(colorRef(p.border.color))}`;
  for (const k of Object.keys(d)) if (d[k] == null) delete d[k];
  return d;
}

const merge = (base, over) => {
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) if (v == null) delete out[k]; else out[k] = v;
  return out;
};
const block = (sel, d) => `${sel} { ${Object.entries(d).map(([k, v]) => `${k}: ${v};`).join(" ")} }`;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function emitPage(pg) {
  const bps = pg.breakpoints; // widest first
  const media = bps.slice(1).map((b, i) => ({ name: b.name, query: `(max-width: ${bps[i].width - 0.02}px)`, rules: [] }));
  const base = [];
  function walk(el, parent, parentAt, depth) {
    const cls = className(el);
    const baseD = decls(el, el.props, parent?.props);
    base.push(block(`.${cls}`, baseD));
    // Each breakpoint inherits the wider ones, so compare with what is in effect there.
    let prevProps = el.props, prevD = baseD;
    const atProps = {};
    for (const m of media) {
      const over = el.at?.[m.name];
      const props = over ? merge(prevProps, over) : prevProps;
      const pProps = parentAt?.[m.name] || parent?.props;
      const d = decls(el, props, pProps);
      const changed = {};
      for (const k of new Set([...Object.keys(d), ...Object.keys(prevD)])) {
        if (d[k] !== prevD[k]) changed[k] = d[k] ?? (k === "display" ? "block" : "initial");
      }
      if (Object.keys(changed).length) m.rules.push(block(`.${cls}`, changed));
      atProps[m.name] = props;
      prevProps = props; prevD = d;
    }
    const pad = "  ".repeat(depth);
    const linkOpen = el.link ? `<a href="${esc(el.link.href)}"${el.link.newTab ? ' target="_blank" rel="noopener"' : ""}>` : "";
    const linkClose = el.link ? "</a>" : "";
    if (el.kind === "text") {
      const t = bridge.tokens.text[el.style];
      const tag = t?.tag || "p";
      return `${pad}<${tag} class="${cls}${el.style ? " t-" + el.style : ""}">${linkOpen}${esc(el.text ?? "")}${linkClose}</${tag}>`;
    }
    if (el.kind === "unsupported") return `${pad}<!-- ${el.source} "${esc(el.name || "")}" not converted yet -->`;
    const inner = [];
    if (el.image) {
      const fitImage = el.props.height?.fit === "image";
      inner.push(`${pad}  <img class="${fitImage ? "img-flow" : "img-fill"}" src="${esc(el.image.src.replace(/^\//, ""))}" alt="${esc(el.image.alt)}">`);
    }
    for (const c of el.children) inner.push(walk(c, el, atProps, depth + 1));
    const tag = el.link ? "a" : "div";
    const href = el.link ? ` href="${esc(el.link.href)}"` : "";
    return `${pad}<${tag} class="${cls}"${href}>\n${inner.join("\n")}\n${pad}</${tag}>`;
  }
  const body = walk(pg.root, null, null, 1);
  const t = bridge.tokens;
  const out = [
    "/* Generated by Bridge from bridge.json. */",
    ...t.fonts.map((f) => `@font-face { font-family: "${f.family}"; font-weight: ${f.weight}; font-style: ${f.style}; src: url("${f.src.replace(/^\//, "")}"); font-display: swap; }`),
    `:root { ${Object.entries(t.color).map(([k, v]) => `--${k}: ${v.light};`).join(" ")} }`,
    `@media (prefers-color-scheme: dark) { :root { ${Object.entries(t.color).filter(([, v]) => v.dark).map(([k, v]) => `--${k}: ${v.dark};`).join(" ")} } }`,
    "*, *::before, *::after { box-sizing: border-box; }",
    "html, body { margin: 0; } body { -webkit-font-smoothing: antialiased; }",
    "p, h1, h2, h3, h4, h5, h6 { margin: 0; } a { color: inherit; text-decoration: inherit; }",
    ".img-fill { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; border-radius: inherit; }",
    ".img-flow { display: block; width: 100%; height: auto; }",
    ...Object.entries(t.text).flatMap(([k, s]) => {
      const one = (b) => ({ "font-size": b.fontSize, "line-height": b.lineHeight, "letter-spacing": b.letterSpacing, "text-align": b.align, "text-transform": b.transform !== "none" ? b.transform : null, "text-decoration": b.decoration !== "none" ? b.decoration : null });
      const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
      return [
        block(`.t-${k}`, clean({ "font-family": `"${s.family}", sans-serif`, "font-weight": s.weight, "font-style": s.style, color: color(s.color), "text-wrap": s.balance ? "balance" : null, ...one(s) })),
        ...s.breakpoints.map((b) => `@media (min-width: ${b.minWidth}px) { ${block(`.t-${k}`, clean(one(b)))} }`),
      ];
    }),
    ...base,
    ...media.filter((m) => m.rules.length).map((m) => `/* ${m.name} */\n@media ${m.query} {\n  ${m.rules.join("\n  ")}\n}`),
  ];
  return { body, css: out.join("\n") };
}

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, "bridge.json"), JSON.stringify(bridge, null, 2));
const { body, css: style } = emitPage(bridge.pages[0]);
await writeFile(path.join(OUT, "style.css"), style + "\n");
await writeFile(path.join(OUT, "index.html"), `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="style.css">
</head>
<body>
${body}
</body>
</html>
`);
await cp(path.join(PROJECT, "assets"), path.join(OUT, "assets"), { recursive: true });
console.error(`Wrote ${OUT}: bridge.json, index.html, style.css${bridge.pages[0].notes.length ? `\nNotes:\n  ${bridge.pages[0].notes.join("\n  ")}` : ""}`);
