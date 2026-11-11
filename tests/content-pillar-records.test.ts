// tests/content-pillar-records.test.ts
// Content pillars as records (docs/pillar-records-plan.md, phase 1). The table is the truth,
// onboarding_context.content_pillars is derived, drafting counts by pillar_id so a rename keeps its
// history, and a text answer (chat card, wizard, AI wand) reconciles the records without losing them.
//
// Run:  npx tsx tests/content-pillar-records.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    planNameSync, derivedPillarNames, validatePillarFields, pillarPromptText, sortPillars,
    MAX_ACTIVE_PILLARS, MAX_PILLAR_NAME, MAX_PILLAR_DESCRIPTION, type Pillar,
} from '../src/utils/content-pillars-store';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');

const row = (id: number, name: string, sortOrder: number, isActive = true, description: string | null = null): Pillar =>
    ({ id, name, description, sortOrder, isActive });

// ── Pure ────────────────────────────────────────────────────────────────────────────────────────

check('limits match the shared splitter (5 on, 60-character names)', () => {
    assert.strictEqual(MAX_ACTIVE_PILLARS, 5);
    assert.strictEqual(MAX_PILLAR_NAME, 60);
    assert.strictEqual(MAX_PILLAR_DESCRIPTION, 300);
});

check('derived names are the ACTIVE pillars in order', () => {
    const rows = [row(3, 'Food', 2), row(1, 'Fitness', 0), row(2, 'Mindset', 1, false), row(4, 'Sleep', 1)];
    assert.deepStrictEqual(derivedPillarNames(rows), ['Fitness', 'Sleep', 'Food']);
    assert.deepStrictEqual(sortPillars(rows).map((r) => r.id), [1, 2, 4, 3], 'ties broken by id');
});

check('validation: names are short themes, descriptions optional and capped', () => {
    assert.deepStrictEqual(validatePillarFields({ name: '  Behind   the scenes ' }), { ok: true, name: 'Behind the scenes' });
    assert.strictEqual(validatePillarFields({ name: '   ' }).ok, false);
    assert.strictEqual(validatePillarFields({ name: 'x'.repeat(61) }).ok, false);
    assert.deepStrictEqual(validatePillarFields({ description: '  ' }), { ok: true, description: null }, 'a blank description clears it');
    assert.deepStrictEqual(validatePillarFields({ description: null }), { ok: true, description: null });
    assert.strictEqual(validatePillarFields({ description: 'x'.repeat(301) }).ok, false);
    assert.deepStrictEqual(validatePillarFields({}), { ok: true }, 'absent fields stay absent');
});

check('prompt text carries the description when the owner wrote one', () => {
    assert.strictEqual(pillarPromptText({ id: 1, name: 'Studio', description: 'kiln days, glazing' }), '"Studio" (kiln days, glazing)');
    assert.strictEqual(pillarPromptText({ id: null, name: 'Studio', description: null }), '"Studio"');
});

check('text sync keeps matching rows (any case), creates new ones, archives dropped ones', () => {
    const rows = [row(1, 'Fitness', 0, true, 'gym'), row(2, 'Mindset', 1), row(3, 'Food', 2)];
    const plan = planNameSync(rows, 'food, Fitness, Sleep');
    assert.deepStrictEqual(plan.updates, [
        { id: 3, name: 'food', sortOrder: 0, isActive: true },
        { id: 1, name: 'Fitness', sortOrder: 1, isActive: true },
    ]);
    assert.deepStrictEqual(plan.creates, [{ name: 'Sleep', sortOrder: 2 }]);
    assert.deepStrictEqual(plan.archives, [2]);
    assert.deepStrictEqual(plan.reorders, []);
});

check('text sync leaves switched-off pillars alone (the text never showed them)', () => {
    const rows = [row(1, 'Fitness', 0), row(2, 'Mindset', 1, false), row(3, 'Food', 2)];
    const plan = planNameSync(rows, 'Fitness, Food');
    assert.deepStrictEqual(plan.archives, []);
    assert.deepStrictEqual(plan.reorders, [{ id: 2, sortOrder: 2 }], 'moved after the active ones');
    // …and naming a switched-off pillar switches it back on.
    const back = planNameSync(rows, 'Mindset');
    assert.deepStrictEqual(back.updates, [{ id: 2, name: 'Mindset', sortOrder: 0, isActive: true }]);
    assert.deepStrictEqual(back.archives, [1, 3]);
});

check('text sync on an assistant with no rows seeds them; same text twice changes nothing', () => {
    assert.deepStrictEqual(planNameSync([], 'A · B · C').creates.map((c) => c.name), ['A', 'B', 'C']);
    const rows = [row(1, 'A', 0), row(2, 'B', 1)];
    const again = planNameSync(rows, ['A', 'B']);
    assert.deepStrictEqual(again.creates, []);
    assert.deepStrictEqual(again.archives, []);
    assert.deepStrictEqual(again.updates.map((u) => [u.id, u.sortOrder]), [[1, 0], [2, 1]]);
});

check('text sync brings back an archived pillar of the same name, with its description', () => {
    // Staging 2026-11-08: an old list re-created "Customer stories" as a new, empty row.
    const live = [row(1, 'Time saving', 0)];
    const archived = [row(6, 'Customer stories', 1, false, 'Real clients'), row(4, 'Customer stories', 3, false, 'older')];
    const plan = planNameSync(live, 'Time saving, customer stories', archived);
    assert.deepStrictEqual(plan.revives, [{ id: 6, name: 'customer stories', sortOrder: 1 }], 'the most recently archived row');
    assert.deepStrictEqual(plan.creates, []);
});

check('text sync never switches on more than five', () => {
    const plan = planNameSync([], 'A, B, C, D, E, F, G');
    assert.strictEqual(plan.creates.length, 5);
});

// ── Wiring (source scans) ───────────────────────────────────────────────────────────────────────

const sqlFile = read('db/z-content-pillars.sql');
const schema = read('db/schema.ts');
const jobs = read('netlify/functions/process-content-jobs.ts');
const auto = read('netlify/functions/autonomous-media-suggestions.ts');
const ctxSave = read('netlify/functions/update-assistant-context.ts');
const onboarding = read('netlify/functions/onboarding.ts');
const api = read('netlify/functions/content-pillars.ts');
const assistants = read('assistants.js');
const detail = read('assistant-detail.html');
const workspace = read('workspace.html');
const list = read('src/components/pillar-list.js');

check('SQL: the table, a live-name unique index, and scheduled_posts.pillar_id', () => {
    assert.match(sqlFile, /CREATE TABLE IF NOT EXISTS content_pillars/);
    assert.match(sqlFile, /CREATE UNIQUE INDEX IF NOT EXISTS content_pillars_live_name_uq[\s\S]*?WHERE archived_at IS NULL/);
    assert.match(sqlFile, /ADD COLUMN IF NOT EXISTS pillar_id INTEGER REFERENCES content_pillars\(id\) ON DELETE SET NULL/);
    assert.match(schema, /export const contentPillars = pgTable\("content_pillars"/);
    assert.match(schema, /pillarId: integer\("pillar_id"\)\.references\(\(\) => contentPillars\.id/);
});

check('drafting reads the records and counts by pillar_id, then by name for older posts', () => {
    for (const [name, src] of [['process-content-jobs', jobs], ['autonomous-media-suggestions', auto]] as const) {
        assert.match(src, /loadDraftPillars\(db, /, `${name} reads the records`);
        assert.match(src, /\.groupBy\(scheduledPosts\.pillarId, scheduledPosts\.pillar\)/, `${name} counts by id`);
        assert.match(src, /u\.pillarId === p\.id\) \|\| \(u\.pillarId === null && u\.pillar === p\.name\)/, `${name} matches by id, then name`);
    }
    assert.match(jobs, /pillarId: resolvedPillarId,/, 'the post records its pillar id');
    assert.match(jobs, /pillar: primary\?\.pillar \?\? null, pillarId: primary\?\.pillarId \?\? null,/, 'cross-post siblings share it');
    assert.match(auto, /pillarId: pillarRecord\?\.id \?\? null/);
    assert.match(jobs, /What the owner puts under this pillar/, 'the description reaches the prompt');
});

check('the profile save carries pillars across, and text answers reconcile the records', () => {
    assert.match(ctxSave, /const CARRY_ACROSS = \['content_pillars', /);
    // Under the role's key since phase 3a (content_pillars for Social, blogTopics / newsletterTopics for Blog / Email).
    assert.match(ctxSave, /const synced = await syncPillarsFromNames\(tx, orgId, assistantId, mergedContext\[pillarKey\]\);/);
    assert.match(onboarding, /await ensurePillarRecords\(db, orgId, newAssistant\.id, newAssistant\.onboardingContext\)/, 'the wizard creates records');
});

check('one server path, Social Media assistants only, tenant-checked', () => {
    assert.match(api, /requireTenant\(event, db\)/);
    assert.match(api, /eq\(aiAssistants\.organisationId, orgId\)/);
    // Social, Blog and Email since phase 3a (src/utils/pillar-profiles.ts); any other role is refused.
    assert.match(api, /const profile = pillarProfileFor\(asst\.roleKey\);\s+if \(!profile\) return json\(400/);
    for (const a of ['add', 'update', 'archive', 'reorder']) assert.ok(api.includes(`case '${a}':`), a);
});

check('profile: a pillar list replaces the free-text box; the hidden carrier stays for the wand', () => {
    assert.match(detail, /<div id="pillars-list" aria-labelledby="pillars-heading"><\/div>/);
    assert.match(detail, /<textarea id="edit_pillars" class="hidden" aria-hidden="true" tabindex="-1"><\/textarea>/);
    assert.ok(!detail.includes('id="pillars-chips"'), 'the old chips are gone');
    assert.ok(workspace.indexOf('/src/components/pillar-list.js') > -1);
    assert.match(assistants, /window\.PillarList\?\.mount\(document\.getElementById\('pillars-list'\)/);
    // ⚠️ The autosave sends pillar text ONLY when the wand / strategy fix wrote some. Sending the page's
    // copy clobbered the records on staging (2026-11-08): a stale save reconciled them back.
    assert.match(assistants, /if \(!window\._pillarsTextDirty\) delete newContext\.content_pillars;/);
    assert.match(assistants, /\(k !== 'content_pillars' \|\| sentPillarText\)/, 'no redraft offer for pillars a save did not send');
    assert.match(assistants, /if \(sentPillarText\) \{ window\._pillarsTextDirty = false; window\.PillarList\?\.reload\(\); \}/);
    assert.match(list, /window\._detailSetContextKey\?\.\(state\.contextKey, value\)/, 'the list hands its names back to the autosave');
    assert.match(list, /window\.offerRedraftUpcoming\?\./, 'a change offers to redraft upcoming posts');
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
