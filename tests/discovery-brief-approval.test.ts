// tests/discovery-brief-approval.test.ts
// Phase 0: a human reads the actual web searches before the campaign is allowed to spend anything.
//
// ── What this fixes ──────────────────────────────────────────────────────────
// A prod run on 2026-08-08 searched `site:trustpilot.com OR site:g2.com`,
// `site:linkedin.com/jobs`, `inurl:careers OR inurl:jobs` and
// `best social media agencies UK ... directories`. All 35 results were discarded or scored cold.
// The queries were visible NOWHERE until after the money was spent — discovery-query-gen.ts ran
// them inside the job — so the only feedback channel was rejecting the leads afterwards. Reading
// that list would have taken seconds.
//
// ⚠️ THE INVARIANTS WORTH DEFENDING:
//
//   1. COST-NEUTRALITY. The worker runs its query_gen stage only when `cursor.flat` is missing.
//      approve_brief seeds the cursor, so the approved queries run verbatim AND the Haiku call is
//      not paid for twice. Break the seeding and Phase 0 silently becomes a second paid call whose
//      output nobody approved — the run would search something OTHER than what was on screen.
//
//   2. A SCHEDULED RE-RUN MUST NOT REPLAY THE APPROVED QUERIES. Identical queries return
//      substantially the same domains, and the (campaign_id, domain) dedupe then discards every
//      one — a weekly campaign would find leads once and nothing ever again. The brief is a
//      targeting CONTRACT that steers regeneration, not a script.
//
//   3. NOTHING SPENDS BEFORE APPROVAL. The form now creates a draft; only approve_brief promotes
//      it and enqueues a job.
//
//   4. The form's submission must not be deduped against an older campaign. That dedupe exists for
//      re-hydrated chat proposal cards, and Phase 0 made the form send `asDraft` too.
//
// Run:  npx tsx tests/discovery-brief-approval.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flattenQueries, buildSystemPrompt } from '../src/lib/discovery-query-gen';
import { landmark } from './landmark';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

function stripComments(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
}

const API = stripComments(read('netlify/functions/discovery-campaigns.ts'));
const WORKER = stripComments(read('netlify/functions/process-discovery-jobs.ts'));
const UI = stripComments(read('src/components/assistant-discovery-campaigns.js'));
const SCHEMA = read('db/schema.ts');
const DDL = read('db/discovery-approved-brief.sql');

/** The approve_brief branch alone, so ordering claims can't match another action's code. */
const APPROVE = API.slice(landmark(API, "if (action === 'approve_brief')"), landmark(API, "if (action === 'run_now')"));
const GENERATE = API.slice(landmark(API, "if (action === 'generate_brief')"), landmark(API, "if (action === 'approve_brief')"));

// ── 1. Cost-neutrality: the seeded cursor ────────────────────────────────────

check('approving seeds the job cursor, which is what skips the worker’s query_gen', () => {
    assert.ok(/cursor: \{ flat, queryIndex: 0 \}/.test(APPROVE),
        'approve_brief no longer seeds the cursor — the worker would regenerate queries and run something the user never saw');
    assert.ok(/stage: 'searching'/.test(APPROVE),
        "the seeded job must start at stage 'searching', matching what query_gen would have set");
});

check('the worker still skips query_gen when a cursor is already present', () => {
    // The other half of the contract. If this guard changes shape, seeding stops working and
    // Phase 0 becomes a second paid call whose output nobody approved.
    assert.ok(/if \(!cursor \|\| !Array\.isArray\(cursor\.flat\)\)/.test(WORKER),
        'the query_gen skip condition has changed — re-verify that a seeded cursor still bypasses generation');
});

check('an approved plan is flattened by the SAME rule the generator uses', () => {
    // Two implementations would mean the queries a user approved ran in a different order from the
    // ones they were shown, and an early budget cut would then drop a different set.
    const flat = flattenQueries({
        niche_scrape: ['n1', 'n2'],
        intent_signal: ['i1'],
        footprint: ['f1', 'f2'],
    });
    assert.deepEqual(flat.map((f) => f.query), ['n1', 'i1', 'f1', 'n2', 'f2'],
        'the interleave changed — a budget cut would no longer sample all three strategies early');
    assert.ok(/flattenQueries\(queries\)/.test(APPROVE), 'approve_brief no longer uses the shared flattener');
});

check('an empty plan is refused rather than starting a run that searches nothing', () => {
    assert.ok(/A search plan needs at least one query/.test(APPROVE), 'the empty-plan guard is gone');
    assert.deepEqual(flattenQueries({ niche_scrape: [], intent_signal: [], footprint: [] }), []);
});

// ── 2. A re-run must not replay ──────────────────────────────────────────────

check('a scheduled re-run regenerates, steered by the brief rather than replaying it', () => {
    assert.ok(/approvedQueries: approvedQueriesOf\(campaign\.approvedBrief\)/.test(WORKER),
        'the worker no longer passes the approved brief as steering');
    const prompt = buildSystemPrompt(5, [], ['site:example.com widgets', 'artisan bakery Bristol']);
    assert.ok(prompt.includes('site:example.com widgets'), 'approved queries never reach the prompt');
    assert.ok(/Do NOT reuse them/i.test(prompt),
        'the prompt does not forbid replaying the approved queries — a weekly campaign would dedupe to nothing');
    assert.ok(/Match their SHAPE/i.test(prompt), 'the steering intent is gone — the brief stops being a contract');
});

check('with no approved brief the prompt is unchanged', () => {
    // Every campaign predating this feature reads NULL, and must generate exactly as before.
    const bare = buildSystemPrompt(5, []);
    assert.ok(!/previously reviewed and approved/.test(bare),
        'the steering block leaks into campaigns that never had a brief');
});

// ── 3. Nothing spends before approval ────────────────────────────────────────

check('the form saves a draft and goes to the brief instead of starting a run', () => {
    assert.ok(/asDraft: true, fromForm: true/.test(UI),
        'the create form no longer defers spending — it would start searching before anyone read the plan');
    assert.ok(/await openBrief\(data\.campaignId\)/.test(UI), 'the form never reaches the brief');
});

check('a draft campaign routes to the brief, not to a blind run', () => {
    assert.ok(/data-dc-brief="\$\{c\.id\}"/.test(UI),
        'the draft button no longer opens the brief — a plan nobody read would start on one click');
    assert.ok(/Review &amp; start/.test(UI), 'the draft button copy no longer says the brief will be shown');
});

check('the brief is reachable for a campaign that has ALREADY run', () => {
    // ⚠️ Found by using it: the `draft` const additionally requires no run history, which is
    // right for the "never started" label and wrong for the button. Keyed on `draft`, a campaign
    // put back to draft after its targeting was edited still showed "Run now" — so the brief was
    // unreachable for any campaign that had ever run, i.e. nearly all of them.
    assert.ok(/const needsBrief = c\.status === 'draft';/.test(UI),
        'the button no longer keys on status alone — an edited campaign with run history cannot reach its brief');
    assert.ok(/: needsBrief\n\s*\? `<button type="button" data-dc-brief/.test(UI),
        'the primary button is not driven by needsBrief');
    // And any settled campaign can read its plan without committing to a run.
    assert.ok(/\$\{running \|\| needsBrief \? '' : `<button type="button" data-dc-brief/.test(UI),
        'there is no way to review the plan of an active campaign before running it');
    assert.ok(/Review plan/.test(UI), 'the secondary review action is gone');
});

check('a draft with run history says its plan needs review, not "completed"', () => {
    assert.ok(/needsBrief \? 'plan needs review'/.test(UI),
        'a campaign awaiting re-approval reports its last run status instead of its real state');
});

check('approving is what promotes a draft and enables a recurring schedule', () => {
    assert.ok(/status: 'active' as const/.test(APPROVE), 'approval no longer activates the campaign');
    assert.ok(/discoverySchedules\.cadence\} <> 'one_off'/.test(APPROVE),
        'a recurring cadence is never enabled — the campaign would run once and never again');
    assert.ok(/campaign\.status === 'draft'/.test(APPROVE),
        'approval must only promote a DRAFT — resurrecting a paused campaign would undo a human decision');
});

check('the form submission is not deduped against an older campaign', () => {
    assert.ok(/const fromForm = body\.fromForm === true;/.test(API), 'the fromForm distinction is gone');
    assert.ok(/if \(asDraft && !fromForm\)/.test(API),
        'the chat dedupe now catches form submissions too — a new search would silently return an old campaign');
});

// ── 4. What the user is actually shown ───────────────────────────────────────

check('the brief states the exclusions, not just the queries', () => {
    assert.ok(/exclusions: \{/.test(GENERATE), 'generate_brief no longer returns the exclusions');
    assert.ok(/categories: Object\.values\(EXCLUSION_CATEGORY_LABELS\)/.test(GENERATE),
        'the skipped categories are gone — "it will skip directories and job boards" is half of what is being approved');
    assert.ok(/It will skip/.test(UI), 'the UI no longer renders the exclusions');
});

check('the plan is editable, and edits are what gets sent', () => {
    assert.ok(/function collectQueries\(root\)/.test(UI), 'the edited plan is never read back from the DOM');
    assert.ok(/data-dc-query-input/.test(UI), 'the queries are not editable');
    assert.ok(/data-dc-remove/.test(UI) && /data-dc-add/.test(UI), 'queries cannot be removed or added');
    assert.ok(/queries,\n/.test(UI.slice(landmark(UI, 'approve_brief'))), 'the collected queries are not sent to approve_brief');
});

check('user-edited queries are sanitised server-side', () => {
    // The client sends whatever is in the inputs; a query is a search string and nothing more.
    assert.ok(/cleanQueryList\(raw\.niche_scrape\)/.test(APPROVE), 'edited queries are no longer sanitised');
    assert.ok(/MAX_QUERIES_PER_STRATEGY/.test(API), 'the per-strategy cap is gone — each query is a paid search call');
});

// ── 5. Storage ───────────────────────────────────────────────────────────────

check('approved_brief exists in BOTH the DDL and the schema', () => {
    // Out of sync, a future drizzle-kit push silently drops the column.
    assert.ok(/ADD COLUMN IF NOT EXISTS approved_brief jsonb/.test(DDL), 'the migration no longer adds the column');
    assert.ok(/approvedBrief: jsonb\("approved_brief"\)/.test(SCHEMA),
        'db/schema.ts is missing approved_brief — a drizzle-kit push would drop it');
});

check('the brief is NOT nested inside icpSnapshot', () => {
    // icp_snapshot is the attribution key stamped onto every revenue-ledger event; overloading it
    // would change the meaning of every row that carries one.
    assert.ok(!/icpSnapshot: \{[\s\S]{0,200}queries/.test(APPROVE),
        'the brief is being written into icpSnapshot — that column is a revenue-ledger attribution key');
    assert.ok(/approvedBrief: \{/.test(APPROVE), 'the brief is not being persisted at all');
});

console.log(`\n${passed} checks passed.`);
