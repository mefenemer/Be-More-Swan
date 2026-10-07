// tests/email-campaign-builder.test.ts
// The Email Studio's campaign builder (plan → write → review → save, without the chat) and the
// Newsletter → Email Marketing rename (2026-10-01).
//
// What would hurt, in the order a customer would meet it:
//   1. THE CHAT AND THE STUDIO SUGGEST DIFFERENT DAYS — two copies of one default.
//   2. "WRITE THE EMAILS" SAVES SOMETHING — it must only return copy for the person to read.
//   3. A TIMEOUT. One model call for a whole campaign runs close to the function's ~26s limit.
//   4. THE STUDIO SAVES DIFFERENTLY FROM THE CHAT CARD — two save behaviours to reason about.
//   5. THE RENAME BREAKS A MERGE TAG, or renames an assistant somebody named themselves.

import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAMPAIGN_CADENCES, campaignCadencePromptBlock } from '../src/config/email-campaign-cadences';
import { CAMPAIGN_TYPES, MAX_CAMPAIGN_EMAILS } from '../src/utils/newsletter-campaign-chat-draft';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
    const ok = () => { passed++; console.log(`  ✓ ${name}`); };
    const bad = (err: unknown) => { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; };
    try {
        const out = fn();
        if (out && typeof (out as Promise<void>).then === 'function') return (out as Promise<void>).then(ok, bad);
        ok();
    } catch (err) { bad(err); }
    return Promise.resolve();
}

const ORCH = read('netlify/functions/chat-orchestrator.ts');
const ISSUES = read('netlify/functions/newsletter-issues.ts');
const GEN = read('src/utils/newsletter-campaign-generate.ts');
const STUDIO = read('newsletter.js');
const STUDIO_HTML = read('newsletter.html');
const RENAME = read('db/email-marketing-rename.sql');

async function main() {

// ── 1. One list of defaults ─────────────────────────────────────────────────

await check('every campaign kind has a sane default shape', () => {
    assert.deepEqual(CAMPAIGN_CADENCES.map((c) => c.type).sort(), [...CAMPAIGN_TYPES].sort(), 'one default per kind, no more, no fewer');
    for (const c of CAMPAIGN_CADENCES) {
        assert.ok(c.steps.length >= 1 && c.steps.length <= MAX_CAMPAIGN_EMAILS, `${c.type}: 1–${MAX_CAMPAIGN_EMAILS} emails`);
        assert.equal(c.steps[0].day, 1, `${c.type}: the first email goes on Day 1`);
        c.steps.forEach((s, i) => {
            assert.ok(s.role.trim(), `${c.type}: every email has a job`);
            if (i) assert.ok(s.day > c.steps[i - 1].day, `${c.type}: days only go up`);
        });
    }
});

await check('the chat prompt is BUILT from the same list the Studio serves', () => {
    assert.match(ORCH, /campaignCadencePromptBlock\(\),/);
    assert.ok(!ORCH.includes('`CADENCES — the defaults you propose'), 'no second, hand-written copy in the prompt');
    const block = campaignCadencePromptBlock();
    for (const c of CAMPAIGN_CADENCES) for (const s of c.steps) assert.ok(block.includes(`Day ${s.day} ${s.role}`));
    assert.match(ISSUES, /campaignCadences: CAMPAIGN_CADENCES\.map/, 'and the Studio reads it from the server, not a copy of its own');
});

// ── 2. Writing returns, it does not save ────────────────────────────────────

await check('"Write the emails" returns copy and saves nothing', () => {
    const a = ISSUES.slice(landmark(ISSUES, "if (action === 'draftCampaign')"), landmark(ISSUES, "if (action === 'createCampaign')"));
    assert.match(a, /draftCampaignEmails\(db, \{/);
    assert.ok(!/db\.insert|db\.update|\btx\./.test(a), 'nothing is written until the person presses Save');
    assert.match(a, /MAX_CAMPAIGN_EMAILS/);
});

// ── 3. No timeout ───────────────────────────────────────────────────────────

await check('one model call per email, in parallel, each seeing the whole plan', () => {
    assert.match(GEN, /await Promise\.all\(steps\.map\(async/);
    assert.match(GEN, /The whole plan \(you write ONE of these/);
    assert.match(GEN, /max_tokens: 1200/);
});

await check('the Studio builder goes through the chat card\'s normaliser, grounded on what the person typed', () => {
    assert.match(GEN, /campaignDraftFromUiElement\(\{/);
    assert.match(GEN, /\[input\.facts, input\.goal, input\.audience\]\.join/);
    assert.match(GEN, /Open with exactly "Hi \$\{GREETING_EXAMPLE\}," on its own line/, 'one greeting across the series — and a real one');
});

// ── 4. One save behaviour ───────────────────────────────────────────────────

await check('the Studio saves through the same two endpoints as the chat card', () => {
    const save = STUDIO.slice(landmark(STUDIO, 'async function saveCampaign'), landmark(STUDIO, 'function onCampaignReviewInput'));
    assert.match(save, /action: 'importCampaign'/);
    assert.match(save, /action: 'createCampaign'/);
    // Saving never overwrites an existing campaign (2026-10-07), so there is no replace question.
    assert.doesNotMatch(save, /SEQUENCE_HAS_STEPS|replace/);
});

await check('the builder\'s handlers are bound once in wire(), never from a render path', () => {
    for (const fn of ['function renderCampaignPlan', 'function renderCampaignReview']) {
        const body = STUDIO.slice(landmark(STUDIO, fn), STUDIO.indexOf('\n  }\n', landmark(STUDIO, fn)));
        assert.ok(!body.includes('addEventListener'), `${fn} must not bind handlers`);
    }
    const wire = STUDIO.slice(landmark(STUDIO, 'function wire() {'));
    for (const id of ['nl-campaign', 'nl-cmp-write', 'nl-cmp-save', 'nl-cmp-steps', 'nl-cmp-emails']) assert.ok(wire.includes(`$('${id}')`), `${id} is wired`);
    assert.match(STUDIO_HTML, /id="nl-campaign-modal"/);
    assert.match(STUDIO_HTML, /New email campaign/);
});

// ── 5. The rename ───────────────────────────────────────────────────────────

await check('no source file still says "Newsletter Assistant" or "Newsletter Studio"', () => {
    // Applied migrations are exempt ON PURPOSE: the runner re-runs a file whose checksum changed.
    const hits: string[] = [];
    const walk = (dir: string) => {
        for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
            const p = join(dir, e.name);
            if (e.isDirectory()) { if (!['node_modules', '.git', '.claude', 'docs', 'tests', 'remotion', '.netlify', 'dist'].includes(e.name)) walk(p); continue; }
            if (!/\.(js|ts|html|json)$/.test(e.name)) continue;
            if (/Newsletter (Assistant|Studio)/.test(read(p))) hits.push(p);
        }
    };
    walk('.');
    assert.deepEqual(hits, []);
});

await check('the migration renames only untouched defaults, and never touches a merge tag', () => {
    assert.match(RENAME, /AND a\.name = 'Newsletter Assistant'/, 'a customer-chosen name is theirs');
    assert.match(RENAME, /WHERE role_key = 'newsletter_editor'/, 'keyed on role_key, not the drifting name');
    assert.ok(!/REPLACE\([^)]*'issue', 'email'\)/.test(RENAME), 'a bare issue→email REPLACE would turn {{issue.subject}} into {{email.subject}}');
});

console.log(`\n${passed} checks passed.`);
}

main();
