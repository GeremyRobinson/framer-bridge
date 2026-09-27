# Bridge

Design in Framer, host on GitHub. Framer Bridge connects a published Framer
site to a GitHub repository and keeps a GitHub Pages copy of it in sync.

**Open the app:** https://geremyrobinson.github.io/framer-bridge/

## How it works

1. Sign in with a GitHub token (the `repo` and `workflow` scopes). The token
   stays in your browser; the app has no server and talks to GitHub directly.
2. Connect a project: paste the published Framer address, choose a new or
   existing repository, and optionally a custom domain. The app turns on
   GitHub Pages and commits three things to the repo:
   - `.github/workflows/framer-bridge.yml`, the sync workflow
   - `tools/framer-export.mjs`, the exporter
   - `.framer-bridge.json`, the project's settings
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
  can break it until the exporter is updated. Update `template/framer-export.mjs`
  here, then re-connect a project (or copy the file into its `tools/` folder).
- GitHub pauses scheduled workflows in a repository after 60 days without any
  commits. Pressing **Sync now** or pushing anything wakes it up.
- Pages on a private repository needs a paid GitHub plan.
