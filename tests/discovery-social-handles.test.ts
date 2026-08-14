// tests/discovery-social-handles.test.ts
// Social profile capture (src/lib/discovery-enrich.ts `extractSocialHandles`) — Phase 2 item 7.
//
// Roughly two SMB sites in three publish no contact address, so "None found" is the majority
// verdict in the Leads table and it used to be a dead end. This captures the profiles the company
// links from its own footer, at no extra fetch cost, so a user has somewhere to go next.
//
// THE FAILURE MODE THIS FILE EXISTS FOR: share widgets. Nearly every site with a blog carries
// `twitter.com/intent/tweet?url=…` and `facebook.com/sharer/sharer.php?u=…` on every article. Treat
// those as profiles and EVERY lead in the database gets the same three handles that belong to
// nobody — a fabrication bug wearing the clothes of an extraction one, in a module whose entire
// contract is that it never invents a contact. Lock the rejections hard.
//
// Run:  npx tsx tests/discovery-social-handles.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { extractSocialHandles } from '../src/lib/discovery-enrich';
import { SOCIAL_PLATFORMS } from '../src/config/platform-formats';
import { landmark } from './landmark';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const page = (body: string) => `<html><body>${body}</body></html>`;
const footer = (body: string) => page(`<main><h1>Acme</h1></main><footer>${body}</footer>`);

console.log('\n──── what a footer yields ────');

check('captures the profiles a company links from its own footer', () => {
    const h = extractSocialHandles(footer(`
        <a href="https://www.linkedin.com/company/acme-ltd">LinkedIn</a>
        <a href="https://www.instagram.com/acmeltd/">Instagram</a>`), 'acme.co.uk');
    assert.equal(h.linkedin, 'https://www.linkedin.com/company/acme-ltd');
    assert.equal(h.instagram, 'https://www.instagram.com/acmeltd');
});

check('captures every supported platform', () => {
    const h = extractSocialHandles(footer(`
        <a href="https://www.linkedin.com/company/acme">li</a>
        <a href="https://instagram.com/acme">ig</a>
        <a href="https://www.facebook.com/acmeltd">fb</a>
        <a href="https://x.com/acme">x</a>
        <a href="https://www.tiktok.com/@acme">tt</a>
        <a href="https://www.youtube.com/@acmeltd">yt</a>
        <a href="https://www.pinterest.co.uk/acmeltd">pin</a>
        <a href="https://www.threads.net/@acme">th</a>`), 'acme.co.uk');
    assert.deepEqual(Object.keys(h).sort(),
        ['facebook', 'instagram', 'linkedin', 'pinterest', 'threads', 'tiktok', 'x', 'youtube']);
});

check('twitter.com and x.com are the same platform, not two', () => {
    const h = extractSocialHandles(footer('<a href="https://twitter.com/acmeltd">Twitter</a>'), 'acme.co.uk');
    assert.equal(h.x, 'https://twitter.com/acmeltd', 'an old twitter.com link is still the X profile');
});

check('a relative or protocol-relative href still resolves', () => {
    const h = extractSocialHandles(footer('<a href="//www.linkedin.com/company/acme">li</a>'), 'acme.co.uk');
    assert.equal(h.linkedin, 'https://www.linkedin.com/company/acme');
});

// ── The rejections that matter ────────────────────────────────────────────────

console.log('\n──── share widgets are not profiles ────');

check('rejects the share widgets that appear on every blog page', () => {
    // The whole reason this file exists. These four are on a large share of SMB sites.
    const h = extractSocialHandles(footer(`
        <a href="https://twitter.com/intent/tweet?url=https://acme.co.uk/post">Tweet this</a>
        <a href="https://www.facebook.com/sharer/sharer.php?u=https://acme.co.uk/post">Share</a>
        <a href="https://www.linkedin.com/shareArticle?mini=true&url=https://acme.co.uk">Share</a>
        <a href="https://pinterest.com/pin/create/button/?url=https://acme.co.uk">Pin it</a>`), 'acme.co.uk');
    assert.deepEqual(h, {}, 'a share button is not the company’s profile — this would forge a handle for every lead');
});

check('a share widget does not shadow the real profile beside it', () => {
    // The realistic markup: a blog footer carrying both. The share link must be skipped, not treated
    // as the platform's "first match" and allowed to win.
    const h = extractSocialHandles(footer(`
        <a href="https://www.facebook.com/sharer/sharer.php?u=https://acme.co.uk">Share</a>
        <a href="https://www.facebook.com/acmeltd">Find us on Facebook</a>`), 'acme.co.uk');
    assert.equal(h.facebook, 'https://www.facebook.com/acmeltd');
});

check('rejects individual posts, pins and videos', () => {
    const h = extractSocialHandles(footer(`
        <a href="https://www.instagram.com/p/Cabc123/">Our latest post</a>
        <a href="https://www.instagram.com/reel/Cxyz789/">A reel</a>
        <a href="https://www.youtube.com/watch?v=dQw4w9WgXcQ">Watch</a>
        <a href="https://www.pinterest.com/pin/12345/">A pin</a>`), 'acme.co.uk');
    assert.deepEqual(h, {}, 'a link to one post says nothing about where the company lives');
});

check('rejects the platforms’ own policy and product pages', () => {
    const h = extractSocialHandles(footer(`
        <a href="https://www.facebook.com/privacy">Facebook privacy</a>
        <a href="https://www.instagram.com/about/">About Instagram</a>
        <a href="https://x.com/tos">Terms</a>`), 'acme.co.uk');
    assert.deepEqual(h, {}, 'a platform’s own page is never a lead’s profile');
});

check('rejects a bare platform homepage with no handle at all', () => {
    const h = extractSocialHandles(footer(`
        <a href="https://www.facebook.com/">Facebook</a>
        <a href="https://www.instagram.com">Instagram</a>`), 'acme.co.uk');
    assert.deepEqual(h, {}, 'linking facebook.com is not publishing a page');
});

check('ignores non-http schemes', () => {
    // These began life as an href on a stranger's site and end up in an href we render.
    const h = extractSocialHandles(footer(`
        <a href="javascript:void(0)">Menu</a>
        <a href="#social">Jump</a>
        <a href="mailto:hello@acme.co.uk">Email</a>`), 'acme.co.uk');
    assert.deepEqual(h, {});
});

check('never invents a handle from the company name', () => {
    // The hard rule the whole module is built around, restated for handles: if it was not an
    // href on the page, it does not exist. No "acme.co.uk → instagram.com/acme" guessing.
    const h = extractSocialHandles(footer('<p>Follow Acme Ltd on Instagram!</p>'), 'acme.co.uk');
    assert.deepEqual(h, {}, 'prose naming a platform is not a link to a profile');
});

console.log('\n──── whose profile is it ────');

check('the footer wins over links in the body', () => {
    // A profile named in an article is as likely to be someone ELSE's — a supplier, a client, a
    // person the post is about. The footer row is the company's own by construction.
    const h = extractSocialHandles(
        page(`<main><p>We love <a href="https://www.instagram.com/somebodyelse">this brand</a></p></main>
              <footer><a href="https://www.instagram.com/acmeltd">Us</a></footer>`), 'acme.co.uk');
    assert.equal(h.instagram, 'https://www.instagram.com/acmeltd');
});

check('a site with no <footer> element falls back to the whole page', () => {
    // Plenty of SMB templates have no semantic footer at all. Refusing to read those would drop
    // the capture on exactly the unsophisticated sites this feature is aimed at.
    const h = extractSocialHandles(
        page('<div class="footer"><a href="https://www.linkedin.com/company/acme">li</a></div>'), 'acme.co.uk');
    assert.equal(h.linkedin, 'https://www.linkedin.com/company/acme');
});

check('the first profile per platform wins', () => {
    const h = extractSocialHandles(footer(`
        <a href="https://www.instagram.com/acmeltd">Main</a>
        <a href="https://www.instagram.com/acmeltd_shop">Shop</a>`), 'acme.co.uk');
    assert.equal(h.instagram, 'https://www.instagram.com/acmeltd');
});

check('drops the query string and fragment', () => {
    // utm tags on a footer link are common, and they are tracking that belongs to the lead's site,
    // not to us. Storing them would put them in front of the user and back onto the platform.
    const h = extractSocialHandles(
        footer('<a href="https://www.instagram.com/acmeltd?utm_source=site#top">ig</a>'), 'acme.co.uk');
    assert.equal(h.instagram, 'https://www.instagram.com/acmeltd');
});

check('a page with no social links yields nothing', () => {
    assert.deepEqual(extractSocialHandles(page('<h1>Welcome</h1><p>Call 0800 000 000</p>'), 'acme.co.uk'), {});
});

console.log('\n──── the vocabularies stay separate ────');

check('the capture list is NOT the publishing allow-list', () => {
    // SOCIAL_PLATFORMS answers "where can this product post?"; this module answers "where might a
    // prospect be reachable?". Collapsing them to one list would silently drop TikTok and
    // Pinterest, both ordinary channels for the DTC brands discovery turns up.
    const captured = extractSocialHandles(footer(`
        <a href="https://www.tiktok.com/@acme">tt</a>
        <a href="https://www.pinterest.co.uk/acmeltd">pin</a>`), 'acme.co.uk');
    assert.deepEqual(Object.keys(captured).sort(), ['pinterest', 'tiktok']);
    for (const k of ['tiktok', 'pinterest']) {
        assert.ok(!(SOCIAL_PLATFORMS as string[]).includes(k),
            `${k} is now publishable — if the two lists have genuinely converged, revisit the comment in discovery-enrich.ts rather than deleting this check`);
    }
});

console.log('\n──── the handle is a link, never a channel ────');

check('nothing in the platform can send to a captured handle', () => {
    // The copy shown beside these links promises a MANUAL step, and that promise is only honest
    // while no send path exists. src/utils/lead-threads.ts declares `channel?: 'email' | 'dm'` and
    // nothing anywhere ASSIGNS 'dm' — the type has always been aspirational. If that changes, the
    // UI copy in assistant-data-hub.js has to change with it.
    const threads = readFileSync(new URL('../src/utils/lead-threads.ts', import.meta.url), 'utf8');
    assert.ok(/channel\?: 'email' \| 'dm'/.test(threads),
        'the channel union moved — re-point this check before trusting it');
    assert.ok(!/channel:\s*'dm'/.test(threads),
        'something now sets channel:\'dm\' — the "nothing here sends a message" copy on the profile links is no longer true');

    const hub = readFileSync(new URL('../src/components/assistant-data-hub.js', import.meta.url), 'utf8');
    const banner = hub.slice(landmark(hub, 'function socialBanner'), landmark(hub, 'Record (or correct)'));
    assert.ok(/Nothing here (sends a message|posts or messages)/.test(banner),
        'the profile links must say plainly that opening one is the user’s job');
    assert.ok(/rel="noopener noreferrer nofollow"/.test(banner),
        'these hrefs come from a stranger’s markup — they must not hand the opener or the referrer over');
    assert.ok(/\^https\?:\\\/\\\//.test(hub),
        'the render must re-check the scheme: the URL has been through a jsonb column and a PATCH endpoint since the scraper vetted it');
});

console.log(`\n${passed} checks passed.`);
