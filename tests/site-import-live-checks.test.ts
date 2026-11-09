// tests/site-import-live-checks.test.ts
// Fixes from running the real import against eight live sites (2026-11-09):
//   · webflow.com sends 17.6 KB of headers — over Node's 16 KB default, so every page "couldn't be reached";
//   · Shopify throttled a burst of reads (429) — now tried again after a pause;
//   · pale main colours (Squarespace #fed9db, a Webflow site's #8dd9e7) and WordPress's default button grey;
//   · YouTube videos, playlists and Facebook groups came through as social profiles; ?ref= kept; twitter/x twice;
//   · a form's machine field name listed as a question;
//   · a 17-page site's plan failed in one request, so every page fell back to plain text — now in batches.
//
// Run:  npx tsx tests/site-import-live-checks.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SafeFetchError } from '../src/utils/safe-fetch';
import { _withRetryForTests } from '../src/utils/site-fetch';
import { readImportedLook, readsOn } from '../src/utils/site-import-theme';
import { readImportPage, socialProfile } from '../src/utils/site-extract';
import { ADAPTERS } from '../src/utils/site-builders';
import { numberBlocks, planInBatches, PLAN_BATCH_PAGES, runImport, withOwnLook, type ReadPage } from '../src/utils/site-import';
import { findBlogIndex } from '../src/utils/site-import-blog';
import { starterSite, themeFromBrandKit } from '../src/utils/site-draft';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

async function main() {
    console.log('Fetching');

    await check('pages with very large headers can be read (maxHeaderSize 64 KB)', () => {
        assert.ok(read('src/utils/safe-fetch.ts').includes('maxHeaderSize: 64 * 1024'));
    });

    await check('"429 Too Many Requests" and 503 are tried again after a pause; other errors are not', async () => {
        let calls = 0;
        const busy = () => new SafeFetchError('That link returned an error (429).', 'http_error' as never);
        const r = await _withRetryForTests(async () => { calls++; if (calls < 3) throw busy(); return 'ok'; }, [1, 1]);
        assert.deepStrictEqual([r, calls], ['ok', 3]);
        calls = 0;
        await assert.rejects(_withRetryForTests(async () => { calls++; throw busy(); }, [1, 1]));
        assert.strictEqual(calls, 3, 'twice more, then it gives up');
        calls = 0;
        await assert.rejects(_withRetryForTests(async () => { calls++; throw new SafeFetchError('That link returned an error (404).', 'http_error' as never); }, [1, 1]));
        assert.strictEqual(calls, 1, 'a 404 is not tried again');
    });

    console.log('\nThe look');

    await check('a main colour must read on the page: a pale first pick gives way to the next that does', () => {
        assert.ok(!readsOn('#fed9db', '#ffffff') && readsOn('#1d5b5a', '#ffffff'));
        const html = '<html><head><meta name="theme-color" content="#fed9db"><style>.btn{background:#7a2e8f}a{color:#7a2e8f}.x{color:#7a2e8f}</style></head><body><main><h1>Hi</h1></main></body></html>';
        assert.strictEqual(readImportedLook(html, 'https://x.example/').primaryColor, '#7a2e8f');
        const shared = readImportedLook('<html><body></body></html>', 'https://x.example/');
        assert.strictEqual(withOwnLook({ ...shared, primaryColor: '#7a2e8f', backgroundColor: '#ffffff' }, { primaryColor: '#f5f5f5' }).primaryColor, '#7a2e8f', 'an adapter\'s pale colour is refused too');
    });

    await check('WordPress\'s default button grey (#32373c) is never the owner\'s colour', () => {
        const wp = ADAPTERS.find((a) => a.key === 'wordpress')!;
        const out = wp.lookCss!({ html: '<style>.wp-block-button__link{background-color:#32373c}</style>', css: '.wp-element-button{background:#32373C}.x{color:#b5462b}' });
        assert.ok(!/32373c/i.test(out.html + out.css) && out.css.includes('#b5462b'));
        const own = wp.look!({ html: '<style>:root{--wp--preset--color--contrast:#32373c;--wp--preset--color--accent:#b5462b}</style>', css: '', $: null as never, url: null });
        assert.notStrictEqual(own?.primaryColor, '#32373c', 'nor through the theme reader');
        const core = wp.lookCss!({ html: '<style>:root{--wp--preset--color--vivid-cyan-blue:#0693e3;--wp--preset--color--accent:#b5462b}</style>', css: '' });
        assert.ok(!core.html.includes('#0693e3') && core.html.includes('#b5462b'), 'WordPress\'s built-in palette is not theirs; their own preset stays');
    });

    console.log('\nSocial links and forms');

    await check('only profiles: no videos, playlists, groups, posts or share links; no tracking; https', () => {
        assert.strictEqual(socialProfile('https://www.youtube.com/watch?v=jXb512M_WSY'), null);
        assert.strictEqual(socialProfile('https://www.youtube.com/playlist?list=PL1'), null);
        assert.strictEqual(socialProfile('https://www.facebook.com/groups/wpastra/'), null);
        assert.strictEqual(socialProfile('https://x.com/ghost/status/123'), null);
        assert.strictEqual(socialProfile('https://www.instagram.com/p/abc/'), null);
        assert.strictEqual(socialProfile('https://twitter.com/ghost?ref=demo.ghost.io'), 'https://twitter.com/ghost');
        assert.strictEqual(socialProfile('http://www.linkedin.com/company/acme'), 'https://www.linkedin.com/company/acme');
        assert.strictEqual(socialProfile('https://www.facebook.com/profile.php?id=615644&ref=x'), 'https://www.facebook.com/profile.php?id=615644');
    });

    await check('the same account on twitter.com and x.com (or with and without www) is listed once', () => {
        const p = readImportPage(`<html><body><main><h1>Hi</h1><p>Words here.</p></main><footer>
<a href="https://x.com/ghost">X</a><a href="https://twitter.com/ghost?ref=demo">Twitter</a><a href="https://www.instagram.com/ghost/">IG</a><a href="https://instagram.com/ghost">IG2</a>
<a href="https://www.youtube.com/watch?v=1">Video</a><a href="https://www.facebook.com/groups/2273">Group</a></footer></body></html>`, 'https://x.example/');
        assert.deepStrictEqual(p.socialLinks, ['https://x.com/ghost', 'https://www.instagram.com/ghost/']);
    });

    await check('a form\'s machine field names are not listed as questions', () => {
        const p = readImportPage(`<html><body><main><h1>Contact</h1><form>
<input name="first-name" placeholder="First Name"><select id="srfm-dropdown-1-18390f9c-lbl-U2VsZWN0IFRvcGlj-select-topic" name="srfm-dropdown-1-18390f9c-lbl-U2VsZWN0IFRvcGlj-select-topic"></select>
<textarea name="msg" placeholder="Type your message"></textarea></form></main></body></html>`, 'https://x.example/contact');
        assert.deepStrictEqual(p.formFields, ['First Name', 'Type your message']);
    });

    console.log('\nLarge sites');

    const bigSite = (n: number): ReadPage[] => Array.from({ length: n }, (_, i) => ({
        url: `https://big.example/${i ? `p${i}` : ''}`, menuLabel: `Page ${i}`,
        page: readImportPage(`<html><body><main><h1>Page ${i}</h1>${Array.from({ length: 30 }, (_, k) => `<p>Paragraph ${k} of page ${i} with enough words.</p>`).join('')}</main></body></html>`, `https://big.example/${i ? `p${i}` : ''}`),
    }));

    await check('a large site is planned in batches that keep page and block numbers; the plans join up', async () => {
        const pages = bigSite(17);
        const { blocks } = numberBlocks(pages);
        const asked: number[][] = [];
        const plan = await planInBatches(pages, blocks, { siteName: 'Big', pictures: 'skip', allowed: () => true }, {
            async plan(prompt) {
                const nums = [...prompt.user.matchAll(/<page number="(\d+)"/g)].map((m) => Number(m[1]));
                asked.push(nums);
                return { pages: nums.map((page) => ({ page, sections: [{ type: 'text', heading: blocks.find((b) => b.page === page - 1)!.n, body: [] }] })), skip: [] };
            },
        });
        assert.ok(asked.length > 1, `more than one request (${asked.length})`);
        assert.ok(asked.every((b) => b.length <= PLAN_BATCH_PAGES));
        assert.deepStrictEqual(asked.flat(), Array.from({ length: 17 }, (_, i) => i + 1), 'every page once, numbers kept');
        assert.strictEqual(plan!.pages.length, 17);
    });

    await check('a batch that fails leaves only its own pages unplanned; a small site is still one request', async () => {
        const pages = bigSite(17);
        const { blocks } = numberBlocks(pages);
        let n = 0;
        const plan = await planInBatches(pages, blocks, { siteName: 'Big', pictures: 'skip', allowed: () => true }, {
            async plan(prompt) {
                n++;
                if (n === 2) throw new Error('model timed out');
                const nums = [...prompt.user.matchAll(/<page number="(\d+)"/g)].map((m) => Number(m[1]));
                return { pages: nums.map((page) => ({ page, sections: [] })), skip: [] };
            },
        });
        assert.ok(plan && plan.pages.length > 0 && plan.pages.length < 17);
        let calls = 0;
        const small = bigSite(3);
        await planInBatches(small, numberBlocks(small).blocks, { siteName: 'S', pictures: 'skip', allowed: () => true }, { async plan() { calls++; return null; } });
        assert.strictEqual(calls, 1);
    });

    console.log('\nWix blogs');

    await check('a blog page whose list is drawn by script still counts when its address and feed say so (incl. /blog-1)', () => {
        const page = '<html><head><meta name="generator" content="Wix.com Website Builder"><link rel="alternate" href="https://w.example/blog-feed.xml" type="application/rss+xml" title="W - RSS"></head><body><main><p>Loading…</p></main></body></html>';
        assert.strictEqual(findBlogIndex(page, 'https://w.example/blog', [])?.feedUrl, 'https://w.example/blog-feed.xml');
        assert.ok(findBlogIndex(page, 'https://w.example/blog-1', []), '/blog-1 is a blog address too');
        assert.strictEqual(findBlogIndex(page, 'https://w.example/about', []), null, 'a feed alone does not make any page the blog');
    });

    await check('a Wix site whose menu has no usable blog page still brings its posts, from /blog-feed.xml', async () => {
        const home = `<!doctype html><html><head><meta name="generator" content="Wix.com Website Builder"></head><body><header><nav><a href="https://w.example/">Home</a><a href="https://w.example/blog-1">Blog</a></nav></header><main><h1>Wellness</h1><p>${'Coaching for nurses who want to grow and thrive in their careers. '.repeat(15)}</p></main><img src="https://static.wixstatic.com/media/a.jpg" width="1" height="1"></body></html>`;
        const post = (t: string) => `<!doctype html><html><head><meta name="generator" content="Wix.com Website Builder"><meta property="og:title" content="${t}"></head><body><main><article><h1>${t}</h1><p>${'The words of the post, written by the owner. '.repeat(20)}</p></article></main></body></html>`;
        const feed = '<?xml version="1.0"?><rss version="2.0"><channel><title>W</title><item><title>First post</title><link>https://w.example/post/first-post</link><pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>';
        const site: Record<string, string> = { 'https://w.example/': home, 'https://w.example/blog-1': '<html><head><meta name="generator" content="Wix.com Website Builder"></head><body><main></main></body></html>', 'https://w.example/blog-feed.xml': feed, 'https://w.example/post/first-post': post('First post') };
        const r = await runImport({ url: 'https://w.example/', pictures: 'skip', current: starterSite({ name: 'W', industry: null, description: null, audience: null, websiteUrl: null, email: 'o@a.example' }, themeFromBrandKit(null)), maxPages: 5 }, {
            async fetchHtml(u) { const h = site[u]; return h ? { ok: true, html: h, finalUrl: u } : { ok: false, message: 'That link returned an error (404).' }; },
            async plan() { return null; }, async savePicture() { return null; },
        });
        assert.ok(r.ok, !r.ok ? r.message : '');
        assert.strictEqual(r.ok && r.report.platform, 'wix');
        assert.deepStrictEqual(r.ok && r.report.blog?.posts.map((p) => p.title), ['First post']);
    });

    console.log('\nHelp Centre and the public connections page');

    await check('two Help Centre articles: bringing your site across, and designing it (dated file, house rules)', () => {
        const sql = read('db/help-articles-website-import-design-2026-11-09.sql');
        for (const t of ['Bringing Your Current Website Across', 'Designing Your Website']) assert.ok(sql.includes(`'${t}'`), t);
        for (const body of sql.match(/\$\$[\s\S]*?\$\$/g) ?? []) assert.ok(!body.includes(';'), 'no semicolons inside a body');
        assert.ok(sql.includes('ON CONFLICT (title) DO NOTHING'));
        for (const label of ['Read my site', 'Preview the imported site', 'Add ticked products to Business Information', 'Tint for alternate sections', 'Old addresses that forward here']) {
            assert.ok(read('src/components/assistant-site-editor.js').includes(label), `the app says "${label}"`);
        }
    });

    await check('/connections lists bringing your current website across as Live, and its count follows', () => {
        const html = read('connections.html');
        const at = html.indexOf('<section id="website"');
        const section = html.slice(at, html.indexOf('</section>', at));
        assert.ok(section.includes('<h4>Your current website</h4><span class="cx-pill cx-live">Live</span>'));
        assert.strictEqual((section.match(/data-live="1"/g) ?? []).length, 2);
        assert.ok(section.includes('<span class="cx-count">2 live</span>'));
    });

    console.log(`\n${passed}/${total} passed`);
}
void main();
