# The repo is published to the open web

Found 2026-08-12 while verifying a deploy: `https://bemoreswan.com/src/lib/discovery-query-gen.ts`
returned 200. It is not one file.

Status: **IMPLEMENTED 2026-08-12 — not yet deployed, and NOT yet verified against a live URL.**
Steps 1–3 below are done: the four client `.js` files moved to `src/public/`, forced-404 redirects
added to `netlify.toml`, and `tests/directory-exposure.test.ts` (7 checks) guards the deny-list
against drift.

⚠️ **A config change of this kind cannot be proven locally.** The tests assert the rules exist and
carry `force = true`; only a real fetch proves Netlify honours them. Two things to check the moment
this deploys:
1. Blocked paths answer **404** — `/db/schema.ts`, `/netlify/functions/assistant-records.ts`,
   `/src/utils/tenant.ts`, `/package-lock.json`.
2. The public subtree still answers **200** — `/src/components/assistant-data-hub.js`,
   `/src/generated/platform-constants.js`, `/src/public/assistant-content.js`. Getting this wrong
   white-screens the workspace, so check it first.

There is no `404.html` in the repo, so the redirect body falls back to Netlify's default page.
`status = 404` is what forces the status; if a blocked path ever answers 200, that is the line to
revisit.

## Severity first

**No credentials are exposed, and this is not a breach.** Verified against prod:

| | |
|---|---|
| `.env` | **404** ✓ |
| `.git/HEAD`, `.git/config` | **404** ✓ |
| `netlify.toml` | **404** ✓ |
| `node_modules/*` | **404** ✓ |
| `seed/*` | **404** ✓ |

Netlify excludes those by default. Nothing below leaks a secret, and the auth model does not
depend on source secrecy — the IDOR guards and tenant scoping are real and hold regardless.

What it does do is turn *finding* a flaw from research into reading, and it publishes internal
commercial material.

## What is actually served (measured, not inferred)

| Path | | Contains |
|---|---|---|
| `netlify/functions/*.ts` | 200 | every endpoint's full server logic |
| `netlify/edge-functions/auth-guard.ts` | 200 | **the auth guard itself, including `PROTECTED_PATHS`** |
| `db/schema.ts` | 200 | 262 KB — the complete database schema |
| `db/*.sql` | 200 | every migration, i.e. the schema's change history |
| `src/utils/*.ts` (147 files) | 200 | tenancy, ledger, blueprint, scenario engine |
| `src/lib/*.ts`, `src/config/*.ts` | 200 | scoring prompts, query generation, guardrail vocabularies |
| `scripts/*` | 200 | including `db-migrate.mjs` |
| `tests/*`, `docs/*` | 200 | internal planning docs, prod diagnostics, competitor analysis |
| `package.json`, `package-lock.json`, `tsconfig.json`, `deno.lock`, `TODO.md` | 200 | exact dependency versions for CVE matching |

The auth-guard source and the exact dependency manifest are the two that matter most.

## Why

`[build]` in `netlify.toml` sets `command` and `functions` but **no `publish`**, so Netlify
publishes the repo root. A comment at the `/docs/*` header already says so, and already says what
should happen:

> *Internal-only files that the repo-root publish exposes to the open web … noindex keeps them out
> of search, but the real fix is to stop deploying them at all.*

So this was known and half-mitigated. `X-Robots-Tag: noindex` exists on `/docs/*` and `/legal/*`,
which stops search indexing and does nothing about direct access. Everything else has no rule.

## The insight that makes the fix safe

⚠️ **The public/private split is by FILE EXTENSION, not by directory.** A naive `/src/*` block
takes the app down — the browser loads real modules from under `src/`.

Grepping every HTML page and client script for `/src/` references gives the complete public set:

- `src/components/*.js` — all client
- `src/generated/*.js` — the generated constants mirror
- `src/i18n.js`
- **`src/config/assistant-content.js`, `src/config/assistant-onboarding-schemas.js`,
  `src/config/mandate-suggestions.js`, `src/lib/marked-bms-directives.js`** — four `.js` files
  sitting in otherwise server-only directories

Everything else under `src/` is TypeScript: 25 `.ts` in `config`, 17 in `lib`, 147 in `utils`,
4 in `constants`. **No `.ts` file in this repo is ever legitimately served** — a browser cannot
execute TypeScript, and nothing here ships `.ts` to a client.

Those four `.js` files are the only thing standing between the current state and a clean
directory-level rule.

## Recommended fix

**Two steps. The first is what makes the second safe.**

### 1. Move the four client `.js` files out of the server-only directories

Into a directory whose name states what it is — `src/public/` — and update the four script tags.
Small, mechanical, and it makes the boundary **structural rather than rule-based**: after this,
every directory is wholly client or wholly server, and no future rule has to carve an exception.

### 2. Block the server-only paths in `netlify.toml`

`[[redirects]]` with `status = 404` and **`force = true`** — force is required, or the rule loses
to the real file that exists there.

```
/db/*  /docs/*  /legal/*  /netlify/*  /remotion/*  /scripts/*  /tests/*
/src/config/*  /src/lib/*  /src/utils/*  /src/constants/*
/package.json  /package-lock.json  /tsconfig.json  /drizzle.config.ts  /deno.lock  /TODO.md
```

⚠️ **Verify `/src/components/*` and `/src/generated/*` still serve** immediately after deploying.
Those two carry the entire workspace UI, and getting the rule order wrong is a white-screen.

### 3. A drift guard, because a deny-list rots

A deny-list silently stops covering a directory nobody added a rule for. Two cheap defences:

- **A CI test** that enumerates top-level directories plus `src/` subdirectories and fails unless
  each is either in a documented public allow-list or matched by a block rule. This is the one
  that actually prevents recurrence; it costs nothing and runs on every push.
- **A post-deploy smoke check** fetching four known-bad paths and asserting 404.

## The alternative, and why it is not first

**Publishing a built `dist/` instead of the repo root** is the structurally correct answer — an
allow-list posture, where a new server file is private by default rather than public by default.
It is also a change to how all ~40 HTML pages are deployed, and it interacts with
`build:seo-html`, which currently rewrites HTML in place in the deploy container.

Getting that wrong takes the site down; getting the deny-list wrong leaves a file exposed that is
already exposed today. So: deny-list now, `dist/` later if an allow-list posture is wanted. Step 1
above is a prerequisite for either, so no work is wasted.

## Risks

- **A too-broad `/src/*` rule white-screens the app.** The mitigation is step 1 plus checking the
  two public subdirectories immediately after deploy.
- **`force = true` is easy to omit**, and without it every rule silently does nothing while
  appearing correct. Verify with a real fetch, never by reading the config.
- **`/legal/*`** — confirm nothing there is legitimately linked from a public page before blocking;
  it is currently only noindexed, which suggests it was thought to be reachable.

## Non-goals

- **No change to the auth model.** The guard is sound; this is about not handing out its source.
- **No secret rotation.** Nothing secret was exposed. `.env` and `.git` are both 404.
- **Not a rewrite of the build.** See the `dist/` note above.
