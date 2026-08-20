// tests/audience-custom-fields.test.ts
// The tenant's own columns — "City", "Plan", "Where we met".
//
// The column has existed since audience_contacts was written and nothing wrote to it. Making it
// real means letting tenant-supplied keys and values reach three dangerous places, and every check
// here is one of them:
//
//   1. ⚠️ INTO EVERY CONTACT'S JSONB. The browser sends whatever its mapper produced; without an
//      allow-list a crafted request writes arbitrary keys nothing lists and nothing can clean up.
//   2. ⚠️ INTO AN EMAIL. A custom merge tag with no fallback prints nothing for everyone we hold no
//      value for — "our new shop in ." — and nobody sees it until it has gone out.
//   3. ⚠️ INTO THE WHERE CLAUSE OF A SEND. "plan is not premium" must include the people we hold no
//      plan for, or the segment quietly excludes most of the list.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PgDialect } from 'drizzle-orm/pg-core';
import { landmark } from './landmark';
import { buildSegmentCondition, checkRuleReferences, parseRules } from '../src/utils/audience-segment-rules';
import { scrubMergeTags } from '../src/utils/newsletter-generate';
import { contactMergeContext, customMergeKeys, sampleMergeContext } from '../src/config/newsletter-merge-vars';
import { keyFromLabel } from '../netlify/functions/audience-custom-fields';
import { pickDefined } from '../netlify/functions/audience-contacts';

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

const SQL = read('db/audience-custom-fields.sql');
const API = read('netlify/functions/audience-custom-fields.ts');
const CONTACTS = read('netlify/functions/audience-contacts.ts');
const STORE = read('src/utils/audience-store.ts');
const SEND = read('src/utils/newsletter-send.ts');
const SEQ = read('src/utils/newsletter-sequence.ts');

const dialect = new PgDialect();
const render = (rules: unknown) => {
    const cond = buildSegmentCondition(42, rules);
    assert.ok(cond, 'expected these rules to compile');
    return dialect.sqlToQuery(cond!);
};
const custom = (op: string, value?: string) => ({
    match: 'all', conditions: [{ field: 'custom', op, key: 'city', ...(value ? { value } : {}) }],
});

async function main() {

// ── 1. The key is the permanent thing ───────────────────────────────────────

await check('a label becomes a key that will still be legal in a year', () => {
    assert.strictEqual(keyFromLabel('City'), 'city');
    assert.strictEqual(keyFromLabel('  Where we met  '), 'where_we_met');
    assert.strictEqual(keyFromLabel('Plan (2026)'), 'plan_2026');
    // Must start with a letter — the CHECK constraint says so, and it is also a merge-tag path.
    assert.match(keyFromLabel('2nd choice'), /^[a-z]/);
    assert.ok(keyFromLabel('x'.repeat(80)).length <= 40);
    for (const label of ['City', 'Where we met', 'Plan (2026)', '2nd choice']) {
        assert.match(keyFromLabel(label), /^[a-z][a-z0-9_]{0,39}$/, `${label} must satisfy the constraint`);
    }
});

await check('rename changes the label and never the key', () => {
    // The key is the JSONB key on every contact and the value in every saved rule.
    const fn = API.slice(landmark(API, "if (action === 'rename')"), landmark(API, "if (action === 'delete')"));
    assert.ok(!fn.includes('keyFromLabel'), 'a rename must not re-derive the key');
    assert.match(fn, /set\(\{ label/);
    assert.match(API, /THE KEY IS NEVER RENAMED/);
});

await check('numbers and dates are reserved in the schema and refused by the API', () => {
    // Reserved so adding them later is not a migration of every row; refused because comparing them
    // means casting tenant-entered text, which throws mid-send on the first "about 40".
    assert.match(SQL, /CHECK \(type IN \('text','number','date'\)\)/);
    assert.match(API, /Only text fields are supported/);
    assert.match(SQL, /22P02/, 'and the reason is written down, not just the rule');
});

// ── 2. Nothing unknown reaches the JSONB ────────────────────────────────────

await check('only defined keys are stored, whatever the browser sends', () => {
    const allowed = new Set(['city', 'plan']);
    const out = pickDefined({ city: ' Bristol ', plan: 'pro', sneaky: 'x', __proto__: 'y' }, allowed);
    assert.deepStrictEqual(Object.keys(out).sort(), ['city', 'plan']);
    assert.strictEqual(out.city, 'Bristol', 'and values are trimmed');
});

await check('a blank cell is not a value', () => {
    // Otherwise "has a city" is true for somebody whose city column was empty.
    assert.deepStrictEqual(pickDefined({ city: '   ' }, new Set(['city'])), {});
    assert.deepStrictEqual(pickDefined(null, new Set(['city'])), {});
    assert.deepStrictEqual(pickDefined('nope' as unknown, new Set(['city'])), {});
});

await check('a value is bounded', () => {
    const out = pickDefined({ city: 'x'.repeat(2000) }, new Set(['city']));
    assert.ok(out.city.length <= 500);
});

await check('a re-import MERGES custom values rather than replacing or ignoring them', () => {
    // Replacing would erase every field not in the new file; ignoring (the behaviour before custom
    // fields existed) would mean a second import could never fill anything in.
    // ⚠️ BOTH upsert paths, not one. audience-store.ts has two onConflictDoUpdate blocks — the
    // single-contact upsert a form submission uses, and the bulk one the importer uses — and this
    // check originally read only the first, which is how the single path was found to be missing it.
    const blocks = [...STORE.matchAll(/onConflictDoUpdate\(\{[\s\S]*?\n        \}\)/g)].map((m) => m[0]);
    assert.strictEqual(blocks.length, 2, 'expected the single and bulk upserts');
    for (const b of blocks) {
        assert.match(b, /customFields: sql`\$\{audienceContacts\.customFields\} \|\| EXCLUDED\.custom_fields`/,
            'every upsert path must merge custom values');
    }
});

await check('editing one field does not erase the others, and blanking one removes it', () => {
    const fn = CONTACTS.slice(landmark(CONTACTS, "if (action === 'update')"), landmark(CONTACTS, "if (action === 'status')"));
    assert.match(fn, /pickDefined\(body\.custom, customKeys\)/, 'the same allow-list as the import');
    assert.match(fn, /\|\| \$\{JSON\.stringify\(clean\)\}::jsonb/, 'merged, not replaced');
    assert.match(fn, /cleared/, 'and an explicitly blanked key is removed');
});

// ── 3. Nothing unresolvable reaches an inbox ────────────────────────────────

await check('a custom tag WITH a fallback survives the scrub', () => {
    const { text, warnings } = scrubMergeTags('Hi, your shop in {{contact.custom.city | "your area"}}.', ['city']);
    assert.match(text, /\{\{contact\.custom\.city \| "your area"\}\}/);
    assert.deepStrictEqual(warnings, []);
});

await check('a custom tag WITHOUT a fallback is removed and reported', () => {
    // ⚠️ There is no honest default for a field called "City", and an empty render is
    // "our new shop in ." in every inbox where we hold no value.
    const { text, warnings } = scrubMergeTags('Our shop in {{contact.custom.city}} is open.', ['city']);
    assert.ok(!text.includes('contact.custom.city'), 'the tag must not survive');
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /needs a fallback/);
});

await check('a custom tag for a field this org has NOT defined is stripped as unknown', () => {
    const { text, warnings } = scrubMergeTags('Hi {{contact.custom.secret | "x"}}', []);
    assert.ok(!text.includes('contact.custom.secret'));
    assert.ok(warnings.length >= 1);
});

await check('the built-in vocabulary is unchanged by all this', () => {
    const { text, warnings } = scrubMergeTags('Hi {{contact.first_name | "there"}}', ['city']);
    assert.match(text, /contact\.first_name/);
    assert.deepStrictEqual(warnings, []);
    assert.deepStrictEqual(customMergeKeys(['city', 'plan']), ['contact.custom.city', 'contact.custom.plan']);
});

await check('the send context carries the values, and only printable ones', () => {
    const ctx = contactMergeContext(
        { firstName: 'Jane', customFields: { city: 'Bristol', nested: { a: 1 }, empty: null } },
        'Acme',
    ) as { contact: { custom: Record<string, string> } };
    assert.strictEqual(ctx.contact.custom.city, 'Bristol');
    // An object would render as "[object Object]" in an email.
    assert.ok(!('nested' in ctx.contact.custom));
    assert.ok(!('empty' in ctx.contact.custom));
});

await check('the preview shows the field NAME as its sample value', () => {
    // "City" reading "City" is unambiguous; a made-up "Bristol" is not.
    const ctx = sampleMergeContext('Acme', [{ key: 'city', label: 'City' }]) as { contact: { custom: Record<string, string> } };
    assert.strictEqual(ctx.contact.custom.city, 'City');
});

await check('both send workers actually SELECT the values', () => {
    // ⚠️ Without this every custom tag renders its fallback for everyone — the personalisation
    // silently does nothing, and looks like it worked because the sentence still reads.
    for (const [name, src] of [['issue send', SEND], ['welcome sequence', SEQ]] as const) {
        assert.match(src, /customFields: audienceContacts\.customFields/, `${name} must read the values`);
    }
});

// ── 4. Nothing surprising reaches the WHERE clause ──────────────────────────

await check('"is not" also matches the people we hold no value for', () => {
    // ⚠️ THE ONE THAT WOULD BE FOUND BY THE RECIPIENTS. Without the IS NULL arm, "plan is not
    // premium" excludes everyone with no plan on file — usually most of the list.
    const q = render(custom('is_not', 'premium'));
    assert.match(q.sql, /IS NULL OR NOT/);
    const positive = render(custom('is', 'premium'));
    assert.ok(!/IS NULL/.test(positive.sql), 'while "is" stays a plain match');
});

await check('comparisons are case-insensitive on both sides', () => {
    // Tenant-typed data on both sides: "Bristol" not matching "bristol" is a segment that looks
    // broken for a reason nobody can see.
    assert.match(render(custom('is', 'bristol')).sql, /lower\(/);
    assert.match(render(custom('contains', 'bris')).sql, /ILIKE/);
    assert.ok(render(custom('contains', 'bris')).params.includes('%bris%'));
});

await check('presence is asked as presence, not as an empty string', () => {
    assert.match(render(custom('is_set')).sql, /IS NOT NULL AND/);
    assert.match(render(custom('is_not_set')).sql, /IS NULL OR/);
});

await check('the KEY is a bound parameter, never spliced into the SQL', () => {
    const q = render(custom('is', 'bristol'));
    assert.ok(q.params.includes('city'), `the key must be bound: ${JSON.stringify(q.params)}`);
    assert.ok(!q.sql.includes("'city'"), 'and must not appear as literal SQL text');
});

await check('a condition naming no field, or one with a value it needs, is refused', () => {
    assert.strictEqual(parseRules({ match: 'all', conditions: [{ field: 'custom', op: 'is', value: 'x' }] }).ok, false);
    assert.strictEqual(parseRules({ match: 'all', conditions: [{ field: 'custom', op: 'is', key: 'City' }] }).ok, false);
    assert.strictEqual(parseRules(custom('is')).ok, false, 'is needs something to compare to');
    assert.ok(parseRules(custom('is_set')).ok, 'is_set does not');
});

await check('a rule naming a field this org never defined is refused', async () => {
    const empty: any = { select: () => new Proxy({}, { get(_t, p) { return p === 'then' ? (r: (v: unknown) => void) => r([]) : () => empty.select(); } }) };
    const err = await checkRuleReferences(empty, 1, custom('is', 'bristol'));
    assert.match(err!, /does not exist here/);
});

console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
