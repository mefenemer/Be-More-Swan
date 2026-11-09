// tests/site-platform-replit.test.ts
// The Website import on sites made with Replit (src/utils/site-builders/replit.ts): Replit Agent's
// React + Vite app (an empty shell until the browser draws it), its Flask app, a development
// preview, and the pages Replit shows instead of an app that is private, unpublished or stopped.
// Synthetic fixtures modelled on Agent's templates: tests/fixtures/site-platforms/replit/.
// No network, no model: fetchHtml returns the shell, renderHtml the rendered page, plan null.
//
// Run:  npx tsx tests/site-platform-replit.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import { adapterFor } from '../src/utils/site-builders';
import { readImportPage } from '../src/utils/site-extract';
import { runImport, type ImportDeps } from '../src/utils/site-import';
import { readImportedLook } from '../src/utils/site-import-theme';
import { starterSite, themeFromBrandKit } from '../src/utils/site-draft';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(__dirname, '..');
const fx = (f: string) => readFileSync(join(root, 'tests/fixtures/site-platforms/replit', f), 'utf8');
const html = (f: string) => fx(`${f}.html`);
const found = (h: string) => adapterFor(h, cheerio.load(h))?.key ?? null;
const APP = 'https://fernhollow.replit.app';
const texts = (p: ReturnType<typeof readImportPage>) => p.blocks.map((b) => ('text' in b ? b.text : `[img] ${b.src}`));
const current = () => starterSite({ name: 'Fernhollow Cycle Workshop', industry: null, description: null, audience: null, websiteUrl: null, email: 'owner@account.example' }, themeFromBrandKit(null));

const ROUTES: Record<string, string> = {
    [`${APP}/`]: 'home-rendered', [`${APP}/services`]: 'services-rendered', [`${APP}/about`]: 'about-notfound-rendered', [`${APP}/contact`]: 'contact-rendered',
};
/** Express serves the same empty shell for every path; the browser draws each route. */
function deps(over: Partial<ImportDeps> = {}): ImportDeps {
    return {
        fetchHtml: async (u) => (ROUTES[u] ? { ok: true, html: html('shell'), finalUrl: u } : { ok: false, message: 'That link returned an error (404).' }),
        renderHtml: async (u) => (ROUTES[u] ? { ok: true, html: html(ROUTES[u]), finalUrl: u } : { ok: false, message: 'not rendered' }),
        plan: async () => null,
        savePicture: async () => null,
        ...over,
    };
}

(async () => {
    console.log('Detection');

    await check('Agent\'s React shell, its rendered pages, the Flask template and a dev preview are Replit', () => {
        for (const f of ['shell', 'home-rendered', 'services-rendered', 'contact-rendered', 'dev-preview-rendered', 'flask-home', 'not-live', 'sign-in']) assert.strictEqual(found(html(f)), 'replit', f);
    });

    await check('a canonical address on replit.app is enough; a plain link to replit.com in someone\'s words is not', () => {
        assert.strictEqual(found('<html><head><link rel="canonical" href="https://fern.replit.app/"></head><body><main><p>Hi</p></main></body></html>'), 'replit');
        assert.strictEqual(found('<html><body><main><p>See my game on <a href="https://replit.com/@me/game">replit.com</a> and fern.replit.app.</p></main></body></html>'), null);
    });

    console.log('\nReading a page');

    await check('the plain read of the shell finds nothing — the headless browser is needed (rendersWithJs)', () => {
        const p = readImportPage(html('shell'), `${APP}/`);
        assert.strictEqual(p.words, 0);
        assert.strictEqual(p.platform, 'replit');
    });

    await check('the rendered home page: their words in order, the logo from the top bar, no badge or toast region', () => {
        const p = readImportPage(html('home-rendered'), `${APP}/`);
        const t = texts(p);
        assert.strictEqual(t.filter((x) => !x.startsWith('[img]'))[0], 'Bikes mended properly, by people who ride');
        assert.ok(t.includes('Book a repair') && t.some((x) => x.startsWith('“They had my commuter bike')));
        assert.ok(!t.some((x) => /replit\.com\/badge|__repl/.test(x)), 'no Replit badge');
        assert.deepStrictEqual(p.logo, { src: `${APP}/assets/fernhollow-logo-1712345678.png`, alt: 'Fernhollow logo' });
        assert.deepStrictEqual(p.navLinks.map((l) => l.href.replace(APP, '')), ['/', '/services', '/about', '/contact']);
    });

    await check('Agent\'s Unsplash pictures are asked for at 1600 wide, keeping the crop\'s shape', () => {
        const imgs = readImportPage(html('home-rendered'), `${APP}/`).blocks.filter((b) => b.kind === 'image').map((b) => (b.kind === 'image' ? new URL(b.src) : null)!);
        assert.strictEqual(imgs.length, 2);
        assert.deepStrictEqual(imgs.map((u) => [u.searchParams.get('w'), u.searchParams.get('h')]), [['1600', '1000'], ['1600', '1067']]);
        assert.ok(imgs.every((u) => u.searchParams.get('fit') === 'crop'));
    });

    await check('a page with no <main>: the badge and dev-preview banner are still not read as content', () => {
        const page = html('dev-preview-rendered').replace(/<\/?main[^>]*>/g, '') + '<a target="_blank" href="/__repl?utm_medium=webview_badge"><img src="https://replit.com/badge?theme=dark" id="replitBadge"></a>';
        const p = readImportPage(page, 'https://abc-00-xyz.picard.replit.dev/');
        const t = texts(p).join('\n');
        assert.ok(t.includes('Bikes mended properly'));
        assert.ok(!/development preview|Publish your app|replit\.com\/badge/.test(t), t);
    });

    await check('the Flask template is read without a browser: words, button, picture', () => {
        const p = readImportPage(html('flask-home'), 'https://brackenbury.replit.app/');
        assert.ok(p.words >= 40);
        const t = texts(p);
        assert.ok(t.includes('Happy dogs, tired legs') && t.includes('Arrange a meet and greet'));
        assert.ok(t.includes('[img] https://brackenbury.replit.app/static/images/pack-on-the-bridge.jpg'));
    });

    await check('a menu link to a page the app never built (the template\'s 404 card) reads as empty', () => {
        assert.strictEqual(readImportPage(html('about-notfound-rendered'), `${APP}/about`).words, 0);
    });

    await check('Replit\'s own pages — not live yet, private app sign-in — are never read as their words', () => {
        const notLive = readImportPage(html('not-live'), `${APP}/`);
        assert.deepStrictEqual([notLive.words, notLive.blocks.length, notLive.title], [0, 0, null]);
        const signIn = readImportPage(html('sign-in'), 'https://replit.com/login?goto=fernhollow.replit.app');
        assert.deepStrictEqual([signIn.words, signIn.blocks.length], [0, 0]);
        // The same sign-in page served on the app's own address (og:site_name says Replit).
        assert.strictEqual(readImportPage(html('sign-in'), `${APP}/`).words, 0);
    });

    console.log('\nThe whole import');

    await check('shell → browser → draft: four menu pages, the 404 route reported unread, the price kept out', async () => {
        const r = await runImport({ url: `${APP}/`, pictures: 'skip', current: current(), maxPages: 5 }, deps());
        assert.ok(r.ok, r.ok ? '' : r.message);
        if (!r.ok) return;
        assert.strictEqual(r.report.platform, 'replit');
        assert.deepStrictEqual(r.report.pages.map((p) => [p.url.replace(APP, ''), p.read]), [['/', true], ['/services', true], ['/about', false], ['/contact', true]]);
        assert.deepStrictEqual(r.report.prices, ['£45']);
        assert.deepStrictEqual(r.report.formFields, ['Your name', 'Email address', 'What does your bike need?']);
        assert.strictEqual(r.report.contact.email, 'hello@fernhollow.example');
        const all = JSON.stringify(r.definition.pages);
        assert.ok(all.includes('Hand-built wheels laced to suit how and where you ride'));
        assert.ok(!/404 Page Not Found|forget to add the page|£45|replit/i.test(all));
    });

    await check('a private or unpublished app: no draft, nothing charged — Replit\'s words never become a site', async () => {
        const replitPage = (f: string, finalUrl: string): ImportDeps => deps({
            fetchHtml: async () => ({ ok: true, html: html(f), finalUrl }),
            renderHtml: async () => ({ ok: true, html: html(f), finalUrl }),
        });
        for (const [f, finalUrl] of [['sign-in', 'https://replit.com/login'], ['not-live', `${APP}/`]] as const) {
            const r = await runImport({ url: `${APP}/`, pictures: 'skip', current: current(), maxPages: 5 }, replitPage(f, finalUrl));
            assert.ok(!r.ok, f);
            assert.ok(!r.ok && /Nothing was charged/.test(r.message) && /\(0 words\)/.test(r.message), !r.ok ? r.message : '');
        }
    });

    await check('a stopped or unpublished app answering 404 says so (site-fetch error), no draft', async () => {
        const r = await runImport({ url: `${APP}/`, pictures: 'skip', current: current(), maxPages: 5 }, deps({ fetchHtml: async () => ({ ok: false, message: 'That link returned an error (404).' }) }));
        assert.ok(!r.ok && r.message.includes('404'));
    });

    console.log('\nThe look (known gap, shared code)');

    await check('shadcn/ui colours are bare HSL numbers — the look reader reads them (design tokens, main session 2026-11-09)', () => {
        const look = readImportedLook(html('home-rendered'), `${APP}/`, fx('index.css'));
        assert.strictEqual(look.headingFont, 'Playfair Display');
        assert.strictEqual(look.primaryColor, '#20794f');   // "--primary: 152 58% 30%"
    });

    console.log(`\n${passed}/${total} passed`);
})();
