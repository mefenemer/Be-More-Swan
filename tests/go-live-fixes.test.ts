// tests/go-live-fixes.test.ts
// "Fix" and "Suggest" beside each failing go-live check on Admin ▸ Assistants (2026-10-10).
// Fix = a rule-based correction; Suggest = a draft the admin edits and Applies; nothing is written
// without Apply, and Apply goes through applyFix's validation — never a raw client-chosen column.
//
// Run:  npx tsx tests/go-live-fixes.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    REMEDIES, applyFix, deterministicFix, findSpecialCategoryClause, nearestRoleKey, specialCategoryProposal,
    suggestionBrief, SPECIAL_CATEGORY_CLAUSE,
} from '../src/utils/go-live-fixes';
import { runGoLiveChecks } from '../src/utils/assistant-go-live';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const known = ['social_media_manager', 'blog_writer', 'brand_designer', 'lead_qualifier'];
const ctx = { knownRoleKeys: known, categories: ['Marketing & Sales', 'Administration'], currentPrompt: 'You are a helpful writer.' };

console.log('\nEvery check has a remedy');
check('every go-live check key maps to fix, suggest, goto or developer', () => {
    const keys = runGoLiveChecks({ roleKey: 'x', knownRoleKeys: [], capabilityRowCount: 0 }).map((c) => c.key);
    for (const k of keys) assert.ok(REMEDIES[k], `no remedy for ${k}`);
});
check('the "built in code" checks say "developer" — no button pretends to write code', () => {
    for (const k of ['setup', 'chat', 'dashboard']) assert.strictEqual(REMEDIES[k].remedy, 'developer');
});

console.log('\nFix (rule-based)');
check('a mistyped "works with" is corrected to the real role key; nonsense is dropped', () => {
    assert.strictEqual(nearestRoleKey('blog_writr', known), 'blog_writer');
    assert.strictEqual(nearestRoleKey('zzzz', known), null);
    const p = deterministicFix('worksWith', { roleKey: 'x', worksWith: ['blog_writr', 'standalone', 'zzzz'], knownRoleKeys: known })!;
    assert.deepStrictEqual(p.value, ['blog_writer', 'standalone']);
    assert.ok(p.direct && /zzzz/.test(p.explanation));
});
check('an EMPTY "works with" has nothing to correct, so it is a suggestion instead', () => {
    assert.strictEqual(deterministicFix('worksWith', { roleKey: 'x', worksWith: [], knownRoleKeys: known }), null);
});
check('integrations come from the code\'s connection map, never invented — and a role with none gets no fix', () => {
    const p = deterministicFix('integrations', { roleKey: 'social_media_manager', worksWith: [], knownRoleKeys: known })!;
    assert.deepStrictEqual(p.value, ['Social Media', 'Design']);
    assert.strictEqual(deterministicFix('integrations', { roleKey: 'campaign_orchestrator', worksWith: [], knownRoleKeys: known }), null);
    assert.deepStrictEqual(deterministicFix('integrations', { roleKey: 'brand_designer', worksWith: [], knownRoleKeys: known })!.value, ['Design']);
});

console.log('\nSpecial-category clause');
check('an existing refusal is found and offered as a confirmation', () => {
    const prompt = 'You write posts. Never ask about or use health, religious, political or ethnic information.';
    assert.ok(findSpecialCategoryClause(prompt));
    const p = specialCategoryProposal(prompt);
    assert.strictEqual(p.kind, 'confirm');
});
check('no refusal → the standard clause is proposed for adding to the prompt', () => {
    assert.strictEqual(findSpecialCategoryClause('You write cheerful posts about our health food shop.'), null, 'a mention is not a refusal');
    const p = specialCategoryProposal('You write posts.');
    assert.strictEqual(p.kind, 'prompt');
    assert.strictEqual(p.value, SPECIAL_CATEGORY_CLAUSE);
});
check('confirming without a clause is refused; adding one makes a new prompt version AND ticks the flag', () => {
    assert.throws(() => applyFix('specialCategory', { confirm: true }, ctx), /no refusal clause/);
    const w = applyFix('specialCategory', SPECIAL_CATEGORY_CLAUSE, ctx);
    assert.strictEqual(w.kind, 'version');
    if (w.kind === 'version') {
        assert.ok(w.systemPrompt.startsWith('You are a helpful writer.') && w.systemPrompt.endsWith(SPECIAL_CATEGORY_CLAUSE));
        assert.deepStrictEqual(w.alsoSet, { specialCategoryClauseEnabled: true });
    }
});

console.log('\nSuggest (drafted by Claude, applied by the admin)');
const a = { name: 'Blog Writing Assistant', roleKey: 'blog_writer', category: 'Marketing & Sales', tagline: null, description: 'Writes articles.', keyFeatures: [], categories: ctx.categories, knownRoleKeys: known, currentPrompt: null };
check('every brief forbids invented features, integrations and claims', () => {
    for (const k of ['name', 'tagline', 'description', 'keyFeatures']) assert.ok(/never invent/i.test(suggestionBrief(k, a)!.ask), k);
});
check('choices are constrained to real options (category, risk, works-with role keys)', () => {
    assert.deepStrictEqual(suggestionBrief('category', a)!.options, ctx.categories);
    assert.ok(/minimal \| limited/.test(suggestionBrief('risk', a)!.ask));
    assert.ok(!/blog_writer,/.test(suggestionBrief('worksWith', a)!.ask.split('role keys only:')[1]), 'offers itself as a teammate');
});

console.log('\nApply validates — it never trusts the client');
check('values are validated per check', () => {
    assert.throws(() => applyFix('description', 'Too short.', ctx), /at least 60/);
    assert.throws(() => applyFix('keyFeatures', ['one', 'two'], ctx), /At least 3/);
    assert.throws(() => applyFix('worksWith', ['nope'], ctx), /Not a role key/);
    assert.throws(() => applyFix('risk', 'very_high', ctx), /Risk must be/);
    assert.deepStrictEqual(applyFix('keyFeatures', 'A\nB\n\nC', ctx), { kind: 'columns', set: { keyFeatures: ['A', 'B', 'C'] } });
});
check('no key can write status, and developer checks cannot be applied', () => {
    for (const k of ['isActive', 'comingSoon', 'lifecycleState', 'setup', 'chat', 'dashboard', 'video', 'rows']) {
        assert.throws(() => applyFix(k, true, ctx), /cannot be fixed/, k);
    }
});

console.log('\nWiring');
const ep = read('netlify/functions/admin-assistants.ts');
const admin = read('admin.html');
check('suggest/apply sit behind the admin check, and apply writes only what applyFix returns', () => {
    assert.ok(ep.indexOf('const adminId = await requireAdmin(event);') < ep.indexOf("q.action === 'suggest' || q.action === 'apply'"));
    const applyPart = ep.slice(ep.indexOf('// apply'), ep.indexOf("return json(405"));
    assert.ok(/write = applyFix\(key, body\.value/.test(applyPart));
    assert.ok(/\.set\(\{ \.\.\.write\.set, updatedAt/.test(applyPart), 'writes something other than the validated set');
});
check('a model choice outside the options is discarded, not applied', () => {
    assert.ok(/brief\.kind === 'choice' && !\(brief\.options \?\? \[\]\)\.includes\(String\(value\)\)\) value = null/.test(ep));
});
check('the page shows Fix / Suggest / Needs a developer, and only Apply or a confirmed Fix writes', () => {
    assert.ok(admin.includes("'Needs a developer'") || admin.includes('>Needs a developer<'));
    const calls = admin.match(/await aaApply\(/g) || [];
    assert.strictEqual(calls.length, 2, 'aaApply reached from somewhere other than Apply or a confirmed Fix');
    assert.ok(/window\.confirmModal\([\s\S]{0,200}'Apply this fix\?'[\s\S]{0,200}if \(ok\) await aaApply/.test(admin));
});

console.log(`\n${passed} checks passed${process.exitCode ? ' — with FAILURES above' : ''}`);
