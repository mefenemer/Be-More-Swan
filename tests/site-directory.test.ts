// tests/site-directory.test.ts
// The site page directory (docs/site-directory-plan.md): a map of the customer's website every live
// assistant reads. Saved pages only — no network: tests/fixtures/site-import/.
//
//   1. Which pages: home first, menu, then sitemap; same site only; no cart, legal, posts or files.
//   2. Entries are the site's own words, by rule — never a price, never a [placeholder].
//   3. A published Be More Swan site is read from its definition: product NAMES, never prices.
//   4. The prompt block: one loader, hard cap, exclusions honoured, full addresses (groundLinks).
//   5. Wiring: every surface reads THE loader; GUI and chat share one action; no task is spent.
//
// Run:  npx tsx tests/site-directory.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readImportPage } from '../src/utils/site-extract';
import {
    cleanDirectoryPath, crawlSite, directoryGaps, directoryPath, entriesFromDefinition, entryFromImportPage, orderChildSitemaps,
    pageKind, parseSitemap, pickDirectoryUrls, readExcluded, readPages, siteDirectoryPromptBlock, sitemapsFromRobots,
    DIRECTORY_MAX_PAGES, SITE_DIRECTORY_CHAR_CAP, type DirectoryPage,
} from '../src/utils/site-directory';
import { siteDirectoryCardFrom, siteDirectoryChatBlock } from '../src/utils/chat-site-directory';
import { directoryView, type DirectoryView } from '../src/utils/site-directory-store';
import { normaliseSiteDefinition } from '../src/utils/site-definition';
import { senderIdentityBlock } from '../src/config/sender-identity';
import { CRAWLERS } from '../src/lib/robots';
import type { HtmlFetch } from '../src/utils/site-fetch';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const fixture = (f: string) => read(`tests/fixtures/site-import/${f}.html`);
const SITE = 'https://willow.example';

const page = (over: Partial<DirectoryPage>): DirectoryPage => ({ url: `${SITE}/x`, path: '/x', title: 'X', summary: null, offers: [], kind: 'other', ...over });

(async () => {
    console.log('\n1. Which pages');

    await check('sitemap <loc>s are read, and an index is told apart', () => {
        const urlset = parseSitemap(`<?xml version="1.0"?><urlset><url><loc>${SITE}/a</loc></url><url><loc> <![CDATA[${SITE}/b?x=1&amp;y=2]]> </loc></url></urlset>`);
        assert.deepStrictEqual(urlset.urls, [`${SITE}/a`, `${SITE}/b?x=1&y=2`]);
        assert.deepStrictEqual(urlset.sitemaps, []);
        const index = parseSitemap(`<sitemapindex><sitemap><loc>${SITE}/post-sitemap.xml</loc></sitemap><sitemap><loc>${SITE}/page-sitemap.xml</loc></sitemap></sitemapindex>`);
        assert.deepStrictEqual(index.urls, []);
        assert.deepStrictEqual(orderChildSitemaps(index.sitemaps), [`${SITE}/page-sitemap.xml`, `${SITE}/post-sitemap.xml`]);
    });

    await check('Sitemap: lines in robots.txt', () => {
        assert.deepStrictEqual(sitemapsFromRobots(`User-agent: *\nDisallow: /cart\nSitemap: ${SITE}/sitemap_index.xml\nsitemap:  ftp://nope\n`), [`${SITE}/sitemap_index.xml`]);
    });

    await check('home first, then the menu, then the sitemap — same site, no machinery, de-duplicated', () => {
        const home = readImportPage(fixture('sqsp-home'), `${SITE}/`);
        const urls = pickDirectoryUrls({
            home: `${SITE}/`, navLinks: home.navLinks,
            sitemapUrls: [`${SITE}/services/`, `${SITE}/gallery`, `https://other.example/x`, `${SITE}/brochure.pdf`, `${SITE}/blog/a-post`, `${SITE}/terms`, `https://www.willow.example/workshops/beginners`],
        });
        assert.strictEqual(urls[0], `${SITE}/`);
        assert.ok(urls.includes(`${SITE}/services`), 'menu page kept');
        assert.ok(urls.includes(`${SITE}/contact`));
        assert.ok(urls.includes(`${SITE}/gallery`), 'sitemap page kept');
        assert.ok(urls.includes('https://www.willow.example/workshops/beginners'), 'www is the same site');
        assert.strictEqual(urls.filter((u) => directoryPath(u) === '/services').length, 1, 'no duplicate for a trailing slash');
        for (const bad of ['other.example', '.pdf', '/blog/a-post', '/cart', '/terms', '/privacy-policy']) assert.ok(!urls.some((u) => u.includes(bad)), `${bad} left out`);
        // bemoreswan.com, 2026-10-31: underscores and .html slipped past the import's rule.
        const legal = pickDirectoryUrls({ home: SITE, navLinks: [], sitemapUrls: [`${SITE}/terms_of_service`, `${SITE}/privacy.html`, `${SITE}/dpa`, `${SITE}/licenses.html`, `${SITE}/pricing`] });
        assert.deepStrictEqual(legal.map(directoryPath), ['/', '/pricing']);
        // The menu comes before the sitemap.
        assert.ok(urls.indexOf(`${SITE}/services`) < urls.indexOf(`${SITE}/gallery`));
    });

    await check(`never more than ${DIRECTORY_MAX_PAGES} pages`, () => {
        const many = Array.from({ length: 80 }, (_, i) => `${SITE}/p${i}`);
        assert.strictEqual(pickDirectoryUrls({ home: SITE, navLinks: [], sitemapUrls: many }).length, DIRECTORY_MAX_PAGES);
    });

    console.log('\n2. Entries are the site\'s own words');

    await check('the home page: its own title part, its description, and its headings as offers', () => {
        const e = entryFromImportPage(readImportPage(fixture('sqsp-home'), `${SITE}/`), `${SITE}/`);
        assert.strictEqual(e.path, '/');
        assert.strictEqual(e.kind, 'home');
        assert.ok(!e.title.includes('|'), `title trimmed: ${e.title}`);
        assert.ok(e.summary && /alterations and repairs/i.test(e.summary), `summary from the description: ${e.summary}`);
        assert.ok(!e.offers.some((o) => /^(what we do|questions)$/i.test(o)), `generic headings dropped: ${e.offers.join(' | ')}`);
    });

    await check('a line that states a price is never kept', () => {
        const e = entryFromImportPage(readImportPage(fixture('sqsp-services'), `${SITE}/services`), `${SITE}/services`);
        const all = [e.title, e.summary ?? '', ...e.offers].join(' ');
        assert.ok(!/£/.test(all), `no price: ${all}`);
        assert.strictEqual(e.kind, 'service');
        assert.strictEqual(e.title, 'Services');
    });

    await check('step numbers and form replies are not offers', () => {
        const html = '<html><head><title>Home</title></head><body><h1>Studio</h1><h2>1. Select your class</h2><h2>Message sent — thank you!</h2><h2>Wheel throwing</h2><p>' + 'Pottery classes for beginners in Bristol, every weekend. '.repeat(3) + '</p></body></html>';
        const e = entryFromImportPage(readImportPage(html, `${SITE}/`), `${SITE}/`);
        assert.deepStrictEqual(e.offers, ['Wheel throwing']);
    });

    await check('page kinds by rule', () => {
        assert.strictEqual(pageKind('/', 'Anything'), 'home');
        assert.strictEqual(pageKind('/contact', 'Contact'), 'contact');
        assert.strictEqual(pageKind('/about-us', 'Our story'), 'about');
        assert.strictEqual(pageKind('/book', 'Book online'), 'booking');
        assert.strictEqual(pageKind('/gift-vouchers', 'Gift vouchers'), 'shop');
        assert.strictEqual(pageKind('/garden-design', 'Garden design'), 'service');
    });

    await check('the crawl: unreadable home fails with the fetcher\'s words; a broken page is skipped, not fatal', async () => {
        const pages: Record<string, string> = { [`${SITE}/`]: fixture('sqsp-home'), [`${SITE}/services`]: fixture('sqsp-services'), [`${SITE}/contact`]: fixture('sqsp-contact') };
        const fetchHtml = async (url: string): Promise<HtmlFetch> => pages[url] ? { ok: true, html: pages[url], finalUrl: url } : { ok: false, message: 'gone' };
        const ok = await crawlSite(`${SITE}/`, { fetchHtml, fetchText: async () => null });
        assert.ok(ok.ok);
        if (!ok.ok) return;
        assert.deepStrictEqual(ok.pages.map((p) => p.path).sort(), ['/', '/contact', '/services']);
        assert.ok(ok.skipped >= 1, 'the /about-us menu link 404s and is skipped');
        const refused = await crawlSite(`${SITE}/`, { fetchHtml: async () => ({ ok: false, message: 'willow.example asks crawlers like ours not to read this page (robots.txt), so we didn\'t.' }), fetchText: async () => null });
        assert.ok(!refused.ok && /robots\.txt/.test(refused.message));
    });

    await check('a thin page is re-rendered, at most a few times', async () => {
        const thin = '<html><head><title>Shell</title></head><body><div id="app"></div></body></html>';
        let renders = 0;
        const urls = Array.from({ length: 10 }, (_, i) => `${SITE}/p${i}`);
        const nav = urls.map((u) => `<a href="${u}">P</a>`).join('');
        const res = await crawlSite(`${SITE}/`, {
            fetchHtml: async (url) => ({ ok: true, html: url === `${SITE}/` ? `<html><body><nav>${nav}</nav></body></html>` : thin, finalUrl: url }),
            fetchText: async () => null,
            renderHtml: async (url) => { renders++; return { ok: true, html: thin, finalUrl: url }; },
        });
        assert.ok(res.ok);
        assert.strictEqual(renders, 5);
    });

    await check('the directory has its own crawler name, so an owner can block it alone', () => {
        assert.strictEqual(CRAWLERS.siteDirectory.token, 'bemoreswan-sitedirectory');
        const store = read('src/utils/site-directory-store.ts');
        assert.ok(store.includes('fetchSiteHtml(url, CRAWLERS.siteDirectory'), 'pages go through site-fetch.ts (robots + safe-fetch)');
        assert.ok(store.includes('safeFetchText('), 'robots.txt / text through safe-fetch');
        assert.ok(!/\bfetch\(\s*url/.test(store), 'no raw fetch of a customer page');
    });

    console.log('\n3. A published Be More Swan site');

    await check('read from the definition: pages in menu order, product names from Business Information, never prices', () => {
        const { definition } = normaliseSiteDefinition({
            version: 1,
            settings: { siteName: 'Willow & Thread', description: 'Alterations in Harrogate.' },
            pages: [
                { id: 'p2', slug: 'services', title: 'Services', sections: [
                    { id: 's1', type: 'features', props: { heading: 'What we do', intro: 'Every job is sewn by hand in our studio.', items: [{ title: 'Hemming', body: 'Trousers and skirts.' }, { title: 'Zips', body: 'Replaced.' }] } },
                    { id: 's2', type: 'products', props: { heading: 'Book', intro: null, productIds: [7], items: [], collectAddress: false, buyLabel: 'Buy' } },
                ] },
                { id: 'p1', slug: '', title: 'Home', sections: [{ id: 'h', type: 'hero', props: { layout: 'centered', eyebrow: null, headline: 'Alterations by hand', subheadline: 'Clothing alterations and repairs in Harrogate, done by hand.', primaryCta: null, secondaryCta: null, image: null } }] },
            ],
        }, { maxPages: 10 });
        const pages = entriesFromDefinition(definition, 'https://willow.bemoreswan.site', new Map([[7, 'Wedding dress fitting']]));
        assert.strictEqual(pages[0].path, '/');
        assert.strictEqual(pages[0].url, 'https://willow.bemoreswan.site/');
        assert.ok(pages[0].summary && /Harrogate/.test(pages[0].summary));
        const services = pages.find((p) => p.path === '/services')!;
        assert.strictEqual(services.url, 'https://willow.bemoreswan.site/services');
        assert.deepStrictEqual(services.offers, ['Hemming', 'Zips', 'Wedding dress fitting']);
    });

    await check('hosted: published version only, rebuilt on publish; unpublish falls back', () => {
        const store = read('src/utils/site-directory-store.ts');
        assert.ok(store.includes('publishedDefinition('), 'reads the frozen published version, never the draft');
        const sites = read('netlify/functions/sites.ts');
        const pub = sites.indexOf("action === 'publish'");
        assert.ok(pub > -1 && sites.indexOf('refreshDirectoryAfterPublish(db, orgId)', pub) > pub);
        const unpub = sites.indexOf("action === 'unpublish'");
        assert.ok(unpub > -1 && sites.indexOf('refreshDirectoryAfterAddressChange(db, orgId)', unpub) > unpub);
        const profile = read('netlify/functions/organisation-profile.ts');
        assert.ok(profile.includes('refreshDirectoryAfterAddressChange(db, orgId)'), 'a new website address re-reads');
    });

    console.log('\n4. The prompt block');

    await check('full addresses (groundLinks keeps only verbatim links), Business Information wins, no prices', () => {
        const block = siteDirectoryPromptBlock({ pages: [page({ url: `${SITE}/`, path: '/', title: 'Home', kind: 'home', summary: 'Alterations in Harrogate.' }), page({ url: `${SITE}/services`, path: '/services', title: 'Services', kind: 'service', offers: ['Hemming', 'Zips'] })] })!;
        assert.ok(block.includes(`- ${SITE}/services — Services (Hemming; Zips)`), block);
        assert.ok(/Business Information is authoritative/.test(block));
        assert.ok(/Never quote prices/.test(block));
    });

    await check('excluded pages never appear; nothing left = no block', () => {
        const pages = [page({ url: `${SITE}/`, path: '/', kind: 'home', title: 'Home' }), page({ url: `${SITE}/secret`, path: '/secret', title: 'Secret' })];
        const block = siteDirectoryPromptBlock({ pages, excluded: ['/secret'] })!;
        assert.ok(!block.includes('/secret'));
        assert.strictEqual(siteDirectoryPromptBlock({ pages: [pages[1]], excluded: ['/secret'] }), null);
        assert.strictEqual(siteDirectoryPromptBlock(null), null);
    });

    await check(`hard cap of ${SITE_DIRECTORY_CHAR_CAP} characters; home and contact always kept`, () => {
        const filler = 'x'.repeat(120);
        const pages = [page({ url: `${SITE}/`, path: '/', kind: 'home', title: 'Home' })];
        for (let i = 0; i < 40; i++) pages.push(page({ url: `${SITE}/p${i}`, path: `/p${i}`, title: `Page ${i}`, summary: filler }));
        pages.push(page({ url: `${SITE}/contact`, path: '/contact', kind: 'contact', title: 'Contact' }));
        const block = siteDirectoryPromptBlock({ pages })!;
        assert.ok(block.length <= SITE_DIRECTORY_CHAR_CAP, `${block.length}`);
        assert.ok(block.includes(`${SITE}/contact`) && block.includes(`- ${SITE}/ —`));
        assert.ok(/\(\+\d+ more pages not shown\)/.test(block));
    });

    await check('stored JSON is read defensively; paths are cleaned', () => {
        assert.deepStrictEqual(readPages([null, { url: 'u', path: '/a', title: 'A', offers: ['x', 3], kind: 'nope' }]), [{ url: 'u', path: '/a', title: 'A', summary: null, offers: ['x'], kind: 'other' }]);
        assert.strictEqual(cleanDirectoryPath('about/'), '/about');
        assert.strictEqual(cleanDirectoryPath(`${SITE}/about?x=1`), '/about');
        assert.strictEqual(cleanDirectoryPath('<script>'), null);
        assert.deepStrictEqual(readExcluded(['/a', 5, '/b/']), ['/a', '/b']);
    });

    await check('lead outreach sees the pages through the sender identity', () => {
        const text = senderIdentityBlock({ businessName: 'Willow', siteDirectoryBlock: `YOUR WEBSITE'S PAGES — x\n- ${SITE}/services — Services` });
        assert.ok(text.includes(`${SITE}/services`));
        assert.ok(/when the email's rules allow a link/.test(text), 'the outreach rules still decide whether a link goes in');
    });

    await check('the Business Mentor\'s gaps: no contact/about page, products no page names', () => {
        const gaps = directoryGaps([page({ path: '/', kind: 'home', title: 'Home', summary: 'Hemming and zips' })], ['Hemming', 'Wedding dress fitting']);
        assert.ok(gaps.some((g) => /No contact page/.test(g)));
        assert.ok(gaps.some((g) => /No about page/.test(g)));
        assert.ok(gaps.some((g) => /Wedding dress fitting/.test(g) && !/Hemming/.test(g)));
        assert.deepStrictEqual(directoryGaps([], ['x']), [], 'no directory, no gaps');
    });

    console.log('\n5. Wiring');

    await check('every surface reads THE loader', () => {
        const surfaces: Record<string, string> = {
            'netlify/functions/chat-orchestrator.ts': 'loadSiteDirectoryBlock(db, orgId)',
            'netlify/functions/process-content-jobs.ts': 'loadSiteDirectoryBlock(db, job.organisation_id)',
            'src/utils/blog-generate.ts': 'loadSiteDirectoryBlock(db, organisationId)',
            'src/utils/newsletter-generate.ts': 'loadSiteDirectoryBlock(db, organisationId)',
            'src/utils/newsletter-campaign-generate.ts': 'loadSiteDirectoryBlock(db, input.organisationId)',
            'src/utils/sender-identity.ts': 'loadSiteDirectoryBlock(db, organisationId)',
            'src/utils/mentor-snapshot.ts': 'loadSiteDirectoryGaps(db, orgId)',
        };
        for (const [file, call] of Object.entries(surfaces)) assert.ok(read(file).includes(call), `${file} calls ${call}`);
        // Every chat route, and the hand-off prompt too.
        const chat = read('netlify/functions/chat-orchestrator.ts');
        assert.ok(/promptWithRules = \[[^\]]*siteDirectoryBlock/.test(chat));
        assert.ok(chat.includes("(siteDirectoryBlock ? `\\n\\n${siteDirectoryBlock}` : '')"), 'the hand-off prompt carries it');
        // Only site-directory.ts formats the directory.
        for (const file of Object.keys(surfaces)) assert.ok(!read(file).includes("YOUR WEBSITE'S PAGES"), `${file} does not format its own`);
    });

    await check('a refresh costs no task (owner, plan D6)', () => {
        for (const f of ['src/utils/site-directory-store.ts', 'src/utils/site-directory.ts', 'netlify/functions/site-directory.ts', 'netlify/functions/site-directory-background.ts']) {
            assert.ok(!/recordCompletedWork\(|consumeTaskCredit\(|hasTaskCapacity\(/.test(read(f)), `${f} spends nothing`);
        }
    });

    await check('GUI and chat call the same action', () => {
        const ui = read('assets.html');
        assert.ok(ui.includes('data-tab="sitepages"') && ui.includes('data-panel="sitepages"'));
        assert.ok(ui.includes("fetch('/.netlify/functions/site-directory'"));
        const card = read('src/components/disruptive-ui-registry.js');
        const at = card.indexOf('function renderSiteDirectoryCard');
        assert.ok(at > -1 && card.indexOf("fetch('/.netlify/functions/site-directory'", at) > at);
        assert.ok(card.includes("register('site_directory', renderSiteDirectoryCard)"));
        const chat = read('netlify/functions/chat-orchestrator.ts');
        assert.ok(chat.includes('resolveSiteDirectoryCard(db, orgId, uiElement)'));
        assert.ok(chat.includes('buildSiteDirectoryChatBlock(db, orgId)'));
    });

    await check('the chat card is checked against the stored directory', () => {
        const row = {
            id: 1, organisationId: 1, source: 'crawl', sourceUrl: SITE, status: 'ready', message: null,
            pages: [{ url: `${SITE}/`, path: '/', title: 'Home', summary: null, offers: [], kind: 'home' }, { url: `${SITE}/about`, path: '/about', title: 'About', summary: null, offers: [], kind: 'about' }],
            excluded: ['/about'], refreshedAt: new Date('2026-10-30T10:00:00Z'), nextRefreshAt: null, requestedBy: null,
            createdAt: new Date('2026-10-30T10:00:00Z'), updatedAt: new Date('2026-10-30T10:00:00Z'),
        };
        const view: DirectoryView = directoryView(row, new Date('2026-10-31T10:00:00Z'));
        assert.strictEqual(siteDirectoryCardFrom({ type: 'site_directory', action: 'refresh' }, view)!.blocked, null);
        assert.ok(siteDirectoryCardFrom({ type: 'site_directory', action: 'exclude', path: '/about' }, view)!.blocked, 'already left out');
        assert.strictEqual(siteDirectoryCardFrom({ type: 'site_directory', action: 'include', path: '/about/' }, view)!.blocked, null);
        assert.ok(siteDirectoryCardFrom({ type: 'site_directory', action: 'exclude', path: '/nowhere' }, view)!.blocked);
        assert.strictEqual(siteDirectoryCardFrom({ type: 'other' }, view), null);
        // Re-read an hour ago by hand → the card says when it can run again.
        const recent = directoryView({ ...row, requestedBy: 5, updatedAt: new Date('2026-10-31T09:30:00Z') }, new Date('2026-10-31T10:00:00Z'));
        assert.ok(/last hour/.test(siteDirectoryCardFrom({ type: 'site_directory', action: 'refresh' }, recent)!.blocked ?? ''));
        // Refused before it ever read a page (robots.txt): says why, never "last read never".
        const refused = siteDirectoryChatBlock(directoryView({ ...row, status: 'failed', refreshedAt: null, pages: [], excluded: [], message: 'x.example asks crawlers like ours not to read this page (robots.txt), so we didn\'t.' }));
        assert.ok(/We tried to read .*robots\.txt.*no pages are known yet/.test(refused), refused);
        const block = siteDirectoryChatBlock(view);
        assert.ok(block.includes('/about (About)') && /never say the site HAS been re-read/.test(block));
    });

    await check('scheduled on prod, poked on staging; SQL file and schema agree', () => {
        const toml = read('netlify.toml');
        assert.ok(/\[functions\.dispatch-site-directories\]\s*\n\s*schedule = /.test(toml));
        assert.ok(/\[functions\.site-directory-background\]\s*\n\s*external_node_modules/.test(toml));
        assert.ok(read('.github/workflows/staging-crons.yml').includes('run-site-directory-dispatch'));
        const sql = read('db/z-site-directory.sql');
        assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS site_directories') && sql.includes('site_directories_org_uq'));
        assert.ok(read('db/schema.ts').includes('export const siteDirectories = pgTable("site_directories"'));
    });

    console.log(`\n${passed}/${total} passed`);
})();
