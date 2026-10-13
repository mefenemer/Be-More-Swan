// tests/campaign-decision-card.test.ts
// Found on prod 2026-10-13, approving campaign 1's first plan:
//
//   1. A Decisions card opened onto nothing but its buttons. The mirror carries `evidence` and
//      `costOfInaction`, the briefs live on campaign_decisions.proposed, and the card read neither —
//      "Add 6 briefs to this campaign" could only be approved blind.
//   2. The card offered "Approve & Schedule", a generic PATCH of the MIRROR: it would mark the card
//      approved while campaigns.ts `decide` never ran and no order was placed. The server now
//      refuses a PATCH of either campaign mirror.
//   3. campaigns.ts answered a missing assistantId with a raw 502 (NaN reached Postgres).
//
// Run:  npx tsx tests/campaign-decision-card.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const client = read('assistants.js');
const records = read('netlify/functions/assistant-records.ts');
const campaigns = read('netlify/functions/campaigns.ts');

function body(src: string, marker: string): string {
    const start = src.indexOf(marker);
    assert.ok(start >= 0, `marker not found: ${marker}`);
    const next = src.indexOf('\nfunction ', start + marker.length);
    return src.slice(start, next < 0 ? undefined : next);
}

console.log('campaign decision card');

check('the card body renders the decision detail', () => {
    const card = body(client, 'function _detailRqRecordCard(');
    assert.ok(card.includes('_rqDecisionDetail(r, statusKey)'), 'card never calls _rqDecisionDetail');
});

check('the detail shows evidence, the briefs, and what doing nothing means', () => {
    const d = body(client, 'function _rqDecisionDetail(');
    for (const k of ['evidence', 'proposed', 'brief', 'costOfInaction']) assert.ok(d.includes(k), `detail ignores ${k}`);
});

check('the briefs are fetched from list_decisions with the Decisions column', () => {
    const r = body(client, 'async function _detailRqRenderRecords(');
    assert.ok(/recordType === 'campaign_decision'/.test(r) && r.includes("action: 'list_decisions'"), 'no list_decisions fetch');
});

check('a decision offers only Approve and Reject — no schedule, send-back or restore', () => {
    const a = body(client, 'function _rqRecordActions(');
    const start = a.indexOf("if (r.recordType === 'campaign_decision')");
    assert.ok(start >= 0, 'no decision branch');
    // Comments stripped: the one above the branch names the buttons it forbids.
    const branch = a.slice(start, a.indexOf("if (statusKey === 'review')", start)).replace(/^\s*\/\/.*$/gm, '');
    assert.ok(branch.includes("'approve'") && branch.includes('reject'), 'approve/reject missing');
    for (const bad of ['showSchedule', "'schedule'", 'Send back', 'Restore']) assert.ok(!branch.includes(bad), `decision branch offers ${bad}`);
});

check('assistant-records refuses a PATCH of a campaign mirror, single and bulk', () => {
    assert.ok(/MIRROR_RECORD_TYPES = new Set\(\['campaign_order', 'campaign_decision'\]\)/.test(records));
    const uses = records.match(/MIRROR_RECORD_TYPES\.has\(/g) || [];
    assert.ok(uses.length >= 2, `expected the single and bulk guards, found ${uses.length}`);
    assert.ok(records.includes('json(409'), 'no 409 for a mirror PATCH');
});

check('campaigns.ts rejects a non-numeric assistant or campaign id before querying', () => {
    const orch = campaigns.slice(campaigns.indexOf('async function requireOrchestrator('));
    assert.ok(/^[\s\S]{0,400}Number\.isInteger\(assistantId\)/.test(orch), 'requireOrchestrator has no id guard');
    const camp = campaigns.slice(campaigns.indexOf('async function requireCampaign('));
    assert.ok(/^[\s\S]{0,200}Number\.isInteger\(campaignId\)/.test(camp), 'requireCampaign has no id guard');
});

console.log(`\n${passed} passed`);
