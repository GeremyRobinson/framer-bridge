// Framer Bridge: connects published Framer sites to GitHub repositories.
// No server: everything below talks to the GitHub REST API from the browser
// with the user's own token.

const API = "https://api.github.com";
const WORKFLOW_FILE = "framer-bridge.yml";
const WORKFLOW_PATH = `.github/workflows/${WORKFLOW_FILE}`;
const CONFIG_PATH = ".framer-bridge.json";
const TOKEN_KEY = "framer-bridge:token";
const CACHE_KEY = "framer-bridge:projects";

const $ = (sel, root = document) => root.querySelector(sel);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

let token = store.get(TOKEN_KEY);
let me = null;
/** full_name -> project state */
const projects = new Map();
let pollTimer = null;

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
        await new Promise((r) => setTimeout(r, 1500));
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

function jobState(job) {
  if (!job) return "idle";
  if (job.status !== "completed") return "busy";
  if (job.conclusion === "success") return "ok";
  if (job.conclusion === "skipped") return "idle";
  if (job.conclusion === "cancelled") return "idle";
  return "err";
}

async function loadStatus(p) {
  const full = p.full;
  const [runs, pages, deployments, workflow] = await Promise.all([
    gh(`/repos/${full}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=1`).catch(() => ({ workflow_runs: [] })),
    gh(`/repos/${full}/pages`).catch((err) => (err.status === 404 ? { missing: true } : null)),
    gh(`/repos/${full}/deployments?environment=github-pages&per_page=1`).catch(() => []),
    gh(`/repos/${full}/actions/workflows/${WORKFLOW_FILE}`).catch(() => null),
  ]);
  const run = runs.workflow_runs?.[0] || null;
  let jobs = [];
  if (run) jobs = (await gh(`/repos/${full}/actions/runs/${run.id}/jobs`).catch(() => ({ jobs: [] }))).jobs;
  const find = (name) => jobs.find((j) => j.name === name);
  p.run = run;
  p.jobs = { check: find("Check Framer"), build: find("Export"), deploy: find("Deploy") };
  p.pages = pages;
  p.lastDeploy = deployments[0]?.created_at || null;
  p.paused = workflow?.state && workflow.state !== "active";
  p.loaded = true;
}

function describe(p) {
  const { run, jobs, pages } = p;
  const running = run && run.status !== "completed";
  const s = {};

  const framer = jobState(jobs.check);
  s.framer = {
    state: !run ? "idle" : framer,
    text: { ok: "Connected", busy: "Checking", err: "Can't reach", idle: "Waiting" }[!run ? "idle" : framer],
  };

  let exp = jobState(jobs.build);
  let expText = { ok: "Exported", busy: "Transferring", err: "Export failed", idle: "No changes" }[exp];
  if (!jobs.build && running) { exp = "idle"; expText = "Waiting"; }
  if (!run) expText = "Not run yet";
  s.export = { state: exp, text: expText };

  let dep = jobState(jobs.deploy);
  let depText = { ok: "Deployed", busy: "Deploying", err: "Deploy failed", idle: "Nothing new" }[dep];
  if (!jobs.deploy && running) { dep = "idle"; depText = "Waiting"; }
  if (!run) depText = "Not run yet";
  s.deploy = { state: dep, text: depText };

  // Pages reports no build status for Actions deployments, so fall back to
  // whether a deployment has happened.
  const pstatus = pages?.status ?? (p.lastDeploy ? "built" : null);
  const live = pages?.missing ? "err" : pstatus === "built" ? "ok" : pstatus === "errored" ? "err" : pstatus === "building" ? "busy" : "idle";
  s.live = { state: live, text: pages?.missing ? "Pages off" : { ok: "Live", busy: "Publishing", err: "Error", idle: "Not yet" }[live] };

  // One summary badge for the whole project.
  const states = Object.values(s).map((x) => x.state);
  if (p.paused) s.badge = ["idle", "Paused"];
  else if (states.includes("err")) s.badge = ["err", "Needs attention"];
  else if (running || states.includes("busy")) s.badge = ["busy", exp === "busy" ? "Transferring" : dep === "busy" ? "Deploying" : "Checking"];
  else if (live === "ok") s.badge = ["ok", "In sync"];
  else s.badge = ["idle", "Setting up"];
  s.running = running;
  return s;
}

function ago(iso) {
  if (!iso) return "never";
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

// ------------------------------------------------------------------ rendering

function liveUrl(p) {
  if (p.pages?.html_url) return p.pages.html_url;
  if (p.config.domain) return `https://${p.config.domain}/`;
  const [owner, repo] = p.full.split("/");
  return repo.toLowerCase() === `${owner.toLowerCase()}.github.io` ? `https://${repo}/` : `https://${owner.toLowerCase()}.github.io/${repo}/`;
}

function renderProject(p) {
  let card = document.querySelector(`[data-full="${CSS.escape(p.full)}"]`);
  if (!card) {
    card = $("#project-tpl").content.firstElementChild.cloneNode(true);
    card.dataset.full = p.full;
    $("#projects").append(card);
  }
  $(".name", card).textContent = p.full.split("/")[1];
  const fu = $(".framer-url", card);
  fu.textContent = "From " + p.config.framerUrl.replace(/^https?:\/\//, "");
  fu.href = p.config.framerUrl;
  $(".repo-link", card).href = `https://github.com/${p.full}`;
  $(".live-link", card).href = liveUrl(p);
  const runLink = $(".run-link", card);
  runLink.hidden = !p.run;
  if (p.run) runLink.href = p.run.html_url;
  $('[data-action="pause"]', card).textContent = p.paused ? "Resume" : "Pause";

  if (!p.loaded) {
    $(".badge", card).textContent = "Loading";
    return;
  }
  const s = describe(p);
  const badge = $(".badge", card);
  badge.className = "badge " + s.badge[0];
  badge.textContent = s.badge[1];
  const stages = ["framer", "export", "deploy", "live"];
  for (const [i, key] of stages.entries()) {
    const li = $(`[data-stage="${key}"]`, card);
    $(".dot", li).className = "dot " + s[key].state;
    $(".state", li).textContent = s[key].text;
    // Animate the connector into a stage while data is moving into it.
    li.classList.toggle("flow", i > 0 && s[key].state === "busy");
  }
  const checked = p.run ? `Checked ${ago(p.run.updated_at || p.run.created_at)}` : "Waiting for the first check";
  $(".meta", card).textContent = `${checked} · Last published ${ago(p.lastDeploy)}` + (p.paused ? " · Automatic sync paused" : "");
}

function renderAll() {
  const list = [...projects.values()].sort((a, b) => a.full.localeCompare(b.full));
  for (const card of document.querySelectorAll("#projects .card")) {
    if (!projects.has(card.dataset.full)) card.remove();
  }
  list.forEach(renderProject);
  $("#empty").hidden = list.length > 0 || !scanned;
}

// ------------------------------------------------------------------ loading

let scanned = false;

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
        renderAll();
        refreshProject(r.full_name);
      } else {
        projects.get(r.full_name).config = config;
      }
    }
  }));
  for (const full of [...projects.keys()]) if (!found.has(full)) projects.delete(full);
  store.set(CACHE_KEY, JSON.stringify([...projects.values()].map((p) => ({ full: p.full, config: p.config }))));
  scanned = true;
  $("#scan-status").textContent = "";
  renderAll();
  return repos;
}

async function refreshProject(full) {
  const p = projects.get(full);
  if (!p) return;
  try {
    await loadStatus(p);
  } catch (err) {
    console.warn(full, err);
  }
  renderProject(p);
  schedulePoll();
}

function refreshAll() {
  return Promise.all([...projects.keys()].map(refreshProject));
}

function schedulePoll() {
  clearTimeout(pollTimer);
  const anyRunning = [...projects.values()].some((p) => p.run && p.run.status !== "completed");
  pollTimer = setTimeout(() => {
    if (document.visibilityState === "visible") refreshAll();
    else schedulePoll();
  }, anyRunning ? 5000 : 30000);
}

// ------------------------------------------------------------------ actions

async function syncNow(full, button) {
  button.disabled = true;
  button.textContent = "Starting…";
  try {
    await gh(`/repos/${full}/actions/workflows/${WORKFLOW_FILE}/dispatches`, { method: "POST", body: { ref: "main" } });
    // The run takes a moment to appear.
    for (let i = 0; i < 6; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      await refreshProject(full);
      if (projects.get(full)?.run?.status !== "completed") break;
    }
  } catch (err) {
    alert(`Couldn't start a sync: ${err.message}`);
  } finally {
    button.disabled = false;
    button.textContent = "Sync now";
  }
}

async function togglePause(full, button) {
  const p = projects.get(full);
  button.disabled = true;
  try {
    await gh(`/repos/${full}/actions/workflows/${WORKFLOW_FILE}/${p.paused ? "enable" : "disable"}`, { method: "PUT" });
    await refreshProject(full);
  } catch (err) {
    alert(err.message);
  } finally {
    button.disabled = false;
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

A GitHub Pages copy of the Framer site [${config.framerUrl.replace(/^https?:\/\//, "")}](${config.framerUrl}),
kept in sync by Framer Bridge.

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
  li.innerHTML = `<i class="dot busy"></i><div><span></span><small></small></div>`;
  $("span", li).textContent = text;
  $("#connect-progress").append(li);
  return {
    done(note = "") { $(".dot", li).className = "dot ok"; $("small", li).textContent = note; },
    fail(note) { $(".dot", li).className = "dot err"; $("small", li).textContent = note; },
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
          description: `GitHub Pages copy of ${framerUrl.replace(/^https?:\/\//, "")}, synced from Framer`,
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
    await commitFiles(full, files, `Connect to Framer site ${framerUrl}\n\nInstalled by Framer Bridge.`);
    step.done("The first sync has started");

    projects.set(full, { full, config });
    renderAll();
    refreshProject(full);
    store.set(CACHE_KEY, JSON.stringify([...projects.values()].map((p) => ({ full: p.full, config: p.config }))));
    const done = progressStep(domain
      ? `Almost there: add a DNS record pointing ${domain} at ${me.login.toLowerCase()}.github.io`
      : "Connected. Watch the status lights on the dashboard.");
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
    await commitFiles(p.full, { [CONFIG_PATH]: JSON.stringify(config, null, 2) + "\n" }, "Update Framer Bridge settings");
    p.config = config;
    $("#settings-dialog").close();
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
  $("#view-dashboard").hidden = false;
  try {
    for (const c of JSON.parse(store.get(CACHE_KEY) || "[]")) projects.set(c.full, c);
  } catch {}
  renderAll();
  refreshAll();
  scanProjects().catch((err) => ($("#scan-status").textContent = friendly(err)));
}

function signOut() {
  store.del(TOKEN_KEY);
  store.del(CACHE_KEY);
  location.reload();
}

$("#token-link").href =
  "https://github.com/settings/tokens/new?scopes=repo,workflow&description=Framer%20Bridge";

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
$("#refresh").addEventListener("click", () => { refreshAll(); scanProjects().catch(() => {}); });
$("#open-connect").addEventListener("click", openConnect);
$("#connect-form").addEventListener("submit", connect);
$("#settings-form").addEventListener("submit", saveSettings);
for (const input of document.querySelectorAll('input[name="repo-mode"]')) {
  input.addEventListener("change", () => {
    const isNew = input.value === "new" && input.checked;
    $("#repo-new").hidden = !isNew;
    $("#repo-existing").hidden = isNew;
  });
}
document.addEventListener("click", (e) => {
  const closer = e.target.closest("[data-close]");
  if (closer) closer.closest("dialog").close();
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const full = btn.closest(".card")?.dataset.full;
  const action = btn.dataset.action;
  if (action === "connect") openConnect();
  if (action === "sync") syncNow(full, btn);
  if (action === "pause") togglePause(full, btn);
  if (action === "settings") openSettings(full);
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && me) refreshAll();
});

if (token) {
  signIn(token).catch(() => {
    store.del(TOKEN_KEY);
    $("#view-signin").hidden = false;
  });
} else {
  $("#view-signin").hidden = false;
}
