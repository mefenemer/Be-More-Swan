// tests/voiceover-long-cost.test.ts
// A long voiceover counts by its length (owner, 2026-11-19): ai_voiceover for the first 2,500 characters, plus
// ai_voiceover_long for each further started 2,500. The baseline is 0, so nobody pays more until a change is
// announced (Terms 5.2). What goes wrong silently if these drift:
//   · the quote counting one script and the build charging for another (a charge above the quote)
//   · a short voiceover, or a post's, starting to cost more than 1
//   · the key missing from the SQL baseline, so Admin shows it but the live costs never hold it
//
// Run:  npx tsx tests/voiceover-long-cost.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { DEFAULT_TASK_WEIGHTS, COST_KEYS, MEDIA_KINDS, formatCost, isCostRise, voiceoverTasks, VOICEOVER_CHARS_PER_STEP, type TaskCosts } from '../src/config/task-weights';
import { buildTasks, voiceoverScript } from '../src/utils/video-producer';
import { formatPlanBlock } from '../src/utils/chat-plan-snapshot';
import type { VideoBrief } from '../src/lib/storyboard';
import { VOICEOVER_MAX_CHARS, LONG_VOICEOVER_MAX_CHARS } from '../src/lib/tts';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const costsWith = (long: number): TaskCosts => ({ weights: { ...DEFAULT_TASK_WEIGHTS, ai_voiceover_long: long }, videoTasksPerSecond: 4, chatMessagesPerTask: 10 } as unknown as TaskCosts);
const brief = (o: Partial<VideoBrief> = {}): VideoBrief => ({ purpose: 'promo', lengthS: 30, message: 'Booking made easy', voiceover: true, allowAi: 'stock_only', ...o });
const words = (n: number) => 'Word. '.repeat(Math.ceil(n / 6)).slice(0, n).trim();
const sbOf = (script: string) => ({ title: 't', caption: 'c', scenes: [{ id: 's1', beat: 'hook', voiceover: script, source: 'brand_card', targetS: 3 }] }) as unknown as Parameters<typeof buildTasks>[0];

check('the rule: 1 up to 2,500 characters, then the long rate for each further started 2,500', () => {
    assert.strictEqual(VOICEOVER_CHARS_PER_STEP, 2500);
    const one = costsWith(1);
    assert.strictEqual(voiceoverTasks(0, one), 1);
    assert.strictEqual(voiceoverTasks(2500, one), 1);
    assert.strictEqual(voiceoverTasks(2501, one), 2);
    assert.strictEqual(voiceoverTasks(5000, one), 2);
    assert.strictEqual(voiceoverTasks(LONG_VOICEOVER_MAX_CHARS, one), 6, '15,000 characters: 1 + 5');
    assert.strictEqual(voiceoverTasks(LONG_VOICEOVER_MAX_CHARS, costsWith(2)), 11);
    assert.ok(VOICEOVER_MAX_CHARS <= VOICEOVER_CHARS_PER_STEP, 'a post\'s or short video\'s voiceover never reaches the long rate');
});

check('today (baseline 0): every voiceover stays 1, whatever its length', () => {
    assert.strictEqual(DEFAULT_TASK_WEIGHTS.ai_voiceover_long, 0);
    assert.strictEqual(voiceoverTasks(LONG_VOICEOVER_MAX_CHARS, costsWith(0)), DEFAULT_TASK_WEIGHTS.ai_voiceover);
    const long = brief({ lengthS: 300, presenter: { id: 'amara' }, screenAssetIds: [1] } as Partial<VideoBrief>);
    assert.strictEqual(buildTasks(sbOf(words(9000)), long, costsWith(0)), 1);
});

check('the quote counts the words the build will speak', () => {
    const long = brief({ lengthS: 300 });
    const script = words(9000);
    assert.strictEqual(voiceoverScript(sbOf(script), long).length, script.length);
    assert.strictEqual(buildTasks(sbOf(script), long, costsWith(1)), 4, '9,000 characters: 1 + 3');
    // A short video is cut to 1,200 before speaking, so a runaway script can't be quoted (or charged) as long.
    assert.strictEqual(voiceoverScript(sbOf(script), brief()).length, VOICEOVER_MAX_CHARS);
    assert.strictEqual(buildTasks(sbOf(script), brief(), costsWith(1)), 1);
    assert.strictEqual(buildTasks(sbOf(script), long, costsWith(1), { sceneAssets: {}, voiceoverAssetId: 7 } as never), 0, 'a voiceover already made is not charged again');
    assert.strictEqual(buildTasks(sbOf(script), { ...long, ownVoice: true } as VideoBrief, costsWith(1)), 0, 'the owner\'s own voice is never charged');
});

check('the build speaks and charges the same script', () => {
    const vp = read('src/utils/video-producer.ts');
    assert.match(vp, /const script = voiceoverScript\(storyboard, brief\);/);
    assert.match(vp, /const voTasks = voiceoverTasks\(script\.length, await getTaskCosts\(\)\);/);
    assert.match(vp, /Math\.min\(voTasks, voiceoverTasks\(script\.length, await getTaskCosts\(p\.startedAt\)\)\)/, 'never above the quote when a cost change starts mid-build');
    assert.match(vp, /n \+= voiceoverTasks\(voiceoverScript\(storyboard, brief\)\.length, costs\)/);
});

check('Admin, notices and SQL: a cost key in the baseline at 0, a rise when raised, not counted as an extra media item', () => {
    assert.ok(COST_KEYS.includes('ai_voiceover_long'));
    assert.ok(!MEDIA_KINDS.includes('ai_voiceover_long' as never), 'the autonomous media cap counts the voiceover once');
    assert.strictEqual(formatCost('ai_voiceover_long', 1), '1 task for each further 2,500 characters');
    assert.strictEqual(formatCost('ai_voiceover_long', 0), 'no tasks');
    assert.strictEqual(isCostRise('ai_voiceover_long', 0, 1), true, 'raising it needs the 30-day notice');
    assert.match(read('db/z-task-costs.sql'), /\(1, 'ai_voiceover_long', 0\)/);
    assert.match(read('db/z-voiceover-long-cost.sql'), /VALUES \(1, 'ai_voiceover_long', 0\)\s*ON CONFLICT \(change_id, cost_key\) DO NOTHING/);
});

check('general chat states the long rate only once it is above 0 (review of #781)', () => {
    const base = { planName: 'Grow', status: 'active' as const, gracePeriodEndsAt: null, monthlyTaskLimit: 500, taskCount: 10, bonusTasks: 0, tasksInFlight: 0, unified: true, now: new Date('2026-11-19T12:00:00Z') };
    assert.doesNotMatch(formatPlanBlock({ ...base, costs: costsWith(0) }), /long video's voiceover/);
    assert.match(formatPlanBlock({ ...base, costs: costsWith(1) }), /a long video's voiceover adds 1 task for each further 2,500 characters after the first 2,500/);
});

console.log(`\n${passed} checks passed`);
