// tests/outreach-unsubscribe.test.ts
// Cold outreach to a prospect must carry a working way to make it stop.
//
// Before this, it did not. send_outreach and the follow-up cadence posted the drafted body verbatim
// with no footer, and gmail.ts/outlook.ts emitted no List-Unsubscribe header — `grep -r
// "List-Unsubscribe"` over the repo returned nothing. The ONLY opt-out route was a prospect
// happening to type "unsubscribe" into a reply, which src/config/opt-out.ts then matched. That is a
// detector, not a mechanism, and it left the product short of CAN-SPAM, CASL and the RFC 8058
// one-click Gmail and Yahoo now expect.
//
// The regressions worth guarding are all silent — an email still sends, the tenant sees a green
// tick, and the missing footer only surfaces as a complaint months later. So these are source
// assertions on the two send sites plus behavioural tests on the footer builder itself.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendOutreachFooter, buildOutreachFooter, isUsablePostalAddress, unsubscribeUrl } from '../src/config/outreach-footer';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const TOKEN = 'AbCdEfGhIjKlMnOpQrSt';

// ── 1. The footer always offers a way out ────────────────────────────────────

check('a footer with a token carries a clickable unsubscribe link', () => {
    const f = buildOutreachFooter({ senderName: 'Acme Ltd', replyToken: TOKEN });
    assert.ok(f.text.includes(unsubscribeUrl(TOKEN)), 'the link must appear in the visible body');
    assert.ok(f.listUnsubscribe?.includes(unsubscribeUrl(TOKEN)), 'and in the List-Unsubscribe header');
});

check('WITHOUT a token there is still an opt-out route, never a bare cold email', () => {
    // openLeadThread is best-effort — lead-generation.ts sends even when the thread write fails,
    // because a lead who never hears from us is worse than one whose replies are untracked. That
    // path has no token, and it must not be the path that ships a non-compliant email.
    const f = buildOutreachFooter({ senderName: 'Acme Ltd', replyToken: null });
    assert.equal(f.listUnsubscribe, null, 'no token means no header to advertise');
    assert.match(f.text, /UNSUBSCRIBE/,
        'the reply-word fallback must be present — it is the mechanism opt-out.ts already enforces');
});

check('the fallback instruction is one detectOptOut actually matches', async () => {
    // A fallback that told people to reply with a word the detector ignores would be worse than
    // useless: it would look compliant and silently do nothing.
    const { detectOptOut } = await import('../src/config/opt-out');
    const f = buildOutreachFooter({ senderName: 'Acme Ltd', replyToken: null });
    const wordMatch = f.text.match(/with the word ([A-Z]+)/);
    assert.ok(wordMatch, 'the fallback should name a specific word');
    assert.equal(detectOptOut(wordMatch![1]).optedOut, true,
        `opt-out.ts must recognise "${wordMatch![1]}" — the footer tells prospects to send it`);
});

// ── 1b. The postal-address gate ──────────────────────────────────────────────
// CAN-SPAM and CASL both require a physical address in every commercial email, so a send without
// one is blocked outright. Enforced while there are no live Lead Generators in production — the
// only moment a required field costs nothing to introduce.

check('isUsablePostalAddress rejects the values that satisfy a non-empty check', () => {
    // The whole point of validating beyond "not empty": a required field answered with "UK" passes
    // a presence test and satisfies no regulator.
    for (const bad of ['', '   ', 'UK', 'n/a', 'N/A', 'none', 'United Kingdom', 'Manchester', '12']) {
        assert.equal(isUsablePostalAddress(bad), false, `"${bad}" must not count as an address`);
    }
    for (const good of [
        '12 High Street, Manchester, M1 2AB, United Kingdom',
        'Unit 4, 12 High Street, Manchester M1 2AB',
        '1600 Pennsylvania Avenue NW, Washington, DC 20500',
    ]) {
        assert.equal(isUsablePostalAddress(good), true, `"${good}" must count as an address`);
    }
});

check('the browser mirror of the validator agrees with the server', () => {
    // assets.js reimplements this for the settings form — it cannot import TS. If the two drift so
    // the form is LOOSER, the field saves green and outreach silently stops with the reason only
    // in a function log, which is the worst failure this feature can produce.
    const js = read('assets.js');
    const at = landmark(js, 'function isUsablePostalAddress(value)');
    const body = js.slice(at, at + 500);
    assert.match(body, /v\.length < 10/, 'length floor must match the server');
    assert.match(body, /\/\\d\/\.test\(v\)/, 'digit requirement must match the server');
    assert.match(body, />= 3/, 'word-count floor must match the server');
});

check('both send paths refuse to send without a usable address', () => {
    const opener = read('netlify/functions/lead-generation.ts');
    assert.match(opener, /reason: 'no_postal_address'/,
        'send_outreach must block, not warn — a warning nobody reads is not compliance');
    // Before the draft: a blocked send should cost no Anthropic call and mint no lead_thread.
    assert.ok(
        landmark(opener, 'isUsablePostalAddress(orgRow?.postalAddress)') < landmark(opener, 'Mint the thread'),
        'the gate must run before the thread is opened and the draft generated',
    );

    const worker = read('netlify/functions/process-sequence-sends.ts');
    const at = landmark(worker, 'isUsablePostalAddress(orgRow?.postalAddress)');
    const block = worker.slice(at, at + 400);
    // SKIP, not halt: a missing address is a fixable config gap, and halts are not resumable.
    assert.match(block, /return 'skipped'/,
        'a follow-up must DEFER on a missing address, never halt — halting kills the cadence permanently');
    assert.ok(!/haltEnrolment/.test(block), 'must not halt the enrolment for a fixable setting');
});

check('the blocked send is explained in the UI', () => {
    const js = read('assistants.js');
    assert.match(js, /sdata\.reason === 'no_postal_address'/,
        'an unexplained non-send reads as a bug; this one is fixable by the user in one step');
});

check('the sender is identified, and the postal address is reported when missing', () => {
    const without = buildOutreachFooter({ senderName: 'Acme Ltd', replyToken: TOKEN });
    assert.ok(without.text.includes('Acme Ltd'), 'CASL and CAN-SPAM both require sender identity');
    assert.equal(without.hasPostalAddress, false);

    const withAddr = buildOutreachFooter({
        senderName: 'Acme Ltd', replyToken: TOKEN, postalAddress: '12 High Street, Manchester M1 2AB',
    });
    assert.ok(withAddr.text.includes('12 High Street, Manchester M1 2AB'));
    assert.equal(withAddr.hasPostalAddress, true);
});

check('appending never swallows the draft, and always separates from it', () => {
    const f = buildOutreachFooter({ senderName: 'Acme Ltd', replyToken: TOKEN });
    const out = appendOutreachFooter('Hi Sam,\n\nQuick question.\n\nBest,\nJo\n\n\n', f);
    assert.ok(out.startsWith('Hi Sam,'), 'the drafted body must survive intact');
    assert.ok(out.includes(unsubscribeUrl(TOKEN)));
    assert.ok(!/\n{4,}/.test(out), 'trailing whitespace in the draft must be collapsed, not stacked');
});

// ── 2. Both send sites use it ────────────────────────────────────────────────
// One send path carrying the footer and the other not is the likeliest regression here: the opener
// and the follow-ups are written in different files, by different code, months apart.

for (const [label, path, fn] of [
    ['the opener', 'netlify/functions/lead-generation.ts', "if (action === 'send_outreach')"],
    ['every follow-up', 'netlify/functions/process-sequence-sends.ts', 'const outgoing = {'],
] as const) {
    check(`${label} sends the body WITH the footer appended`, () => {
        const src = read(path);
        const from = landmark(src, fn);
        const slice = src.slice(from);
        const outgoing = slice.slice(landmark(slice, 'const outgoing = {'));
        const body = outgoing.slice(0, landmark(outgoing, '};'));
        assert.match(body, /body:\s*appendOutreachFooter\(/,
            `${path} must append the compliance footer to the body it actually sends`);
        assert.match(body, /listUnsubscribe/,
            `${path} must advertise List-Unsubscribe on the outgoing message`);
    });
}

check('the stored transcript keeps the un-footered body', () => {
    // recordOutboundMessage feeds the thread view and the template-feedback loop. Storing the
    // footered text would stamp identical boilerplate on every message and make an edited draft
    // harder to distinguish from an unedited one — which is the one thing that loop reads.
    const src = read('netlify/functions/lead-generation.ts');
    const from = landmark(src, 'await recordOutboundMessage(');
    const call = src.slice(from, from + 400);
    assert.ok(!call.includes('appendOutreachFooter'),
        'the stored message should be what the assistant wrote, not the boilerplate around it');
});

// ── 3. The headers are real, on both providers ───────────────────────────────

check('gmail.ts emits the RFC 8058 pair, not just List-Unsubscribe', () => {
    const src = read('src/utils/gmail.ts');
    assert.match(src, /List-Unsubscribe: \$\{listUnsubscribe\}/);
    assert.match(src, /List-Unsubscribe-Post: List-Unsubscribe=One-Click/,
        'without the -Post header Gmail will not render one-click unsubscribe');
});

check('outlook.ts sends them through internetMessageHeaders', () => {
    const src = read('src/utils/outlook.ts');
    // Anchored on the property, not the bare word: the explanatory comment above it mentions
    // `internetMessageHeaders` first, and a landmark that lands in a comment slices the wrong
    // region and reports a false red.
    const from = landmark(src, 'internetMessageHeaders: [');
    const block = src.slice(from, from + 400);
    assert.match(block, /'List-Unsubscribe'/);
    assert.match(block, /'List-Unsubscribe-Post'/);
});

check('both transports strip CR/LF from the header value', () => {
    // The value is derived from a URL carrying a token. Unstripped, a crafted token would let a
    // caller forge arbitrary MIME headers on the tenant's own mailbox.
    for (const p of ['src/utils/gmail.ts', 'src/utils/outlook.ts']) {
        const src = read(p);
        const from = landmark(src, 'listUnsubscribe');
        assert.match(src.slice(from, from + 600), /replace\(\/\[\\r\\n\]\+\/g/, `${p} must strip CR/LF`);
    }
});

// ── 4. The endpoint honours the one-click contract ───────────────────────────

check('lead-unsubscribe answers POST (one-click) as well as GET', () => {
    const src = read('netlify/functions/lead-unsubscribe.ts');
    assert.match(src, /const oneClick = method === 'POST'/,
        'Gmail and Yahoo fire a POST with no user interaction — a GET-only endpoint silently fails them');
    assert.ok(src.includes("method === 'HEAD'"),
        'link scanners pre-fetch; a HEAD must not opt the prospect out on their behalf');
});

check('lead-unsubscribe records at ADDRESS grain, not domain', () => {
    const src = read('netlify/functions/lead-unsubscribe.ts');
    assert.ok(src.includes('leadOptOuts'), 'must write lead_opt_outs');
    assert.ok(!src.includes('suppressionList'),
        'suppression_list is DOMAIN-grained — one person opting out must not suppress their employer');
    assert.match(src, /onConflictDoNothing/, 'clicking twice must not error');
});

check('an opt-out closes the thread and halts the cadence', () => {
    const src = read('netlify/functions/lead-unsubscribe.ts');
    assert.ok(src.includes('haltEnrolmentsForThread'),
        'a follow-up landing after someone pressed unsubscribe is the worst outcome available here');
    assert.match(src, /state: 'closed'/);
});

check("'link' is permitted by the source CHECK constraint in BOTH the DDL and schema.ts", () => {
    // The halt_reason trap: db/schema.ts carries a mirrored check(), and forgetting it means
    // drizzle-kit push silently reverts the DDL. The insert then raises a check violation, the
    // opt-out goes unrecorded, and the prospect keeps being emailed.
    const schema = read('db/schema.ts');
    const from = landmark(schema, 'lead_opt_outs_source_check');
    assert.match(schema.slice(from, from + 200), /'link'/,
        "schema.ts's mirrored constraint must allow source='link'");

    const ddl = read('db/lead-outreach-unsubscribe.sql');
    assert.match(ddl, /DROP CONSTRAINT lead_opt_outs_source_check/,
        'a guarded ADD is a no-op against the existing narrower constraint — it must DROP then ADD');
    assert.match(ddl, /CHECK \(source IN \('reply','manual','bounce','link'\)\)/);
});

console.log(`\n${passed} checks passed\n`);
