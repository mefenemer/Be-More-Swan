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
