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
7. Environment variables: none are needed for the notebook itself
   (everything the person enters stays in their browser). The optional
   AI reflection service needs two — see "Optional: the AI reflection
   service" below. Without them the site deploys with the offline demo.
8. Deploy.

The `NPM_FLAGS = "--legacy-peer-deps"` setting in `netlify.toml` matches
the local install command. If a deploy ever shows Netlify's own "Page not
found" at the root, check that the publish directory is `out` (not
`.next`) and that the base directory is `human-systems`.

## What stays separate from LinkMia

- Build settings: this site reads `human-systems/netlify.toml`, never the
  root `netlify.toml`.
- Environment: none of LinkMia's variables (Supabase, Telegram, Maps) are
  visible to this site, and this site's provider key is not visible to
  LinkMia.
- Functions: this site's `netlify/functions/` (one function) is separate
  from LinkMia's `backend/functions/`.
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

## Optional: the AI reflection service (Step 7A)

Home's "Reflect on this" and Explore's "Help me think about this pattern"
can call a real AI provider. The call never leaves the browser for the
provider directly: it goes to ONE Netlify Function on this site,
`netlify/functions/ai-task.ts`, served at `/api/ai-task`, which holds the
key and forwards exactly the payload the person can inspect under
Library → AI diagnostics. Without the variables below the function answers
"not configured" and the app keeps its offline demo.

Set these in the Netlify UI (Site configuration → Environment variables):

| Variable | Scope | Value | Secret? |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Functions only | the provider key | YES — mark it secret; never Builds scope |
| `NEXT_PUBLIC_AI_PROVIDER` | Builds | `remote` | no (a mode flag; it is inlined into the page) |

Optional server-side tuning (Functions scope): `HSL_AI_MODEL` (default
`claude-opus-5`), `HSL_AI_EFFORT` (`low` default, `medium`, `high`),
`HSL_AI_MAX_OUTPUT_TOKENS` (default 1500), `HSL_AI_TIMEOUT_MS` (default
25000), `HSL_AI_RATE_PER_10MIN` (default 20 per client address, best
effort per function instance), `HSL_AI_DISABLED=1` (kill switch: every
call answers "not configured").

Before turning it on:

1. Set a monthly spend limit in the provider console. The function's
   per-address limiter is a courtesy, not a budget.
2. Check the site's synchronous function time limit on your Netlify plan.
   The function streams a whitespace heartbeat while the provider works
   and waits up to `HSL_AI_TIMEOUT_MS`; if the platform cuts the call
   first, the person sees "Reflection couldn't be completed. Try again."
   with "The reflection service could not be reached." under Details.
   Lower the timeout, choose a faster model, or ask Netlify for a longer
   limit.
3. Redeploy after setting `NEXT_PUBLIC_AI_PROVIDER` (it is a build-time
   value). Removing it and redeploying returns the site to the demo.

What leaves the browser: the task name and the typed context items the
person can read under AI diagnostics (the note, the system description,
recorded values with their basis, observations, the pattern and the
Explore comparison for a pattern). Never the manifest, the model
revision, the clock, browser storage or anything from another notebook.
Sensitive items stay out unless the person includes them on the
diagnostics screen. The function logs one line per call (task, outcome,
duration) and never the content.
