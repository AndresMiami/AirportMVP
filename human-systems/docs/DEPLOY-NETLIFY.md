# Deploying Human Systems Lens on Netlify (independent site)

Human Systems Lens is deployed as its OWN Netlify site, separate from the
LinkMia site that lives at the repository root. Both sites can point at the
same GitHub repository; the base directory keeps them independent.

## One-time setup (Netlify UI)

1. Netlify → **Add new site → Import an existing project → GitHub** →
   choose `AndresMiami/AirportMVP`.
2. **Site name**: something like `human-systems-lens` (gives
   `https://human-systems-lens.netlify.app`; a custom domain can be added
   later under Domain management).
3. **Branch to deploy**: `claude/human-systems-dynamics-app-1gna5u` for
   now. Once the branch is merged, switch this to `main`.
4. **Base directory**: `human-systems`  ← this is the important setting.
5. **Build command**: `npm run build` (pre-filled from `human-systems/netlify.toml`).
6. **Publish directory**: `out` (pre-filled). The app is a static export:
   `next build` writes plain HTML into `out/` and Netlify serves it with
   no server runtime.
7. Leave environment variables empty. This site needs none: no functions,
   no database, no keys. Everything the person enters stays in their
   browser.
8. Deploy.

The `NPM_FLAGS = "--legacy-peer-deps"` setting in `netlify.toml` matches
the local install command. If a deploy ever shows Netlify's own "Page not
found" at the root, check that the publish directory is `out` (not
`.next`) and that the base directory is `human-systems`.

## What stays separate from LinkMia

- Build settings: this site reads `human-systems/netlify.toml`, never the
  root `netlify.toml`.
- Environment: none of LinkMia's variables (Supabase, Telegram, Maps) are
  visible to this site.
- Deploys: a push that only touches `human-systems/` deploys this site;
  Netlify's "ignore builds" can be set to
  `git diff --quiet $CACHED_COMMIT_REF $COMMIT_REF -- .` on each site so a
  change to one app does not rebuild the other.
- Domain: its own `*.netlify.app` subdomain or custom domain.

## Optional later step: its own repository

If you later want the code itself in a separate repository, the history
can be split without losing it:

    git subtree split --prefix=human-systems -b human-systems-only
    git push <new-repo-url> human-systems-only:main

Then point the Netlify site at the new repository with base directory
left empty. Until then, the monorepo plus base directory is simpler.

## Checks before each deploy

    npm run typecheck && npm run lint && npm test && npm run build

To look at the exported site locally, serve the `out/` folder with any
static server (for example `npx serve out`); `next start` does not apply
to a static export.
