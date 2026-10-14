// tests/campaign-first-run-feedback.test.ts
// The owner's first run of a campaign end to end on prod (campaign 1, 2026-10-14), and what it
// found. Each check pins one fix:
//   1. Asking for options showed no "working" signal.
//   2. "Use this" never said whether the brief was finished.
//   3. A picture brief never asked about video.
//   4. The Orders and Campaigns tabs showed state from page load, long after it changed.
//   5. Campaign posts were drafted for Instagram only, all with the ONE approved image.
//   6. Header dropdowns opened underneath the post editor and Blog Studio pages.
//   7. The round button carried its credit cost in its name, and not the assistant's name.
//   8. No way to talk a brief's options through with the Brand Designer from the brief.
//   9. (same cause as 5) A later brand card then went on every following post.
//
// Run:  npx tsx tests/campaign-first-run-feedback.test.ts

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
const briefs = read('src/components/assistant-briefs.js');

console.log('campaign first-run feedback');

check('1. a round in flight holds the house spinner, once, and gives it back', () => {
    assert.ok(briefs.includes('function syncBusy(on)') && briefs.includes('window.bmsBusy(on)'), 'no busy sync');
    assert.ok(/syncBusy\(making\)/.test(briefs), 'the poll does not drive the spinner');
    assert.ok(/finally \{\s*window\.bmsBusy\?\.\(false\);/.test(briefs), 'the click can strand the spinner');
});

check('2. choosing a picture says the brief is finished, and that extras are optional', () => {
    // Superseded by picture counts (2026-10-14): "N of M chosen", then "no more needed".
    assert.ok(briefs.includes('no more pictures are needed for ${forWhat(b)}'), 'the done line does not say no more are needed');
    assert.ok(briefs.includes('`${p.chosen} of ${p.needed} chosen for ${forWhat(b)} — ${p.left} more needed. `'), 'no running tally');
    assert.ok(briefs.includes('That is all this brief needed, so you are done here.'), 'the approve note does not say so');
});

check('3. a pictures-only brief offers video, and the chat asks', () => {
    assert.ok(briefs.includes('function videoOfferHtml(b)') && briefs.includes('data-brief-add-video'), 'no video offer');
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('ASK whether they want video as well as pictures'), 'the chat does not ask');
});

check('4. the Orders and Campaigns tabs re-read when opened again', () => {
    assert.ok(read('src/components/assistant-data-hub.js').includes("state.hub.recordType === 'campaign_order') refresh()"), 'Orders never refreshes');
    assert.ok(read('assistants.js').includes("if (name === 'datahub') window.AssistantDataHub?.activate?.();"), 'activation not wired');
    assert.ok(read('src/components/assistant-campaigns.js').includes('if (state.rendered) { load(); return; }'), 'Campaigns never refreshes');
});

check('5. campaign posts fan out to every platform the assistant drafts for', () => {
    const orders = read('src/utils/campaign-orders.ts');
    assert.ok(orders.includes('async function campaignPostPlatforms('), 'no platform resolution');
    assert.ok(orders.includes('resolveConnectedDraftPlatforms(db, ctx.organisationId, a)'), 'not scoped to the assistant');
    assert.strictEqual((orders.match(/\.\.\.fan,/g) || []).length, 2, 'both post executors must carry the platforms');
});

check('5 & 9. a campaign picture goes on ONE post, then the usual sources take over', () => {
    const r = read('src/utils/media-resolver.ts');
    const fn = r.slice(r.indexOf('async function pickCampaignAsset('), r.indexOf('async function pickStockAsset('));
    assert.ok(fn.includes('NOT EXISTS (SELECT 1 FROM scheduled_post_assets'), 'a used picture can be picked again');
});

check('6. header dropdowns sit above the editor and Blog Studio pages', () => {
    const w = read('workspace.html');
    assert.ok(w.includes('<nav id="app-header"'), 'header has no id');
    assert.ok(w.includes('body:has(#post-review-modal.pr-page:not(.hidden)) #app-header'), 'editor page not covered');
    assert.ok(w.includes('body:has(#bms-blog-backdrop.bs-page.bs-open) #app-header { z-index: 92; }'), 'Blog Studio page not covered');
});

check('7. the round button names the assistant; the cost is its own line', () => {
    assert.ok(briefs.includes('`Ask ${name()} for options`') && briefs.includes('`Ask ${name()} for more options`'), 'button not renamed');
    const label = briefs.slice(briefs.indexOf('function roundButtonLabel('), briefs.indexOf('function roundCostLine('));
    assert.ok(!/credit/i.test(label), 'the button label still carries the cost');
    assert.ok(briefs.includes('${esc(roundCostLine(b))}'), 'the cost is not shown anywhere');
});

check('8. each brief can be talked through with the Brand Designer', () => {
    assert.ok(briefs.includes('data-brief-chat=') && briefs.includes('openAssistantChat?.({ assistantId: state.assistantId, draft:'), 'no chat from the brief');
    const modal = read('src/components/assistant-chat-modal.js');
    assert.ok(modal.includes('if (opts.draft)') && !/sendMessage\(opts\.draft/.test(modal), 'the draft must be typed in, never sent');
});

console.log(`\n${passed} passed`);
