// Bridge: keeps a GitHub Pages copy of a published Framer site in sync, and
// shows the sync happening live. There is no server: everything below talks
// to the GitHub REST API from the browser with the user's own GitHub token,
// which comes from signing in with GitHub (account.js, through Supabase) or
// from an access token pasted on the start screen.

import * as account from "./account.js";

const API = "https://api.github.com";
// What Bridge installs in a repo. The names only describe the site, so nothing
// in the repo mentions the tool the site was designed in. Repos connected
// before the rename use the legacy names until they are reconnected.
const WORKFLOW_FILE = "sync.yml";
const WORKFLOW_PATH = `.github/workflows/${WORKFLOW_FILE}`;
const CONFIG_PATH = ".site.json";
const EXPORTER_PATH = "tools/export.mjs";
const PROJECT_TOOL_PATH = "tools/project.mjs";
const REACT_TOOL_PATH = "tools/react.mjs";
// Repo-to-repo links: .links.json lists the folders a repo pulls from others
// ("pull") and the repos to tell when it changes ("push").
const LINKS_PATH = ".links.json";
const PULL_WORKFLOW = "pull.yml";
const NOTIFY_WORKFLOW = "notify.yml";
const LINKS_TOOL_PATH = "tools/links.mjs";
const SYNC_SECRET = "SYNC_TOKEN";
const LEGACY = { workflow: "framer-bridge.yml", config: ".framer-bridge.json", exporter: "tools/framer-export.mjs" };
const TOKEN_KEY = "framer-bridge:token";
const CACHE_KEY = "framer-bridge:projects";
const LINKS_CACHE_KEY = "framer-bridge:links";
const SELECTED_KEY = "framer-bridge:selected";
const CANVAS_W = 900;
const CANVAS_H = 500;

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
let selected = store.get(SELECTED_KEY) || null; // null: the connection map
const SITES_KEY = "framer-bridge:sites";
const PENDING_SITE_KEY = "framer-bridge:pending-site";
/** Repositories the user can push to (from the last scan). */
let allRepos = [];
/** Framer sites added on the map but not connected yet. */
let looseSites = (() => { try { return JSON.parse(store.get(SITES_KEY) || "[]"); } catch { return []; } })();
const REPO_SOURCES_KEY = "framer-bridge:repo-sources";
/** Repositories added on the map as sources but not linked yet. */
let looseRepos = (() => { try { return JSON.parse(store.get(REPO_SOURCES_KEY) || "[]"); } catch { return []; } })();
/** full_name -> { full, links: { pull, push }, runs, loaded }, for repos with a .links.json */
const linkRepos = new Map();
/** Signed in through Supabase: its user id, so settings follow the user. */
let accountId = null;
let pushTimer;
const saveSites = () => {
  store.set(SITES_KEY, JSON.stringify(looseSites));
  store.set(REPO_SOURCES_KEY, JSON.stringify(looseRepos));
  if (!accountId) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => account.saveSettings(accountId, { sites: looseSites, repos: looseRepos }).catch((err) => console.warn("Couldn't save settings", err)), 500);
};

/** Brings in the sites saved on other devices. */
async function pullSettings() {
  if (!accountId) return;
  try {
    const remote = await account.loadSettings(accountId);
    const merged = [...new Set([...(remote.sites || []), ...looseSites])];
    const mergedRepos = [...new Set([...(remote.repos || []), ...looseRepos])];
    const changed = merged.length !== (remote.sites || []).length || mergedRepos.length !== (remote.repos || []).length;
    looseSites = merged;
    looseRepos = mergedRepos;
    store.set(SITES_KEY, JSON.stringify(looseSites));
    store.set(REPO_SOURCES_KEY, JSON.stringify(looseRepos));
    if (changed) saveSites();
    mapHtml = null;
    render();
  } catch (err) {
    console.warn("Couldn't load settings", err);
  }
}
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

/** The repo's site config, as { framerUrl, domain, …, legacy }. */
async function readConfig(full) {
  for (const [path, legacy] of [[CONFIG_PATH, false], [LEGACY.config, true]]) {
    try {
      const c = JSON.parse(b64decode((await gh(`/repos/${full}/contents/${path}`)).content));
      return { ...c, framerUrl: c.source || c.framerUrl, legacy };
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }
  return null;
}

/** The repo's links, as { pull: [...], push: [...] }, or null without a .links.json. */
async function readLinks(full, ref) {
  try {
    const c = JSON.parse(b64decode((await gh(`/repos/${full}/contents/${LINKS_PATH}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`)).content));
    return { pull: c.pull || [], push: c.push || [] };
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}
const linksFile = (links) => JSON.stringify({ pull: links.pull, push: links.push }, null, 2) + "\n";

/** Publish info from export-report.json (older exports call it "framer"). */
const pub = (r) => r?.publish || r?.framer;
const workflowOf = (p) => (p?.config?.legacy ? LEGACY.workflow : WORKFLOW_FILE);

function configFile(config) {
  const { framerUrl, legacy, source, ...rest } = config;
  return JSON.stringify(legacy ? { framerUrl, ...rest } : { source: framerUrl, ...rest }, null, 2) + "\n";
}

/** Write several files to a branch as a single commit. */
async function commitFiles(full, files, message, branch = "main") {
  let ref;
  try {
    // A just-created repository can take a moment to get its first branch.
    for (let i = 0; ; i++) {
      try {
        ref = await gh(`/repos/${full}/git/ref/heads/${branch}`);
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
      body: { message: "Initial commit", content: btoa("# " + full.split("/")[1] + "\n"), branch },
    });
    ref = await gh(`/repos/${full}/git/ref/heads/${branch}`);
  }
  const parent = await gh(`/repos/${full}/git/commits/${ref.object.sha}`);
  const tree = await gh(`/repos/${full}/git/trees`, {
    method: "POST",
    body: {
      base_tree: parent.tree.sha,
      // A null content deletes the file.
      tree: Object.entries(files).map(([path, content]) =>
        content === null ? { path, mode: "100644", type: "blob", sha: null } : { path, mode: "100644", type: "blob", content }),
    },
  });
  const commit = await gh(`/repos/${full}/git/commits`, {
    method: "POST",
    body: { message, tree: tree.sha, parents: [parent.sha] },
  });
  await gh(`/repos/${full}/git/refs/heads/${branch}`, { method: "PATCH", body: { sha: commit.sha } });
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
    gh(`/repos/${full}/actions/workflows/${workflowOf(p)}/runs?per_page=12`).catch(() => ({ workflow_runs: [] })),
    gh(`/repos/${full}/pages`).catch((err) => (err.status === 404 ? { missing: true } : null)),
    gh(`/repos/${full}/deployments?environment=github-pages&per_page=1`).catch(() => []),
    gh(`/repos/${full}/actions/workflows/${workflowOf(p)}`).catch(() => null),
  ]);
  p.runs = runs.workflow_runs || [];
  const jobs = await Promise.all(p.runs.map((r) => jobsFor(full, r)));
  p.jobs = new Map(p.runs.map((r, i) => [r.id, jobs[i]]));
  p.pages = pages;
  p.lastDeploy = deployments[0]?.created_at || null;
  p.paused = !!workflow?.state && workflow.state !== "active";
  // The export report lives on the live site, so fetching it doubles as an
  // uptime check (GitHub Pages allows cross-origin reads).
  if (p.lastDeploy) {
    try {
      const res = await fetch(liveUrl(p) + "export-report.json", { cache: "no-store" });
      p.liveUp = res.ok;
      if (res.ok) p.report = await res.json();
    } catch {
      p.liveUp = false;
    }
    p.liveCheckedAt = new Date().toISOString();
  }
  p.loaded = true;
}

/** A linked repo's pull runs, and when each folder it pulls last changed. */
async function loadLinkStatus(d) {
  if (!d.links.pull.length) { d.runs = []; d.loaded = true; return; }
  const runs = await gh(`/repos/${d.full}/actions/workflows/${PULL_WORKFLOW}/runs?per_page=6`).catch(() => ({ workflow_runs: [] }));
  d.runs = runs.workflow_runs || [];
  // A folder can only have changed if a run finished since the last look.
  const key = JSON.stringify([d.runs[0]?.id, d.runs[0]?.status, d.links.pull]);
  if (key !== d.updatesKey) {
    d.updatesKey = key;
    d.updates = await Promise.all(d.links.pull.map((l) =>
      gh(`/repos/${d.full}/commits?path=${encodeURIComponent(l.into)}&per_page=1`).then((c) => c[0] || null, () => null)));
  }
  d.loaded = true;
}

/** [dot state, words] for the links into a repo, which share one pull workflow. */
function linkState(d) {
  if (!d?.loaded) return ["busy", "loading"];
  const run = d.runs?.[0];
  if (!run) return ["", "waiting"];
  if (run.status !== "completed") return ["busy", "pulling"];
  if (run.conclusion === "success") return ["ok", "in sync"];
  if (run.conclusion === "failure") return ["err", "failed"];
  return ["", run.conclusion || "waiting"];
}

/** Every repo-to-repo link, one per folder pulled. */
function allLinks() {
  return [...linkRepos.values()].flatMap((d) => d.links.pull.map((l, i) => ({ ...l, dest: d.full, d, i, id: `${d.full}#${i}` })));
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
  const check = find("Check for changes") || find("Check Framer"), build = find("Export"), deploy = find("Deploy");
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
  if (m.live === "ok" && p.liveUp === false) m.live = "err";
  m.why = m.source === "err" ? "Framer unreachable" : m.export === "err" ? "export failed" : m.deploy === "err" ? "deploy failed"
    : p.pages?.missing ? "Pages is off" : m.live === "err" ? "site down" : null;

  if (p.paused) m.badge = ["idle", "Paused"];
  else if (m.why) m.badge = ["err", m.why[0].toUpperCase() + m.why.slice(1)];
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

/** The schedule runs at :04, :19, :34 and :49; GitHub is often late and sometimes skips one. */
function nextCheck() {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(Math.floor((d.getMinutes() + 11) / 15) * 15 + 4);
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
      ${row("Published", pub(r)?.publishedAt ? agoEl(pub(r).publishedAt) : "–")}
      ${row("Build", esc(pub(r)?.build || "–"))}
    </div>
    <div class="box">
      ${row('Last check', cur ? agoEl(cur.run.run_started_at || cur.run.created_at) : "Not yet")}
      ${row('Next check', p.paused ? "Paused" : `<span data-countdown>${clockFmt((nextCheck() - Date.now()) / 1000)}</span>`)}
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
        ${row('Exported', r ? agoEl(r.exportedAt) : m.export === "err" ? "Failed" : "–")}
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
      ${m.deploy === "busy" ? '<div class="meter indeterminate"><i></i></div>' : row('Shipped', p.lastDeploy ? agoEl(p.lastDeploy) : "–")}
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
      ${row('Version from', p.lastDeploy ? dayFmt(p.lastDeploy) : "–")}
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
let wiresSig = null;

/** Position of el within root, ignoring transforms (so entrance animations don't skew wires). */
function offsetIn(el, root) {
  let x = 0, y = 0;
  for (let e = el; e && e !== root; e = e.offsetParent) { x += e.offsetLeft; y += e.offsetTop; }
  return { x, y, w: el.offsetWidth, h: el.offsetHeight };
}

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
  const wireState = (s) => (s === "busy" ? "busy" : s === "err" ? "err" : s === "ok" ? "ok" : "idle");
  const wires = [
    { id: "w-src", d: vCurve(portOf(n("source"), "bottom"), portOf(n("check"), "top")), cls: m.source === "busy" ? "busy" : m.source === "err" ? "err" : m.cur ? "ok" : "idle", ambient: !p.paused && !m.running },
    { id: "w-yes", d: hCurve(rowPort(n("check"), "yes"), portOf(n("export"), "left")), cls: m.branch === "yes" ? (m.export === "busy" ? "busy" : m.export === "err" ? "err" : "yes") : "yes faded", port: "yes" },
    { id: "w-no", d: hCurve(rowPort(n("check"), "no"), portOf(n("skip"), "left")), cls: m.branch === "no" ? "no" : "no faded", port: "no" },
    { id: "w-dep", d: hCurve(headPort(n("export"), "right"), headPort(n("deploy"), "left")), cls: m.branch === "yes" ? wireState(m.deploy) : m.lastShip ? "ok" : "idle" },
    { id: "w-live", d: vCurve(portOf(n("deploy"), "bottom"), portOf(n("live"), "top")), cls: m.deploy === "busy" ? "busy" : wireState(m.live) },
  ];
  // Rebuilding restarts every moving dot, so only rebuild when something changed.
  const sig = p.full + JSON.stringify(wires);
  if (sig === wiresSig && svg.childElementCount) return;
  wiresSig = sig;
  const draw = drawnFor !== p.full;
  drawnFor = p.full;
  svg.setAttribute("viewBox", `0 0 ${CANVAS_W} ${CANVAS_H}`);
  svg.innerHTML = "";
  // Ports and packets sit above the nodes, so a port reads as a whole dot on
  // the node's edge and a packet stays visible right up to where it lands.
  const top = overlay(svg);
  top.setAttribute("viewBox", `0 0 ${CANVAS_W} ${CANVAS_H}`);
  top.innerHTML = "";
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
      const st = /faded|idle/.test(w.cls) ? "idle" : "";
      c.setAttribute("class", `port ${st}`.trim());
      top.append(c);
    }
    // Data packets travel along busy wires; a slow one shows Bridge is watching.
    if (/busy/.test(w.cls) || w.ambient) {
      const packets = w.ambient ? 1 : 2;
      for (let i = 0; i < packets; i++) {
        const dot = document.createElementNS(SVGNS, "circle");
        dot.setAttribute("r", w.ambient ? 3 : 4);
        dot.setAttribute("class", w.ambient ? "pulse-dot watch" : "pulse-dot");
        const am = document.createElementNS(SVGNS, "animateMotion");
        const secsLen = w.ambient ? 3.2 : 1.4;
        am.setAttribute("dur", `${secsLen}s`);
        am.setAttribute("begin", `${-(i * secsLen) / packets}s`);
        am.setAttribute("repeatCount", "indefinite");
        const mp = document.createElementNS(SVGNS, "mpath");
        mp.setAttribute("href", `#${w.id}`);
        am.append(mp);
        dot.setAttribute("opacity", "0");
        dot.append(am, fadeAtEnds(secsLen, -(i * secsLen) / packets));
        top.append(dot);
      }
    }
  }
}

/** The layer above the nodes that belongs to a wires layer. */
function overlay(svg) {
  let top = svg.nextElementSibling?.classList.contains("wires-top") ? svg.nextElementSibling : null;
  if (!top) {
    top = document.createElementNS(SVGNS, "svg");
    top.setAttribute("class", "wires wires-top");
    top.setAttribute("aria-hidden", "true");
    svg.after(top);
  }
  return top;
}

/** Packets fade in as they leave and out as they arrive, instead of popping. */
function fadeAtEnds(dur, begin) {
  const a = document.createElementNS(SVGNS, "animate");
  a.setAttribute("attributeName", "opacity");
  a.setAttribute("values", "0;1;1;0");
  a.setAttribute("keyTimes", "0;0.12;0.88;1");
  a.setAttribute("dur", `${dur}s`);
  a.setAttribute("begin", `${begin}s`);
  a.setAttribute("repeatCount", "indefinite");
  return a;
}

/** A bright spark runs along a wire once, for a moment worth noticing. */
function spark(wireId) {
  const svg = $("#wires");
  if (!$("#" + wireId, svg)) return;
  const dot = document.createElementNS(SVGNS, "circle");
  dot.setAttribute("r", 5);
  dot.setAttribute("class", "spark");
  dot.innerHTML = `<animateMotion dur="0.9s" fill="freeze" begin="indefinite"><mpath href="#${wireId}"/></animateMotion>`;
  overlay(svg).append(dot);
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
  // The canvas is never scaled, so text stays one size; narrow screens scroll it.
}

// ------------------------------------------------------------------ activity

function activityItems(p, m) {
  const items = [];
  const byRun = m.infos;
  for (let i = 0; i < byRun.length; i++) {
    const it = byRun[i];
    const when = it.run.run_started_at || it.run.created_at;
    const add = (x) => items.push({ when, ...x });
    const why = { workflow_dispatch: "Manual sync", push: "Settings changed", schedule: "Scheduled check" }[it.run.event] || "Check";
    if (it.running) {
      const jobs = [it.deploy, it.build, it.check].filter((j) => j && j.status !== "completed");
      const job = jobs.find((j) => j.status === "in_progress") || jobs[0];
      add({ dot: "busy", title: it.changed ? "Shipping a new publish" : "Checking Framer", meta: `${why} · ${currentStep(job)}` });
      continue;
    }
    if (it.s.check === "err") { add({ dot: "err", title: "Couldn't reach Framer", meta: `${dayFmt(when)} · live site kept`, href: it.run.html_url }); continue; }
    if (it.s.build === "err") { add({ dot: "err", title: "Export failed, live site kept", meta: dayFmt(when), href: it.run.html_url }); continue; }
    if (it.s.deploy === "err") { add({ dot: "err", title: "Deploy failed, live site kept", meta: dayFmt(when), href: it.run.html_url }); continue; }
    if (it.s.deploy === "ok") {
      const took = secs(it.run.run_started_at || it.run.created_at, it.run.updated_at);
      add({ dot: "ok", title: it.run.event === "schedule" ? "New publish shipped" : `${why}, shipped`, meta: `${dayFmt(when)} · took ${dur(took)}`, href: it.run.html_url });
      continue;
    }
    if (it.changed === false) {
      // Fold a streak of quiet checks into one line.
      let j = i;
      while (j + 1 < byRun.length && byRun[j + 1].changed === false && !byRun[j + 1].running) j++;
      const n = j - i + 1;
      const first = byRun[j].run.run_started_at || byRun[j].run.created_at;
      add({ dot: "", title: n > 1 ? `${n} checks, no changes` : "Checked, no changes", meta: n > 1 ? `${timeFmt(first)} to ${dayFmt(when)}` : dayFmt(when), href: it.run.html_url });
      i = j;
      continue;
    }
    add({ dot: "", title: it.run.conclusion === "cancelled" ? "Run cancelled" : why, meta: dayFmt(when), href: it.run.html_url });
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
  const sel = $("#project-select");
  const html = `<option value=""${selected ? "" : " selected"}>All connections  ·  ${list.length}</option>` +
    list.map((p) => `<option value="${esc(p.full)}"${p.full === selected ? " selected" : ""}>${esc(host(p.config.framerUrl))}  →  ${esc(p.full.split("/")[1])}</option>`).join("");
  if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
}

function renderInfo(p, m) {
  const r = p.report;
  const url = liveUrl(p);
  const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;
  const rows = [
    ["Source", link(p.config.framerUrl, host(p.config.framerUrl))],
    ["Framer build", esc(pub(r)?.build || "–")],
    ["Published", pub(r)?.publishedAt ? esc(dayFmt(pub(r).publishedAt)) : "–"],
    ["CMS", pub(r) ? `${pub(r).cmsCollections ?? "–"} collections` : "–"],
    ["Repository", link(`https://github.com/${p.full}`, p.full)],
    ["Address", link(url, host(url))],
    ["Pages", r ? r.pages.length : "–"],
    ["Files", r ? r.files : "–"],
    ["Mode", r ? r.mode : "–"],
    ["Shipped", p.lastDeploy ? esc(dayFmt(p.lastDeploy)) : "–"],
    ["Schedule", p.paused ? "paused" : "*/15 * * * *"],
  ];
  const html = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  const dl = $("#info");
  if (dl.dataset.html !== html) { dl.innerHTML = html; dl.dataset.html = html; }
}

function render() {
  if (selected && !projects.has(selected)) selected = null;
  renderList();
  const p = projects.get(selected);
  const isMap = !p;
  $(".app").classList.toggle("is-map", isMap);
  $("#stage-empty").hidden = true;
  $("#stage-map").hidden = !isMap;
  $("#stage-project").hidden = isMap;
  $("#rail").hidden = isMap;
  $("#side").hidden = false;
  updateClock();
  if (isMap) return renderMap();

  $("#p-owner").textContent = p.full.split("/")[0];
  $("#p-name").textContent = p.full.split("/")[1];
  $("#a-view").href = liveUrl(p);
  $("#a-repo").href = `https://github.com/${p.full}`;
  $("#a-run").href = p.runs?.[0]?.html_url || `https://github.com/${p.full}/actions`;
  $("#pause-label").textContent = p.paused ? "Resume auto-sync" : "Pause auto-sync";

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
  renderInfo(p, m);
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
  if (!me) return;
  const all = [...projects.values()].filter((p) => p.loaded);
  const busy = all.filter((p) => p.runs?.[0] && p.runs[0].status !== "completed");
  const text = busy.length
    ? `syncing ${busy.map((p) => p.full.split("/")[1]).join(", ")}`
    : `watching ${projects.size} · next check ${clockFmt((nextCheck() - Date.now()) / 1000)}`;
  $("#clock-text").textContent = text;
  $("#clock-dot").className = "dot " + (busy.length ? "busy" : "ok");
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
  store.set(LINKS_CACHE_KEY, JSON.stringify([...linkRepos.values()].map((d) => ({ full: d.full, links: d.links }))));
}

/** Track a repo's links, refreshing its status when they're new or changed. */
function setLinks(full, links) {
  const d = linkRepos.get(full);
  if (d && JSON.stringify(d.links) === JSON.stringify(links)) return;
  if (!links.pull.length && !links.push.length) { linkRepos.delete(full); mapHtml = null; render(); return; }
  linkRepos.set(full, { ...(d || {}), full, links });
  mapHtml = null;
  render();
  refreshLinks(full);
}

async function refreshLinks(full) {
  const d = linkRepos.get(full);
  if (!d) return;
  try {
    await loadLinkStatus(d);
  } catch (err) {
    console.warn(full, err);
  }
  render();
  renderLinkInfo();
  schedulePoll();
}

async function scanProjects() {
  $("#scan-status").textContent = "Looking for connected repositories…";
  const repos = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await gh(`/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator`);
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  allRepos = repos.filter((r) => r.permissions?.push);
  const found = new Set();
  const foundLinks = new Set();
  let i = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < repos.length) {
      const r = repos[i++];
      if (!r.permissions?.push) continue;
      const [config, links] = await Promise.all([
        readConfig(r.full_name).catch(() => null),
        readLinks(r.full_name).catch(() => null),
      ]);
      if (links && (links.pull.length || links.push.length)) {
        foundLinks.add(r.full_name);
        setLinks(r.full_name, links);
      }
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
  for (const full of [...linkRepos.keys()]) if (!foundLinks.has(full)) linkRepos.delete(full);
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
  return Promise.all([...[...projects.keys()].map(refreshProject), ...[...linkRepos.keys()].map(refreshLinks)]);
}

function schedulePoll() {
  clearTimeout(pollTimer);
  const anyRunning = [...projects.values(), ...linkRepos.values()].some((p) => p.runs?.[0] && p.runs[0].status !== "completed");
  pollTimer = setTimeout(() => {
    if (document.visibilityState === "visible") refreshAll();
    else schedulePoll();
  }, anyRunning ? 4000 : 30000);
}

// ------------------------------------------------------------------ actions

// Starts the sync workflow. force: false only re-exports if Framer changed
// (a "check"); repos installed before the input existed reject it with a 422,
// so those fall back to a full sync.
async function dispatch(full, force) {
  const url = `/repos/${full}/actions/workflows/${workflowOf(projects.get(full))}/dispatches`;
  if (force) return gh(url, { method: "POST", body: { ref: "main" } });
  try {
    await gh(url, { method: "POST", body: { ref: "main", inputs: { force: "false" } } });
  } catch (err) {
    if (err.status !== 422) throw err;
    await gh(url, { method: "POST", body: { ref: "main" } });
  }
}

async function syncNow(fulls, button, force = true) {
  const label = $("span", button);
  const idle = label.textContent;
  button.disabled = true;
  label.textContent = "Starting…";
  try {
    const before = new Map(fulls.map((f) => [f, projects.get(f)?.runs?.[0]?.id]));
    await Promise.all(fulls.map((f) => dispatch(f, force)));
    toast(force ? "Sync started" : fulls.length > 1 ? `Checking ${fulls.length} Framer sites` : "Checking Framer");
    // The run takes a moment to appear.
    for (let i = 0; i < 8; i++) {
      await sleep(2000);
      await Promise.all(fulls.map(refreshProject));
      if (fulls.every((f) => projects.get(f)?.runs?.[0]?.id !== before.get(f))) break;
    }
  } catch (err) {
    toast(`Couldn't start a ${force ? "sync" : "check"}: ${friendly(err)}`);
  } finally {
    button.disabled = false;
    label.textContent = idle;
  }
}

async function togglePause(full, button) {
  const p = projects.get(full);
  button.disabled = true;
  try {
    await gh(`/repos/${full}/actions/workflows/${workflowOf(p)}/${p.paused ? "enable" : "disable"}`, { method: "PUT" });
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

The website [${host(config.framerUrl)}](${config.framerUrl}): every page, image,
font and script, served on GitHub Pages.

\`site/\` holds the full site, one commit per publish. Every 15 minutes
\`.github/workflows/${WORKFLOW_FILE}\` checks whether the site was republished
and, if so, exports it with \`tools/export.mjs\`, commits it to \`site/\` and
deploys it. To update right away, open the **Actions** tab, pick **Sync site**
and click **Run workflow**.

\`site/\` is overwritten on every sync, so make design changes at the source.
Forms, site search and analytics that depend on the original host won't work in
this copy.
`;
}

async function loadTemplates() {
  const [exporter, workflow, project, react] = await Promise.all(
    ["template/export.mjs", "template/sync.yml", "template/project.mjs", "template/react.mjs"].map((f) =>
      fetch(f, { cache: "no-cache" }).then((r) => {
        if (!r.ok) throw new Error(`Couldn't load ${f}`);
        return r.text();
      })
    )
  );
  return { exporter, workflow, project, react };
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
          description: host(framerUrl),
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
    const config = { framerUrl, domain: domain || undefined, connectedAt: new Date().toISOString(), version: 2 };
    // Reconnecting a repo set up with the old names replaces those files.
    const files = installFiles(t, config, !isNew && (await readConfig(full).catch(() => null))?.legacy);
    const hasReadme = await gh(`/repos/${full}/contents/README.md`).then((f) => f.size > 60, () => false);
    if (!hasReadme) files["README.md"] = templateReadme(full, config);
    await commitFiles(full, files, `Set up automatic updates from ${host(framerUrl)}`);
    step.done("The first sync has started");

    projects.set(full, { full, config });
    looseSites = looseSites.filter((u) => u !== framerUrl);
    saveSites();
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

// The design project (link + API key) lives only in the repo's Actions secrets.
const SECRET = { project: "SITE_PROJECT", key: "SITE_API_KEY" };

async function secretNames(full) {
  const r = await gh(`/repos/${full}/actions/secrets?per_page=100`);
  return new Set((r.secrets || []).map((s) => s.name));
}

/** Store an Actions secret, sealed in the browser with the repo's public key. */
async function putSecret(full, name, value) {
  const [{ key_id, key }, { seal }] = await Promise.all([
    gh(`/repos/${full}/actions/secrets/public-key`),
    import("./vendor/seal.js"),
  ]);
  const sealed = seal(new TextEncoder().encode(value), Uint8Array.from(atob(key), (c) => c.charCodeAt(0)));
  let bin = "";
  for (const b of sealed) bin += String.fromCharCode(b);
  await gh(`/repos/${full}/actions/secrets/${name}`, { method: "PUT", body: { encrypted_value: btoa(bin), key_id } });
}

/** The files Bridge installs, replacing a legacy setup's files in the same commit. */
function installFiles(t, config, legacy) {
  const files = {
    [WORKFLOW_PATH]: t.workflow,
    [EXPORTER_PATH]: t.exporter,
    [PROJECT_TOOL_PATH]: t.project,
    [REACT_TOOL_PATH]: t.react,
    [CONFIG_PATH]: configFile({ ...config, legacy: false }),
  };
  if (legacy) Object.assign(files, { [`.github/workflows/${LEGACY.workflow}`]: null, [LEGACY.exporter]: null, [LEGACY.config]: null });
  return files;
}

let settingsFor = null;
let settingsSecrets = new Set();
function showProjectState(state, text) {
  $("#set-project-dot").className = "dot " + state;
  $("#set-project-state").textContent = text;
}
function openSettings(full) {
  const p = projects.get(full);
  settingsFor = full;
  $("#settings-title").textContent = full.split("/")[1];
  $("#set-framer-url").value = p.config.framerUrl;
  $("#set-domain").value = p.config.domain || "";
  $("#set-project").value = "";
  $("#set-api-key").value = "";
  $("#settings-error").hidden = true;
  showProjectState("", "checking…");
  settingsSecrets = new Set();
  secretNames(full).then((names) => {
    if (settingsFor !== full) return;
    settingsSecrets = names;
    const on = names.has(SECRET.project) && names.has(SECRET.key);
    showProjectState(on ? "ok" : "", on ? "connected" : "not connected");
  }, () => showProjectState("", "unknown"));
  $("#settings-dialog").showModal();
}

async function saveSettings(e) {
  e.preventDefault();
  const p = projects.get(settingsFor);
  const err = $("#settings-error");
  const button = $("#settings-form button[type=submit]");
  err.hidden = true;
  button.disabled = true;
  try {
    const framerUrl = normalizeFramerUrl($("#set-framer-url").value);
    const domain = normalizeDomain($("#set-domain").value);
    const project = $("#set-project").value.trim();
    const apiKey = $("#set-api-key").value.trim();
    if (project && !/^https:\/\/[^/]+\/projects\/[^/?#]+/.test(project)) throw new Error("The project link should look like https://framer.com/projects/…");
    if ((project || apiKey) && !(project || settingsSecrets.has(SECRET.project))) throw new Error("Add the project link too.");
    if ((project || apiKey) && !(apiKey || settingsSecrets.has(SECRET.key))) throw new Error("Add the API key too.");
    const config = { ...p.config, framerUrl, domain: domain || undefined };
    if (domain !== (p.config.domain || "")) await enablePages(p.full, domain);
    // Secrets first, so the sync this commit starts already has them.
    if (project) await putSecret(p.full, SECRET.project, project);
    if (apiKey) await putSecret(p.full, SECRET.key, apiKey);
    if (project || apiKey || config.legacy) {
      // Also brings the repo's sync files up to date.
      await commitFiles(p.full, installFiles(await loadTemplates(), config, config.legacy), "Update site settings");
      config.legacy = false;

    } else {
      await commitFiles(p.full, { [CONFIG_PATH]: configFile(config) }, "Update site settings");
    }
    p.config = config;
    saveCache();
    // A full sync, so the project is saved now rather than at the next publish.
    if (project || apiKey) await dispatch(p.full, true).catch(() => {});
    $("#settings-dialog").close();
    toast(project || apiKey ? "Saved. Syncing the site and project now." : "Saved. Re-exporting now.");
    refreshProject(p.full);
  } catch (ex) {
    err.textContent = friendly(ex);
    err.hidden = false;
  } finally {
    button.disabled = false;
  }
}

async function openConnect(framerUrl, target) {
  const dlg = $("#connect-dialog");
  $("#connect-form").reset();
  if (typeof framerUrl === "string") $("#framer-url").value = framerUrl;
  const mode = target?.repo ? "existing" : "new";
  $("#connect-fields").hidden = false;
  $("#connect-progress").hidden = true;
  $("#connect-done").hidden = true;
  $("#connect-error").hidden = true;
  $(`input[name="repo-mode"][value="${mode}"]`).checked = true;
  $("#repo-new").hidden = mode !== "new";
  $("#repo-existing").hidden = mode !== "existing";
  if (target?.name) $("#repo-name").value = target.name;
  $("#default-address").textContent = `${me.login.toLowerCase()}.github.io/<repo>`;
  dlg.showModal();
  const sel = $("#repo-select");
  sel.innerHTML = "<option value=''>Loading…</option>";
  try {
    const repos = allRepos.length ? allRepos : (await gh("/user/repos?per_page=100&sort=pushed&affiliation=owner")).filter((r) => r.permissions?.push);
    sel.innerHTML = "";
    for (const r of repos.filter((r) => !projects.has(r.full_name))) {
      sel.add(new Option(r.full_name + (r.private ? " (private)" : ""), r.full_name));
    }
  } catch {
    sel.innerHTML = "";
  }
  if (target?.repo && ![...sel.options].some((o) => o.value === target.repo)) sel.add(new Option(target.repo, target.repo));
  if (target?.repo) sel.value = target.repo;
  if (!sel.options.length) sel.add(new Option("Couldn't load repositories", ""));
}

// ------------------------------------------------------------------ connection map

const FRAMER_ICON = '<svg viewBox="0 0 24 24"><path d="M5 3h14v6H12L5 3Z"/><path d="M5 9h7l7 6H5V9Z"/><path d="M5 15h7v6l-7-6Z"/></svg>';
const GITHUB_ICON = '<svg viewBox="0 0 24 24"><path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/></svg>';
const siteReach = new Map(); // framer url -> "ok" | "err" | "busy"
let mapHtml = null;
let arming = null; // { key } while a new wire is being drawn

function connState(p) {
  if (!p.loaded) return ["busy", "loading"];
  if (p.paused) return ["", "paused"];
  const m = model(p);
  return [m.badge[0], m.badge[0] === "ok" ? "in sync" : m.badge[1].toLowerCase()];
}

/** One circle per step, so a failing connection shows where it broke. */
function stepDots(p) {
  if (!p.loaded) return "";
  const m = model(p);
  const steps = [["Framer", m.source], ["Export", m.export], ["Deploy", m.deploy], ["Live", m.live]];
  return `<span class="steps">${steps.map(([name, st]) => `<i class="dot ${st === "idle" ? "" : st}" title="${name}: ${STATE_TEXT[st] || st}"></i>`).join("")}</span>`;
}

/** The worst of several states: a failure shows first, then work in progress. */
const worst = (states) => (states.includes("err") ? "err" : states.includes("busy") ? "busy" : states.includes("ok") ? "ok" : "");

// Sources on the left of the map are keyed by their Framer address, or by
// "repo:owner/name" for a GitHub repository.
const REPO_KEY = "repo:";
const isRepoKey = (k) => k.startsWith(REPO_KEY);
/** What the Add card adds: a Framer "site" or a GitHub "repo". */
let addKind = "site";

function mapRows() {
  // Newest first, under the "add" row: connections by when their repo was
  // created, sources in the order they were added, repos by creation too.
  const created = new Map(allRepos.map((r) => [r.full_name, r.created_at || ""]));
  const newest = (a, b) => (created.get(b) || "").localeCompare(created.get(a) || "") || a.localeCompare(b);
  const conns = [
    ...[...projects.values()].map((p) => ({ s: p.config.framerUrl, g: p.full, p })),
    ...allLinks().map((l) => ({ s: REPO_KEY + l.repo, g: l.dest, l })),
  ].sort((a, b) => newest(a.g, b.g));
  // Each source and each repository shows once; its other connections wire to it.
  const seenS = new Set(), seenG = new Set();
  const rows = conns.map((c) => {
    const r = { s: seenS.has(c.s) ? null : c.s, g: seenG.has(c.g) ? null : c.g, p: c.p, l: c.l };
    seenS.add(c.s);
    seenG.add(c.g);
    return r;
  });
  const sources = [...looseSites, ...looseRepos.map((r) => REPO_KEY + r)].filter((k) => !seenS.has(k)).reverse();
  const repos = allRepos.filter((r) => !seenG.has(r.full_name)).map((r) => r.full_name).sort(newest).slice(0, 6);
  const n = Math.max(sources.length, repos.length);
  for (let i = 0; i < n; i++) rows.push({ s: sources[i] || null, g: repos[i] || null });
  rows.unshift({ s: "__add", g: "__new" });
  return rows;
}

function sourceNode(key) {
  if (key === "__add") return addNode();
  return isRepoKey(key) ? repoSourceNode(key.slice(REPO_KEY.length)) : framerNode(key);
}

function addNode() {
  const repo = addKind === "repo";
  return `<form class="node mnode fr add" id="add-site">
    <div class="node-head">${repo ? GITHUB_ICON : FRAMER_ICON}<h3>Add a source</h3></div>
    <div class="box">
      <fieldset class="seg add-kind">
        <legend class="sr">Kind of source</legend>
        <label><input type="radio" name="kind" value="site"${repo ? "" : " checked"}><span>Framer site</span></label>
        <label><input type="radio" name="kind" value="repo"${repo ? " checked" : ""}><span>GitHub repo</span></label>
      </fieldset>
      <input class="pill mono" name="site" type="text" autocomplete="off" ${repo
        ? 'list="repo-options" placeholder="owner/repository" aria-label="GitHub repository"'
        : 'inputmode="url" placeholder="yoursite.framer.website" aria-label="Published Framer site"'}>
      <button class="pill pill-btn" type="submit">Add<i class="tri right"></i></button>
    </div>
  </form>`;
}

function framerNode(url) {
  const linked = [...projects.values()].filter((p) => p.config.framerUrl === url);
  let state, text;
  if (linked.length) {
    state = worst(linked.map((p) => connState(p)[0]));
    text = linked.length === 1 ? "connected" : `${linked.length} repos`;
  } else {
    state = siteReach.get(url) || "";
    text = state === "ok" ? "reachable" : state === "err" ? "can't reach" : "not connected";
  }
  const fr = linked.map((p) => pub(p.report)).find(Boolean);
  const report = linked.map((p) => p.report).find(Boolean);
  return `<div class="node mnode fr${linked.length ? " linked" : " unlinked"}" data-source="${esc(url)}" data-framer="${esc(url)}">
    <div class="node-head">${FRAMER_ICON}<h3>${esc(host(url))}</h3><span class="node-state"><i class="dot ${state}"></i>${text}</span></div>
    <div class="box">
      ${row("Site", `<a class="site-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(host(url))}</a>`)}
      ${linked.length ? "" : row("Repository", `<button type="button" class="link" data-remove-site="${esc(url)}">none · remove</button>`)}
    </div>
    ${linked.length ? `<div class="box">
      ${row("Published", fr?.publishedAt ? `<span data-ago="${esc(fr.publishedAt)}"></span>` : "–")}
      ${row("Build", esc(fr?.build || "–"))}
      ${row("Pages", report ? `${report.pages.length}<span class="sep">·</span>${fr?.cmsCollections ?? "–"} cms` : "–")}
    </div>` : ""}
    <button type="button" class="mport out" data-port-source="${esc(url)}" title="Drag to a repository to connect" aria-label="Connect ${esc(host(url))} to a repository"></button>
  </div>`;
}

function repoSourceNode(full) {
  const key = REPO_KEY + full;
  const links = allLinks().filter((l) => l.repo === full);
  const [owner, name] = full.split("/");
  const state = links.length ? worst(links.map((l) => linkState(l.d)[0])) : "";
  const text = !links.length ? "not linked" : links.length === 1 ? "linked" : `${links.length} links`;
  const uniq = (xs) => [...new Set(xs)].join(", ");
  return `<div class="node mnode fr repo${links.length ? " linked" : " unlinked"}" data-source="${esc(key)}">
    <div class="node-head">${GITHUB_ICON}<h3>${esc(name)}</h3><span class="node-state"><i class="dot ${state}"></i>${text}</span></div>
    <div class="box">
      ${row("Repo", `<a class="site-link" href="https://github.com/${esc(full)}" target="_blank" rel="noopener">${esc(owner)}/${esc(name)}</a>`)}
      ${links.length
        ? row("Branch", esc(uniq(links.map((l) => l.branch || "default")))) + row("Folder", esc(uniq(links.map((l) => (l.path ? l.path + "/" : "all")))))
        : row("Linked to", `<button type="button" class="link" data-remove-repo="${esc(full)}">none · remove</button>`)}
    </div>
    <button type="button" class="mport out" data-port-source="${esc(key)}" title="Drag to a repository to link" aria-label="Link ${esc(full)} to a repository"></button>
  </div>`;
}

/** When a linked folder last changed in its destination. */
function lastUpdate(d) {
  return (d?.updates || []).map((c) => c?.commit?.committer?.date).filter(Boolean).sort().pop() || null;
}

function githubNode(full) {
  if (full === "__new") {
    return `<div class="node mnode gh new" data-repo="__new">
      <button type="button" class="mport in" data-port-repo="__new" aria-label="Connect to a new repository"></button>
      <div class="node-head">${GITHUB_ICON}<h3>New repository</h3></div>
      <div class="box">${row("Created by", "Bridge")}${row("Hosting", "GitHub Pages")}</div>
    </div>`;
  }
  const p = projects.get(full);
  const d = linkRepos.get(full);
  const pulls = d?.links.pull.length || 0;
  const r = allRepos.find((x) => x.full_name === full);
  const [owner, name] = full.split("/");
  const url = p ? liveUrl(p) : null;
  let state = "", text = r?.private ? "private" : "public";
  if (p) {
    [state, text] = connState(p);
    if (url && state !== "err" && state !== "busy") text = "live";
    if (pulls) state = worst([state, linkState(d)[0]]);
  } else if (pulls) {
    [state, text] = linkState(d);
  }
  const updated = pulls ? lastUpdate(d) : null;
  return `<div class="node mnode gh${p || pulls ? " linked" : ""}" data-repo="${esc(full)}">
    <button type="button" class="mport in" data-port-repo="${esc(full)}" aria-label="Connect to ${esc(full)}"></button>
    <div class="node-head">${GITHUB_ICON}<h3>${esc(name)}</h3><span class="node-state">${p || pulls ? `<i class="dot ${state}"></i>` : ""}${esc(text)}</span></div>
    <div class="box">
      ${row("Repo", `<a class="site-link" href="https://github.com/${esc(full)}" target="_blank" rel="noopener">${esc(owner)}/${esc(name)}</a>`)}
      ${p || !pulls ? row("Live", url ? `<a class="site-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(host(url))}</a>` : "–") : ""}
      ${pulls ? row("Pulls", `${pulls} folder${pulls > 1 ? "s" : ""}<span class="sep">·</span>${updated ? agoEl(updated) : "not yet"}`) : ""}
    </div>
  </div>`;
}

function linkLabel(l) {
  const [st, text] = linkState(l.d);
  const from = `${l.repo}${l.path ? "/" + l.path : ""}`;
  return `<button type="button" class="mlabel${st === "err" ? " is-err" : ""}" data-link="${esc(l.id)}" title="${esc(`${from} → ${l.dest}/${l.into}`)}"><i class="dot ${st}"></i><span class="mono">${esc(text)}</span></button>`;
}

const wireId = (raw) => raw.replace(/[^\w-]/g, "_");

function renderMap() {
  const rows = mapRows();
  let floats = "";
  const html = `<div class="map-col-title">Sources</div><div></div><div class="map-col-title">Destinations</div>` + rows.map(({ s, g, p, l }) => {
    let mid = "";
    if (p) {
      const [st, text] = connState(p);
      mid = `<button type="button" class="mlabel${st === "err" ? " is-err" : ""}" data-open="${esc(p.full)}" title="Framer · Export · Deploy · Live">${stepDots(p)}<span class="mono">${esc(text)}</span></button>`;
    } else if (l) {
      mid = linkLabel(l);
    }
    // Both ends already sit on other rows: the label floats on its wire instead.
    if (!s && !g) {
      if (mid) floats += mid.replace('class="mlabel', `data-wire="${wireId(p ? "mw-" + p.full : "ml-" + l.id)}" class="mlabel float`);
      return "";
    }
    return `<div class="mcell fr">${s ? sourceNode(s) : ""}</div>` +
      `<div class="mmid">${mid}</div>` +
      `<div class="mcell gh">${g ? githubNode(g) : ""}</div>`;
  }).join("") + floats;
  const grid = $("#map-grid");
  if (html !== mapHtml) {
    const input = document.activeElement?.closest?.("#add-site") ? $("#add-site input[name=site]") : null;
    const typed = input?.value;
    grid.innerHTML = html;
    mapHtml = html;
    if (input) { const again = $("#add-site input[name=site]"); again.value = typed; again.focus(); }
    requestAnimationFrame(drawMapWires);
    setTimeout(() => $("#map").classList.add("entered"), 900);
    for (const u of looseSites) if (!siteReach.has(u)) checkSite(u);
  }
  const options = allRepos.map((r) => `<option value="${esc(r.full_name)}">`).join("");
  const list = $("#repo-options");
  if (list.dataset.html !== options) { list.innerHTML = options; list.dataset.html = options; }
  renderMapSide();
  const states = [...[...projects.values()].map((p) => (p.loaded ? connState(p)[0] : "")), ...allLinks().map((l) => (l.d.loaded ? linkState(l.d)[0] : ""))];
  const failing = states.filter((s) => s === "err").length;
  const syncing = states.filter((s) => s === "busy").length;
  $("#map-summary").textContent = !states.length ? "none yet"
    : `${states.length} · ${failing ? `${failing} failing` : syncing ? `${syncing} syncing` : "all healthy"}`;
  $("#map-summary-dot").className = "dot " + (!states.length ? "" : failing ? "err" : syncing ? "busy" : "ok");
  tick();
}

let mapWiresSig = null;
function drawMapWires() {
  const map = $("#map");
  const svg = $("#map-wires");
  if (!map || map.offsetParent === null) return;
  if (getComputedStyle(svg).display === "none") return;
  // The centre of a port circle, or the node's side if it has none.
  const pt = (node, side) => {
    const port = $(side === "right" ? ".mport.out" : ".mport.in", node);
    const o = offsetIn(port || node, map);
    return port ? [o.x + o.w / 2, o.y + o.h / 2] : [side === "right" ? o.x + o.w : o.x, o.y + o.h / 2];
  };
  const conns = [
    ...[...projects.values()].map((p) => ({ id: "mw-" + p.full, s: p.config.framerUrl, g: p.full, st: connState(p)[0] })),
    ...allLinks().map((l) => ({ id: "ml-" + l.id, s: REPO_KEY + l.repo, g: l.dest, st: linkState(l.d)[0] })),
  ];
  const links = [];
  for (const c of conns) {
    const f = $(`.mnode.fr[data-source="${CSS.escape(c.s)}"]`, map);
    const g = $(`.mnode.gh[data-repo="${CSS.escape(c.g)}"]`, map);
    if (!f || !g) continue;
    const [a, b] = [pt(f, "right"), pt(g, "left")];
    links.push({ id: wireId(c.id), d: hCurve(a, b), st: c.st, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] });
  }
  // A floating label sits on the middle of its wire (a level curve's midpoint is halfway between its ends).
  const grid = offsetIn($("#map-grid"), map);
  for (const el of $$(".mlabel.float", map)) {
    const l = links.find((x) => x.id === el.dataset.wire);
    el.hidden = !l;
    if (l) { el.style.left = `${l.mid[0] - grid.x}px`; el.style.top = `${l.mid[1] - grid.y}px`; }
  }
  // Rebuilding restarts the moving dots, so only rebuild when something changed.
  const sig = `${map.offsetWidth}x${map.offsetHeight}` + JSON.stringify(links);
  if (sig === mapWiresSig && svg.childElementCount) return;
  mapWiresSig = sig;
  svg.setAttribute("viewBox", `0 0 ${map.offsetWidth} ${map.offsetHeight}`);
  svg.innerHTML = "";
  for (const l of links) {
    const path = document.createElementNS(SVGNS, "path");
    path.id = l.id;
    path.setAttribute("d", l.d);
    path.setAttribute("class", "wire" + (l.st === "busy" ? " busy" : l.st === "" ? " idle" : ""));
    svg.append(path);
    if (l.st === "ok" || l.st === "busy") {
      const n = l.st === "busy" ? 3 : 1;
      const dur = l.st === "busy" ? 1.8 : 3.6;
      for (let i = 0; i < n; i++) {
        const dot = document.createElementNS(SVGNS, "circle");
        dot.setAttribute("r", 3);
        dot.setAttribute("class", "runner-dot" + (l.st === "busy" ? " busy" : ""));
        dot.setAttribute("opacity", "0");
        const begin = -(i * dur) / n;
        dot.innerHTML = `<animateMotion dur="${dur}s" begin="${begin}s" repeatCount="indefinite"><mpath href="#${l.id}"/></animateMotion>`;
        dot.append(fadeAtEnds(dur, begin));
        svg.append(dot);
      }
    }
  }
  const drag = document.createElementNS(SVGNS, "path");
  drag.id = "drag-wire";
  drag.setAttribute("class", "wire");
  svg.append(drag);
}

// Redraw the map's wires whenever its layout shifts (fonts loading, text changing, resizing).
if ("ResizeObserver" in window) {
  const ro = new ResizeObserver(() => requestAnimationFrame(drawMapWires));
  const watch = () => { const g = $("#map-grid"); if (g) ro.observe(g); };
  document.readyState === "loading" ? addEventListener("DOMContentLoaded", watch) : watch();
}
document.fonts?.ready.then(() => requestAnimationFrame(drawMapWires));

/** Activity for the links into a repo: pulls running or failing, and folders updated. */
function linkActivity(d) {
  const name = d.full.split("/")[1];
  const items = [];
  const run = d.runs?.[0];
  const when = run && (run.run_started_at || run.created_at);
  if (run && run.status !== "completed") items.push({ when, dot: "busy", title: "Pulling linked repos", meta: `${name} · ${dayFmt(when)}`, href: run.html_url });
  else if (run?.conclusion === "failure") items.push({ when, dot: "err", title: "Pull failed", meta: `${name} · ${dayFmt(when)}`, href: run.html_url });
  d.links.pull.forEach((l, i) => {
    const c = d.updates?.[i];
    const at = c?.commit?.committer?.date;
    if (at) items.push({ when: at, dot: "ok", title: `${l.into}/ updated from ${l.repo.split("/")[1]}`, meta: `${name} · ${dayFmt(at)}`, href: c.html_url });
  });
  return items;
}

function renderMapSide() {
  const all = [...projects.values()];
  const links = allLinks();
  const loaded = all.filter((p) => p.loaded);
  const states = [...all.map((p) => connState(p)[0]), ...links.map((l) => linkState(l.d)[0])];
  const sources = new Set([...all.map((p) => p.config.framerUrl), ...looseSites, ...links.map((l) => REPO_KEY + l.repo), ...looseRepos.map((r) => REPO_KEY + r)]).size;
  const rows = [
    ["Sources", sources],
    ["Repositories", allRepos.length || all.length],
    ["Connections", states.length],
    ["In sync", `${states.filter((s) => s === "ok").length} / ${states.length}`],
    ["Failing", states.filter((s) => s === "err").length],
    ["Schedule", "*/15 * * * *"],
  ];
  const dl = $("#info");
  const infoHtml = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  if (dl.dataset.html !== infoHtml) { dl.innerHTML = infoHtml; dl.dataset.html = infoHtml; }

  const items = [
    ...loaded.flatMap((p) => activityItems(p, model(p)).map((i) => ({ ...i, meta: `${p.full.split("/")[1]} · ${i.meta}` }))),
    ...[...linkRepos.values()].filter((d) => d.loaded).flatMap(linkActivity),
  ]
    .sort((a, b) => (a.dot === "busy" ? -1 : b.dot === "busy" ? 1 : new Date(b.when) - new Date(a.when)))
    .slice(0, 8);
  const pending = `<li class="pending"><i class="dot"></i><span class="a-title">Next check in <span data-countdown>${clockFmt((nextCheck() - Date.now()) / 1000)}</span></span></li>`;
  const html = pending + (items.length
    ? items.map((i) => `<li><i class="dot ${i.dot}"></i>${i.href ? `<a class="a-title" href="${esc(i.href)}" target="_blank" rel="noopener">${esc(i.title)}</a>` : `<span class="a-title">${esc(i.title)}</span>`}<span class="a-meta">${esc(i.meta)}</span></li>`).join("")
    : `<li><i class="dot"></i><span class="a-title">Nothing yet</span><span class="a-meta">Connect a source to a repository.</span></li>`);
  const ol = $("#activity");
  if (ol.dataset.html !== html) { ol.innerHTML = html; ol.dataset.html = html; }
}

async function checkSite(url) {
  siteReach.set(url, "busy");
  try { await fetch(url + "/", { mode: "no-cors", cache: "no-store" }); siteReach.set(url, "ok"); }
  catch { siteReach.set(url, "err"); }
  if (!selected) { mapHtml = null; renderMap(); }
}

function addSite(url) {
  if (![...projects.values()].some((p) => p.config.framerUrl === url) && !looseSites.includes(url)) {
    looseSites.push(url);
    saveSites();
  }
  mapHtml = null;
  renderMap();
  checkSite(url);
}

/** "owner/name", a github.com link, or just a name in your own account. */
function parseRepo(v) {
  v = v.trim().replace(/^(https?:\/\/)?(www\.)?github\.com\//i, "").replace(/\.git$/, "").replace(/\/+$/, "");
  if (/^[\w.-]+$/.test(v) && me) v = `${me.login}/${v}`;
  const m = v.match(/^([\w.-]+)\/([\w.-]+)/);
  if (!m) throw new Error("Enter a repository as owner/name.");
  return `${m[1]}/${m[2]}`;
}

async function addRepoSource(v) {
  let full = parseRepo(v);
  try {
    full = (await gh(`/repos/${full}`)).full_name;
  } catch (err) {
    return toast(err.status === 404 ? `Couldn't find ${full}` : friendly(err));
  }
  if (!looseRepos.includes(full) && !allLinks().some((l) => l.repo === full)) {
    looseRepos.push(full);
    saveSites();
  }
  mapHtml = null;
  renderMap();
  const input = $("#add-site input[name=site]");
  if (input) input.value = "";
  toast("Now drag its dot to a repository");
}

function suggestName(url) {
  return host(url).replace(/^www\./, "").replace(/\.framer\.(website|app|ai)$/, "").replace(/\.[a-z]+$/, "").replace(/[^A-Za-z0-9._-]+/g, "-");
}

/** Can a wire from this source end at this repository? */
function canTarget(key, repo) {
  if (repo === "__new") return true;
  if (isRepoKey(key)) return repo !== key.slice(REPO_KEY.length);
  return !projects.has(repo);
}

function finishWire(key, repo) {
  cancelWire();
  if (!key || !repo) return;
  if (isRepoKey(key)) {
    const src = key.slice(REPO_KEY.length);
    if (repo === src) return toast("A repository can't pull from itself");
    return openLink(src, repo);
  }
  if (repo === "__new") return openConnect(key, { name: suggestName(key) });
  if (projects.has(repo)) return toast(`${repo.split("/")[1]} is already connected`);
  openConnect(key, { repo });
}

function cancelWire() {
  arming = null;
  $("#map")?.classList.remove("arming");
  $$(".mnode.armed").forEach((n) => n.classList.remove("armed"));
  $$(".mnode.target").forEach((n) => n.classList.remove("target"));
  $("#drag-wire")?.setAttribute("d", "");
}

// Drag from a source's port to a repository, or tap the port and then tap a repository.
document.addEventListener("pointerdown", (e) => {
  const port = e.target.closest("[data-port-source]");
  if (!port) return;
  e.preventDefault();
  const key = port.dataset.portSource;
  const map = $("#map");
  const box = map.getBoundingClientRect();
  const r = port.getBoundingClientRect();
  const from = [r.left + r.width / 2 - box.left, r.top + r.height / 2 - box.top];
  const start = [e.clientX, e.clientY];
  arming = { key };
  map.classList.add("arming");
  port.closest(".mnode").classList.add("armed");
  for (const n of $$(".mnode.gh", map)) n.classList.toggle("target", canTarget(key, n.dataset.repo));
  const move = (ev) => {
    const to = [ev.clientX - box.left, ev.clientY - box.top];
    $("#drag-wire")?.setAttribute("d", hCurve(from, to));
  };
  const up = (ev) => {
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    const moved = Math.hypot(ev.clientX - start[0], ev.clientY - start[1]) > 6;
    const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(".mnode.gh");
    if (target) return finishWire(key, target.dataset.repo);
    if (moved) cancelWire(); // dropped on nothing
    else $("#drag-wire")?.setAttribute("d", ""); // tap: wait for a repository tap
  };
  addEventListener("pointermove", move);
  addEventListener("pointerup", up);
});
document.addEventListener("click", (e) => {
  const open = e.target.closest("[data-open]");
  if (open) return select(open.dataset.open);
  const link = e.target.closest("[data-link]");
  if (link) return openLinkManage(link.dataset.link);
  const rm = e.target.closest("[data-remove-site]");
  if (rm) {
    looseSites = looseSites.filter((u) => u !== rm.dataset.removeSite);
    saveSites();
    mapHtml = null;
    return renderMap();
  }
  const rmRepo = e.target.closest("[data-remove-repo]");
  if (rmRepo) {
    looseRepos = looseRepos.filter((r) => r !== rmRepo.dataset.removeRepo);
    saveSites();
    mapHtml = null;
    return renderMap();
  }
  if (arming) {
    const target = e.target.closest(".mnode.gh");
    if (target) return finishWire(arming.key, target.dataset.repo);
    if (!e.target.closest("[data-port-source]")) cancelWire();
    return;
  }
  const node = e.target.closest(".mnode.linked .node-head");
  if (node) {
    const n = node.closest(".mnode");
    const key = n.dataset.source;
    if (key && isRepoKey(key)) {
      const l = allLinks().find((x) => x.repo === key.slice(REPO_KEY.length));
      return l && openLinkManage(l.id);
    }
    const full = n.dataset.repo || [...projects.values()].find((p) => p.config.framerUrl === key)?.full;
    if (projects.has(full)) return select(full);
    const l = allLinks().find((x) => x.dest === full);
    if (l) openLinkManage(l.id);
  }
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") cancelWire(); });
document.addEventListener("change", (e) => {
  if (!e.target.matches("#add-site input[name=kind]")) return;
  addKind = e.target.value;
  const typed = $("#add-site input[name=site]").value;
  mapHtml = null;
  renderMap();
  const input = $("#add-site input[name=site]");
  input.value = typed;
  input.focus();
});
document.addEventListener("submit", (e) => {
  if (e.target.id !== "add-site") return;
  e.preventDefault();
  const v = e.target.site.value;
  if (!v.trim()) return;
  if (addKind === "repo") return addRepoSource(v);
  try {
    addSite(normalizeFramerUrl(v));
  } catch (err) {
    toast(err.message);
  }
});

// ------------------------------------------------------------------ repo links

// Folders a link can't copy into: the repo's own setup.
const KEPT_DIRS = [".git", ".github", "tools", LINKS_PATH, ".site.json"];
// Rewritten on every site sync, so a link into them would be overwritten.
const SITE_DIRS = ["site", "app", "project"];

/** A folder inside a repo: no leading or trailing slash, no "." or "..". */
function cleanDir(v) {
  const d = String(v ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (d.split("/").some((part) => part === ".." || part === ".")) throw new Error(`"${v}" can't contain . or ..`);
  return d;
}

let linkDraft = null; // { src, dest } while the link dialog is creating a link
let managing = null; // the link the dialog is showing
let intoTouched = false;

function linkDialogMode(mode) {
  $("#link-fields").hidden = mode !== "create";
  $("#link-manage").hidden = mode !== "manage";
  $("#link-progress").hidden = mode !== "progress";
  $("#link-done").hidden = true;
  $("#link-error").hidden = true;
  if (mode === "progress") $("#link-progress").innerHTML = "";
}

async function openLink(src, dest) {
  const isNew = dest === "__new";
  linkDraft = { src, dest };
  managing = null;
  intoTouched = false;
  $("#link-form").reset();
  $("#link-title").textContent = "Link repositories";
  linkDialogMode("create");
  $("#link-from").value = src;
  $("#link-to").value = isNew ? "" : dest;
  $("#link-to").readOnly = !isNew;
  $("#link-to").placeholder = isNew ? "new-repository" : "";
  $("#link-to-label").textContent = isNew ? "New repository name" : "To";
  $("#link-new").hidden = !isNew;
  $("#link-into").value = src.split("/")[1];
  $("#link-dialog").showModal();
  const sel = $("#link-branch");
  sel.innerHTML = "<option value=''>Loading…</option>";
  try {
    const [repo, branches] = await Promise.all([gh(`/repos/${src}`), gh(`/repos/${src}/branches?per_page=100`)]);
    sel.innerHTML = "";
    for (const b of branches) sel.add(new Option(b.name, b.name));
    sel.value = repo.default_branch;
  } catch (err) {
    sel.innerHTML = "";
    sel.add(new Option("Couldn't load branches", ""));
  }
}

$("#link-path").addEventListener("input", () => {
  if (intoTouched || !linkDraft) return;
  const last = $("#link-path").value.trim().replace(/\/+$/, "").split("/").pop();
  $("#link-into").value = last || linkDraft.src.split("/")[1];
});
$("#link-into").addEventListener("input", () => { intoTouched = true; });

function progressIn(list) {
  return (text) => {
    const li = document.createElement("li");
    li.innerHTML = `<i class="dot busy"></i><span class="a-title"></span><span class="a-meta"></span>`;
    $(".a-title", li).textContent = text;
    $(list).append(li);
    return {
      done(note = "") { $(".dot", li).className = "dot ok"; $(".a-meta", li).textContent = note; },
      fail(note) { $(".dot", li).className = "dot err"; $(".a-meta", li).textContent = note; },
    };
  };
}

async function createLink(e) {
  e.preventDefault();
  const err = $("#link-error");
  err.hidden = true;
  const { src } = linkDraft;
  const isNew = linkDraft.dest === "__new";
  let dest, branch, from, into;
  try {
    branch = $("#link-branch").value;
    if (!branch) throw new Error("Pick a branch to copy from.");
    from = cleanDir($("#link-path").value);
    into = cleanDir($("#link-into").value);
    if (!into) throw new Error("Choose a folder to copy into.");
    if (KEPT_DIRS.includes(into.split("/")[0])) throw new Error(`${into.split("/")[0]} is kept for the repository's own setup. Pick another folder.`);
    if (isNew) {
      const name = $("#link-to").value.trim();
      if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("Give the new repository a name (letters, numbers, dashes).");
      dest = `${me.login}/${name}`;
    } else {
      dest = linkDraft.dest;
    }
    if (dest === src) throw new Error("A repository can't pull from itself.");
    if (projects.has(dest) && SITE_DIRS.includes(into.split("/")[0])) throw new Error(`${into.split("/")[0]}/ is rewritten on every site sync. Pick another folder.`);
    const taken = linkRepos.get(dest)?.links.pull.find((l) => l.into === into);
    if (taken) throw new Error(`${taken.repo} already copies into ${into}/. Pick another folder.`);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
    return;
  }

  linkDialogMode("progress");
  const progressStep = progressIn("#link-progress");
  let step;
  try {
    step = progressStep("Loading the sync tools");
    const t = await loadLinkTemplates();
    step.done();

    let destRepo;
    if (isNew) {
      step = progressStep(`Creating ${dest}`);
      destRepo = await gh("/user/repos", { method: "POST", body: { name: dest.split("/")[1], private: $("#link-private").checked, auto_init: true } });
      step.done();
    } else {
      step = progressStep(`Checking ${dest}`);
      destRepo = await gh(`/repos/${dest}`);
      if (!destRepo.permissions?.push) throw new Error("You don't have write access to that repository.");
      step.done();
    }
    const srcRepo = await gh(`/repos/${src}`);
    const canPush = !!srcRepo.permissions?.push;

    // The token lets the destination read a private source and lets the
    // source tell the destination about a push the moment it happens.
    step = progressStep("Storing your GitHub access as a secret");
    try {
      await putSecret(dest, SYNC_SECRET, token);
      if (canPush) await putSecret(src, SYNC_SECRET, token);
      step.done();
    } catch (ex) {
      if (srcRepo.private) throw ex;
      step.done("Skipped. It will check for changes every 15 minutes.");
    }

    step = progressStep(`Setting up ${dest.split("/")[1]} to pull`);
    const links = (await readLinks(dest, destRepo.default_branch)) || { pull: [], push: [] };
    links.pull = links.pull.filter((l) => l.into !== into).concat({ repo: src, branch, path: from, into });
    await commitFiles(dest, {
      [`.github/workflows/${PULL_WORKFLOW}`]: t.pull,
      [LINKS_TOOL_PATH]: t.tool,
      [LINKS_PATH]: linksFile(links),
    }, `Copy ${from ? from + "/" : "everything"} from ${src} into ${into}/`, destRepo.default_branch);
    step.done("The first copy has started");

    let srcLinks = null;
    if (canPush) {
      step = progressStep(`Setting up ${src.split("/")[1]} to announce changes`);
      srcLinks = (await readLinks(src, branch)) || { pull: [], push: [] };
      if (!srcLinks.push.some((x) => x.repo === dest && x.branch === branch)) srcLinks.push.push({ repo: dest, branch });
      await commitFiles(src, {
        [`.github/workflows/${NOTIFY_WORKFLOW}`]: t.notify,
        [LINKS_TOOL_PATH]: t.tool,
        [LINKS_PATH]: linksFile(srcLinks),
      }, `Tell ${dest} when this changes`, branch);
      step.done();
    } else {
      progressStep(`${src} isn't yours to change, so ${dest.split("/")[1]} checks it every 15 minutes`).done();
    }

    looseRepos = looseRepos.filter((r) => r !== src);
    saveSites();
    if (isNew) allRepos.unshift(destRepo);
    setLinks(dest, links);
    if (srcLinks && srcRepo.default_branch === branch) setLinks(src, srcLinks);
    saveCache();
    progressStep(`Linked. Pushes to ${branch} now copy over to ${dest.split("/")[1]}/${into}.`).done();
  } catch (ex) {
    step?.fail(friendly(ex));
  }
  $("#link-done").hidden = false;
}

async function loadLinkTemplates() {
  const [pull, notify, tool] = await Promise.all(
    ["template/pull.yml", "template/notify.yml", "template/links.mjs"].map((f) =>
      fetch(f, { cache: "no-cache" }).then((r) => {
        if (!r.ok) throw new Error(`Couldn't load ${f}`);
        return r.text();
      })
    )
  );
  return { pull, notify, tool };
}

function openLinkManage(id) {
  const l = allLinks().find((x) => x.id === id);
  if (!l) return;
  managing = l;
  linkDraft = null;
  $("#link-title").textContent = `${l.repo.split("/")[1]} → ${l.dest.split("/")[1]}`;
  linkDialogMode("manage");
  const unlink = $("#link-unlink");
  unlink.textContent = "Unlink";
  delete unlink.dataset.armed;
  renderLinkInfo();
  $("#link-dialog").showModal();
  refreshLinks(l.dest);
}

function renderLinkInfo() {
  if (!managing || $("#link-manage").hidden) return;
  const d = linkRepos.get(managing.dest);
  const l = d?.links.pull.find((x) => x.repo === managing.repo && x.into === managing.into);
  if (!l) return;
  const i = d.links.pull.indexOf(l);
  const [st, text] = linkState(d);
  const run = d.runs?.[0];
  const c = d.updates?.[i];
  const tree = (repo, ref, dir) => `https://github.com/${repo}/tree/${encodeURIComponent(ref || "HEAD")}/${dir}`;
  const a = (href, t) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(t)}</a>`;
  const rows = [
    ["From", a(tree(l.repo, l.branch, l.path || ""), `${l.repo}${l.path ? "/" + l.path : ""}`)],
    ["Branch", esc(l.branch || "default")],
    ["Into", a(tree(l.dest || managing.dest, "HEAD", l.into), `${managing.dest}/${l.into}`)],
    ["Status", `<span class="node-state"><i class="dot ${st}"></i>${esc(text)}</span>`],
    ["Updated", c ? a(c.html_url, dayFmt(c.commit.committer.date)) : "not yet"],
    ["Last run", run ? a(run.html_url, dayFmt(run.run_started_at || run.created_at)) : "–"],
    ["Runs", "on push · every 15 min"],
  ];
  const html = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  const dl = $("#link-info");
  if (dl.dataset.html !== html) { dl.innerHTML = html; dl.dataset.html = html; }
}

async function dispatchPull(full) {
  const repo = await gh(`/repos/${full}`);
  await gh(`/repos/${full}/actions/workflows/${PULL_WORKFLOW}/dispatches`, { method: "POST", body: { ref: repo.default_branch } });
}

$("#link-sync").addEventListener("click", async (e) => {
  const button = e.currentTarget;
  const l = managing;
  if (!l) return;
  button.disabled = true;
  try {
    const before = linkRepos.get(l.dest)?.runs?.[0]?.id;
    await dispatchPull(l.dest);
    toast("Pulling now");
    for (let i = 0; i < 8; i++) {
      await sleep(2000);
      await refreshLinks(l.dest);
      if (linkRepos.get(l.dest)?.runs?.[0]?.id !== before) break;
    }
  } catch (err) {
    toast(`Couldn't start a pull: ${friendly(err)}`);
  } finally {
    button.disabled = false;
  }
});

$("#link-unlink").addEventListener("click", async (e) => {
  const button = e.currentTarget;
  const l = managing;
  if (!l) return;
  if (!button.dataset.armed) {
    button.dataset.armed = "1";
    button.textContent = `Stop copying? The folder stays in ${l.dest.split("/")[1]}`;
    return;
  }
  button.disabled = true;
  button.textContent = "Unlinking…";
  try {
    await unlink(l);
    $("#link-dialog").close();
    toast(`Unlinked. ${l.into}/ stays in ${l.dest.split("/")[1]}`);
  } catch (err) {
    toast(`Couldn't unlink: ${friendly(err)}`);
    button.textContent = "Unlink";
    delete button.dataset.armed;
  } finally {
    button.disabled = false;
  }
});

async function unlink(l) {
  const destRepo = await gh(`/repos/${l.dest}`);
  const links = (await readLinks(l.dest, destRepo.default_branch)) || { pull: [], push: [] };
  links.pull = links.pull.filter((x) => !(x.repo === l.repo && x.into === l.into));
  const empty = !links.pull.length && !links.push.length;
  const files = { [LINKS_PATH]: empty ? null : linksFile(links) };
  if (!links.pull.length) files[`.github/workflows/${PULL_WORKFLOW}`] = null;
  if (empty) files[LINKS_TOOL_PATH] = null;
  await commitFiles(l.dest, files, `Stop copying from ${l.repo}`, destRepo.default_branch);
  if (empty) await gh(`/repos/${l.dest}/actions/secrets/${SYNC_SECRET}`, { method: "DELETE" }).catch(() => {});
  setLinks(l.dest, links);

  // The source no longer needs to announce changes to this repo, unless
  // another of its folders is still copied here.
  if (links.pull.some((x) => x.repo === l.repo)) return saveCache();
  try {
    const branch = l.branch || (await gh(`/repos/${l.repo}`)).default_branch;
    const src = await readLinks(l.repo, branch);
    if (!src?.push.some((x) => x.repo === l.dest)) return saveCache();
    src.push = src.push.filter((x) => x.repo !== l.dest);
    const none = !src.pull.length && !src.push.length;
    const sfiles = { [LINKS_PATH]: none ? null : linksFile(src) };
    if (!src.push.length) sfiles[`.github/workflows/${NOTIFY_WORKFLOW}`] = null;
    if (none) sfiles[LINKS_TOOL_PATH] = null;
    await commitFiles(l.repo, sfiles, `Stop telling ${l.dest} about changes`, branch);
    if (none) await gh(`/repos/${l.repo}/actions/secrets/${SYNC_SECRET}`, { method: "DELETE" }).catch(() => {});
    if (linkRepos.has(l.repo)) setLinks(l.repo, src);
  } catch (err) {
    console.warn(`Left ${l.repo} as it was`, err); // not ours to change, or already tidied
  }
  saveCache();
}

$("#link-form").addEventListener("submit", createLink);

// ------------------------------------------------------------------ appearance

const THEME_KEY = "framer-bridge:theme";
function applyTheme(t) {
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  for (const b of $$("[data-theme-set]")) b.setAttribute("aria-pressed", String(b.dataset.themeSet === (t || "system")));
}
applyTheme(store.get(THEME_KEY));
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-theme-set]");
  if (!b) return;
  const t = b.dataset.themeSet;
  if (t === "system") store.del(THEME_KEY); else store.set(THEME_KEY, t);
  applyTheme(t);
});

// ------------------------------------------------------------------ wiring

async function signIn(t, user) {
  token = t;
  me = user || await gh("/user");
  store.set(TOKEN_KEY, t);
  $("#avatar").src = me.avatar_url;
  $("#login").textContent = me.login;
  $("#account").hidden = false;
  $("#view-signin").hidden = true;
  $("#view-app").hidden = false;
  try {
    for (const c of JSON.parse(store.get(CACHE_KEY) || "[]")) projects.set(c.full, c);
    for (const c of JSON.parse(store.get(LINKS_CACHE_KEY) || "[]")) linkRepos.set(c.full, c);
  } catch {}
  scanned = projects.size > 0;
  render();
  refreshAll();
  setInterval(tick, 1000);
  pullSettings();
  scanProjects().catch((err) => {
    scanned = true;
    $("#scan-status").textContent = "Couldn't look for other connected projects.";
    $("#scan-status").title = friendly(err);
    render();
  });
}

async function signOut() {
  await account.signOut();
  store.del(TOKEN_KEY);
  store.del(CACHE_KEY);
  store.del(LINKS_CACHE_KEY);
  store.del(SELECTED_KEY);
  location.reload();
}

$("#token-link").href =
  "https://github.com/settings/tokens/new?scopes=repo,workflow&description=Bridge";

// ------------------------------------------------------------------ start screen

function setConn(id, state, text) {
  const n = $("#" + id);
  $(".node-state .dot", n).className = "dot " + state;
  $(".node-state span", n).textContent = text;
  n.dataset.state = state;
  const f = $("#cn-framer").dataset.state, g = $("#cn-github").dataset.state;
  $("#pair-wire").className = "pair-wire" + (f === "ok" && g === "ok" ? " ok" : f === "busy" || g === "busy" ? " busy" : "");
}

/** Framer sites don't allow reading them cross-origin, but an opaque request still tells us the site answers. */
let framerCheck = 0;
async function checkFramer() {
  const v = $("#signin-framer").value.trim();
  const id = ++framerCheck;
  if (!v) return setConn("cn-framer", "", "Not connected"), null;
  let url;
  try { url = normalizeFramerUrl(v); } catch (err) { setConn("cn-framer", "err", "Editor link"); return null; }
  setConn("cn-framer", "busy", "Checking");
  try {
    await fetch(url + "/", { mode: "no-cors", cache: "no-store" });
    if (id === framerCheck) setConn("cn-framer", "ok", host(url));
    return url;
  } catch {
    if (id === framerCheck) setConn("cn-framer", "err", "Can't reach");
    return url;
  }
}
let framerTimer;
$("#signin-framer").addEventListener("input", () => { clearTimeout(framerTimer); framerTimer = setTimeout(checkFramer, 600); });
$("#signin-framer").addEventListener("blur", checkFramer);

$("#signin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errEl = $("#signin-error");
  errEl.hidden = true;
  const fail = (msg) => { errEl.textContent = msg; errEl.hidden = false; };
  let framerUrl = null;
  if ($("#signin-framer").value.trim()) {
    try { framerUrl = normalizeFramerUrl($("#signin-framer").value); } catch (err) { setConn("cn-framer", "err", "Editor link"); return fail(err.message); }
  }
  const t = $("#token").value.trim();
  if (!t) { setConn("cn-github", "err", "Token needed"); return fail("Add a GitHub token to connect your GitHub account."); }
  setConn("cn-github", "busy", "Checking");
  let user;
  try {
    token = t;
    user = await gh("/user");
  } catch (err) {
    token = null;
    setConn("cn-github", "err", "Rejected");
    return fail(err.status === 401 ? "GitHub didn't accept that token." : err.message);
  }
  setConn("cn-github", "ok", user.login);
  if (framerUrl && $("#cn-framer").dataset.state !== "ok") await checkFramer();
  await sleep(900);
  await signIn(t, user);
  if (framerUrl) { select(null); addSite(framerUrl); toast("Now drag its dot to a repository"); }
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
function select(full) {
  selected = full || null;
  store.set(SELECTED_KEY, selected || "");
  drawnFor = null;
  mapHtml = null;
  render();
}
$("#project-select").addEventListener("change", (e) => select(e.target.value));
document.addEventListener("click", (e) => {
  if (!e.target.closest("#account")) $("#account").open = false;
  if (e.target.closest("#account .menu")) $("#account").open = false;
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
  if (action === "map") return select(null);
  if (action === "check") {
    const fulls = selected ? [selected] : [...projects.keys()];
    const pulls = selected ? [] : [...linkRepos.values()].filter((d) => d.links.pull.length).map((d) => d.full);
    for (const full of pulls) dispatchPull(full).then(() => sleep(3000)).then(() => refreshLinks(full)).catch(() => {});
    if (!fulls.length && pulls.length) return toast(`Pulling into ${pulls.length} linked repo${pulls.length > 1 ? "s" : ""}`);
    return fulls.length ? syncNow(fulls, btn, false) : toast("Nothing connected yet");
  }

  if (!selected) return;
  if (action === "sync") syncNow([selected], btn);
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
    else if (!selected) drawMapWires();
  });
});

$("#github-signin").addEventListener("click", async () => {
  setConn("cn-github", "busy", "Opening GitHub");
  // Keep a site typed in on the left for when GitHub sends us back.
  try { store.set(PENDING_SITE_KEY, normalizeFramerUrl($("#signin-framer").value)); } catch { store.del(PENDING_SITE_KEY); }
  try {
    await account.signInWithGitHub();
  } catch (err) {
    setConn("cn-github", "err", "Sign-in failed");
    $("#signin-error").textContent = err.message;
    $("#signin-error").hidden = false;
  }
});

async function start() {
  // With accounts on, GitHub is one click and the token is the fallback.
  const oneClick = account.enabled();
  $("#github-account").hidden = !oneClick;
  $("#github-account-note").hidden = !oneClick;
  $("#token-alt-toggle").hidden = !oneClick;
  $("#token-alt").open = !oneClick;
  $(".connect-foot").hidden = oneClick;
  $("#token-alt").addEventListener("toggle", () => { if (oneClick) $(".connect-foot").hidden = !$("#token-alt").open; });
  let session = null;
  try { session = await account.currentSession(); } catch (err) { console.warn("Couldn't read the sign-in", err); }
  accountId = session?.user?.id || null;
  // GitHub hands over its token only on the way back from signing in.
  if (session?.provider_token) token = session.provider_token;
  if (token) {
    try {
      await signIn(token);
      const pending = store.get(PENDING_SITE_KEY);
      store.del(PENDING_SITE_KEY);
      if (pending && session?.provider_token) { select(null); addSite(pending); toast("Now drag its dot to a repository"); }
      return;
    } catch { store.del(TOKEN_KEY); token = null; }
  }
  if (session && !token) {
    // Signed in, but this browser has no GitHub token any more: sign in again to get one.
    accountId = null;
    await account.signOut();
  }
  $("#view-signin").hidden = false;
}
start();
