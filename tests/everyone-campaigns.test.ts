// tests/everyone-campaigns.test.ts
// The welcome sequence is just another email campaign (2026-10-07). It used to be special: one per
// org, and saving a chat/planner campaign for "everyone who subscribes" REPLACED its emails. Now
// any number may exist, only ONE may be on, and nothing is ever written over. What could regress:
//   · the old one-welcome-per-org index coming back (a second campaign → 23505)
//   · an import overwriting an existing campaign's emails again
//   · switching on a second "everyone" campaign silently, or failing without offering the swap
//   · enrolment picking an OFF campaign over the ON one
//   · the Studio addressing campaigns by trigger instead of by id
//
// Source scans. Run:  npx tsx tests/everyone-campaigns.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const slice = (s: string, from: string, to: string) => {
    const a = s.indexOf(from); const b = s.indexOf(to, a + 1);
    assert.ok(a >= 0, `landmark missing: ${from}`); assert.ok(b > a, `landmark missing: ${to}`);
    return s.slice(a, b);
};

const SQL = read('db/newsletter-sequences-everyone-campaigns.sql');
const SCHEMA = read('db/schema.ts');
const FN = read('netlify/functions/newsletter-sequences.ts');
const STUDIO = read('newsletter.js');

check('the migration drops both one-welcome indexes and allows only one ON everyone campaign', () => {
    assert.match(SQL, /DROP INDEX IF EXISTS newsletter_sequences_org_welcome_uidx;/);
    assert.match(SQL, /DROP INDEX IF EXISTS newsletter_sequences_assistant_welcome_uidx;/);
    assert.match(SQL, /CREATE UNIQUE INDEX IF NOT EXISTS newsletter_sequences_org_everyone_on_uidx\s+ON newsletter_sequences \(organisation_id\)\s+WHERE trigger_event = 'subscribed' AND is_enabled;/);
    assert.doesNotMatch(SCHEMA, /welcome_uidx/);
    assert.match(SCHEMA, /uniqueIndex\("newsletter_sequences_org_everyone_on_uidx"\)\.on\(t\.organisationId\)\.where\(sql`trigger_event = 'subscribed' AND is_enabled`\)/);
});

check('with no id, the ON campaign wins — in the endpoint and in enrolment', () => {
    assert.match(read('src/utils/newsletter-sequence.ts'), /\.orderBy\(desc\(newsletterSequences\.isEnabled\), asc\(newsletterSequences\.createdAt\)\)/);
    assert.ok((FN.match(/orderBy\(desc\(newsletterSequences\.isEnabled\), asc\(newsletterSequences\.createdAt\)\)/g) || []).length >= 3);
});

check('switching on a second everyone campaign asks, and takeOver swaps both in one transaction', () => {
    const en = slice(FN, "if (action === 'enable')", 'Say what switching off');
    assert.match(en, /if \(other && body\.takeOver !== true\)/);
    assert.match(en, /code: 'ANOTHER_EVERYONE_ON', otherId: other\.id, otherName: other\.name/);
    assert.ok(en.indexOf('isEnabled: false') < en.indexOf('isEnabled: enable'), 'the other goes off BEFORE this one goes on');
    assert.match(en, /db\.transaction/);
    assert.match(en, /=== '23505'/, 'a race on the index answers 409, not 500');
});

check('who receives it can change, but never to a second ON everyone campaign', () => {
    const st = slice(FN, "if (action === 'setTrigger')", "if (action === 'enable')");
    assert.match(st, /if \(to === 'subscribed' && sequence\.isEnabled\)/);
    assert.match(st, /code: 'ANOTHER_EVERYONE_ON'/);
    assert.match(st, /\.set\(\{ triggerEvent: to,/);
});

check('the Studio lists every campaign by id and offers the swap', () => {
    assert.match(STUDIO, /data-auto-seq="\$\{x\.id\}"/);
    assert.match(STUDIO, /seqState\.selectedId = Number\(b\.getAttribute\('data-auto-seq'\)\) \|\| null;/);
    assert.match(STUDIO, /<select id="nl-seq-trigger"/);
    assert.match(STUDIO, /action: 'setTrigger', trigger: to/);
    assert.match(STUDIO, /r\.status === 409 && res\.code === 'ANOTHER_EVERYONE_ON'/);
    assert.match(STUDIO, /takeOver: true/);
});

check('no surface still describes a one-and-only welcome sequence being replaced', () => {
    for (const f of ['newsletter.js', 'src/components/disruptive-ui-registry.js', 'src/components/chat-session.js', 'src/components/assistant-email-campaigns.js']) {
        assert.doesNotMatch(read(f), /Replace your welcome sequence|Replacing your welcome sequence|SEQUENCE_HAS_STEPS/, f);
    }
});

console.log(`\n${passed} checks passed`);
