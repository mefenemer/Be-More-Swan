// tests/lead-email-kind.test.ts
// The role-vs-personal classifier (src/config/lead-email-kind.ts) and its THREE writers — Phase 2
// item 9.
//
// `emailKind` decides which chip the Leads tab shows and whether the Review Queue asks a human to
// confirm before emailing an identified individual. It stands in for the GDPR footing of the
// contact, so the failure that matters is quiet and one-directional:
//
//   contactState() reads `emailKind === 'personal' ? 'personal' : 'role'`
//
// — an address stored with NO kind renders as "Role inbox", the green chip. A missing field does
// not look broken; it looks safe. Every writer of `contactEmail` must therefore also write a kind,
// which is what most of this file checks.
//
// Run:  npx tsx tests/lead-email-kind.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { classifyEmailKind, roleOrPersonal, ROLE_EMAIL_PREFIXES } from '../src/config/lead-email-kind';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

console.log('\n──── the classifier ────');

check('a generic company inbox is a role address', () => {
    for (const e of ['info@acme.co.uk', 'hello@acme.co.uk', 'enquiries@acme.co.uk', 'bookings@venue.com']) {
        assert.equal(classifyEmailKind(e), 'role', `${e} should be a role inbox`);
    }
});

check('a named individual is not', () => {
    for (const e of ['jane.smith@acme.co.uk', 'j.doe@acme.co.uk', 'rachel@acme.co.uk']) {
        assert.equal(classifyEmailKind(e), 'personal', `${e} should be a named person`);
    }
});

check('separators do not disguise a role inbox', () => {
    assert.equal(classifyEmailKind('front-desk@venue.com'), 'role');
    assert.equal(classifyEmailKind('contact.us@acme.co.uk'), 'role');
});

check('case and surrounding space are irrelevant', () => {
    assert.equal(classifyEmailKind('  INFO@Acme.co.uk '), 'role');
});

check('a non-address classifies as nothing, not as a role inbox', () => {
    // The fallbacks at both writers turn null into 'personal' — the cautious direction. Returning
    // 'role' here would launder junk into the green chip.
    for (const junk of ['', '   ', 'not an email', 'two@@acme.com', 'nobody@localhost', null, undefined]) {
        assert.equal(classifyEmailKind(junk as string), null, `${JSON.stringify(junk)} is not an address`);
    }
});

check('the domain is deliberately NOT checked', () => {
    // Unlike the scraper's classify(), which must reject the web agency's address on a page full of
    // other people's. A human who has gone and FOUND an address may well have found it on a
    // directory or a LinkedIn page, and rejecting an off-domain address would refuse the only
    // remedy the "None found" chip offers.
    assert.equal(classifyEmailKind('jane@some-other-domain.com'), 'personal');
    assert.equal(classifyEmailKind('info@gmail.com'), 'role');
});

console.log('\n──── one vocabulary, not three ────');

check('the scraper classifies through this module, not a copy of it', () => {
    const enrich = read('src/lib/discovery-enrich.ts');
    assert.ok(/roleOrPersonal/.test(enrich) && /config\/lead-email-kind/.test(enrich),
        'discovery-enrich.ts must import the shared rule');
    assert.ok(!/^const ROLE_PREFIXES = new Set\(/m.test(enrich),
        'the scraper has grown its own role-prefix list again — that is the drift this module ended');
});

check('the browser gets a generated mirror, never a hand-typed one', () => {
    // Memory of the platform allow-list: every hand copy of a shared vocabulary in this repo has
    // drifted, and the drift is always a silent user-visible bug rather than a crash.
    const generated = read('src/generated/platform-constants.js');
    assert.ok(/window\.LeadEmailKind/.test(generated), 'the classifier never reached the browser');
    for (const prefix of ROLE_EMAIL_PREFIXES) {
        assert.ok(generated.includes(`"${prefix}"`), `the generated vocabulary is missing "${prefix}"`);
    }
    const hub = read('src/components/assistant-data-hub.js');
    assert.ok(/window\.LeadEmailKind/.test(hub), 'the hub must classify through the generated mirror');
    assert.ok(!/'info', 'hello'/.test(hub), 'the hub has hand-copied the role prefixes');
});

check('an empty Set cannot reach the browser', () => {
    // JSON.stringify renders a Set as {}. That failure mode is invisible — no error, and EVERY
    // address quietly classifies as a named person.
    const generated = read('src/generated/platform-constants.js');
    assert.ok(/var ROLE_EMAIL_PREFIXES = new Set\(\["info"/.test(generated),
        'the generated vocabulary is empty or malformed — every address would read as a person');
});

console.log('\n──── every writer of an address writes a kind ────');

check('the chat "add lead" path stamps a kind beside its source', () => {
    const fn = read('netlify/functions/lead-generation.ts');
    const block = fn.slice(fn.indexOf('const submittedEmail'), fn.indexOf('const submittedEmail') + 400);
    assert.ok(/card\.emailSource = 'manual'/.test(block), 'the manual source stamp has moved');
    assert.ok(/card\.emailKind = classifyEmailKind\(submittedEmail\)/.test(block),
        'a manually added lead stores an address with no kind — it will render as "Role inbox" whoever it belongs to');
});

check('the Edit lead form stamps provenance when the address changes', () => {
    const hub = read('src/components/assistant-data-hub.js');
    assert.ok(/stampContactProvenance\(data, nextData\)/.test(hub),
        'the Edit lead submit no longer stamps provenance');
    const fn = hub.slice(hub.indexOf('function stampContactProvenance'), hub.indexOf('function openEditLeadModal'));
    assert.ok(/nextData\.emailSource = 'manual'/.test(fn), 'a typed address must record that a human supplied it');
    assert.ok(/nextData\.emailKind =/.test(fn), 'a typed address must record what kind of inbox it is');
});

check('an UNCHANGED address keeps its original provenance', () => {
    // The hazard worth a test of its own. Re-stamping on every save would rewrite a SCRAPED
    // address's source to 'manual', and the personal-inbox confirmation fires only on
    // `emailKind === 'personal' && emailSource === 'scrape'`. Opening this form and saving an
    // unrelated field would then permanently disarm that gate for the lead — a safety control
    // removed by an action that looks like editing a note.
    const hub = read('src/components/assistant-data-hub.js');
    const fn = hub.slice(hub.indexOf('function stampContactProvenance'), hub.indexOf('function openEditLeadModal'));
    assert.ok(/if \(before === after\) return;/.test(fn),
        'provenance is re-stamped on every save — this silently converts scraped addresses to manual ones');

    // And the gate it protects still reads both fields, so the above still matters.
    const inbox = read('netlify/functions/signal-inbox.ts');
    assert.ok(/emailKind === 'personal' && emailSource === 'scrape'/.test(inbox),
        'the personal-inbox gate changed shape — re-check what "manual" now exempts');
});

check('clearing the address clears the provenance with it', () => {
    const hub = read('src/components/assistant-data-hub.js');
    const fn = hub.slice(hub.indexOf('function stampContactProvenance'), hub.indexOf('function openEditLeadModal'));
    const cleared = fn.slice(fn.indexOf('if (!after)'));
    for (const key of ['emailKind', 'emailSource', 'emailFoundOn']) {
        assert.ok(new RegExp(`delete nextData\\.${key}`).test(cleared),
            `${key} outlives the address it describes — the next lead detail would show a kind for nothing`);
    }
});

console.log('\n──── the remedy is findable ────');

check('a lead with no address offers the fix on the record itself', () => {
    // The Contact chip has told users to "add an address by hand" since item 11 shipped, while the
    // only way to do it was an Email field inside a modal called "Edit lead". A remedy nobody can
    // find is not a remedy.
    const hub = read('src/components/assistant-data-hub.js');
    const actions = hub.slice(hub.indexOf('function detailActions'), hub.indexOf('function detailPanel'));
    assert.ok(/if \(!contactEmailOf\(record\)\)/.test(actions),
        'the add-an-address action is not conditional on the lead actually lacking one');
    assert.ok(/label: 'Add an address'/.test(actions), 'the action is gone or renamed');
    assert.ok(/focus: 'contactEmail'/.test(actions),
        'the button should land the cursor in the Email field it promised');
});

console.log(`\n${passed} checks passed.`);
