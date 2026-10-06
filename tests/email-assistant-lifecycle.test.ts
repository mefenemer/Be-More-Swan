// tests/email-assistant-lifecycle.test.ts
// The Email Marketing Assistant's page follows its work like every other assistant (2026-10-06):
//   · the Review tab counts EVERY column from one list, so an email visibly moves Review → Sent
//   · "Posted" reads "Sent" for emails; failed sends sit in Needs attention, not Archived
//   · sent emails carry their results; campaigns have their own tab with status and results
//   · a campaign opens straight into the Email Studio
//
// Run:  npx tsx tests/email-assistant-lifecycle.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');
const a = read('assistants.js');

check('every column is counted from one list of the assistant\'s emails', () => {
    assert.match(a, /_detailRqPaintNewsletterCounts\(all\);\s*const issues = all\.filter\(\(i\) => wanted\.includes\(i\.status\)\);/);
    assert.match(a, /function _detailRqPaintNewsletterCounts\(all\) \{/);
});

check('Sent label, failed → Needs attention, results on sent cards', () => {
    assert.match(a, /setText\('detail-rq-col-label-posted', 'Sent'\);/);
    assert.match(a, /setText\('detail-rq-col-label-posted', 'Posted'\);/);
    assert.match(a, /attention: \['failed'\],\s*archived: \['archived', 'rejected'\],/);
    assert.match(a, /\$\{issue\.status === 'sent' \? _rqNewsletterResults\(issue\) : ''\}/);
    assert.match(read('netlify/functions/newsletter-issues.ts'), /clickedCount: newsletterIssues\.clickedCount,/);
    assert.match(read('assistant-detail.html'), /<span id="detail-rq-col-label-posted">Posted<\/span>/);
});

check('a Campaigns tab for this role only, fed by one summary request', () => {
    const d = read('assistant-detail.html');
    assert.match(d, /id="maintab-btn-email-campaigns" data-maintab="email-campaigns" class="main-tab-btn hidden"/);
    assert.match(d, /<div id="maintab-email-campaigns" class="main-tab-content hidden">/);
    assert.match(read('src/components/assistant-dashboard-registry.js'), /emailCampaignsTab: true,/);
    assert.match(a, /toggle\('maintab-btn-email-campaigns', !!cfg\.emailCampaignsTab\);/);
    assert.match(a, /if \(name === 'email-campaigns'\) window\.AssistantEmailCampaigns\?\.activate\(\);/);
    assert.match(read('workspace.html'), /<script src="\/src\/components\/assistant-email-campaigns\.js"><\/script>/);
    assert.match(read('netlify/functions/newsletter-sequences.ts'), /if \(event\.queryStringParameters\?\.summary === '1'\) \{\s*return json\(200, \{ campaigns: await campaignSummaries\(/);
});

check('a campaign opens in the Email Studio; New opens the campaign planner', () => {
    const c = read('src/components/assistant-email-campaigns.js');
    assert.match(c, /window\._newsletterInitialSequenceId = Number\(/);
    assert.match(c, /window\._newsletterOpenNewCampaign = true;/);
    const n = read('newsletter.js');
    assert.match(n, /if \(wantedSeq\) \{ seqState\.selectedId = wantedSeq; openWelcomeModal\(\); \}\s*else if \(newCampaign\) openCampaignModal\(\);/);
});

console.log(`\n${passed} checks passed`);
