# Bridge

Design in Framer, host on GitHub. Framer Bridge connects a published Framer
site to a GitHub repository and keeps a GitHub Pages copy of it in sync.

**Open the app:** https://geremyrobinson.github.io/framer-bridge/

## How it works

1. Sign in with GitHub (through Supabase, see `account.js`), or paste a GitHub
   token with the `repo` and `workflow` scopes. Either way the GitHub token
   stays in your browser; the app has no server and talks to GitHub directly.
   Signed in with GitHub, your sites are saved per user in Supabase
   (`supabase/schema.sql`, one row per user behind row-level security), so
   they follow you to every device.
2. Connect a project: paste the published Framer address, choose a new or
   existing repository, and optionally a custom domain. The app turns on
   GitHub Pages and commits these to the repo:
   - `.github/workflows/sync.yml`, the sync workflow
   - `tools/export.mjs`, the exporter
   - `tools/project.mjs`, which saves the design project when a key is set
   - `tools/react.mjs`, which rebuilds the site as a React app
   - `.site.json`, the project's settings

   Each sync also commits the full exported site to `site/` and a React +
   Vite version of it to `app/` (served as a preview at `<site>/react/`),
   which runs none of the builder's code. When the design project is saved,
   the site's own code components (from `project/code/`) run live in it.
   Hand-written replacements for parts that only exist at run time go in
   `app/src/custom/` (listed in its `islands.json`) and survive every sync. Nothing Bridge
   writes to the repo names Framer: file names, commit messages, the README
   and the exported site itself only carry the site's own name (the exporter
   replaces the builder's name in the output; `--keep-names` turns that off).
   Repos connected before this used `framer-bridge.yml`, `framer-export.mjs`
   and `.framer-bridge.json`; Bridge still reads those, and reconnecting a
   repo swaps them for the new names.
3. From then on, publishing in Framer is all you do. Every 15 minutes the
   workflow checks whether the Framer site changed, and if it did, exports it
   and deploys it to Pages. **Sync now** does it immediately.

Each project card shows four status lights:

| Light | Meaning |
| --- | --- |
| Framer | Can the published Framer site be reached |
| Update | Was a new version found and exported ("Transferring" while it runs) |
| Deploy | Was the export deployed to GitHub Pages |
| Live | Is GitHub Pages serving the site |

Green is done, pulsing amber is working, grey is nothing to do, red needs attention.
A failed export never replaces the live site: the last good version stays up.

## Limits

- Anything that runs on Framer's servers doesn't work in the copy: forms,
  checkout, CMS search, analytics.
- The exporter reads Framer's published output, so a change on Framer's side
  can break it until the exporter is updated. Update `template/export.mjs`
  here, then re-connect a project (or copy the file into its `tools/` folder).
- GitHub pauses scheduled workflows in a repository after 60 days without any
  commits. Pressing **Sync now** or pushing anything wakes it up.
- Pages on a private repository needs a paid GitHub plan.

## Font

The interface is designed for ABC Areal (Dinamo), using its MONO axis for
technical values. The font is licensed and its licence forbids storing it on a
public server, so it is not in this repository. Browsers that have it installed
use it; everyone else gets Helvetica and the system monospace. With a Dinamo web
licence, put the file at `fonts/ABCArealSuperfamilyVariable.ttf` and remove
`fonts/` from `.gitignore`.
