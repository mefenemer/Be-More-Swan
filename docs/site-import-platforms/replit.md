# Replit

Adapter: `src/utils/site-builders/replit.ts` · Test: `tests/site-platform-replit.test.ts` ·
Fixtures (synthetic, modelled on Replit Agent's templates): `tests/fixtures/site-platforms/replit/`

## How sites on Replit are built

- **Replit Agent's usual output is a React + Vite single-page app served by Express** (shadcn/ui,
  Tailwind, wouter routes). `client/index.html` is an empty `<div id="root">` plus the hashed
  `/assets/index-*.js` and `.css`. Express answers **every path with the same shell**, so a plain fetch
  of any page finds 0 words; the words only exist after the browser runs the app. Our headless
  browser (`site-js-render.ts`) is what reads these sites.
- Agent leaves `<script src="https://replit.com/public/js/replit-dev-banner.js">` in `index.html`, and
  Vite keeps it in the production build, so it is on published apps too. The script only draws its
  banner on `*.replit.dev` development previews ("This is a temporary development preview…").
- **Flask apps** (the other common Agent template) are drawn on the server with Bootstrap from
  `https://cdn.replit.com/agent/bootstrap-agent-dark-theme.min.css` — readable without a browser.
- Next.js and other stacks also run on Replit, with no Replit fingerprint except the host.
- The menu is a bare `<nav>` at the top of `#root` holding the logo, usually with **no `<header>`**.
  Pages are often one long page whose menu items are `<button>`s that scroll (no `href`).
- Pictures: many Agent sites use Unsplash photos asked for at card size (`w=600–800&fit=crop`);
  the owner's own uploads are hashed files under `/assets/` (from `attached_assets/`).
- Colours live in shadcn CSS variables as **bare HSL numbers**: `--primary: 152 58% 30%`, used as
  `hsl(var(--primary))`.
- A page that matches no route shows the template's card: "404 Page Not Found / Did you forget to
  add the page to the router?" — still with HTTP 200, since Express serves the shell for everything.
- Hosting: published apps live on `<name>.replit.app` (or a custom domain); Autoscale deployments
  scale to zero when idle and start again on the next request (a slower first answer, not a
  different page); Reserved VMs never sleep. Development previews are `*.replit.dev` and only work
  while the owner's workspace is running. The old `*.repl.co` hosting is retired (no longer resolves).
- What Replit serves instead of an app (seen 2026-11-08 with `curl`):
  - unknown / unpublished `*.replit.app` → **HTTP 404**, "This app isn't live yet … publish your app";
  - stopped `*.replit.dev` preview → **HTTP 404**, "This project isn't available right now", with
    `X-Robots-Tag: none`;
  - **private** app ("Workspace only" / "Invite only") → Replit's sign-in screen; **password protected**
    → Replit's password screen. Neither was observed directly (no private app to hand); the docs only
    say visitors "are prompted to sign in through Replit". Modelled as a page on `replit.com` or a
    page with `og:site_name` "Replit".

## Already covered

Before this pass, with the generic reading (fixtures, no network, no model):
- Shell → too few words → headless browser → rendered page read: headings, text, cards, quote,
  buttons, Unsplash background and `<img>` pictures, menu (`/`, `/services`, `/about`, `/contact`),
  phone, email, form questions; the price (£45) is kept out and listed in the report.
- Flask template read in full without a browser.
- A 404 from Replit (not live / stopped preview) stops the import with "We couldn't read …: That link
  returned an error (404)." Nothing is charged.

What was lost or wrong:
- **The logo** was never found (it sits in `<nav>`, not `<header>`).
- **A menu link to an unbuilt page imported the template's 404 card as a page** ("404 Page Not Found").
- **Replit's own pages would become the draft** when served with 200: a private app's sign-in
  screen read as ~60 words of "Log in … New to Replit? Create an account" — over the 40-word bar.
- On a page without `<main>`, the old "Built with Replit" badge (`<img id="replitBadge"
  src="https://replit.com/badge?…">`, no file extension) would be copied as a picture, and on a
  `replit.dev` preview the dev banner's sentence would be read as their words.
- Unsplash pictures came across at 600–800 px wide.
- Colours: none read (bare HSL variables) — still open, shared code (below).
- Detection matched any page containing "replit.com", e.g. a hand-made portfolio linking to a repl.

## Fixed in this pass

| Fix | Test |
| --- | --- |
| `detect` uses Replit's fingerprints only: dev banner script, `cdn.replit.com/agent/`, the badge, `/__replco/` interstitial assets, `data-replit-metadata` (dev build), `@replit/vite-plugin`, `/__repl?` links, a canonical/og:url on `replit.app`/`replit.dev`/`repl.co`, `og:site_name` Replit. A link to replit.com in prose no longer counts. | "a canonical address on replit.app is enough…" |
| Replit's own pages (on `replit.com`, `og:site_name` Replit, or `/__replco/` with no app root) read as **empty**, title and description too — so the import refuses with "We could only read a little of your site (0 words)… Nothing was charged." instead of drafting Replit's sign-in words. | "Replit's own pages…", "a private or unpublished app…" |
| The template's 404 card reads as empty, so that menu page is reported "We couldn't read any words on this page" and not drafted. | "a menu link to a page the app never built…", "shell → browser → draft…" |
| The dev-preview banner, the badge (`#replitBadge`, `a[href^="/__repl"]`) and the shadcn toast region are removed. | "a page with no `<main>`…" |
| A top `<nav>` holding a picture, with no `<header>` on the page, is wrapped in `<header>` so the logo is found. | "the rendered home page…" |
| Unsplash pictures asked for at 1600 wide, height scaled to keep the crop. | "Agent's Unsplash pictures…" |
| `noise`: "Made/Built with Replit", "Open in Replit", the banner sentence. `rendersWithJs: true`. | — |

## What the owner sees when the app sleeps or is private

- **Autoscale app asleep**: it wakes on our request; the first answer is slower but is the real app.
  If it takes longer than our page timeout the owner sees "We couldn't reach that page just now." —
  trying again a minute later works (it is awake then).
- **Unpublished / deleted app, or a stopped `replit.dev` preview**: "We couldn't read
  https://….replit.app/: That link returned an error (404)." Correct but unhelpful (see Can be done).
- **Private or password-protected app**: if Replit answers with an error status, the same error
  message; if it answers 200 with its sign-in/password page (directly or after a redirect to
  replit.com), the adapter blanks it and the owner sees the thin-site message ("…draws its words with
  JavaScript…") — no draft, nothing charged, but the reason given is wrong.
- **Development preview link while the workspace is running** (`*.replit.dev`): imports normally,
  without the banner. The owner should publish and import from the `replit.app` address instead.

## Can be done (not done yet)

1. **Say why a Replit page couldn't be read** (S; `site-builders/types.ts`, `site-extract.ts`,
   `site-import.ts`). Add to `BuilderAdapter`:
   ```ts
   /** When this page is the platform's own (sign-in, not published, stopped): what to tell the owner. */
   gate?($: cheerio.CheerioAPI, url: URL | null): string | null;
   ```
   In `readImportPage`, before `prepare`: `const gated = (() => { try { return adapter?.gate?.($, base) ?? null; } catch { return null; } })();`
   and return it as `ImportPage.gated?: string | null`. In `runImport`, when `homePage.gated`, return
   `{ ok: false, message: homePage.gated, report: baseReport() }` before the thin check. Replit would
   return: "Your Replit app is private, so we can't see it. Set its sharing to Public in Replit's
   Publishing tool (or import while it's public), then try again. Nothing was charged." and for the
   not-live page: "Your Replit app isn't published yet. Publish it in Replit, then import from its
   .replit.app address. Nothing was charged." (`isReplitsOwnPage` in replit.ts already tells them apart
   with one more title test.)
2. **Read the 404 page's words before failing** (S; `safe-fetch.ts`/`site-fetch.ts`): return the body
   with the status so a platform's 404 explanation ("This app isn't live yet") reaches `gate` above.
3. **Pass the page's address to `detect`** (S; `types.ts`, `index.ts`, `site-extract.ts`): a Next.js or
   Express app on `*.replit.app` with no fingerprint is detected only by its host today.
   `detect(html, gen, $, url?: URL | null)` and `adapterFor(html, $, url)`.
4. **Retry once on a slow first answer** (S; `site-import-store.ts`): Autoscale cold starts. On a
   timeout for the home page, wait ~5 s and fetch once more.
5. **Colours from shadcn/ui variables** (S; `brand-extract.ts` `parseColour`) — helps Replit, Lovable,
   Bolt, v0 and every shadcn site. Accept `hsl()`/`hsla()` and bare `H S% L%` triplets:
   ```ts
   const hsl = /^(?:hsla?\(\s*)?(\d+(?:\.\d+)?)(?:deg)?[\s,]+(\d+(?:\.\d+)?)%[\s,]+(\d+(?:\.\d+)?)%\s*(?:[,/]\s*([\d.]+%?)\s*)?\)?$/.exec(v);
   if (hsl) {
       if (hsl[4] !== undefined && parseFloat(hsl[4]) / (hsl[4].endsWith('%') ? 100 : 1) < 0.5) return null;
       const [h, s, l] = [Number(hsl[1]) % 360, Number(hsl[2]) / 100, Number(hsl[3]) / 100];
       const k = (n: number) => (n + h / 30) % 12;
       const f = (n: number) => l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
       return `#${[f(0), f(8), f(4)].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;
   }
   ```
   and in step 1 of `harvestBrandSignals`, stop at the first `:root` block for `--primary` (the `.dark`
   block repeats it lighter). The test "shadcn/ui colours are bare HSL numbers" then expects about
   `#20794f` instead of null. Also read `--background` / `--foreground` as background and text.
6. **Brand link is not a menu entry** (S; `site-extract.ts` menu loop): a link to `/` that holds the
   logo picture (Agent's `<a href="/"><img…><span>Fernhollow</span></a>`, Bootstrap's `.navbar-brand`)
   makes the home page's menu word the business name and hides the real "Home" entry. Skip a nav link
   to the home path when it contains an `<img>` or has class `*brand*`/`*logo*`.
7. **Scroll buttons as menu entries** (M; `site-import.ts`): one-page Agent sites use
   `<button>Services</button>` to scroll to `#services`. Today those become buttons with no link.
   Reading `id`s on sections and pairing them with button words would rebuild the menu as anchors.

## Can't be done

- **Private and password-protected apps**: the content is behind Replit's sign-in by the owner's
  choice; we never sign in or enter passwords for them. The owner makes the app public for the import.
- **Development previews while the workspace is stopped**: there is nothing to read until the owner
  opens their workspace; we can't start it.
- **Words the app loads after a click or from its own API at runtime** (tabs, "Load more", a
  booking widget calling `/api/...`): the headless browser reads what the first paint shows.
- **The owner's source** (the repl's `client/src/pages/*.tsx`, `attached_assets/`): reading it would
  need their Replit account (OAuth / GitHub export), outside a "paste your address" import.

## Suggested improvements to our import

- `gate` (Can be done 1) — useful for every hosted builder that answers with its own page: Wix "site
  not published", Squarespace's password page, Webflow's "site not found", Lovable/Bolt private links.
- Move Unsplash resizing into the shared `fullSizeImageUrl` — Lovable, Bolt, v0, Cursor and Claude
  Code sites use it just as much.
- A shared "same-shell SPA" hint: when every menu page's plain HTML is byte-identical to the home
  page's, go straight to the browser for the rest instead of reading each shell first.
- Template 404 text is shared across AI builders (Lovable's "Oops! Page not found"); a shared list of
  starter-template 404 phrases would stop them being imported as pages.

## Detection

Signals (`FINGERPRINT` in replit.ts): `replit-dev-banner` (Agent's React template, present in
production builds), `cdn.replit.com/agent/` (Flask template), `replit-badge` / `replitBadge` /
`href="/__repl?` (old badge), `/__replco/` (Replit's interstitial pages), `data-replit-metadata` and
`@replit/vite-plugin` (an app deployed with the dev server running), `<meta name="generator">`
containing "replit", a canonical or `og:url` on `replit.app` / `replit.dev` / `repl.co`, and
`og:site_name` "Replit".

- False positives removed: a page merely linking to `replit.com` or naming a `.replit.app` address in
  prose (the old `/replit\.(app|dev|com)/` test matched those).
- False negatives: a Replit-hosted app with none of the above (Next.js, custom templates, an owner
  who deleted the banner script) on a custom domain — read by the generic path, which works; on
  `*.replit.app` it would be caught with the host (Can be done 3).
- Order: Lovable, Bolt and v0 are checked first. An app started in Lovable and moved to Replit keeps
  Lovable's markers and is read by the Lovable adapter — fine, the page shape is the same.
