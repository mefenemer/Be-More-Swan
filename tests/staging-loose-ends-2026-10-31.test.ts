// tests/staging-loose-ends-2026-10-31.test.ts
// Three things found testing the Campaign Assistant, Brand Designer and Video Producer on staging
// (2026-10-31), each pinned so it can't come back:
//   · the Brand Designer quoted "AI credits" while the workspace is charged tasks
//   · a campaign said "Nothing needed from you" while a storyboard or picture options waited on the user
//   · "28 of 10500 tasks used · 11396 left" — right (bonus tasks), but read as a broken sum
// No network, no database.
//
// Run:  npx tsx tests/staging-loose-ends-2026-10-31.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_SPECS } from '../src/config/visual-brief-vocab';
import { TASK_WEIGHTS } from '../src/config/task-weights';
import { artefactWaitingOnYou, describeWork, nextStep } from '../src/utils/campaign-work-state';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}

console.log('\n──── the Brand Designer quotes tasks ────');

check('every source says what a round takes in tasks, from the task weights', () => {
    assert.strictEqual(SOURCE_SPECS.ai_image.tasks, TASK_WEIGHTS.ai_image);
    assert.strictEqual(SOURCE_SPECS.ai_video.tasks, TASK_WEIGHTS.ai_video);
    for (const k of ['stock', 'brand_card', 'stock_video'] as const) assert.strictEqual(SOURCE_SPECS[k].tasks, 0, k);
});

check('the Briefs tab gets the unit and words its cost lines by it', () => {
    assert.match(read('netlify/functions/brand-briefs.ts'), /unit: balance\?\.unit \?\? 'credits'/);
    const tab = read('src/components/assistant-briefs.js');
    assert.match(tab, /state\.unit = data\.unit === 'tasks' \? 'tasks' : 'credits';/);
    assert.match(tab, /Each round uses \$\{n\} task\$\{n === 1 \? '' : 's'\}/);
    assert.match(tab, /'Tasks left this month'/);
    assert.match(tab, /state\.unit === 'tasks' \? `\$\{ai\.tasks\} tasks`/);
});

check('its chat, the campaign order and the team feed no longer say AI credits', () => {
    const chat = read('netlify/functions/chat-orchestrator.ts');
    const route = chat.slice(chat.indexOf('    brand_designer: {'), chat.indexOf('    video_producer: {'));
    assert.match(route, /A round with AI images uses \$\{SOURCE_SPECS\.ai_image\.tasks\} task/);
    assert.doesNotMatch(route.replace(/\/\/.*$/gm, ''), /AI credit/);
    assert.doesNotMatch(chat, /that is where the AI credit is shown/);
    assert.doesNotMatch(read('src/config/campaign-vocab.ts').match(/commission_visuals: \{[\s\S]*?\n    \},/)![0], /AI credit is shown/);
    assert.ok(read('src/utils/team-messages.ts').includes("label: 'Yes — AI video (uses tasks)'"));
});

console.log('\n──── a campaign says when work waits on you ────');

const row = (o: Partial<Parameters<typeof describeWork>[0][number]>) => ({
    id: 1, action: 'commission_video', status: 'issued', blockedOnOrderId: null, resultSummary: 'The Video Producer is planning the storyboard',
    artefactKind: 'video_project', targetAssistantId: 60, brief: {}, ...o,
});

check('a storyboard or picture options waiting on the user make the item "waiting on you", live', () => {
    assert.match(artefactWaitingOnYou('video_project', 'planned')!, /Make the video/);
    assert.match(artefactWaitingOnYou('video_project', 'built')!, /Review Queue/);
    assert.match(artefactWaitingOnYou('visual_brief', 'in_review')!, /Briefs tab/);
    assert.match(artefactWaitingOnYou('visual_brief', 'open')!, /ask the Brand Designer for options/);
    assert.strictEqual(artefactWaitingOnYou('video_project', 'planning'), null);
    assert.strictEqual(artefactWaitingOnYou('video_project', 'building'), null);
    assert.strictEqual(artefactWaitingOnYou('visual_brief', 'generating'), null);
    assert.strictEqual(artefactWaitingOnYou('scheduled_post', 'planned'), null);
});

check('the next step names it instead of "Nothing needed from you"', () => {
    const planning = describeWork([row({ artefactStatus: 'planning' })]);
    assert.strictEqual(planning[0].state, 'working');
    assert.match(nextStep({ status: 'active' }, false, planning).text, /^Nothing needed from you/);
    const waiting = describeWork([row({ artefactStatus: 'planned' })]);
    assert.strictEqual(waiting[0].state, 'waiting_you');
    assert.deepStrictEqual(waiting[0].link, { assistantId: 60, tab: 'videos', label: 'Open the video' });
    const step = nextStep({ status: 'active' }, false, waiting);
    assert.strictEqual(step.kind, 'act');
    assert.match(step.text, /Item 1, commission a video: Storyboard ready/);
});

check('the Campaigns tab reads the brief\'s or video\'s own status', () => {
    const fn = read('netlify/functions/campaigns.ts');
    assert.match(fn, /WHEN 'video_project' THEN \(SELECT v\.status FROM video_projects v WHERE v\.id = \$\{campaignOrders\.artefactId\}\)/);
    assert.match(fn, /WHEN 'visual_brief' THEN \(SELECT b\.status FROM visual_briefs b WHERE b\.id = \$\{campaignOrders\.artefactId\}\)/);
    assert.match(fn, /artefactStatus: o\.artefactStatus \?\? null,/);
});

console.log('\n──── the task count explains itself ────');

check('"left" says it includes bonus tasks', () => {
    assert.match(read('src/utils/work-metering.ts'), /Math\.max\(plan\.limit - used, 0\) \+ bonus - inFlight/);
    assert.match(read('src/utils/campaign-ledger.ts'), /noPlan: false, bonus: usage\.bonus \}/);
    assert.match(read('src/components/assistant-campaigns.js'), /, including \$\{esc\(String\(gate\.bonus\)\)\} bonus tasks/);
});

console.log(`\n${passed} checks passed`);
