// tests/follow-up-plan.test.ts
// The Lead Generator's editable follow-up plan — docs/lead-outreach-restructure-plan.md, Phase 3.
//
// What is pinned, and why each one would fail silently:
//   1. the rules — limits, no reordering, numbers never reused — because a renumbered step re-sends or
//      skips an email to a stranger part-way through, with nothing on screen to say so;
//   2. the chat card is rebuilt from the stored plan, so it can only offer what the save accepts;
//   3. the worker reads POSITION, not step number, for "the first follow-up" (the offer's link), "the
//      last one" (it says so) and the 5-email ceiling — numbers have gaps once a plan is edited;
//   4. one save action for the panel and the card, writing through the one writer;
//   5. the panel, the card, and every sentence that used to type "3 days, a week".
//
//   6. Phase 4: a preview is the worker's own draft, written for one lead and sent to nobody.
//
// Run:  npx tsx tests/follow-up-plan.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';
import { FOLLOW_UP_LIMITS, LAST_FOLLOW_UP_RULE, describeFollowUpPlan, validateFollowUpSteps } from '../src/config/follow-up-plan';
import { buildFollowUpPlanCard, renderFollowUpPlanChatBlock } from '../src/utils/chat-follow-up-plan';
import type { FollowUpPlan } from '../src/utils/outreach-sequences';
import { MAX_STEPS_PER_ENROLMENT } from '../src/config/outreach-sequences';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const BRIEF = 'A short nudge that adds one new detail.';
const step = (stepNumber: number | null, delayDays = 3, brief = BRIEF) => ({ stepNumber, delayDays, brief });

// ── 1. the rules ────────────────────────────────────────────────────────────
console.log('\n──── 1. the rules ────');

check('a plan that edits, removes and appends is accepted as given', () => {
    const v = validateFollowUpSteps([step(1, 2), step(3, 9), step(null, 14)], [1, 2, 3]);
    assert.ok(v.ok);
    if (v.ok) assert.deepStrictEqual(v.steps.map((s) => s.stepNumber), [1, 3, null]);
});

check('reordering is refused — it cannot be done without renumbering', () => {
    const v = validateFollowUpSteps([step(2), step(1)], [1, 2]);
    assert.ok(!v.ok && /reorder/i.test(v.error));
    const newFirst = validateFollowUpSteps([step(null), step(1)], [1]);
    assert.ok(!newFirst.ok && /reorder/i.test(newFirst.error), 'a new step must go after every existing one');
});

check('a step number the plan never had is refused', () => {
    const v = validateFollowUpSteps([step(7)], [1, 2, 3]);
    assert.ok(!v.ok && /doesn’t have/.test(v.error));
});

check('a removed step can be brought back by its own number (still in usedNumbers)', () => {
    assert.ok(validateFollowUpSteps([step(2)], [1, 2, 3]).ok);
});

check('the limits hold, and they are the worker’s own ceiling', () => {
    assert.strictEqual(FOLLOW_UP_LIMITS.maxSteps, MAX_STEPS_PER_ENROLMENT);
    assert.ok(!validateFollowUpSteps([], [1]).ok, 'zero steps — switch chasing off instead');
    assert.ok(!validateFollowUpSteps(Array.from({ length: FOLLOW_UP_LIMITS.maxSteps + 1 }, () => step(null)), []).ok);
    assert.ok(!validateFollowUpSteps([step(null, 0)], []).ok, '0 days');
    assert.ok(!validateFollowUpSteps([step(null, 31)], []).ok, '31 days');
    assert.ok(!validateFollowUpSteps([step(null, 2.5)], []).ok, 'not a whole number');
    assert.ok(!validateFollowUpSteps([step(null, 3, 'hi')], []).ok, 'too short to say anything');
    assert.ok(!validateFollowUpSteps([step(null, 3, 'x'.repeat(FOLLOW_UP_LIMITS.maxBriefChars + 1))], []).ok);
    assert.ok(!validateFollowUpSteps('nope', []).ok);
});

check('the plan reads as one line', () => {
    assert.strictEqual(describeFollowUpPlan(true, [{ delayDays: 3 }, { delayDays: 7 }, { delayDays: 1 }]),
        '3 follow-ups — after 3 days, then 7 days later, then 1 day later');
    assert.match(describeFollowUpPlan(false, [{ delayDays: 3 }]), /one email only/);
});

// ── 2. the chat card ────────────────────────────────────────────────────────
console.log('\n──── 2. the chat card is rebuilt from the stored plan ────');

// A plan whose step 2 was removed and step 4 added: numbers [1, 3, 4], positions 1–3.
const PLAN: FollowUpPlan = {
    enabled: true,
    steps: [step(1, 3, 'First nudge, one new detail.') as never, step(3, 7, 'Lighter, offer a short call.') as never, step(4, 7, 'Polite close-out, last email.') as never],
    usedNumbers: [1, 2, 3, 4],
    provisioned: true, lockedOff: false, running: 2,
} as FollowUpPlan;

check('"from" is a POSITION the model was shown; it becomes the real step number', () => {
    const card = buildFollowUpPlanCard({ type: 'follow_up_plan', steps: [{ from: 1 }, { from: 3, waitDays: 10 }] }, PLAN);
    assert.strictEqual(card.blocked, null);
    assert.deepStrictEqual(card.steps!.map((s) => s.stepNumber), [1, 4], 'position 3 is step number 4');
    assert.strictEqual(card.steps![1].delayDays, 10);
    assert.strictEqual(card.steps![1].brief, 'Polite close-out, last email.', 'no "says" keeps that step’s own words');
});

check('a new step is appended with no number; the save assigns one', () => {
    const card = buildFollowUpPlanCard({ type: 'follow_up_plan', steps: [{ from: 1 }, { from: 2 }, { from: 3 }, { from: null, waitDays: 14, says: 'One last check-in with a new case study.' }] }, PLAN);
    assert.strictEqual(card.blocked, null);
    assert.strictEqual(card.steps![3].stepNumber, null);
});

check('switching off carries no steps and offers to stop the running ones', () => {
    const card = buildFollowUpPlanCard({ type: 'follow_up_plan', enabled: false }, PLAN);
    assert.strictEqual(card.blocked, null);
    assert.strictEqual(card.steps, null, 'the steps are kept for switching back on');
    assert.strictEqual(card.running, 2);
});

check('the card refuses what the save would refuse, and says why', () => {
    assert.match(buildFollowUpPlanCard({ type: 'follow_up_plan', steps: [{ from: 9 }] }, PLAN).blocked!, /no follow-up 9/);
    assert.match(buildFollowUpPlanCard({ type: 'follow_up_plan', steps: [{ from: 2 }, { from: 1 }] }, PLAN).blocked!, /reorder/i);
    assert.match(buildFollowUpPlanCard({ type: 'follow_up_plan', steps: [{ from: 1 }, { from: 2 }, { from: 3 }] }, PLAN).blocked!, /already says exactly that/);
    assert.match(buildFollowUpPlanCard({ type: 'follow_up_plan', enabled: false }, { ...PLAN, enabled: false }).blocked!, /already off/);
    assert.match(buildFollowUpPlanCard({ type: 'follow_up_plan' }, { ...PLAN, lockedOff: true }).blocked!, /support/);
});

check('the prompt block shows positions, the shape, and the no-claims rule', () => {
    const block = renderFollowUpPlanChatBlock(PLAN);
    assert.match(block, /1\. wait 3 days after the first email/);
    assert.match(block, /3\. wait 7 days after follow-up 2/);
    assert.match(block, /"type": "follow_up_plan"/);
    assert.match(block, /never say the plan HAS changed/);
    assert.match(block, /2 leads are being followed up right now/);
});

// ── 3. the worker ───────────────────────────────────────────────────────────
console.log('\n──── 3. the worker reads position, not number ────');

const WORKER = read('netlify/functions/process-sequence-sends.ts');

check('the ceiling, the offer link and "follow-up number N" use the position in the plan', () => {
    assert.match(WORKER, /const position = step \? steps\.indexOf\(step\) \+ 1 : 0;/);
    assert.match(WORKER, /if \(!step \|\| position > MAX_STEPS_PER_ENROLMENT\)/);
    assert.ok(WORKER.includes('followUpLinkTarget(sender.outreachOffer, position)'));
    assert.ok(WORKER.includes('This is follow-up number ${place.position}'));
    assert.ok(!WORKER.includes('step.stepNumber > MAX_STEPS_PER_ENROLMENT'), 'the old number-based ceiling would stop an edited plan early');
});

check('the last email in the plan says it is the last, whatever its brief says', () => {
    assert.ok(WORKER.includes('{ position, isLast: position === steps.length }'));
    assert.ok(WORKER.includes("${place.isLast ? `\\n${LAST_FOLLOW_UP_RULE}\\n` : ''}"));
    assert.match(LAST_FOLLOW_UP_RULE, /will not follow up again/);
});

// ── 4. one save ─────────────────────────────────────────────────────────────
console.log('\n──── 4. one action, one writer ────');

const LEADGEN = read('netlify/functions/lead-generation.ts');
const SEQ = read('src/utils/outreach-sequences.ts');

check('the save validates, writes through saveSequenceSteps, and merges ONE setup key', () => {
    const branch = LEADGEN.slice(landmark(LEADGEN, "if (action === 'get_follow_up_plan' || action === 'save_follow_up_plan')"), landmark(LEADGEN, "// ── List this assistant's lead ideas"));
    assert.match(branch, /assistant\.roleKey !== 'lead_qualifier'/);
    assert.ok(branch.indexOf('validateFollowUpSteps(body.steps, before.usedNumbers)') < branch.indexOf('saveSequenceSteps('), 'validate before writing');
    assert.match(branch, /onboardingContext: \{ \.\.\.onboarding, outreachFollowUps: enabled \? 'automatic' : 'none' \}/);
    assert.ok(!branch.includes('functions/update-assistant-context'), 'that route REPLACES the context');
    assert.match(branch, /!enabled && body\.stopRunning === true/, 'running follow-ups stop only when the owner says so');
});

check('the writer never deletes or renumbers a step', () => {
    const fn = SEQ.slice(landmark(SEQ, 'export async function saveSequenceSteps('), landmark(SEQ, 'export async function haltActiveEnrolmentsForAssistant('));
    assert.ok(!/\.delete\(sequenceSteps\)/.test(fn), 'a removed step is switched off, never deleted');
    assert.match(fn, /set\(\{ isEnabled: false \}\)/);
    assert.match(fn, /reduce\(\(m, r\) => Math\.max\(m, r\.stepNumber\), 0\) \+ 1/, 'a new step takes the next number up');
    assert.match(fn, /db\.transaction\(/, 'a plan is never half-saved');
    assert.match(fn, /ensureDefaultSequence\(/, 'an unprovisioned plan saves onto the default numbers');
});

check('stopping the running ones goes through haltEnrolment, so each stop is in the ledger', () => {
    const fn = SEQ.slice(landmark(SEQ, 'export async function haltActiveEnrolmentsForAssistant('));
    assert.match(fn.slice(0, 1500), /haltEnrolment\(db, r, 'manual'/);
});

// ── 5. the surfaces ─────────────────────────────────────────────────────────
console.log('\n──── 5. the panel, the card, and the words ────');

const PANEL = read('src/components/assistant-follow-up-plan.js');
const STRIP = read('src/components/assistant-lead-outreach.js');
const DETAIL = read('assistant-detail.html');
const WORKSPACE = read('workspace.html');
const CARDS = read('src/components/disruptive-ui-registry.js');
const CHAT_UI = read('src/components/chat-session.js');
const ORCH = read('netlify/functions/chat-orchestrator.ts');

check('the panel lives outside the strip, so a count repaint cannot take the caret', () => {
    const panel = DETAIL.slice(landmark(DETAIL, 'id="maintab-review-queue"'), landmark(DETAIL, '<!-- /maintab-review-queue -->'));
    assert.ok(panel.includes('id="lead-follow-up-plan"'));
    assert.ok(!STRIP.includes('id="lead-follow-up-plan"'), 'the strip must not draw the panel host inside itself');
    assert.ok(landmark(WORKSPACE, 'assistant-follow-up-plan.js') < landmark(WORKSPACE, 'assistant-lead-outreach.js'));
});

check('the panel binds its handlers once, on document, and keeps the draft in state', () => {
    assert.match(PANEL, /document\.addEventListener\('input'/);
    assert.match(PANEL, /document\.addEventListener\('click'/);
    assert.ok(!/h\.querySelector\([^)]*\)\.addEventListener/.test(PANEL), 'no handler bound from the render path');
    assert.match(PANEL, /state\.draft\.steps\[Number\(brief\)\]\.brief = e\.target\.value/);
});

check('"Reset to default" lays the defaults onto the existing numbers', () => {
    const fn = PANEL.slice(landmark(PANEL, 'function resetToDefault()'), landmark(PANEL, "document.addEventListener('click'"));
    assert.match(fn, /stepNumber: existing\[i\] \? existing\[i\]\.stepNumber : null/);
});

check('the panel and the card save through the same action', () => {
    assert.match(PANEL, /call\('save_follow_up_plan', payload\)/);
    assert.match(CHAT_UI, /action: 'save_follow_up_plan'/);
    assert.match(CHAT_UI, /addEventListener\('lead:followUpPlan', onFollowUpPlan\)/);
    assert.match(CHAT_UI, /removeEventListener\('lead:followUpPlan', onFollowUpPlan\)/);
    assert.match(CARDS, /register\('follow_up_plan', renderFollowUpPlanCard\)/);
    // The page catches a save made from chat.
    assert.match(PANEL, /addEventListener\('lead:followUpPlanSaved'/);
});

check('the card is a profile card, so a reply claiming "updated" is neutralised', () => {
    assert.match(ORCH, /outreachOfferCard \?\? followUpPlanCard \?\? ctaCard/);
    assert.match(ORCH, /followUpPlanBlock,/);
});

check('the To approve note quotes the SAVED plan — the consent disclosure', () => {
    const fn = STRIP.slice(landmark(STRIP, 'function noteText()'), landmark(STRIP, 'function paintStrip()'));
    assert.match(fn, /window\.LeadFollowUpPlan\?\.plan\(\)/);
    assert.match(fn, /Approving also starts your follow-up plan: \$\{plan\.summary\}/);
});

check('no surface types the old fixed cadence any more', () => {
    for (const [name, src] of [
        ['registry', read('src/components/assistant-dashboard-registry.js')],
        ['assistants.js', read('assistants.js')],
        ['send cards', CARDS],
    ] as Array<[string, string]>) {
        assert.ok(!/up to three (more emails|follow-ups)/i.test(src), `${name} still promises "up to three"`);
        assert.ok(!src.includes('3 days, a week, then a sign-off'), `${name} still types the fixed cadence`);
    }
});

check('every class the panel uses is compiled into style.css', () => {
    const css = read('style.css');
    const tokens = new Set<string>();
    for (const m of PANEL.matchAll(/class="([^"]*)"/g)) {
        for (const raw of m[1].replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) if (raw) tokens.add(raw);
    }
    const escapeSel = (t: string) => t.replace(/([:[\].\/])/g, '\\$1');
    const missing = [...tokens].filter((t) => !t.startsWith('btn-') && !css.includes(escapeSel(t)));
    assert.deepStrictEqual(missing, [], `not compiled into style.css: ${missing.join(', ')}`);
});

check('the Help Centre file swaps the exact paragraph the outreach-stages file wrote', () => {
    const help = read('db/help-articles-2026-12zzzzzzzzzzz-follow-up-plan.sql');
    const prior = read('db/help-articles-2026-12zzzzzzzzzz-outreach-stages.sql');
    const old = help.split("replace(content_md,\n           '")[1].split("',\n")[0].replace(/''/g, "'");
    assert.ok(prior.includes(old), 'the paragraph being replaced is not what the earlier file published');
    const literals = help.slice(landmark(help, 'UPDATE help_articles'), landmark(help, 'RETURNING'));
    assert.ok(!literals.includes(';'), 'a semicolon inside a literal breaks the Neon editor');
});

// ── 6. preview (Phase 4) ────────────────────────────────────────────────────
console.log('\n──── 6. preview: the real drafter, sent to nobody ────');

const THREADS_UI = read('src/components/assistant-lead-threads.js');
const CHAT_PLAN = read('src/utils/chat-follow-up-plan.ts');

check('the preview is drafted by the worker’s own function, and writes nothing', () => {
    const fn = WORKER.slice(landmark(WORKER, 'export async function previewFollowUp('), landmark(WORKER, '// ── One enrolment'));
    assert.match(fn, /await draftFollowUp\(/, 'a second prompt would preview an email the worker never writes');
    assert.match(fn, /preview: true/);
    assert.ok(!/\.insert\(|\.update\(|\.delete\(/.test(fn), 'a preview must not write anything');
    assert.ok(!fn.includes('offerLinkForThread('), 'a preview must not mint a tracked link');
    assert.ok(!/send(Gmail|Outlook)Message\(/.test(fn), 'a preview must never send');
});

check('the action checks ownership and state, then meters as a helper, then drafts', () => {
    const branch = LEADGEN.slice(landmark(LEADGEN, "if (action === 'preview_follow_up')"), landmark(LEADGEN, "// ── List this assistant's lead ideas"));
    assert.match(branch, /eq\(leadThreads\.organisationId, orgId\), eq\(leadThreads\.aiAssistantId, assistant\.id\)/);
    assert.match(branch, /thread\.state !== 'open'/, 'no preview for a lead who has replied');
    const meter = branch.indexOf("meterInteraction(db, orgId, 'helpers')");
    const draft = branch.indexOf('previewFollowUp(db,');
    const validate = branch.indexOf('FOLLOW_UP_LIMITS.minBriefChars');
    assert.ok(validate > -1 && meter > validate && draft > meter, 'validate → meter → draft, so a refused preview costs nothing');
    assert.match(branch, /nothing was sent/i);
});

check('the panel previews the wording ON SCREEN, for a chosen emailed lead', () => {
    const fn = PANEL.slice(landmark(PANEL, 'async function preview(i)'), landmark(PANEL, 'async function save()'));
    assert.match(fn, /brief: s\.brief, planLength: state\.draft\.steps\.length/);
    assert.match(PANEL, /previewableLeads\(\)/);
    assert.match(THREADS_UI, /t\.threadId != null && t\.phase === 'following_up' && t\.state === 'open'/);
});

check('a conversation can preview its own next follow-up', () => {
    assert.match(THREADS_UI, /action: 'preview_follow_up', assistantId: state\.assistantId, threadId: t\.threadId/);
    assert.match(THREADS_UI, /data-lt-preview/);
});

check('the chat proposes a preview card and never writes the follow-up itself', () => {
    assert.match(CHAT_PLAN, /"type": "follow_up_preview"/);
    assert.match(CHAT_PLAN, /Never write the follow-up yourself/);
    const fn = CHAT_PLAN.slice(landmark(CHAT_PLAN, 'export async function resolveFollowUpPreviewProposal('));
    assert.match(fn, /eq\(assistantRecords\.organisationId, organisationId\), eq\(assistantRecords\.aiAssistantId, assistantId\)/);
    assert.match(fn, /thread\.state !== 'open'/);
    assert.match(CARDS, /register\('follow_up_preview', renderFollowUpPreviewCard\)/);
    assert.match(CHAT_UI, /addEventListener\('lead:followUpPreview', onFollowUpPreview\)/);
    assert.match(CHAT_UI, /removeEventListener\('lead:followUpPreview', onFollowUpPreview\)/);
    assert.match(ORCH, /isFollowUpPreviewProposal\(uiElement\)/);
});

check('the Help Centre preview file appends after the exact sentence the plan file wrote', () => {
    const help = read('db/help-articles-2026-12zzzzzzzzzzzz-follow-up-preview.sql');
    assert.ok(read('db/help-articles-2026-12zzzzzzzzzzz-follow-up-plan.sql').includes('nothing changes until you press **Save this plan**.'));
    assert.match(help, /NOT LIKE '%### Preview a follow-up%'/, 'idempotent');
    assert.ok(!help.slice(landmark(help, 'UPDATE help_articles'), landmark(help, 'RETURNING')).includes(';'));
});

console.log(`\n${passed} checks passed.`);
