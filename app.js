// Bridge: keeps a GitHub Pages copy of a published Framer site in sync, and
// shows the sync happening live. There is no server: everything below talks
// to the GitHub REST API from the browser with the user's own token.

const API = "https://api.github.com";
const WORKFLOW_FILE = "framer-bridge.yml";
const WORKFLOW_PATH = `.github/workflows/${WORKFLOW_FILE}`;
const CONFIG_PATH = ".framer-bridge.json";
const TOKEN_KEY = "framer-bridge:token";
const CACHE_KEY = "framer-bridge:projects";
const SELECTED_KEY = "framer-bridge:selected";
const CANVAS_W = 1150;
const CANVAS_H = 560;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let token = store.get(TOKEN_KEY);
let me = null;
/** full_name -> project state */
const projects = new Map();
/** run id -> jobs, for runs that have finished (they never change again) */
const jobCache = new Map();
let selected = store.get(SELECTED_KEY);
let pollTimer = null;
let scanned = false;

// ------------------------------------------------------------------ GitHub

class GitHubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function gh(path, { method = "GET", body, raw = false } = {}) {
  const res = await fetch(path.startsWith("http") ? path : API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  if (raw) return res;
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new GitHubError(res.status, data?.message || res.statusText);
  return data;
}

const b64decode = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, "")), (c) => c.charCodeAt(0)));

async function readConfig(full) {
  try {
    const f = await gh(`/repos/${full}/contents/${CONFIG_PATH}`);
    return JSON.parse(b64decode(f.content));
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** Write several files to a branch as a single commit. */
async function commitFiles(full, files, message) {
  let ref;
  try {
    // A just-created repository can take a moment to get its first branch.
    for (let i = 0; ; i++) {
      try {
        ref = await gh(`/repos/${full}/git/ref/heads/main`);
        break;
      } catch (err) {
        if (i >= 4 || (err.status !== 404 && err.status !== 409)) throw err;
        await sleep(1500);
      }
    }
  } catch (err) {
    if (err.status !== 404 && err.status !== 409) throw err;
    // Empty repository: the Git Data API needs one commit to exist first.
    await gh(`/repos/${full}/contents/README.md`, {
      method: "PUT",
      body: { message: "Initial commit", content: btoa("# " + full.split("/")[1] + "\n"), branch: "main" },
    });
    ref = await gh(`/repos/${full}/git/ref/heads/main`);
  }
  const parent = await gh(`/repos/${full}/git/commits/${ref.object.sha}`);
  const tree = await gh(`/repos/${full}/git/trees`, {
    method: "POST",
    body: {
      base_tree: parent.tree.sha,
      tree: Object.entries(files).map(([path, content]) => ({ path, mode: "100644", type: "blob", content })),
    },
  });
  const commit = await gh(`/repos/${full}/git/commits`, {
    method: "POST",
    body: { message, tree: tree.sha, parents: [parent.sha] },
  });
  await gh(`/repos/${full}/git/refs/heads/main`, { method: "PATCH", body: { sha: commit.sha } });
}

async function enablePages(full, domain) {
  try {
    await gh(`/repos/${full}/pages`, { method: "POST", body: { build_type: "workflow" } });
  } catch (err) {
    if (err.status !== 409) throw err; // 409: Pages already exists
  }
  await gh(`/repos/${full}/pages`, { method: "PUT", body: { build_type: "workflow", cname: domain || null } });
}

// ------------------------------------------------------------------ status

async function jobsFor(full, run) {
  if (jobCache.has(run.id)) return jobCache.get(run.id);
  const jobs = (await gh(`/repos/${full}/actions/runs/${run.id}/jobs`).catch(() => ({ jobs: [] }))).jobs || [];
  if (run.status === "completed" && jobs.length) jobCache.set(run.id, jobs);
  return jobs;
}

async function loadStatus(p) {
  const full = p.full;
  const [runs, pages, deployments, workflow] = await Promise.all([
    gh(`/repos/${full}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=12`).catch(() => ({ workflow_runs: [] })),
    gh(`/repos/${full}/pages`).catch((err) => (err.status === 404 ? { missing: true } : null)),
    gh(`/repos/${full}/deployments?environment=github-pages&per_page=1`).catch(() => []),
    gh(`/repos/${full}/actions/workflows/${WORKFLOW_FILE}`).catch(() => null),
  ]);
  p.runs = runs.workflow_runs || [];
  const jobs = await Promise.all(p.runs.map((r) => jobsFor(full, r)));
  p.jobs = new Map(p.runs.map((r, i) => [r.id, jobs[i]]));
  p.pages = pages;
  p.lastDeploy = deployments[0]?.created_at || null;
  p.paused = !!workflow?.state && workflow.state !== "active";
  // The export report lives on the live site; only refetch it after a deploy.
  if (p.lastDeploy && p.reportFor !== p.lastDeploy) {
    try {
      const res = await fetch(liveUrl(p) + "export-report.json", { cache: "no-store" });
      if (res.ok) { p.report = await res.json(); p.reportFor = p.lastDeploy; }
    } catch {}
  }
  p.loaded = true;
}

function jobState(job) {
  if (!job) return "none";
  if (job.status !== "completed") return "busy";
  if (job.conclusion === "success") return "ok";
  if (job.conclusion === "skipped") return "skip";
  if (job.conclusion === "cancelled") return "skip";
  return "err";
}

const secs = (a, b) => (a && b ? Math.max(0, Math.round((new Date(b) - new Date(a)) / 1000)) : null);

function runInfo(p, run) {
  const jobs = p.jobs?.get(run.id) || [];
  const find = (name) => jobs.find((j) => j.name === name);
  const check = find("Check Framer"), build = find("Export"), deploy = find("Deploy");
  const s = { check: jobState(check), build: jobState(build), deploy: jobState(deploy) };
  let changed = null;
  if (s.check === "ok" && s.build !== "none") changed = s.build !== "skip";
  else if (s.build === "busy" || s.build === "ok" || s.build === "err") changed = true;
  return { run, check, build, deploy, s, changed, running: run.status !== "completed" };
}

/** Everything the canvas and activity feed show, derived from API data. */
function model(p) {
  const infos = (p.runs || []).map((r) => runInfo(p, r));
  const cur = infos[0] || null;
  const lastExport = infos.find((i) => i.s.build === "ok");
  const lastShip = infos.find((i) => i.s.deploy === "ok");
  const checked = infos.filter((i) => i.changed !== null);
  const m = {
    cur,
    infos,
    lastExport,
    lastShip,
    changedCount: checked.filter((i) => i.changed).length,
    sameCount: checked.filter((i) => !i.changed).length,
    running: !!cur?.running,
  };
  m.source = !cur ? "idle" : cur.s.check === "busy" ? "busy" : cur.s.check === "err" ? "err" : "ok";
  m.branch = !cur ? null : cur.changed === true ? "yes" : cur.changed === false ? "no" : null;
  m.export = !cur ? "idle" : m.branch === "yes" ? (cur.s.build === "none" ? "busy" : cur.s.build) : lastExport ? "ok" : "idle";
  m.deploy = !cur ? "idle" : m.branch === "yes" && cur.s.build !== "err"
    ? (cur.s.deploy === "none" ? (cur.s.build === "ok" ? "busy" : "idle") : cur.s.deploy)
    : lastShip || p.lastDeploy ? "ok" : "idle";
  if (m.deploy === "skip") m.deploy = "idle";
  // The deploy job sits queued until the export finishes.
  if (m.export === "busy" && m.deploy === "busy") m.deploy = "idle";
  if (m.export === "skip") m.export = "idle";
  const pstatus = p.pages?.status ?? (p.lastDeploy ? "built" : null);
  m.live = p.pages?.missing ? "err" : m.deploy === "busy" ? "busy" : pstatus === "built" ? "ok" : pstatus === "errored" ? "err" : "idle";

  if (p.paused) m.badge = ["idle", "Paused"];
  else if (m.source === "err" || m.export === "err" || m.deploy === "err" || m.live === "err") m.badge = ["err", "Needs attention"];
  else if (m.running) m.badge = ["busy", m.deploy === "busy" ? "Deploying" : m.export === "busy" ? "Transferring" : "Checking Framer"];
  else if (m.live === "ok") m.badge = ["ok", "In sync"];
  else m.badge = ["idle", "Setting up"];
  return m;
}

// ------------------------------------------------------------------ formatting

function ago(iso) {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function dur(s) {
  if (s == null) return "–";
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

const clockFmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const timeFmt = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const dayFmt = (iso) => {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? timeFmt(iso) : d.toLocaleDateString([], { month: "short", day: "numeric" }) + ", " + timeFmt(iso);
};
const host = (url) => url.replace(/^https?:\/\//, "").replace(/\/$/, "");

/** GitHub runs the 15-minute schedule on the quarter hour, often a few minutes late. */
function nextCheck() {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(Math.floor(d.getMinutes() / 15) * 15 + 15);
  return d;
}

function liveUrl(p) {
  if (p.pages?.html_url) return p.pages.html_url.replace(/\/?$/, "/");
  if (p.config.domain) return `https://${p.config.domain}/`;
  const [owner, repo] = p.full.split("/");
  return repo.toLowerCase() === `${owner.toLowerCase()}.github.io` ? `https://${repo}/` : `https://${owner.toLowerCase()}.github.io/${repo}/`;
}

// ------------------------------------------------------------------ canvas

const ICONS = {
  source: '<svg viewBox="0 0 24 24"><path d="M5 3h14v6H12L5 3Z"/><path d="M5 9h7l7 6H5V9Z"/><path d="M5 15h7v6l-7-6Z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>',
  export: '<svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>',
  skip: '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>',
  deploy: '<svg viewBox="0 0 24 24"><path d="M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.2 2.2 0 0 0-2.9-.1Z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.9A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22.4 22.4 0 0 1-4 2Z"/><path d="M9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0"/><path d="M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5"/></svg>',
  live: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z"/></svg>',
};

const STATE_TEXT = { ok: "Done", busy: "Running", err: "Failed", idle: "Idle", skip: "Skipped", none: "Waiting" };

function head(kind, title, state, text) {
  return `<div class="node-head">${ICONS[kind]}<h3>${esc(title)}</h3><span class="node-state"><i class="dot ${state === "skip" ? "idle" : state}"></i>${esc(text ?? STATE_TEXT[state])}</span></div>`;
}
const row = (label, value, attrs = "") => `<div class="row"${attrs}><span>${label}</span><b>${value}</b></div>`;
const count = (key, n) => `<span data-count="${esc(key)}" data-to="${n}">${n}</span>`;
const since = (iso) => `<span data-since="${esc(iso)}">${clockFmt(secs(iso, new Date()) || 0)}</span>`;
const agoEl = (iso) => `<span data-ago="${esc(iso || "")}">${ago(iso)}</span>`;

function currentStep(job) {
  const step = job?.steps?.find((s) => s.status === "in_progress") || job?.steps?.find((s) => s.status === "queued");
  if (!step) return job?.status === "queued" ? "Waiting for a runner" : "Starting";
  return step.name.replace(/^Run /, "");
}

function renderNodes(p, m) {
  const canvas = $("#canvas");
  const node = (name) => $(`[data-node="${name}"]`, canvas);
  const cur = m.cur;
  const r = p.report;

  // Framer site
  const src = node("source");
  src.className = "node" + (m.source === "busy" ? " is-busy" : m.source === "err" ? " is-err" : "");
  src.innerHTML = `<span class="node-tag">Start</span>
    ${head("source", "Framer site", p.paused ? "idle" : m.source, p.paused ? "Paused" : m.source === "busy" ? "Checking" : m.source === "err" ? "Unreachable" : cur ? "Watching" : "Waiting")}
    <div class="box">
      ${row("Site", `<a class="site-link" href="${esc(p.config.framerUrl)}" target="_blank" rel="noopener">${esc(host(p.config.framerUrl))}</a>`)}
      ${row("Checks", p.paused ? "Paused" : "Every 15 min")}
    </div>
    <div class="box">
      ${row('<i class="clock"></i> Last check', cur ? agoEl(cur.run.run_started_at || cur.run.created_at) : "Not yet")}
      ${row('<i class="clock"></i> Next check', p.paused ? "Paused" : `<span data-countdown>${clockFmt((nextCheck() - Date.now()) / 1000)}</span>`)}
    </div>`;

  // New publish?
  const chk = node("check");
  const checkJob = cur?.check;
  chk.className = "node" + (m.source === "busy" ? " is-busy" : m.source === "err" ? " is-err" : "");
  const verdict = !cur ? "Waiting" : m.source === "busy" ? "Comparing" : m.branch === "yes" ? "New publish" : m.branch === "no" ? "No change" : "–";
  chk.innerHTML = `${head("check", "New publish?", m.source === "busy" ? "busy" : m.source === "err" ? "err" : cur ? "ok" : "idle", verdict)}
    <div class="box">
      <div class="box-title">Compares the published build with the live copy</div>
      ${row("Took", m.source === "busy" && checkJob?.started_at ? since(checkJob.started_at) : dur(secs(checkJob?.started_at, checkJob?.completed_at)))}
    </div>
    <div class="box">
      ${row('<i class="dot ok"></i> Changed', `${count("changed", m.changedCount)}<span class="sep">/</span>${m.infos.length}`, ' data-port="yes"')}
      ${row('<i class="dot"></i> No change', `${count("same", m.sameCount)}<span class="sep">/</span>${m.infos.length}`, ' data-port="no"')}
    </div>`;

  // Export
  const exp = node("export");
  const b = m.branch === "yes" ? cur.build : m.lastExport?.build;
  exp.className = "node" + (m.export === "busy" ? " is-busy" : m.export === "err" ? " is-err" : "");
  if (m.export === "busy") {
    exp.innerHTML = `${head("export", "Export", "busy", "Transferring")}
      <div class="box">
        <div class="box-title">${esc(currentStep(b))}</div>
        <div class="meter indeterminate"><i></i></div>
        ${row("Elapsed", b?.started_at ? since(b.started_at) : "0:00")}
        ${r ? row("Last time", `${r.pages.length} pages<span class="sep">·</span>${r.files} files`) : ""}
      </div>`;
  } else {
    const failed = r?.failures?.length || 0;
    exp.innerHTML = `${head("export", "Export", m.export, m.export === "err" ? "Failed" : r ? "Exported" : "Not yet")}
      <div class="box">
        ${row("Pages", r ? count("pages", r.pages.length) : "–")}
        ${row("Files", r ? count("files", r.files) : "–")}
        ${row("Skipped", r ? (failed ? `<span title="${esc(r.failures.slice(0, 8).join("\n"))}">${failed}</span>` : "0") : "–")}
      </div>
      <div class="box">
        ${row('<i class="clock"></i> Exported', r ? agoEl(r.exportedAt) : m.export === "err" ? "Failed" : "–")}
        ${row("Took", dur(secs(b?.started_at, b?.completed_at)))}
        ${m.export === "err" ? '<div class="box-title">The live site was kept as it was.</div>' : ""}
      </div>`;
  }

  // Up to date
  const skip = node("skip");
  let streak = 0;
  for (const i of m.infos) { if (i.changed === false) streak++; else if (i.changed === true) break; }
  skip.className = "node small" + (m.branch === "no" ? "" : " is-dim");
  skip.innerHTML = `${head("skip", "Up to date", m.branch === "no" ? "ok" : "idle", m.branch === "no" ? "Nothing to do" : "Not this time")}
    <div class="box">
      ${row("Quiet checks", `${count("streak", streak)} in a row`)}
      ${row("Last change", p.lastDeploy ? agoEl(p.lastDeploy) : "–")}
    </div>`;

  // Deploy
  const dep = node("deploy");
  const d = m.branch === "yes" && cur.deploy && m.deploy !== "idle" ? cur.deploy : m.lastShip?.deploy;
  dep.className = "node" + (m.deploy === "busy" ? " is-busy" : m.deploy === "err" ? " is-err" : "");
  dep.innerHTML = `${head("deploy", "Deploy", m.deploy, m.deploy === "busy" ? "Shipping" : m.deploy === "err" ? "Failed" : m.deploy === "ok" ? "Shipped" : "Waiting")}
    <div class="box">
      ${row("Target", "GitHub Pages")}
      ${m.deploy === "busy" ? row("Elapsed", d?.started_at ? since(d.started_at) : "0:00") : row("Took", dur(secs(d?.started_at, d?.completed_at)))}
      ${m.deploy === "busy" ? '<div class="meter indeterminate"><i></i></div>' : row('<i class="clock"></i> Shipped', p.lastDeploy ? agoEl(p.lastDeploy) : "–")}
    </div>`;

  // Live site
  const live = node("live");
  const url = liveUrl(p);
  live.className = "node" + (m.live === "busy" ? " is-busy" : m.live === "err" ? " is-err" : "");
  live.innerHTML = `${head("live", "Live site", m.live, { ok: "Online", busy: "Updating", err: p.pages?.missing ? "Pages off" : "Error", idle: "Not yet" }[m.live])}
    <div class="box">
      ${row("Address", `<a class="site-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(host(url))}</a>`)}
      ${row("Serving", r ? `${count("live-pages", r.pages.length)} pages` : "–")}
      ${row("Mode", r ? (r.mode === "static" ? "Plain HTML" : "Interactive") : "–")}
    </div>
    <div class="box">
      ${row('<i class="clock"></i> Version from', p.lastDeploy ? dayFmt(p.lastDeploy) : "–")}
    </div>`;

  countUp();
}

/** Numbers roll up when they change, so new data feels like it arrived. */
const lastCounts = new Map();
function countUp() {
  for (const el of $$("[data-count]")) {
    const key = selected + ":" + el.dataset.count;
    const to = Number(el.dataset.to);
    const from = lastCounts.has(key) ? lastCounts.get(key) : 0;
    lastCounts.set(key, to);
    if (from === to || matchMedia("(prefers-reduced-motion: reduce)").matches) continue;
    const t0 = performance.now();
    const len = 900;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / len);
      el.textContent = Math.round(from + (to - from) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
    };
    el.textContent = from;
    requestAnimationFrame(step);
  }
}

const SVGNS = "http://www.w3.org/2000/svg";
let drawnFor = null;

function portOf(el, side) {
  const x = el.offsetLeft, y = el.offsetTop, w = el.offsetWidth, h = el.offsetHeight;
  return { right: [x + w, y + h / 2], left: [x, y + h / 2], bottom: [x + w / 2, y + h], top: [x + w / 2, y] }[side];
}

/** A port level with the node's title, so side-by-side nodes join in a straight line. */
function headPort(el, side) {
  return [side === "right" ? el.offsetLeft + el.offsetWidth : el.offsetLeft, el.offsetTop + 22];
}

function rowPort(nodeEl, name) {
  const r = $(`[data-port="${name}"]`, nodeEl);
  if (!r) return portOf(nodeEl, "right");
  let y = r.offsetTop + r.offsetHeight / 2;
  for (let e = r.offsetParent; e && e !== nodeEl; e = e.offsetParent) y += e.offsetTop;
  return [nodeEl.offsetLeft + nodeEl.offsetWidth, nodeEl.offsetTop + y];
}

const hCurve = ([x1, y1], [x2, y2]) => {
  const dx = Math.max(30, Math.abs(x2 - x1) / 2);
  return `M${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
};
const vCurve = ([x1, y1], [x2, y2]) => {
  const dy = Math.max(30, Math.abs(y2 - y1) / 2);
  return `M${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`;
};

function renderWires(p, m) {
  const svg = $("#wires");
  const n = (name) => $(`[data-node="${name}"]`);
  if (!n("source").offsetWidth) return; // stacked phone layout: CSS draws the links
  const wireState = (s) => (s === "busy" ? "busy" : s === "err" ? "err" : s === "ok" ? "ok" : "");
  const wires = [
    { id: "w-src", d: hCurve(portOf(n("source"), "right"), portOf(n("check"), "left")), cls: m.source === "busy" ? "busy" : m.source === "err" ? "err" : m.cur ? "ok" : "", ambient: !p.paused && !m.running },
    { id: "w-yes", d: hCurve(rowPort(n("check"), "yes"), portOf(n("export"), "left")), cls: m.branch === "yes" ? (m.export === "busy" ? "busy" : m.export === "err" ? "err" : "yes") : "yes faded", port: "yes" },
    { id: "w-no", d: hCurve(rowPort(n("check"), "no"), portOf(n("skip"), "left")), cls: m.branch === "no" ? "no" : "no faded", port: "no" },
    { id: "w-dep", d: hCurve(headPort(n("export"), "right"), headPort(n("deploy"), "left")), cls: m.branch === "yes" ? wireState(m.deploy) : m.lastShip ? "ok faded" : "" },
    { id: "w-live", d: vCurve(portOf(n("deploy"), "bottom"), portOf(n("live"), "top")), cls: m.deploy === "busy" ? "busy" : wireState(m.live) },
  ];
  const draw = drawnFor !== p.full;
  drawnFor = p.full;
  svg.setAttribute("viewBox", `0 0 ${CANVAS_W} ${CANVAS_H}`);
  svg.innerHTML = "";
  for (const w of wires) {
    const path = document.createElementNS(SVGNS, "path");
    path.id = w.id;
    path.setAttribute("d", w.d);
    path.setAttribute("class", `wire ${w.cls}`.trim());
    svg.append(path);
    if (draw) {
      const len = Math.ceil(path.getTotalLength());
      path.style.setProperty("--len", len);
      path.classList.add("wire-draw");
      path.addEventListener("animationend", () => path.classList.remove("wire-draw"), { once: true });
    }
    // Ports at both ends.
    const pts = w.d.match(/-?[\d.]+/g).map(Number);
    for (const [x, y] of [[pts[0], pts[1]], [pts[pts.length - 2], pts[pts.length - 1]]]) {
      const c = document.createElementNS(SVGNS, "circle");
      c.setAttribute("cx", x);
      c.setAttribute("cy", y);
      c.setAttribute("r", 4.5);
      const st = /busy/.test(w.cls) ? "" : /err/.test(w.cls) ? "err" : /faded/.test(w.cls) || !w.cls ? "idle" : w.port || "";
      c.setAttribute("class", `port ${st}`.trim());
      svg.append(c);
    }
    // Data packets travel along busy wires; a slow one shows Bridge is watching.
    if (/busy/.test(w.cls) || w.ambient) {
      const packets = w.ambient ? 1 : 2;
      for (let i = 0; i < packets; i++) {
        const dot = document.createElementNS(SVGNS, "circle");
        dot.setAttribute("r", w.ambient ? 3 : 4);
        dot.setAttribute("class", "pulse-dot");
        if (w.ambient) dot.style.opacity = ".45";
        const am = document.createElementNS(SVGNS, "animateMotion");
        const secsLen = w.ambient ? 3.2 : 1.4;
        am.setAttribute("dur", `${secsLen}s`);
        am.setAttribute("begin", `${(i * secsLen) / packets}s`);
        am.setAttribute("repeatCount", "indefinite");
        const mp = document.createElementNS(SVGNS, "mpath");
        mp.setAttribute("href", `#${w.id}`);
        am.append(mp);
        dot.append(am);
        svg.append(dot);
      }
    }
  }
}

/** A bright spark runs along a wire once, for a moment worth noticing. */
function spark(wireId) {
  const svg = $("#wires");
  if (!$("#" + wireId, svg)) return;
  const dot = document.createElementNS(SVGNS, "circle");
  dot.setAttribute("r", 5);
  dot.setAttribute("class", "spark");
  dot.innerHTML = `<animateMotion dur="0.9s" fill="freeze" begin="indefinite"><mpath href="#${wireId}"/></animateMotion>`;
  svg.append(dot);
  dot.firstElementChild.beginElement();
  setTimeout(() => dot.remove(), 1000);
}

function flash(name) {
  const el = $(`[data-node="${name}"]`);
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
  setTimeout(() => el.classList.remove("flash"), 950);
}

function fitCanvas() {
  const wrap = $("#canvas-wrap");
  const canvas = $("#canvas");
  if (!wrap || $("#stage-project").hidden) return;
  if (matchMedia("(max-width: 760px)").matches) {
    wrap.style.height = "";
    canvas.style.transform = "";
    return;
  }
  const scale = Math.min(1, wrap.clientWidth / CANVAS_W);
  canvas.style.transform = `scale(${scale})`;
  wrap.style.height = `${CANVAS_H * scale}px`;
}

// ------------------------------------------------------------------ activity

function activityItems(p, m) {
  const items = [];
  const byRun = m.infos;
  for (let i = 0; i < byRun.length; i++) {
    const it = byRun[i];
    const when = it.run.run_started_at || it.run.created_at;
    const why = { workflow_dispatch: "Manual sync", push: "Settings changed", schedule: "Scheduled check" }[it.run.event] || "Check";
    if (it.running) {
      const jobs = [it.deploy, it.build, it.check].filter((j) => j && j.status !== "completed");
      const job = jobs.find((j) => j.status === "in_progress") || jobs[0];
      items.push({ dot: "busy", title: it.changed ? "Shipping a new publish" : "Checking Framer", meta: `${why} · ${currentStep(job)}` });
      continue;
    }
    if (it.s.check === "err") { items.push({ dot: "err", title: "Couldn't reach Framer", meta: `${dayFmt(when)} · live site kept`, href: it.run.html_url }); continue; }
    if (it.s.build === "err") { items.push({ dot: "err", title: "Export failed, live site kept", meta: dayFmt(when), href: it.run.html_url }); continue; }
    if (it.s.deploy === "err") { items.push({ dot: "err", title: "Deploy failed, live site kept", meta: dayFmt(when), href: it.run.html_url }); continue; }
    if (it.s.deploy === "ok") {
      const took = secs(it.run.run_started_at || it.run.created_at, it.run.updated_at);
      items.push({ dot: "ok", title: it.run.event === "schedule" ? "New publish shipped" : `${why}, shipped`, meta: `${dayFmt(when)} · took ${dur(took)}`, href: it.run.html_url });
      continue;
    }
    if (it.changed === false) {
      // Fold a streak of quiet checks into one line.
      let j = i;
      while (j + 1 < byRun.length && byRun[j + 1].changed === false && !byRun[j + 1].running) j++;
      const n = j - i + 1;
      const first = byRun[j].run.run_started_at || byRun[j].run.created_at;
      items.push({ dot: "", title: n > 1 ? `${n} checks, no changes` : "Checked, no changes", meta: n > 1 ? `${timeFmt(first)} to ${dayFmt(when)}` : dayFmt(when), href: it.run.html_url });
      i = j;
      continue;
    }
    items.push({ dot: "", title: it.run.conclusion === "cancelled" ? "Run cancelled" : why, meta: dayFmt(when), href: it.run.html_url });
  }
  return items.slice(0, 8);
}

function renderActivity(p, m) {
  const ol = $("#activity");
  const pending = p.paused
    ? `<li class="pending"><i class="dot"></i><span class="a-title">Auto-sync paused</span><span class="a-meta"></span></li>`
    : m.running ? "" : `<li class="pending"><i class="dot"></i><span class="a-title">Next check in <span data-countdown>${clockFmt((nextCheck() - Date.now()) / 1000)}</span></span><span class="a-meta"></span></li>`;
  const items = activityItems(p, m);
  const html = pending + (items.length
    ? items.map((i) => `<li><i class="dot ${i.dot}"></i>${i.href ? `<a class="a-title" href="${esc(i.href)}" target="_blank" rel="noopener">${esc(i.title)}</a>` : `<span class="a-title">${esc(i.title)}</span>`}<span class="a-meta">${esc(i.meta)}</span></li>`).join("")
    : `<li><i class="dot"></i><span class="a-title">Nothing yet</span><span class="a-meta">The first check runs within 15 minutes.</span></li>`);
  // Only replace the list when it changed, so entries don't re-animate on every poll.
  if (ol.dataset.html !== html) { ol.innerHTML = html; ol.dataset.html = html; }
}

// ------------------------------------------------------------------ rendering

function renderList() {
  const list = [...projects.values()].sort((a, b) => a.full.localeCompare(b.full));
  const ul = $("#project-list");
  ul.innerHTML = list.map((p) => {
    const state = p.loaded ? model(p).badge[0] : "";
    return `<li><button data-select="${esc(p.full)}" aria-current="${p.full === selected}">
      <i class="dot ${state}"></i>
      <span class="pl-name">${esc(p.full.split("/")[1])}<span class="pl-sub">${esc(host(p.config.framerUrl))}</span></span>
    </button></li>`;
  }).join("");
}

function render() {
  if (selected && !projects.has(selected)) selected = null;
  if (!selected && projects.size) selected = [...projects.keys()].sort()[0];
  renderList();
  const p = projects.get(selected);
  $("#stage-empty").hidden = !!p || !scanned;
  $("#stage-project").hidden = !p;
  $("#rail").hidden = !p;
  updateClock();
  if (!p) return;

  $("#p-owner").textContent = p.full.split("/")[0];
  $("#p-name").textContent = p.full.split("/")[1];
  $("#a-view").href = liveUrl(p);
  $("#a-repo").href = `https://github.com/${p.full}`;
  $("#a-run").href = p.runs?.[0]?.html_url || `https://github.com/${p.full}/actions`;
  $("#pause-label").textContent = p.paused ? "Resume auto-sync" : "Pause auto-sync";
  $("#pause-ico").innerHTML = p.paused ? '<path d="M7 4v16l13-8Z"/>' : '<path d="M9 5v14M15 5v14"/>';

  const badge = $("#p-badge");
  if (!p.loaded) {
    badge.className = "badge busy";
    badge.textContent = "Connecting";
    return;
  }
  const m = model(p);
  badge.className = "badge " + m.badge[0];
  badge.textContent = m.badge[1];

  fitCanvas();
  renderNodes(p, m);
  renderWires(p, m);
  renderActivity(p, m);
  celebrate(p, m);
}

/** Mark the moments that matter as they happen. */
function celebrate(p, m) {
  const prev = p.prev;
  p.prev = { source: m.source, branch: m.branch, export: m.export, deploy: m.deploy, run: m.cur?.run.id };
  if (!prev || document.hidden) return;
  if (prev.source === "busy" && m.branch === "yes") { spark("w-yes"); flash("export"); toast("New publish found. Exporting it now."); }
  if (prev.source === "busy" && m.branch === "no") { spark("w-no"); flash("skip"); }
  if (prev.export === "busy" && m.export === "ok") { spark("w-dep"); flash("deploy"); }
  if (prev.deploy === "busy" && m.deploy === "ok") { spark("w-live"); flash("live"); toast("New version is live"); }
  if (prev.export === "busy" && m.export === "err") toast("Export failed. The live site wasn't touched.");
}

function updateClock() {
  const el = $("#top-clock");
  el.hidden = !me;
  if (!me) return;
  const all = [...projects.values()].filter((p) => p.loaded);
  const busy = all.filter((p) => p.runs?.[0] && p.runs[0].status !== "completed");
  const text = busy.length
    ? `Syncing ${busy.map((p) => p.full.split("/")[1]).join(", ")}`
    : `Watching ${projects.size} ${projects.size === 1 ? "site" : "sites"} · next check ${clockFmt((nextCheck() - Date.now()) / 1000)}`;
  $("#clock-text").textContent = text;
  el.classList.toggle("busy", busy.length > 0);
}

/** Once a second: countdowns, elapsed timers and "ago" labels stay current. */
function tick() {
  const left = clockFmt(Math.max(0, (nextCheck() - Date.now()) / 1000));
  for (const el of $$("[data-countdown]")) el.textContent = left;
  for (const el of $$("[data-since]")) el.textContent = clockFmt(secs(el.dataset.since, new Date()) || 0);
  for (const el of $$("[data-ago]")) el.textContent = ago(el.dataset.ago);
  updateClock();
}

let toastTimer;
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

// ------------------------------------------------------------------ loading

function saveCache() {
  store.set(CACHE_KEY, JSON.stringify([...projects.values()].map((p) => ({ full: p.full, config: p.config }))));
}

async function scanProjects() {
  $("#scan-status").textContent = "Looking for connected repositories…";
  const repos = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await gh(`/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator`);
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  const found = new Set();
  let i = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < repos.length) {
      const r = repos[i++];
      if (!r.permissions?.push) continue;
      const config = await readConfig(r.full_name).catch(() => null);
      if (!config?.framerUrl) continue;
      found.add(r.full_name);
      if (!projects.has(r.full_name)) {
        projects.set(r.full_name, { full: r.full_name, config });
        render();
        refreshProject(r.full_name);
      } else {
        projects.get(r.full_name).config = config;
      }
    }
  }));
  for (const full of [...projects.keys()]) if (!found.has(full)) projects.delete(full);
  saveCache();
  scanned = true;
  $("#scan-status").textContent = "";
  render();
}

async function refreshProject(full) {
  const p = projects.get(full);
  if (!p) return;
  try {
    await loadStatus(p);
  } catch (err) {
    console.warn(full, err);
  }
  render();
  schedulePoll();
}

function refreshAll() {
  return Promise.all([...projects.keys()].map(refreshProject));
}

function schedulePoll() {
  clearTimeout(pollTimer);
  const anyRunning = [...projects.values()].some((p) => p.runs?.[0] && p.runs[0].status !== "completed");
  pollTimer = setTimeout(() => {
    if (document.visibilityState === "visible") refreshAll();
    else schedulePoll();
  }, anyRunning ? 4000 : 30000);
}

// ------------------------------------------------------------------ actions

async function syncNow(full, button) {
  const label = $("span", button);
  button.disabled = true;
  label.textContent = "Starting…";
  try {
    const before = projects.get(full)?.runs?.[0]?.id;
    await gh(`/repos/${full}/actions/workflows/${WORKFLOW_FILE}/dispatches`, { method: "POST", body: { ref: "main" } });
    toast("Sync started");
    // The run takes a moment to appear.
    for (let i = 0; i < 8; i++) {
      await sleep(2000);
      await refreshProject(full);
      if (projects.get(full)?.runs?.[0]?.id !== before) break;
    }
  } catch (err) {
    toast(`Couldn't start a sync: ${friendly(err)}`);
  } finally {
    button.disabled = false;
    label.textContent = "Sync now";
  }
}

async function togglePause(full, button) {
  const p = projects.get(full);
  button.disabled = true;
  try {
    await gh(`/repos/${full}/actions/workflows/${WORKFLOW_FILE}/${p.paused ? "enable" : "disable"}`, { method: "PUT" });
    toast(p.paused ? "Auto-sync is back on" : "Auto-sync paused");
    await refreshProject(full);
  } catch (err) {
    toast(friendly(err));
  } finally {
    button.disabled = false;
  }
}

async function copyUrl(full) {
  const url = liveUrl(projects.get(full));
  try {
    await navigator.clipboard.writeText(url);
    toast("Copied " + host(url));
  } catch {
    toast(host(url));
  }
}

function normalizeFramerUrl(v) {
  v = v.trim();
  if (!/^https?:\/\//i.test(v)) v = "https://" + v;
  const u = new URL(v);
  if (/(^|\.)framer\.com$/i.test(u.hostname)) {
    throw new Error("That looks like the Framer editor link. Use the published site address instead.");
  }
  return u.origin;
}

function normalizeDomain(v) {
  return v.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
}

function templateReadme(full, config) {
  const name = full.split("/")[1];
  return `# ${name}

A GitHub Pages copy of the Framer site [${host(config.framerUrl)}](${config.framerUrl}),
kept in sync by Bridge.

Every 15 minutes \`.github/workflows/${WORKFLOW_FILE}\` checks whether the Framer
site was republished. If it was, it runs \`tools/framer-export.mjs\` and deploys
the result. To update right away, open the **Actions** tab, pick
**Framer Bridge sync** and click **Run workflow**.

Things that only work on Framer's hosting (forms, CMS search, analytics, checkout)
won't work in this copy.
`;
}

async function loadTemplates() {
  const [exporter, workflow] = await Promise.all(
    ["template/framer-export.mjs", "template/framer-bridge.yml"].map((f) =>
      fetch(f, { cache: "no-cache" }).then((r) => {
        if (!r.ok) throw new Error(`Couldn't load ${f}`);
        return r.text();
      })
    )
  );
  return { exporter, workflow };
}

function progressStep(text) {
  const li = document.createElement("li");
  li.innerHTML = `<i class="dot busy"></i><span class="a-title"></span><span class="a-meta"></span>`;
  $(".a-title", li).textContent = text;
  $("#connect-progress").append(li);
  return {
    done(note = "") { $(".dot", li).className = "dot ok"; $(".a-meta", li).textContent = note; },
    fail(note) { $(".dot", li).className = "dot err"; $(".a-meta", li).textContent = note; },
  };
}

async function connect(e) {
  e.preventDefault();
  const err = $("#connect-error");
  err.hidden = true;
  let framerUrl, domain, full, isNew;
  try {
    framerUrl = normalizeFramerUrl($("#framer-url").value);
    domain = normalizeDomain($("#domain").value);
    isNew = document.querySelector('input[name="repo-mode"]:checked').value === "new";
    if (isNew) {
      const name = $("#repo-name").value.trim();
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("Give the new repository a name (letters, numbers, dashes).");
      full = `${me.login}/${name}`;
    } else {
      full = $("#repo-select").value;
      if (!full) throw new Error("Pick a repository.");
    }
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
    return;
  }

  $("#connect-fields").hidden = true;
  $("#connect-progress").hidden = false;
  $("#connect-progress").innerHTML = "";
  let step;
  try {
    step = progressStep("Loading the exporter");
    const t = await loadTemplates();
    step.done();

    if (isNew) {
      step = progressStep(`Creating ${full}`);
      await gh("/user/repos", {
        method: "POST",
        body: {
          name: full.split("/")[1],
          private: $("#repo-private").checked,
          auto_init: true,
          description: `GitHub Pages copy of ${host(framerUrl)}, synced from Framer by Bridge`,
        },
      });
      step.done();
    } else {
      step = progressStep(`Checking ${full}`);
      const repo = await gh(`/repos/${full}`);
      if (!repo.permissions?.push) throw new Error("You don't have write access to that repository.");
      step.done();
    }

    step = progressStep("Turning on GitHub Pages");
    await enablePages(full, domain);
    step.done(domain ? `Custom domain ${domain} set` : "");

    step = progressStep("Installing the sync workflow");
    const config = { framerUrl, domain: domain || undefined, connectedAt: new Date().toISOString(), version: 1 };
    const files = {
      [WORKFLOW_PATH]: t.workflow,
      "tools/framer-export.mjs": t.exporter,
      [CONFIG_PATH]: JSON.stringify(config, null, 2) + "\n",
    };
    const hasReadme = await gh(`/repos/${full}/contents/README.md`).then((f) => f.size > 60, () => false);
    if (!hasReadme) files["README.md"] = templateReadme(full, config);
    await commitFiles(full, files, `Connect to Framer site ${framerUrl}\n\nInstalled by Bridge.`);
    step.done("The first sync has started");

    projects.set(full, { full, config });
    selected = full;
    store.set(SELECTED_KEY, full);
    drawnFor = null;
    saveCache();
    render();
    refreshProject(full);
    const done = progressStep(domain
      ? `Almost there: add a DNS record pointing ${domain} at ${me.login.toLowerCase()}.github.io`
      : "Connected. Close this to watch the first sync.");
    done.done();
  } catch (ex) {
    step?.fail(friendly(ex));
  }
  $("#connect-done").hidden = false;
}

function friendly(err) {
  if (err.status === 401) return "GitHub rejected the token. Sign out and sign in with a new one.";
  if (err.status === 403 || err.status === 404) {
    return `${err.message}. Check the token has the "repo" and "workflow" permissions.`;
  }
  if (err.status === 422 && /name already exists/i.test(err.message)) return "A repository with that name already exists. Pick another name or use the existing one.";
  return err.message;
}

let settingsFor = null;
function openSettings(full) {
  const p = projects.get(full);
  settingsFor = full;
  $("#settings-title").textContent = full.split("/")[1];
  $("#set-framer-url").value = p.config.framerUrl;
  $("#set-domain").value = p.config.domain || "";
  $("#settings-error").hidden = true;
  $("#settings-dialog").showModal();
}

async function saveSettings(e) {
  e.preventDefault();
  const p = projects.get(settingsFor);
  const err = $("#settings-error");
  err.hidden = true;
  try {
    const framerUrl = normalizeFramerUrl($("#set-framer-url").value);
    const domain = normalizeDomain($("#set-domain").value);
    const config = { ...p.config, framerUrl, domain: domain || undefined };
    if (domain !== (p.config.domain || "")) await enablePages(p.full, domain);
    await commitFiles(p.full, { [CONFIG_PATH]: JSON.stringify(config, null, 2) + "\n" }, "Update Bridge settings");
    p.config = config;
    saveCache();
    $("#settings-dialog").close();
    toast("Saved. Re-exporting now.");
    refreshProject(p.full);
  } catch (ex) {
    err.textContent = friendly(ex);
    err.hidden = false;
  }
}

async function openConnect() {
  const dlg = $("#connect-dialog");
  $("#connect-form").reset();
  $("#connect-fields").hidden = false;
  $("#connect-progress").hidden = true;
  $("#connect-done").hidden = true;
  $("#connect-error").hidden = true;
  $("#repo-new").hidden = false;
  $("#repo-existing").hidden = true;
  $("#default-address").textContent = `${me.login.toLowerCase()}.github.io/<repo>`;
  dlg.showModal();
  const sel = $("#repo-select");
  sel.innerHTML = "<option value=''>Loading…</option>";
  try {
    const repos = await gh("/user/repos?per_page=100&sort=pushed&affiliation=owner");
    sel.innerHTML = "";
    for (const r of repos.filter((r) => r.permissions?.push && !projects.has(r.full_name))) {
      sel.add(new Option(r.full_name + (r.private ? " (private)" : ""), r.full_name));
    }
  } catch {
    sel.innerHTML = "<option value=''>Couldn't load repositories</option>";
  }
}

// ------------------------------------------------------------------ wiring

async function signIn(t) {
  token = t;
  me = await gh("/user");
  store.set(TOKEN_KEY, t);
  $("#avatar").src = me.avatar_url;
  $("#login").textContent = me.login;
  $("#account").hidden = false;
  $("#view-signin").hidden = true;
  $("#view-app").hidden = false;
  try {
    for (const c of JSON.parse(store.get(CACHE_KEY) || "[]")) projects.set(c.full, c);
  } catch {}
  scanned = projects.size > 0;
  render();
  refreshAll();
  setInterval(tick, 1000);
  scanProjects().catch((err) => {
    scanned = true;
    $("#scan-status").textContent = "Couldn't look for other connected projects.";
    $("#scan-status").title = friendly(err);
    render();
  });
}

function signOut() {
  store.del(TOKEN_KEY);
  store.del(CACHE_KEY);
  store.del(SELECTED_KEY);
  location.reload();
}

$("#token-link").href =
  "https://github.com/settings/tokens/new?scopes=repo,workflow&description=Bridge";

$("#signin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("#signin-error");
  errEl.hidden = true;
  try {
    await signIn($("#token").value.trim());
  } catch (err) {
    token = null;
    errEl.textContent = err.status === 401 ? "GitHub didn't accept that token." : err.message;
    errEl.hidden = false;
  }
});
$("#signout").addEventListener("click", signOut);
$("#connect-form").addEventListener("submit", connect);
$("#settings-form").addEventListener("submit", saveSettings);
for (const input of $$('input[name="repo-mode"]')) {
  input.addEventListener("change", () => {
    const isNew = input.value === "new" && input.checked;
    $("#repo-new").hidden = !isNew;
    $("#repo-existing").hidden = isNew;
  });
}
document.addEventListener("click", (e) => {
  const closer = e.target.closest("[data-close]");
  if (closer) closer.closest("dialog").close();
  const pick = e.target.closest("[data-select]");
  if (pick) {
    selected = pick.dataset.select;
    store.set(SELECTED_KEY, selected);
    drawnFor = null;
    render();
    return;
  }
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === "connect") return openConnect();
  if (!selected) return;
  if (action === "sync") syncNow(selected, btn);
  if (action === "pause") togglePause(selected, btn);
  if (action === "settings") openSettings(selected);
  if (action === "copy") copyUrl(selected);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && me) refreshAll();
});
let resizeFrame;
addEventListener("resize", () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    fitCanvas();
    const p = projects.get(selected);
    if (p?.loaded) renderWires(p, model(p));
  });
});

if (token) {
  signIn(token).catch(() => {
    store.del(TOKEN_KEY);
    $("#view-signin").hidden = false;
  });
} else {
  $("#view-signin").hidden = false;
}
