# Runbook: Remotion Lambda deploy (video text-overlay render)

**Scope:** the AWS side of Phase 4 — the render function and the composition bundle that
`trigger-post-render` / `render-post-video-background` drive when a reviewer approves a video post
carrying timed text overlays.

A browser has no video encoder, so a video post's overlays cannot bake locally the way a photo's do.
They are burned in by Remotion Lambda instead, and the post is held out of the publish queue
(`scheduled_posts.render_status`) until the overlaid clip is attached. Until the steps below are
done, `remotionConfigured()` is false, `trigger-post-render` answers **503 `RENDER_UNAVAILABLE`**,
and no post is ever gated — approving a video post with text simply refuses rather than stranding it.
That is the intended un-deployed state.

## What gets deployed

Two independent AWS artefacts, both created by the Remotion CLI:

| Artefact | Created by | Named | Holds |
|---|---|---|---|
| Render function (one, shared) | `npm run remotion:deploy-fn` | `remotion-render-<version>-mem<n>mb-disk<n>mb-<n>sec` | The renderer itself (Chrome + ffmpeg). Version-specific, stateless — staging and production share it safely. |
| Site — staging | `npm run remotion:deploy-site-staging` | bucket `remotionlambda-<region>-<hash>`, key `sites/bemoreswan-overlay-staging` | **Our composition** — `remotion/`, `src/lib/overlay-geometry.ts`, and everything they import. |
| Site — production | `npm run remotion:deploy-site-prod` | same bucket, key `sites/bemoreswan-overlay-prod` | The same bundle, deployed separately. |

> **The most important operational fact in this document.** A site is a *bundle sitting in S3*, not
> the repo. Pushing to `staging`/`main` does **not** update it. Any change to `remotion/PostOverlay.tsx`,
> `remotion/Root.tsx`, or `src/lib/overlay-geometry.ts` requires re-running the deploy-site script or
> renders keep using the old geometry — silently, with no error anywhere. See
> [Redeploying after a code change](#redeploying-after-a-code-change).
>
> **This is also why there are two sites and not one.** With a shared bundle, deploying a composition
> change to test it on staging would change *production's* renders at the same instant, with no deploy,
> no review, and nothing in git to show for it. Two site names cost a few hundred KB of S3 and remove
> that entirely. The function stays shared — it holds no code of ours.

## Prerequisites

1. **Remotion licence — decided: the free licence.** Free covers individuals, non-profits, and
   for-profit companies with up to 3 employees (`node_modules/remotion/LICENSE.md`). Revisit if the
   company grows past that; a purchased key is then passed as `licenseKey` on the render call.
2. **AWS account and region — decided: a dedicated account, `eu-west-2` (London).** London keeps the
   render (which holds customer video frames in memory and writes the output to S3) inside the UK,
   matching where the business and its customers are; `eu-west-1` (Ireland) is the fallback if a
   service is ever unavailable in London. Everything Remotion creates lives inside this account.
3. Node + the repo installed locally (`npm install`). Every command below runs from the repo root.

## Environment variables

Set on **each** Netlify context (staging and production) — Site configuration → Environment
variables. All five are required together; `remotionConfigured()` treats a missing one as
"not deployed". Note that staging is a *branch deploy*, so scope the values to a context that
actually covers it rather than to production only.

| Var | Value | Notes |
|---|---|---|
| `REMOTION_REGION` | `eu-west-2` | Must match the region the function **and** site were deployed to. `npx remotion lambda regions` lists the supported set. |
| `REMOTION_LAMBDA_FUNCTION_NAME` | printed by `remotion:deploy-fn` | Same value in both contexts. Changes on every Remotion version upgrade — see [Upgrading Remotion](#upgrading-remotion). |
| `REMOTION_SERVE_URL` | printed by the deploy-site script | **Differs per context** — the `-staging` URL on staging, the `-prod` URL on production. Getting these crossed is the one way to make a staging composition render production posts. |
| `REMOTION_AWS_ACCESS_KEY_ID` | the IAM user's key | |
| `REMOTION_AWS_SECRET_ACCESS_KEY` | the IAM user's secret | |

> **Why the `REMOTION_`-prefixed names, and why they are not optional.** Netlify Functions run on AWS
> Lambda, so the runtime already injects `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` for Netlify's
> *own* execution role. Remotion's credential resolver falls back to those (precedence:
> `REMOTION_AWS_PROFILE` → `REMOTION_AWS_*` keys → `AWS_PROFILE` → `AWS_*` keys), so without the
> prefixed pair it would happily authenticate as Netlify and fail deep inside the render with an
> opaque permissions error instead of a clean "not configured". `remotionConfigured()` demands the
> prefixed names explicitly for exactly this reason — do not "simplify" it to the bare `AWS_*` names.

R2 must also be configured (`R2_*`), because the worker copies the render output into our own storage.
`trigger-post-render` refuses with the same 503 when it is not.

## Procedure

### 0. First-time-only: secure the new AWS account

Do these once, before anything else. None of them are Remotion-specific — they are what stops a
compromised key becoming an unbounded bill on an account that now runs compute.

1. **Enable MFA on the root user** and then stop using it. Root exists to create the first admin and
   to close the account.
2. **Never create root access keys.** If the account already has any, delete them.
3. **Set a billing alarm.** Billing → *Budgets* → a monthly cost budget with an email alert (£20 is a
   sensible tripwire; real usage should be pennies). A runaway render loop is the failure this catches.
4. Confirm the console's region selector reads **Europe (London) eu-west-2** before clicking through
   any of the steps below — a resource created in the wrong region is invisible to the CLI and the
   commonest cause of "it deployed but nothing works".

### 1. Create the IAM role, then the IAM user

The CLI prints the exact JSON for both policies. Read them from the CLI rather than copying a snapshot
out of this file — they change between Remotion versions:

```bash
npx remotion lambda policies role
```

```bash
npx remotion lambda policies user
```

**The role first.** IAM → Roles → *Create role* → trusted entity **AWS service → Lambda**. Attach a
new policy built from the `policies role` JSON. The role **must** be named exactly
`remotion-lambda-role` — the deployed function assumes it by that name, and nothing creates it for
you. This is the step most likely to be skipped, and it fails later rather than at creation time.

**Then the user.** IAM → Users → *Create user*, no console access. Attach a new policy built from the
`policies user` JSON, then create an access key of type *Application running outside AWS*.

Both policies are already scoped to `remotion-render-*` functions and `remotionlambda-*` buckets — do
not widen them.

### 1b. Put the credentials in a local AWS profile

Keep the secret out of shell history and out of the repo. Add to `~/.aws/credentials`:

```ini
[bemoreswan-remotion]
aws_access_key_id = AKIA…
aws_secret_access_key = …
```

Then every command below can use the profile, which Remotion resolves at the *highest* precedence:

```bash
export REMOTION_AWS_PROFILE=bemoreswan-remotion
export REMOTION_REGION=eu-west-2
```

The raw key and secret are still needed later for Netlify (step 4) — Netlify has no profile support.

### 2. Deploy the render function

```bash
npm run remotion:deploy-fn
```

This is the first command that actually calls AWS, so it doubles as the credential check — a missing
permission fails here with the action named.

Defaults are 2048 MB memory, 2048 MB ephemeral disk, a 120 s per-chunk timeout, and 14-day CloudWatch
retention. Those are fine for social clips (seconds to ~2 minutes). Raise memory/disk only if renders
start failing on long or high-resolution sources; `src/lib/post-render.ts` caps an accepted clip at
`MAX_RENDER_SECONDS` (10 minutes) and 4096 px per side.

Note the printed function name → `REMOTION_LAMBDA_FUNCTION_NAME`.

Then check the account's Lambda concurrency, which is low by default on a **new** AWS account and is
what a render silently queues behind:

```bash
npx remotion lambda quotas
```

The user policy includes `servicequotas:RequestServiceQuotaIncrease` so an increase can be requested
from the CLI if the limit turns out to be tight. One post's render is fine at any limit; a batch
approval of several video posts is what would feel it.

### 3. Deploy the two sites

```bash
npm run remotion:deploy-site-staging
```

```bash
npm run remotion:deploy-site-prod
```

Each bundles `remotion/index.ts` and uploads it under its own site name. Note **both** printed
**Serve URLs** — the `-staging` one goes on the staging context, the `-prod` one on production.

Confirm the bundle exposes the composition the gateway asks for (`PostOverlay`):

```bash
npx remotion lambda compositions "<the serve URL>"
```

### 4. Set the Netlify env vars and redeploy

Set all five vars on **staging only** first — with the `-staging` serve URL — then trigger a deploy so
the functions pick them up (Netlify bakes env into the function bundle at deploy time; changing a var
alone is not enough). Staging is a branch deploy, so make sure the values are scoped to a context that
covers branch deploys, not just production.

Leave production unset until step 5 passes. An unset production is a *working* production here — video
posts with text simply refuse approval with the 503, which is a far better place to be than half-configured.

### 5. Verify — with a real post, not a synthetic render

The only verification that proves the whole path is an actual approval:

1. In the Review Queue, open a **video** post, add two text boxes, and time them to different,
   non-overlapping windows on the timeline.
2. Approve it. The approval should return immediately — the render is asynchronous.
3. `post_render_jobs` should show the row move `queued → rendering → completed`, with `render_id`,
   `bucket_name`, and `region` filled in, and `output_asset_id` set at the end.
4. `scheduled_posts.render_status` should end at `'done'`. **If it stops at `pending` or `rendering`,
   stop and read the troubleshooting section** — a post in a non-terminal state is invisible to all
   three publishers and will never go out.
5. Play the attached asset and confirm each box appears only inside its own window, at the position
   and size it had on the canvas.

Step 5 is also the **font check** — see the known gap below. Do it with an overlay in Impact or
Georgia, not the Arial default.

### 6. Repeat step 4 for production

Same five vars, with the `-prod` serve URL, then deploy `main` and run step 5 once against a real
production post.

## Redeploying after a code change

Re-run the deploy-site script **for the environment you are shipping to** whenever any of these
change, and update that context's `REMOTION_SERVE_URL` if the command prints a new one:

- `remotion/PostOverlay.tsx`, `remotion/Root.tsx`, `remotion/index.ts`
- `src/lib/overlay-geometry.ts` — the shared geometry, imported by the composition
- anything else reachable from those imports

Nothing in CI does this. A geometry change shipped to staging without a site redeploy produces the
worst possible failure mode: the browser preview moves, the render does not, and the WYSIWYG contract
the whole feature rests on is quietly broken. `tests/overlay-geometry.test.ts` guards the
editor-vs-module drift but cannot see a stale S3 bundle.

Because the two sites are separate, a promote to production is **two** actions, not one: merge to
`main` *and* run `remotion:deploy-site-prod`. Merging alone leaves production rendering the last
bundle anyone pushed to it.

The **function** only needs redeploying on a Remotion version upgrade, not on our code changes.

## Upgrading Remotion

`remotion-render-*` function names embed the Remotion version, so an upgrade produces a *new*
function and leaves the old one running. Sequence, staging first and production only once staging
verifies: `npm run remotion:deploy-fn` → the matching `remotion:deploy-site-*` (bundles must match the
function version) → update `REMOTION_LAMBDA_FUNCTION_NAME` and that context's `REMOTION_SERVE_URL` →
redeploy Netlify → verify → then delete the old function (`npx remotion lambda functions ls` / `rm`)
once **both** contexts are off it. Renders in flight during the swap keep using whichever function
they started on.

## Known gaps and decisions

### Fonts — the one place render and preview can still diverge

The overlay editor offers Arial, Helvetica, Verdana, Trebuchet MS, Georgia, Times New Roman,
Courier New, Impact, and Comic Sans MS (`src/components/image-overlay-editor.js`). Every one of
those is a Microsoft core or Apple system font. The Lambda container is Amazon Linux and does not
carry them; a missing face is **silently substituted**, not errored. Local renders on a Mac look
correct precisely because macOS has the real fonts — they prove the geometry, not the typeface.

Because overlay geometry is fraction-based but the *box* is sized by the rendered text, a substituted
face with different metrics shifts the box, not just the letterforms.

Recommended fix (a code change, not a deploy step): back each entry in the editor's list with an
embedded open font loaded in **both** the browser editor and the Remotion bundle, preferring
metric-compatible substitutes (Arimo for Arial/Helvetica, Tinos for Times New Roman, Cousine for
Courier New, Gelasio for Georgia) so widths are identical, and accepting a visual match for the rest
(Anton for Impact, Comic Neue for Comic Sans MS). Until that lands, treat step 5's font check as
mandatory on first deploy and narrow the editor's list if the substitution is unacceptable.

### Render output privacy

`startRender` uses `privacy: 'public'` because the worker copies the output with a plain `fetch()`.
The URL is unguessable (a random render id) and `deleteAfter: '1-day'` puts an S3 lifecycle rule on
the object, while the worker copies it into R2 within minutes. If a stricter posture is ever required,
the change is to make `persistRemoteMediaToR2` sign the request and switch to `privacy: 'private'`.

### zod version warning

Every Remotion CLI invocation prints a version mismatch (root `zod@4.4.3` vs the required `4.3.6`).
It is inert here: it is raised against `@remotion/zod-types`, which is only loaded when a composition
declares a `schema`, and `PostOverlay` declares none. **If a future composition adds a `schema` prop,
pin zod to Remotion's version first** (`npx remotion add zod`) and re-check whatever else in the tree
depends on it.

### Cost

Billed per render (Lambda GB-seconds + S3). A short social clip is fractions of a cent, but the
pipeline renders on *every* approval of a video post with text, including re-approvals. There is no
per-org cap on renders today — if that becomes a concern, the gate belongs in `trigger-post-render`
alongside the existing configuration checks.

## Troubleshooting

**A post is stuck at `render_status = 'pending'`.** The worker was never reached. `trigger-post-render`
awaits its dispatch and un-gates the post on failure, so this means the worker started and died before
claiming. Check the function log for `[render-post-video-background]`, then clear the gate manually
(`UPDATE scheduled_posts SET render_status = NULL WHERE id = …`) so the post can publish or be retried.

**Stuck at `'rendering'`.** The job was claimed but never reached a terminal state — a timeout past the
15-minute background ceiling, or a crash between claiming and the error handler. `post_render_jobs`
carries `render_id`, `bucket_name`, and `region`: the `renders/<render_id>/` prefix in that S3 bucket
holds `progress.json` (what AWS thinks the state is) and `out.mp4` once encoding finished, and the
function's CloudWatch log group is `/aws/lambda/remotion-render-*`. Same manual clear applies.

**`render_status = 'failed'`.** Intentional and terminal — the post stays out of the publish queue.
`post_render_jobs.error_message` carries the reason. Fix the cause, then re-approve.

**Permissions errors mentioning an unfamiliar role.** Almost always the `REMOTION_AWS_*` vars are
missing on that Netlify context and Remotion fell through to Netlify's own execution-role credentials.
See the note under [Environment variables](#environment-variables).

**Renders succeed but the text is wrong/shifted.** Stale site bundle or a font substitution — in that
order of likelihood. Re-run this context's `remotion:deploy-site-*` first.

## Rollback

Unset `REMOTION_LAMBDA_FUNCTION_NAME` (or any of the five vars) and redeploy. `remotionConfigured()`
goes false, `trigger-post-render` returns 503, and video posts with text refuse approval instead of
being gated. **Nothing already gated clears itself** — before rolling back, drain the queue: any post
sitting at `pending`/`rendering` must be cleared to `NULL` or `'done'` by hand, or it stays unpublishable.
Photo overlays and every other publish path are unaffected; they never touch this pipeline.
