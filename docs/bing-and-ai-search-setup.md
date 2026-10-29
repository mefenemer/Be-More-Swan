# Bing and AI search setup

Why this matters: Microsoft Copilot answers from Bing, and ChatGPT's web search leans heavily on Bing too. A site Bing hasn't indexed is mostly invisible to both, however good its pages are. Google Search Console doesn't cover any of this.

What's already in the code (since 2026-10-29):

- **Readable pages.** Prices, assistant pages, the assistant library, help articles and the FAQ are all written into the HTML at build time (`scripts/build-seo-html.mjs`), so crawlers that don't run JavaScript can read them.
- **`/llms.txt`.** A plain summary for AI tools. The introduction is hand-written in `llms.txt`; the assistants, prices and help articles are filled in at each build.
- **Sitemap.** `/sitemap.xml` now includes one page per live assistant (`/ai-…`).
- **IndexNow.** The key file is `/<key>.txt` at the repo root. After every production deploy goes live, the build plugin `netlify/plugins/indexnow` runs `scripts/indexnow-ping.mjs`. It first reads the key back from the live site, then sends the sitemap's URLs to IndexNow, which shares them with Bing (and Yandex, Seznam, Naver). Staging and preview deploys skip it. The result is a `[indexnow]` line near the end of the Netlify deploy log.

## One-time steps (about 20 minutes, done by the owner)

### 1. Bing Webmaster Tools

1. Go to <https://www.bing.com/webmasters> and sign in with the **same Google account that owns the Search Console property** for bemoreswan.com.
2. Choose **Import from Google Search Console**. This verifies the site and copies the sitemaps in one step, with no DNS or file changes.
   - If the import isn't offered, add `https://bemoreswan.com/` manually and verify with the **HTML meta tag** option. Send me the tag and I'll add it to `index.html`.
3. Under **Sitemaps**, check that both of these are listed, and submit any that are missing:
   - `https://bemoreswan.com/sitemap.xml`
   - `https://bemoreswan.com/b/wgt_a29af16bd7af9af3499cd70c/sitemap.xml` (our own blog)
4. Under **URL Inspection**, check these three and confirm Bing sees real content, not a "Loading…" shell:
   - `https://bemoreswan.com/pricing`: the plan prices should appear
   - `https://bemoreswan.com/ai-social-media-assistant`: the full assistant copy
   - `https://bemoreswan.com/llms.txt`
5. Under **IndexNow**, after the next production deploy, submitted URLs should appear within a day.

   ⚠️ **Never ping before the key file is live.** Bing fetches `/<key>.txt` to check the key. If that check fails, Bing keeps refusing the key with `403 UserForbiddedToAccessSite`, even after the file appears. That happened on 2026-10-29: the ping used to run in the build command, before the deploy was published, and every ping after that was refused. The key was rotated and the ping moved to `onSuccess`. If the deploy log ever shows `[indexnow] ⚠️ REFUSED 403`, rotate the key: replace the `<key>.txt` file (new name and content, 32 hex characters, e.g. `openssl rand -hex 16`) and deploy.

### 2. Automatic rebuild when a plan changes (production site only)

Prices are written into the pages at build time. So that a price change in Admin reaches crawlers in minutes rather than at the next release:

1. Netlify → the **bemoreswan** site → **Site configuration → Build & deploy → Continuous deployment → Build hooks → Add build hook**. Name it `Site rebuild (plan change)` and set the branch to `main`. Netlify shows a URL like `https://api.netlify.com/build_hooks/<24-character id>`. That URL is the value.
2. **Site configuration → Environment variables → Add a variable**: key `SITE_REBUILD_HOOK`, value = that URL. Set **Scopes** to include **Functions**, and under **Deploy contexts** give it a value for **Production only**.
3. **Production only matters.** Staging is a branch deploy of this same site, so a variable set for all contexts reaches staging's functions too. Then a plan edit on staging's database would rebuild production for nothing, because the build always reads prices from bemoreswan.com.
4. Treat the URL like a password: anyone who has it can trigger production builds. Don't paste it into chats or commit it. If it leaks, delete the hook and make a new one.

Until this variable is set, everything still works. The baked prices just update at the next normal deploy.

## Checking it's working (monthly)

- **Bing Webmaster Tools → Search Performance**: impressions and clicks from Bing.
- **AI answers**: ask ChatGPT (with search on), Copilot, Gemini and Claude the same fixed set of questions a prospect would ask, such as "best AI marketing assistant for a small UK business" or "AI tool that writes my social media posts for me". Note whether Be More Swan appears and where.
- **Server-side check**: `curl -s https://bemoreswan.com/pricing | grep -c '£'` should be well above zero. If it's zero, the build stopped baking prices.

## When something changes

| Change | What to do |
|---|---|
| A new assistant goes live | Nothing for the page itself: the next deploy generates it. Add the role to `ASSISTANT_PAGE_SLUGS` in `scripts/seo/ai-readability.mjs` to pin its URL. The build warns until you do. |
| An assistant is renamed | Nothing. Its URL is pinned to the role, not the name. |
| The `llms.txt` introduction is out of date | Edit the text above the `BUILD:LLMS-GENERATED` marker in `llms.txt`. |
| You want to change the IndexNow key | Replace the `<key>.txt` file at the repo root (the file name and its contents must both be the new key). Nothing else refers to it. |
