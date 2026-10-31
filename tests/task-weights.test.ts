// tests/task-weights.test.ts
// The single task allowance (docs/task-metering.md): what each finished piece of work costs, and
// how a pre-cutover credit amount converts. These numbers are what customers are charged — the
// pricing page, FAQ, terms and help article quote them, so a silent change here is a billing change.
//
// Run:  npx tsx tests/task-weights.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASK_WEIGHTS, WORK_KIND_LABELS, MEDIA_KINDS, taskWeight, type WorkKind } from '../src/config/task-weights';
import { tasksForCredits, workKindForMedia, IMAGE_CREDIT_COST, VIDEO_CREDIT_COST, MUSIC_CREDIT_COST, MUSIC_SHARED_CREDIT_COST } from '../src/utils/ai-credits';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

console.log('Task weights — one finished piece of work, weighted only where it costs real money');

check('the agreed weights: work 1, image 1, video and music 20, shared music 12, X link post 10', () => {
    for (const k of ['social_post', 'blog_article', 'lead_search', 'email_issue', 'email_campaign',
        'outreach_email', 'site_audit', 'site_draft', 'site_words', 'ai_image'] as WorkKind[]) {
        assert.strictEqual(taskWeight(k), 1, k);
    }
    assert.strictEqual(TASK_WEIGHTS.ai_video, 20);
    assert.strictEqual(TASK_WEIGHTS.ai_music, 20);
    assert.strictEqual(TASK_WEIGHTS.ai_music_shared, 12);
    assert.strictEqual(TASK_WEIGHTS.x_link_post, 10);
});

check('every weight is a positive integer and every kind has a customer-facing label', () => {
    for (const [k, w] of Object.entries(TASK_WEIGHTS)) {
        assert.ok(Number.isInteger(w) && w > 0, `${k} = ${w}`);
        assert.ok(WORK_KIND_LABELS[k as WorkKind], `${k} has no label`);
    }
});

check('media kinds are exactly the AI-generated ones (the autonomous cap counts these)', () => {
    assert.deepStrictEqual([...MEDIA_KINDS].sort(), ['ai_image', 'ai_music', 'ai_music_shared', 'ai_video', 'ai_voiceover']);
});

check('a pre-cutover credit amount converts to the same tasks as the weight', () => {
    assert.strictEqual(tasksForCredits('image', IMAGE_CREDIT_COST), TASK_WEIGHTS.ai_image);
    assert.strictEqual(tasksForCredits('video', VIDEO_CREDIT_COST), TASK_WEIGHTS.ai_video);
    assert.strictEqual(tasksForCredits('audio', MUSIC_CREDIT_COST), TASK_WEIGHTS.ai_music);
    assert.strictEqual(tasksForCredits('audio', MUSIC_SHARED_CREDIT_COST), TASK_WEIGHTS.ai_music_shared);
    assert.strictEqual(tasksForCredits('video', 0), 0);
    assert.strictEqual(workKindForMedia('audio', MUSIC_SHARED_CREDIT_COST), 'ai_music_shared');
    assert.strictEqual(workKindForMedia('video', VIDEO_CREDIT_COST), 'ai_video');
});

check('the cutover converts media credits at the video rate (×4), matching tasksForCredits', () => {
    const sql = read('db/ops/task-allowance-cutover.sql');
    assert.match(sql, /GREATEST\(b\.balance, 0\) \* 4 AS from_media/);
    assert.strictEqual(TASK_WEIGHTS.ai_video / VIDEO_CREDIT_COST, 4);
});

check('the cutover script is NOT a migration the tracker would run early', () => {
    // scripts/db-migrate.mjs applies every pending db/*.sql — the cutover must live in db/ops/.
    assert.throws(() => read('db/z-task-credit-conversion.sql'));
    assert.match(read('scripts/db-migrate.mjs'), /readdirSync\(DB_DIR\)/);
});

console.log(`\n${passed} checks passed.`);
