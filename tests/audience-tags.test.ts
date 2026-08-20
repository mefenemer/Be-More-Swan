// tests/audience-tags.test.ts
// Tags: labels a tenant attaches to people, and then composes into an audience.
//
// ⚠️ THE DESIGN DECISION THIS FILE GUARDS. A tag is a segment with kind = 'tag' — the SAME
// membership table, the same writes, the same four readers. A separate audience_tags table would be
// a second answer to "who is in this group", and in this product that question means "who receives
// an email". Two sources of truth for that is what this schema has spent several migrations
// avoiding. If a future change starts building a tags table, this file should fail first.
//
// What follows from the decision, and is checked here:
//   1. The kind vocabulary is widened without dropping a value (the constraint is re-created).
//   2. A rule can compose a tag — that is the whole point of having them.
//   3. A rule may NOT be built on a dynamic segment: a rule over a rule is a cycle.
//   4. The tag subquery is org-scoped inside the EXISTS.
//   5. Controls that would report success and change nothing are refused, not hidden.

import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PgDialect } from 'drizzle-orm/pg-core';
import { landmark } from './landmark';
import {
    buildSegmentCondition, checkRuleReferences, describeRules, parseRules,
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

const SQL = read('db/audience-tags.sql');
const AUDIENCE_SQL = read('db/audience.sql');
const SCHEMA = read('db/schema.ts');
const RULES = read('src/utils/audience-segment-rules.ts');
const SEGMENTS = read('netlify/functions/audience-segments.ts');
const CONTACTS = read('netlify/functions/audience-contacts.ts');
const UI = read('audience.js');
const NL_UI = read('newsletter.js');

const dialect = new PgDialect();
const render = (rules: unknown) => {
    const cond = buildSegmentCondition(42, rules);
    assert.ok(cond, 'expected these rules to compile');
    return dialect.sqlToQuery(cond!);
};

/** Answers the one lookup checkRuleReferences makes. */
function fakeDb(rows: { id: number; kind: string; name: string }[]) {
    const chain: any = new Proxy({}, {
        get(_t, prop) {
            if (prop === 'then') return (resolve: (r: unknown) => void) => resolve(rows);
            return () => chain;
        },
    });
    return { select: () => chain } as any;
}

async function main() {

// ── 1. A tag is not a new table ─────────────────────────────────────────────

await check('there is no separate tags table', () => {
    // The membership, the tenancy re-check and the cascade rules already exist for segments.
    const dbFiles = readdirSync(join(root, 'db')).filter((f) => f.endsWith('.sql'));
    for (const f of dbFiles) {
        const src = readFileSync(join(root, 'db', f), 'utf8');
        assert.ok(!/CREATE TABLE IF NOT EXISTS audience_tags\b/.test(src),
            `${f} creates an audience_tags table — a tag is a segment with kind = 'tag'`);
    }
    assert.match(SQL, /WHY THERE IS NO audience_tags TABLE/);
});

await check("the kind vocabulary is widened, and nothing is dropped", () => {
    const before = [...AUDIENCE_SQL.slice(landmark(AUDIENCE_SQL, 'audience_segments_kind_check'))
        .slice(0, 400).matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    assert.ok(before.includes('manual') && before.includes('dynamic'), 'the old list was found');
    const after = SQL.slice(landmark(SQL, 'ADD CONSTRAINT audience_segments_kind_check'), landmark(SQL, 'ADD CONSTRAINT audience_segments_kind_check') + 200);
    for (const v of before) assert.ok(after.includes(`'${v}'`), `widening dropped '${v}'`);
    assert.match(after, /'tag'/);
    // DROP + ADD, because db/audience.sql adds its version only IF NOT EXISTS.
    assert.match(SQL, /DROP CONSTRAINT IF EXISTS audience_segments_kind_check/);
    // And the drizzle mirror, which a test in audience-consent.test.ts style would otherwise catch late.
    assert.match(SCHEMA, /audience_segments_kind_check[\s\S]{0,160}'tag'/);
});

// ── 2. A rule can compose a tag ─────────────────────────────────────────────

await check('"is tagged X" compiles to an org-scoped EXISTS', () => {
    const q = render({ match: 'all', conditions: [{ field: 'tag', op: 'in', value: 5 }] });
    assert.match(q.sql, /EXISTS/);
    assert.match(q.sql, /"audience_contact_segments"/);
    // ⚠️ The organisation is re-asserted inside, through the segment row.
    assert.match(q.sql, /"audience_segments"\."organisation_id" =/);
    assert.ok(q.params.includes(42));
});

await check('"is not tagged X" is the negation of the same subquery', () => {
    assert.match(render({ match: 'all', conditions: [{ field: 'tag', op: 'not_in', value: 5 }] }).sql, /NOT EXISTS/);
});

await check('a tag condition needs a real reference, not a blank', () => {
    for (const v of [0, -1, 'abc', null, undefined]) {
        assert.strictEqual(parseRules({ match: 'all', conditions: [{ field: 'tag', op: 'in', value: v }] }).ok, false);
    }
    assert.ok(parseRules({ match: 'all', conditions: [{ field: 'tag', op: 'in', value: 5 }] }).ok);
});

await check('the sentence names the tag rather than its id', () => {
    const text = describeRules(
        { match: 'all', conditions: [{ field: 'tag', op: 'in', value: 5 }] },
        undefined,
        new Map([[5, 'Bought something']]),
    );
    assert.match(text, /is tagged Bought something/);
});

// ── 3. A rule over a rule is refused ────────────────────────────────────────

await check('a rule cannot be built on a dynamic segment', () => {
    // A cycle waiting to be written, and the first one would be found by whichever send hit it.
    return checkRuleReferences(fakeDb([{ id: 9, kind: 'dynamic', name: 'Recently engaged' }]), 1,
        { match: 'all', conditions: [{ field: 'tag', op: 'in', value: 9 }] })
        .then((err) => {
            assert.ok(err, 'it must be refused');
            assert.match(err!, /itself a rule-based segment/);
            assert.match(err!, /Recently engaged/, 'and it names which one');
        });
});

await check('a rule pointing at a tag that is gone is refused', () => {
    return checkRuleReferences(fakeDb([]), 1,
        { match: 'all', conditions: [{ field: 'tag', op: 'in', value: 9 }] })
        .then((err) => assert.match(err!, /no longer exists/));
});

await check('a tag or manual segment reference is accepted', async () => {
    for (const kind of ['tag', 'manual']) {
        const err = await checkRuleReferences(fakeDb([{ id: 9, kind, name: 'Customers' }]), 1,
            { match: 'all', conditions: [{ field: 'tag', op: 'in', value: 9 }] });
        assert.strictEqual(err, null, `${kind} must be allowed`);
    }
});

await check('a rule with no tag condition makes no lookup at all', () => {
    const exploding = { select: () => { throw new Error('must not query'); } } as any;
    return checkRuleReferences(exploding, 1, { match: 'all', conditions: [{ field: 'emailed', op: 'never' }] })
        .then((err) => assert.strictEqual(err, null));
});

await check('every write path checks the references, not just the shape', () => {
    for (const action of ["if (action === 'preview')", "if (action === 'create')", "if (action === 'setRules')"]) {
        const from = landmark(SEGMENTS, action);
        assert.ok(SEGMENTS.slice(from, from + 1400).includes('checkRuleReferences'),
            `${action} must validate what the rule points at`);
    }
});

// ── 4. Controls that would do nothing are refused ───────────────────────────

await check('a dynamic segment still refuses hand-added members', () => {
    const fn = CONTACTS.slice(landmark(CONTACTS, "if (action === 'segment')"), landmark(CONTACTS, "if (action === 'import')"));
    assert.match(fn, /seg\.kind === 'dynamic'/);
});

await check('"add to segment" does not offer tags or rule-based segments', () => {
    // There is a Tag button for the first, and the second works its own members out.
    // ⚠️ Bounded FORWARDS: the bulk-tag handler is wired earlier in the file, so slicing to it
    // would run backwards and match the empty string.
    const fn = UI.slice(landmark(UI, "const bulkSegment = $('aud-bulk-segment')"), landmark(UI, '// Detail panel'));
    assert.match(fn, /x\.kind !== 'dynamic' && x\.kind !== 'tag'|s\.kind !== 'dynamic' && s\.kind !== 'tag'/);
});

await check('the rule builder only offers non-dynamic targets for a tag condition', () => {
    const fn = UI.slice(landmark(UI, "spec.value === 'tag'"), landmark(UI, "spec.value === 'form'"));
    assert.match(fn, /x\.kind !== 'dynamic'/);
});

// ── 5. Two rows, one meaning ────────────────────────────────────────────────

await check('tags and segments are drawn separately but rendered by one function', () => {
    // Same chips, same handler: they are the same thing, shown apart so forty labels do not bury
    // four sendable audiences.
    assert.match(UI, /function renderChips/);
    const fn = UI.slice(landmark(UI, 'function renderSegments'), landmark(UI, 'function renderChips'));
    assert.match(fn, /kind !== 'tag'/);
    assert.match(fn, /kind === 'tag'/);
});

await check('the newsletter audience picker groups them, and still offers both', () => {
    // A tag IS a valid audience — grouping is for the person choosing, not a restriction.
    assert.match(NL_UI, /<optgroup label="Segments">/);
    assert.match(NL_UI, /<optgroup label="Tags">/);
});

console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
