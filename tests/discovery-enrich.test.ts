// tests/discovery-enrich.test.ts
// Lead Generator contact enrichment (src/lib/discovery-enrich.ts) — tier 1, site scrape.
// This module decides which address a cold outreach email gets SENT to, so a false
// positive is worse than a miss: it means emailing a stranger, or worse, emailing the
// lead's web designer. Lock the classifier's rejections hard.
// Run:  npx tsx tests/discovery-enrich.test.ts

import assert from 'node:assert';
import { extractEmails } from '../src/lib/discovery-enrich';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const page = (body: string) => `<html><body>${body}</body></html>`;

check('pulls a role address out of a mailto: link', () => {
    const hits = extractEmails(page('<a href="mailto:hello@acme.co.uk">Email us</a>'), 'acme.co.uk');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].email, 'hello@acme.co.uk');
    assert.equal(hits[0].kind, 'role');
});

check('pulls an address written in body text', () => {
    const hits = extractEmails(page('<p>Contact us at info@acme.co.uk today</p>'), 'acme.co.uk');
    assert.equal(hits[0].email, 'info@acme.co.uk');
});

check('classifies hospitality desk inboxes as role, not personal', () => {
    // Regression: a live staging run classified reservations@ as 'personal' and put a
    // "check before approving" warning on an obviously generic venue inbox.
    for (const p of ['reservations', 'bookings', 'events', 'concierge']) {
        const hits = extractEmails(page(`<p>${p}@venue.co.uk</p>`), 'venue.co.uk');
        assert.equal(hits[0]?.kind, 'role', `${p}@ should be a role inbox`);
    }
});

check('classifies a named inbox as personal, not role', () => {
    const hits = extractEmails(page('<a href="mailto:jane.smith@acme.co.uk">Jane</a>'), 'acme.co.uk');
    assert.equal(hits[0].kind, 'personal');
});

check('role addresses sort ahead of personal ones', () => {
    const hits = extractEmails(page(`
        <a href="mailto:jane.smith@acme.co.uk">Jane</a>
        <a href="mailto:sales@acme.co.uk">Sales</a>`), 'acme.co.uk');
    assert.equal(hits[0].kind, 'role', 'a role inbox is the safer outreach target');
    assert.equal(hits[0].email, 'sales@acme.co.uk');
});

// ── The rejections that matter ────────────────────────────────────────────────

check('rejects third-party addresses on another domain', () => {
    // The single most common false positive: the agency that built the site.
    const hits = extractEmails(page(`
        <p>Site by <a href="mailto:studio@webagency.com">WebAgency</a></p>
        <a href="mailto:info@acme.co.uk">Us</a>`), 'acme.co.uk');
    assert.equal(hits.length, 1, 'only the lead\'s own domain is contactable');
    assert.equal(hits[0].email, 'info@acme.co.uk');
});

check('rejects noreply and other unattended inboxes', () => {
    for (const addr of ['noreply@acme.co.uk', 'no-reply@acme.co.uk', 'donotreply@acme.co.uk', 'postmaster@acme.co.uk']) {
        assert.equal(extractEmails(page(`<p>${addr}</p>`), 'acme.co.uk').length, 0, addr);
    }
});

check('rejects compliance inboxes that must not receive marketing', () => {
    for (const addr of ['privacy@acme.co.uk', 'dpo@acme.co.uk', 'legal@acme.co.uk', 'unsubscribe@acme.co.uk']) {
        assert.equal(extractEmails(page(`<p>${addr}</p>`), 'acme.co.uk').length, 0, addr);
    }
});

check('rejects retina image filenames misparsed as addresses', () => {
    // "logo@2x.png" matches a naive email regex and is a real hazard on image-heavy sites.
    const hits = extractEmails(page('<img src="logo@2x.png"><p>brand@2x.png</p>'), null);
    assert.equal(hits.length, 0);
});

check('rejects placeholder addresses from template markup', () => {
    for (const addr of ['your@email.com', 'name@example.com', 'email@domain.com']) {
        assert.equal(extractEmails(page(`<p>${addr}</p>`), null).length, 0, addr);
    }
});

check('ignores addresses inside script and style tags', () => {
    const hits = extractEmails(
        `<html><body><script>var t="tracking@sentry.io";</script><style>/* a@b.com */</style>
         <a href="mailto:info@acme.co.uk">Us</a></body></html>`, 'acme.co.uk');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].email, 'info@acme.co.uk');
});

check('accepts a subdomain of the lead domain', () => {
    const hits = extractEmails(page('<p>hello@mail.acme.co.uk</p>'), 'acme.co.uk');
    assert.equal(hits.length, 1);
});

check('treats www. on the lead domain as the same domain', () => {
    const hits = extractEmails(page('<p>info@acme.co.uk</p>'), 'www.acme.co.uk');
    assert.equal(hits.length, 1);
});

// ── Hygiene ───────────────────────────────────────────────────────────────────

// ── Text-node fusion (prod, indielee.com, 2026-08-12) ────────────────────────
// A label in one element running straight into an address in the next produced
// `supporthello@indielee.com`: right domain, no blocked prefix, so it passed every check —
// and it SWALLOWED the real `hello@indielee.com`, leaving the page with no role address.
// The lead reached the Review Queue with an undeliverable recipient and an Approve button.

check('does not fuse a label in one element with an address in the next', () => {
    const hits = extractEmails(page('<div><span>Support</span><a>hello@indielee.com</a></div>'), 'indielee.com');
    assert.deepEqual(hits.map(h => h.email), ['hello@indielee.com'],
        'the label must not become part of the local part');
    assert.equal(hits[0].kind, 'role', 'hello@ is a role inbox — fusion had it graded personal');
});

check('the exact indielee.com markup yields the real address', () => {
    const hits = extractEmails(
        page('<footer><p><span>Support</span><a href="mailto:hello@indielee.com">hello@indielee.com</a></p></footer>'),
        'indielee.com',
    );
    assert.deepEqual(hits.map(h => h.email), ['hello@indielee.com']);
});

check('a fused text match never outlives the mailto address it swallowed', () => {
    // The second defence, for markup where the fusion happens with no element boundary to
    // insert — the raw text genuinely reads "Supporthello@acme.co.uk".
    const hits = extractEmails(
        page('<a href="mailto:hello@acme.co.uk">Email</a><p>Supporthello@acme.co.uk</p>'),
        'acme.co.uk',
    );
    assert.deepEqual(hits.map(h => h.email), ['hello@acme.co.uk'],
        'the prefixed duplicate must be dropped, not ranked below');
});

check('the suffix rule does not discard a genuinely distinct inbox', () => {
    // presales@ ends with sales@ — two deliberate mailto links are two addresses, not a fusion.
    const hits = extractEmails(
        page('<a href="mailto:sales@acme.co.uk">A</a><a href="mailto:presales@acme.co.uk">B</a>'),
        'acme.co.uk',
    );
    assert.deepEqual(hits.map(h => h.email).sort(), ['presales@acme.co.uk', 'sales@acme.co.uk']);
});

check('block-level text still yields addresses normally', () => {
    // The boundary insertion must not break the ordinary case it was added to protect.
    const hits = extractEmails(page('<ul><li>info@acme.co.uk</li><li>jane@acme.co.uk</li></ul>'), 'acme.co.uk');
    assert.deepEqual(hits.map(h => h.email), ['info@acme.co.uk', 'jane@acme.co.uk']);
});

check('entity-encoded addresses are still decoded and found', () => {
    // Guards the choice to insert boundaries through the DOM rather than regex-stripping
    // tags: .text() decodes entities, a tag-strip on raw HTML would not.
    const hits = extractEmails(page('<p>&#104;ello@acme.co.uk</p>'), 'acme.co.uk');
    assert.deepEqual(hits.map(h => h.email), ['hello@acme.co.uk']);
});

check('deduplicates and lowercases repeated addresses', () => {
    const hits = extractEmails(page(`
        <a href="mailto:Info@Acme.co.uk">a</a><p>info@acme.co.uk</p><p>INFO@ACME.CO.UK</p>`), 'acme.co.uk');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].email, 'info@acme.co.uk');
});

check('strips trailing sentence punctuation', () => {
    const hits = extractEmails(page('<p>Write to info@acme.co.uk.</p>'), 'acme.co.uk');
    assert.equal(hits[0].email, 'info@acme.co.uk');
});

check('strips mailto query params like ?subject=', () => {
    const hits = extractEmails(page('<a href="mailto:info@acme.co.uk?subject=Hello%20there">Us</a>'), 'acme.co.uk');
    assert.equal(hits[0].email, 'info@acme.co.uk');
});

check('a page with no contact address yields nothing', () => {
    assert.equal(extractEmails(page('<h1>Welcome</h1><p>Call 0800 000 000</p>'), 'acme.co.uk').length, 0);
});

console.log(`\n${passed} checks passed.`);
