#!/usr/bin/env node
// Keeps folders in step between linked repositories, as listed in .links.json:
//
//   {
//     "pull": [{ "repo": "owner/name", "branch": "main", "path": "content", "into": "content" }],
//     "push": [{ "repo": "owner/other", "branch": "main" }]
//   }
//
//   node tools/links.mjs pull     copy each "pull" folder into this repo, commit what changed
//                                 and tell the "push" repos when something did
//   node tools/links.mjs notify   tell each "push" repo watching this branch to pull now
//
// SYNC_TOKEN is a GitHub token that can read the linked repos and start their
// workflows. Without it, public repos still pull with GITHUB_TOKEN, on the
// timer. An empty "path" means the whole repository. Node 20+.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const CONFIG = ".links.json";
const TOKEN = process.env.SYNC_TOKEN || "";
const READ_TOKEN = TOKEN || process.env.GITHUB_TOKEN || "";
// Overridable for tests.
const GIT_BASE = process.env.LINKS_GIT_BASE || "https://github.com";
const API = process.env.LINKS_API_BASE || "https://api.github.com";
// Never copied between repos, and never written into.
const PROTECTED = [".git", ".github", "tools", CONFIG, ".site.json"];

const log = (s) => console.log(s);
const warn = (s) => console.log(`::warning::${s}`);
const fail = (s) => console.log(`::error::${s}`);
const scrub = (s) => (READ_TOKEN ? String(s).split(READ_TOKEN).join("***") : String(s));

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
}

function readConfig() {
  if (!existsSync(CONFIG)) return { pull: [], push: [] };
  const c = JSON.parse(readFileSync(CONFIG, "utf8"));
  return { pull: c.pull || [], push: c.push || [] };
}

/** A folder inside the repo: no leading or trailing slash, no "..". */
function cleanDir(v) {
  const d = String(v ?? "").trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (d.split("/").some((part) => part === ".." || part === ".")) throw new Error(`"${v}" can't contain . or ..`);
  return d;
}

function checkLink(link) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(link.repo || "")) throw new Error(`"${link.repo}" isn't an owner/name repository`);
  if (link.branch && !/^[\w./-]+$/.test(link.branch)) throw new Error(`"${link.branch}" isn't a branch name`);
  const from = cleanDir(link.path);
  const into = cleanDir(link.into);
  if (!into) throw new Error(`the link from ${link.repo} needs a folder to copy into`);
  if (PROTECTED.includes(into.split("/")[0])) throw new Error(`${into} is kept for the repository's own setup`);
  return { ...link, from, into };
}

function cloneUrl(repo) {
  if (GIT_BASE.startsWith("https://") && READ_TOKEN) {
    return `${GIT_BASE.replace("https://", `https://x-access-token:${READ_TOKEN}@`)}/${repo}.git`;
  }
  return `${GIT_BASE}/${repo}.git`;
}

function summary(lines) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
}

async function pull() {
  const { pull: links } = readConfig();
  if (!links.length) return log("Nothing to pull.");
  git(["config", "user.name", "github-actions[bot]"]);
  git(["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
  const rows = ["| From | Into | Version | Changed |", "| --- | --- | --- | --- |"];
  let commits = 0, failures = 0;
  for (const raw of links) {
    let link, tmp;
    try {
      link = checkLink(raw);
      tmp = mkdtempSync(path.join(os.tmpdir(), "link-"));
      try {
        git(["clone", "-q", "--depth", "1", ...(link.branch ? ["--branch", link.branch] : []), cloneUrl(link.repo), tmp]);
      } catch (err) {
        throw new Error(`couldn't read ${link.repo}${link.branch ? ` (${link.branch})` : ""}. ${TOKEN ? "Check it still exists and the token can read it." : "Private repositories need the SYNC_TOKEN secret."}\n${scrub(err.stderr || err.message)}`);
      }
      const sha = git(["-C", tmp, "rev-parse", "--short", "HEAD"]);
      const src = path.join(tmp, link.from);
      if (!existsSync(src)) throw new Error(`${link.repo} has no folder "${link.from}"`);
      // The folder becomes an exact copy: files removed at the source go here too.
      const skip = new Set([".git", ...(link.from ? [] : PROTECTED)].map((p) => path.join(src, p)));
      rmSync(link.into, { recursive: true, force: true });
      mkdirSync(link.into, { recursive: true });
      cpSync(src, link.into, { recursive: true, verbatimSymlinks: true, filter: (f) => !skip.has(f) });
      git(["add", "-A", "--", link.into]);
      let changed = false;
      try { git(["diff", "--cached", "--quiet"]); } catch { changed = true; }
      if (changed) {
        git(["commit", "-q", "-m", `Update ${link.into} from ${link.repo}${link.from ? `/${link.from}` : ""} (${sha})`]);
        commits++;
      }
      log(`${link.repo}${link.from ? `/${link.from}` : ""} @ ${sha} -> ${link.into}: ${changed ? "updated" : "no change"}`);
      rows.push(`| ${link.repo}/${link.from} | ${link.into}/ | ${sha} | ${changed ? "yes" : "no"} |`);
    } catch (err) {
      failures++;
      fail(scrub(err.message));
      rows.push(`| ${raw.repo}/${raw.path || ""} | ${raw.into || ""}/ | – | failed |`);
      git(["reset", "-q"]);
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
  }
  summary(rows);
  if (commits) {
    const branch = process.env.GITHUB_REF_NAME || git(["rev-parse", "--abbrev-ref", "HEAD"]);
    let pushed = false;
    for (let i = 0; i < 3 && !pushed; i++) {
      try {
        git(["pull", "-q", "--rebase", "origin", branch]);
        git(["push", "-q", "origin", `HEAD:${branch}`]);
        pushed = true;
      } catch (err) {
        warn(`Push attempt ${i + 1} failed: ${scrub(err.stderr || err.message)}`);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
    if (!pushed) { fail("Couldn't push the pulled changes"); process.exit(1); }
    log(`Pushed ${commits} update${commits > 1 ? "s" : ""}.`);
    // Pushes made with GITHUB_TOKEN don't start workflows, so pass the news on.
    await notify(branch);
  }
  if (failures) process.exit(1);
}

async function notify(branch = process.env.GITHUB_REF_NAME) {
  const { push: targets } = readConfig();
  const due = targets.filter((t) => !t.branch || !branch || t.branch === branch);
  if (!due.length) return log("No linked repositories to tell."), 0;
  if (!TOKEN) return warn("SYNC_TOKEN isn't set, so linked repositories pick up changes on their timer instead."), 0;
  let failures = 0;
  for (const t of due) {
    const res = await fetch(`${API}/repos/${t.repo}/dispatches`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({ event_type: "source-updated", client_payload: { from: process.env.GITHUB_REPOSITORY || "" } }),
    }).catch((err) => ({ ok: false, status: 0, statusText: err.message }));
    if (res.ok) log(`Told ${t.repo} to pull.`);
    else { failures++; warn(`Couldn't reach ${t.repo}: ${res.status} ${res.statusText}`); }
  }
  return failures === due.length ? 1 : 0;
}

const cmd = process.argv[2];
if (cmd === "pull") await pull();
else if (cmd === "notify") process.exitCode = await notify();
else {
  console.error("Usage: node tools/links.mjs pull|notify");
  process.exit(2);
}
