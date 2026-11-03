// tests/campaign-decision-restore.test.ts
// Found 2026-11-03: an archived decision — "Small creative & professional services firms" is mostly
// finding the wrong companies (a halt, 38 of 84 leads cold against a 40% threshold) — could be read
// under Decisions ▸ Archived and not acted on. A halt expires after two days, and the archived card
// had no button at all. Now it can be restored, from the tab and from the chat, through ONE action.
//
// Run:  npx tsx tests/campaign-decision-restore.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    RESTORABLE_DECISION_STATUSES, datedEvidence, remeasuredHaltEvidence, restoreProblem, restoredMessage,
} from '../src/utils/campaign-decision-restore';
import { DECISION_TTL_DAYS } from '../src/config/campaign-vocab';

let passed = 0;
function check(name: string, fn: () => void): void {
    try {
        fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const strip = (src: string) => src.replace(/^\s*\/\/.*$/gm, '');

console.log('campaign decision restore');

// The owner's card, as the proposer wrote it (campaign-proposer.ts buildHaltProposal).
const ownersEvidence = [
    { label: 'Leads found in the window', value: '84' },
    { label: 'Rated cold', value: '38 (45%)' },
    { label: 'Your threshold', value: '40%' },
];
const raised = new Date('2026-10-30T04:01:00Z');

check('only expired and turned-down decisions come back', () => {
    assert.deepStrictEqual([...RESTORABLE_DECISION_STATUSES], ['expired', 'rejected']);
    assert.strictEqual(restoreProblem('expired', 'active'), null);
    assert.strictEqual(restoreProblem('rejected', 'paused'), null);
    assert.match(restoreProblem('pending', 'active') ?? '', /already waiting/);
    assert.match(restoreProblem('approved', 'active') ?? '', /Briefs tab/);
    assert.match(restoreProblem('superseded', 'active') ?? '', /newer plan/);
});

check('a finished or archived campaign cannot take a restored decision', () => {
    assert.match(restoreProblem('expired', 'finished') ?? '', /finished/);
    assert.match(restoreProblem('expired', 'archived') ?? '', /archived/);
});

check('a restored halt shows TODAY\'s count and keeps the figures it was raised with', () => {
    const r = remeasuredHaltEvidence({ total: 120, cold: 60, since: new Date('2026-10-29T04:01:00Z') }, ownersEvidence, raised);
    assert.strictEqual(r.belowThreshold, false);
    assert.strictEqual(r.evidence[0].value, '120');
    assert.match(r.evidence[0].label, /counted again/);
    assert.strictEqual(r.evidence[1].value, '60 (50%)');
    assert.strictEqual(r.evidence[2].value, '40%');
    assert.match(r.evidence[3].label, /When it was raised \(30 Oct 2026\)/);
    assert.strictEqual(r.evidence[3].value, '38 (45%) rated cold of 84');
    // _rqDecisionDetail numbers any line carrying `detail` as if it were a brief.
    assert.ok(r.evidence.every((e) => !('detail' in e)), 'a restored halt line carries detail');
});

check('a halt that has recovered is still restored, but says so', () => {
    const r = remeasuredHaltEvidence({ total: 100, cold: 30, since: raised }, ownersEvidence, raised);
    assert.strictEqual(r.belowThreshold, true);
    assert.match(r.evidence[1].value, /under your threshold/);
});

check('a halt with too few leads since says so, rather than claiming it recovered', () => {
    const r = remeasuredHaltEvidence({ total: 0, cold: 0, since: raised }, ownersEvidence, raised);
    assert.strictEqual(r.belowThreshold, false);
    assert.strictEqual(r.evidence[1].value, '0 (0%) — too few leads since to judge again');
});

check('evidence that cannot be re-counted is dated, once, and never numbered', () => {
    const once = datedEvidence(ownersEvidence, raised);
    const twice = datedEvidence(once, raised);
    assert.strictEqual(twice.length, ownersEvidence.length + 1, 'restoring twice stacked two "Restored" lines');
    assert.match(twice[twice.length - 1].value, /from 30 Oct 2026 and were not measured again/);
    assert.ok(twice.every((e) => !('detail' in e) || e.detail === undefined || ownersEvidence.includes(e as never)));
});

check('the message gives the fresh expiry and says what happened to the figures and the reason', () => {
    const expiresAt = new Date(Date.now() + DECISION_TTL_DAYS.halt * 86400000);
    const halt = restoredMessage({ kind: 'halt', expiresAt, remeasured: true, belowThreshold: false, keptRejectReason: false });
    assert.match(halt, /2 days to approve/);
    assert.match(halt, /counted again/);
    const plan = restoredMessage({ kind: 'strategy', expiresAt, remeasured: false, belowThreshold: false, keptRejectReason: true });
    assert.match(plan, /from when it was raised/);
    assert.match(plan, /reason you gave/);
});

const mod = strip(read('src/utils/campaign-decision-restore.ts'));

check('a restore is the SAME row back to pending, with a fresh expiry and the rejection cleared', () => {
    assert.match(mod, /status: 'pending',\s*expiresAt,/);
    assert.match(mod, /DECISION_TTL_DAYS\[d\.kind/);
    for (const f of ['rejectReason: null', 'rejectNote: null', 'decidedAt: null', 'decidedBy: null']) assert.ok(mod.includes(f), `does not clear ${f}`);
    assert.ok(!/insert\(campaignDecisions\)/.test(mod), 'restore inserts a copy instead of re-queuing the row');
    // Guarded on the status it read, so the tab and a chat card cannot both write.
    assert.match(mod, /eq\(campaignDecisions\.status, d\.status\)/);
});

check('the mirror goes back to pending_approval, so the card returns to Review', () => {
    assert.match(mod, /approvalStatus: 'pending_approval'/);
    assert.match(mod, /mirrorDecision\(db,/);
});

check('it refuses a second pending decision of the same kind, and a halt whose search is gone', () => {
    assert.match(mod, /ne\(campaignDecisions\.id, d\.id\)/);
    assert.match(mod, /search\.status === 'archived'/);
});

check('campaigns.ts serves restore_decision through the shared module, and decide is untouched by it', () => {
    const c = read('netlify/functions/campaigns.ts');
    assert.match(c, /if \(action === 'restore_decision'\) \{\s*const r = await restoreDecision\(db, orgId, Number\(body\.decisionId\)\)/);
    assert.match(c, /message: restoredMessage\(r\)/);
});

check('the Decisions tab restores through campaigns.ts, not the generic PATCH', () => {
    const a = read('assistants.js');
    const fn = a.slice(a.indexOf('async function _rqRestoreCampaignDecision('), a.indexOf('\n}\n', a.indexOf('async function _rqRestoreCampaignDecision(')));
    assert.ok(fn.includes("action: 'restore_decision'"), 'tab does not call restore_decision');
    assert.ok(!fn.includes('assistant-records'), 'tab restores through the mirror PATCH');
    const act = a.slice(a.indexOf('window._detailRqRecordAct = async function'));
    assert.match(act.slice(0, 3000), /if \(action === 'restoreDecision'\) \{[\s\S]{0,200}_rqRestoreCampaignDecision\(card, rec\)/);
    // A chat restore moves the card on the tab behind the modal.
    assert.match(a, /addEventListener\('campaign:updated'[\s\S]{0,200}recordType !== 'campaign_decision'/);
});

check('the chat sees archived decisions with their ids, and proposes a card that calls the same action', () => {
    const plan = read('src/utils/campaign-plan.ts');
    assert.match(plan, /await archivedDecisionsLine\(db, r\.id\)/);
    assert.match(mod, /Archived decisions \(under Decisions ▸ Archived; each can be restored\): \$\{rows\.map/);
    assert.match(mod, /decisionId \$\{r\.id\}/);

    const orch = read('netlify/functions/chat-orchestrator.ts');
    assert.match(orch, /"type": "campaign_decision_restore"/);
    assert.match(orch, /BRINGING BACK AN ARCHIVED DECISION/);
    assert.match(orch, /"Restore to Review"/, 'the prompt must name the tab button');
    assert.match(orch, /approves nothing and briefs nobody/);

    const card = read('src/components/disruptive-ui-registry.js');
    assert.match(card, /register\('campaign_decision_restore', renderCampaignDecisionRestoreCard\)/);
    assert.match(card, /new CustomEvent\('campaign:restoreDecision'/);

    const chat = read('src/components/chat-session.js');
    const fn = chat.slice(chat.indexOf('function onCampaignRestoreDecision'), chat.indexOf('\n    }\n', chat.indexOf('function onCampaignRestoreDecision')));
    assert.ok(fn.includes("action: 'restore_decision'"), 'chat card does not call restore_decision');
    assert.ok(fn.includes("'campaign:updated'"), 'chat restore does not tell the tab');
    assert.match(chat, /addEventListener\('campaign:restoreDecision', onCampaignRestoreDecision\)/);
    assert.match(chat, /removeEventListener\('campaign:restoreDecision', onCampaignRestoreDecision\)/);
});

console.log(`\n${passed} passed`);
