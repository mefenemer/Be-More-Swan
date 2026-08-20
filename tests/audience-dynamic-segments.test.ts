// tests/audience-dynamic-segments.test.ts
// A segment that is a saved RULE rather than a hand-kept list.
//
// The rule compiles to the WHERE clause of a SEND, so the failure that matters is not "the segment
// is wrong" — it is "the segment is WIDER than the tenant believes". Every check here is a way that
// happens:
//
//   1. An empty rule compiling to TRUE. Delete your last condition, press save, email everyone.
//   2. A condition we cannot read being SKIPPED. Dropping "opened in the last 90 days" from a
//      three-condition rule silently triples the audience.
//   3. "match" defaulting to 'any'. The wider joiner must never be the fallback.
//   4. The send falling back to the whole audience when the segment or its rules are gone.
//   5. The preview and the send asking different questions — a disagreement only the recipients
//      ever discover.
//   6. The engagement subquery reading another tenant's send ledger.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PgDialect } from 'drizzle-orm/pg-core';
import { landmark } from './landmark';
import {
    buildSegmentCondition, describeRules, parseRules, MAX_CONDITIONS, MAX_DAYS,
} from '../src/utils/audience-segment-rules';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
    const ok = () => { passed++; console.log(`  ✓ ${name}`); };
    const bad = (err: unknown) => {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
        process.exitCode = 1;
    };
    try {
        const out = fn();
        if (out && typeof (out as Promise<void>).then === 'function') return (out as Promise<void>).then(ok, bad);
        ok();
    } catch (err) { bad(err); }
    return Promise.resolve();
}

const RULES = read('src/utils/audience-segment-rules.ts');
const SEND = read('src/utils/newsletter-send.ts');
const ISSUES = read('netlify/functions/newsletter-issues.ts');
const SEGMENTS = read('netlify/functions/audience-segments.ts');
const CONTACTS = read('netlify/functions/audience-contacts.ts');

const dialect = new PgDialect();
const render = (rules: unknown) => {
    const cond = buildSegmentCondition(42, rules);
    assert.ok(cond, 'expected these rules to compile');
    return dialect.sqlToQuery(cond!);
};

const opened90 = { match: 'all', conditions: [{ field: 'opened', op: 'within', value: 90 }] };

async function main() {

// ── 1. Nothing compiles to "everyone" ───────────────────────────────────────

await check('an empty rule set is refused, not read as "everyone"', () => {
    for (const empty of [{}, { match: 'all' }, { match: 'all', conditions: [] }, null, undefined]) {
        const r = parseRules(empty);
        assert.strictEqual(r.ok, false, `${JSON.stringify(empty)} must not compile`);
        assert.match((r as { error: string }).error, /match your whole audience/);
    }
    assert.strictEqual(buildSegmentCondition(1, {}), null, 'and it compiles to null, never a bare TRUE');
});

await check('an unreadable condition fails the WHOLE rule', () => {
    // ⚠️ Skipping it is the dangerous default: dropping one condition widens the audience.
    const r = parseRules({ match: 'all', conditions: [
        { field: 'opened', op: 'within', value: 90 },
        { field: 'astrology_sign', op: 'is', value: 'leo' },
    ] });
    assert.strictEqual(r.ok, false);
    assert.match((r as { error: string }).error, /Condition 2/, 'and it says which one');
});

await check('an unknown comparison is refused too', () => {
    const r = parseRules({ match: 'all', conditions: [{ field: 'source', op: 'contains', value: 'web_form' }] });
    assert.strictEqual(r.ok, false);
    assert.match((r as { error: string }).error, /comparison/);
});

await check('"match" defaults to ALL, the narrower joiner', () => {
    // 'any' is the wider one, so it must never be what an absent value means.
    const r = parseRules({ conditions: [{ field: 'emailed', op: 'never' }] });
    assert.ok(r.ok);
    assert.strictEqual((r as { rules: { match: string } }).rules.match, 'all');
    assert.strictEqual(parseRules({ match: 'nonsense', conditions: [{ field: 'emailed', op: 'never' }] }).ok
        && (parseRules({ match: 'nonsense', conditions: [{ field: 'emailed', op: 'never' }] }) as any).rules.match, 'all');
});

// ── 2. Values are checked, not trusted ──────────────────────────────────────

await check('a day count outside its range is refused', () => {
    for (const days of [0, -5, MAX_DAYS + 1, 'soon', null]) {
        const r = parseRules({ match: 'all', conditions: [{ field: 'opened', op: 'within', value: days }] });
        assert.strictEqual(r.ok, false, `${days} must be refused`);
    }
    assert.ok(parseRules({ match: 'all', conditions: [{ field: 'opened', op: 'within', value: 90 }] }).ok);
});

await check('a source we do not have is refused', () => {
    assert.strictEqual(parseRules({ match: 'all', conditions: [{ field: 'source', op: 'is', value: 'carrier_pigeon' }] }).ok, false);
    assert.ok(parseRules({ match: 'all', conditions: [{ field: 'source', op: 'is', value: 'web_form' }] }).ok);
});

await check('a domain has to look like a domain, and is lower-cased', () => {
    assert.strictEqual(parseRules({ match: 'all', conditions: [{ field: 'email_domain', op: 'is', value: 'not a domain' }] }).ok, false);
    const r = parseRules({ match: 'all', conditions: [{ field: 'email_domain', op: 'is', value: '  GMAIL.com ' }] });
    assert.ok(r.ok);
    assert.strictEqual((r as any).rules.conditions[0].value, 'gmail.com');
});

await check('a rule nobody could read is refused for being too long', () => {
    const conditions = Array.from({ length: MAX_CONDITIONS + 1 }, () => ({ field: 'emailed', op: 'never' }));
    assert.strictEqual(parseRules({ match: 'all', conditions }).ok, false);
});

// ── 3. What it compiles to ──────────────────────────────────────────────────

await check('"opened in the last 90 days" is an org-scoped EXISTS', () => {
    // ⚠️ Scoped INSIDE the subquery: a segment that could see another tenant's send ledger would be
    // a cross-tenant read in the one place nobody would look for one.
    const q = render(opened90);
    assert.match(q.sql, /EXISTS/);
    assert.match(q.sql, /"newsletter_sends"\."organisation_id" =/);
    assert.ok(q.params.includes(42), 'the organisation id is bound, not interpolated');
    assert.match(q.sql, /"opened_at" IS NOT NULL/);
});

await check('"has not opened" is the negation of the same subquery', () => {
    const q = render({ match: 'all', conditions: [{ field: 'opened', op: 'not_within', value: 30 }] });
    assert.match(q.sql, /NOT EXISTS/);
});

await check('a domain match is anchored on the @', () => {
    // Otherwise "notgmail.com" matches "gmail.com".
    const q = render({ match: 'all', conditions: [{ field: 'email_domain', op: 'is', value: 'gmail.com' }] });
    assert.ok(q.params.includes('%@gmail.com'), `expected an anchored pattern, got ${JSON.stringify(q.params)}`);
});

await check('all/any compile to and/or', () => {
    const two = [{ field: 'emailed', op: 'never' }, { field: 'source', op: 'is', value: 'web_form' }];
    assert.match(render({ match: 'all', conditions: two }).sql, / and /);
    assert.match(render({ match: 'any', conditions: two }).sql, / or /);
});

await check('a day boundary is bound as an ISO string, not a Date', () => {
    // A JS Date binds as timestamptz against a plain TIMESTAMP column and is coerced through the
    // server's TimeZone — the trap this repo has hit repeatedly.
    const q = render(opened90);
    for (const p of q.params) assert.ok(!(p instanceof Date), 'no Date may reach the driver');
    assert.ok(q.params.some((p) => typeof p === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(p)));
});

// ── 4. The sentence beside the number ───────────────────────────────────────

await check('a rule reads back as English', () => {
    const text = describeRules({ match: 'all', conditions: [
        { field: 'source', op: 'is', value: 'web_form' },
        { field: 'opened', op: 'within', value: 90 },
    ] });
    assert.match(text, /joined through a sign-up form/);
    assert.match(text, /opened an email in the last 90 days/);
    assert.match(text, / and /);
});

await check('a broken rule describes itself as broken, not as a segment', () => {
    // A confident sentence over a rule that will not compile is how somebody sends to the wrong list.
    assert.match(describeRules({ match: 'all', conditions: [] }), /match your whole audience/);
});

// ── 5. One compiler, every caller ───────────────────────────────────────────

await check('the send, the estimate and the browse all ask the same compiler', () => {
    for (const [name, src] of [['newsletter-send', SEND], ['newsletter-issues', ISSUES], ['audience-contacts', CONTACTS], ['audience-segments', SEGMENTS]] as const) {
        assert.match(src, /buildSegmentCondition/, `${name} must not re-implement the rule`);
    }
});

await check('a missing segment fails the send instead of widening it', () => {
    const fn = SEND.slice(landmark(SEND, 'export async function materialiseRecipients'), landmark(SEND, 'async function materialiseFromAudience'));
    assert.match(fn, /no longer exists/);
    assert.match(fn, /throw new Error/);
    assert.ok(landmark(fn, 'if (!row)') < landmark(fn, 'for (;;)'), 'and it stops before any recipient is written');
});

await check('rules that will not compile fail the send, with the reason on the issue', () => {
    const fn = SEND.slice(landmark(SEND, 'export async function materialiseRecipients'), landmark(SEND, 'async function materialiseFromAudience'));
    assert.match(fn, /could not be read/);
    assert.match(fn, /nothing was sent/, 'the tenant is told the send did not half-happen');
});

await check('a broken rule shows NOBODY in the audience list, not everybody', () => {
    assert.match(CONTACTS, /segmentIsDynamic && !dynamicRule/);
    assert.match(CONTACTS, /nobody is being shown/);
});

await check('a dynamic segment refuses hand-added members', () => {
    // Membership rows are not read for it, so the button would report success and change nothing.
    const fn = CONTACTS.slice(landmark(CONTACTS, "if (action === 'segment')"), landmark(CONTACTS, "if (action === 'import')"));
    assert.match(fn, /seg\.kind === 'dynamic'/);
    assert.match(fn, /decides its own members from its rules/);
});

await check('the segment list counts dynamic segments through the rule', () => {
    // The membership join counts 0 for them, which would read as "this segment is empty" for a
    // rule matching four hundred people.
    assert.match(SEGMENTS, /A DYNAMIC SEGMENT HAS NO MEMBERSHIP ROWS/);
    assert.match(SEGMENTS, /rulesError/);
});

await check('nothing is materialised, so nothing can go stale', () => {
    assert.match(RULES, /never stored/i);
    assert.ok(!/INSERT INTO audience_contact_segments/i.test(RULES));
});

console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
