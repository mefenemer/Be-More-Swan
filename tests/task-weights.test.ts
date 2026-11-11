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
import { DEFAULT_TASK_WEIGHTS, WORK_KIND_LABELS, MEDIA_KINDS, aiVideoTasks, DEFAULT_TASK_COSTS, type WorkKind } from '../src/config/task-weights';
import { billedSecondsFor, i2vModel } from '../src/lib/fal-gateway';
import { switchedOn } from '../src/config/dated-switch';
import { videoPricedBySecond } from '../src/config/task-weights';
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
        assert.strictEqual(DEFAULT_TASK_WEIGHTS[k], 1, k);
    }
    assert.strictEqual(DEFAULT_TASK_WEIGHTS.ai_video, 20);
    assert.strictEqual(DEFAULT_TASK_WEIGHTS.ai_music, 20);
    assert.strictEqual(DEFAULT_TASK_WEIGHTS.ai_music_shared, 12);
    assert.strictEqual(DEFAULT_TASK_WEIGHTS.x_link_post, 10);
});

check('every weight is a positive integer and every kind has a customer-facing label', () => {
    for (const [k, w] of Object.entries(DEFAULT_TASK_WEIGHTS)) {
        assert.ok(Number.isInteger(w) && w > 0, `${k} = ${w}`);
        assert.ok(WORK_KIND_LABELS[k as WorkKind], `${k} has no label`);
    }
});

check('media kinds are exactly the AI-generated ones (the autonomous cap counts these)', () => {
    assert.deepStrictEqual([...MEDIA_KINDS].sort(), ['ai_image', 'ai_music', 'ai_music_shared', 'ai_video', 'ai_voiceover']);
});

check('a pre-cutover credit amount converts to the same tasks as the weight', () => {
    assert.strictEqual(tasksForCredits('image', IMAGE_CREDIT_COST, DEFAULT_TASK_COSTS), DEFAULT_TASK_WEIGHTS.ai_image);
    assert.strictEqual(tasksForCredits('video', VIDEO_CREDIT_COST, DEFAULT_TASK_COSTS), DEFAULT_TASK_WEIGHTS.ai_video);
    assert.strictEqual(tasksForCredits('audio', MUSIC_CREDIT_COST, DEFAULT_TASK_COSTS), DEFAULT_TASK_WEIGHTS.ai_music);
    assert.strictEqual(tasksForCredits('audio', MUSIC_SHARED_CREDIT_COST, DEFAULT_TASK_COSTS), DEFAULT_TASK_WEIGHTS.ai_music_shared);
    assert.strictEqual(tasksForCredits('video', 0, DEFAULT_TASK_COSTS), 0);
    assert.strictEqual(workKindForMedia('audio', MUSIC_SHARED_CREDIT_COST), 'ai_music_shared');
    assert.strictEqual(workKindForMedia('video', VIDEO_CREDIT_COST), 'ai_video');
});

check('the cutover converts media credits at the video rate (×4), matching tasksForCredits', () => {
    const sql = read('db/ops/task-allowance-cutover.sql');
    assert.match(sql, /GREATEST\(b\.balance, 0\) \* 4 AS from_media/);
    assert.strictEqual(DEFAULT_TASK_WEIGHTS.ai_video / VIDEO_CREDIT_COST, 4);
});

check('the cutover script is NOT a migration the tracker would run early', () => {
    // scripts/db-migrate.mjs applies every pending db/*.sql — the cutover must live in db/ops/.
    assert.throws(() => read('db/z-task-credit-conversion.sql'));
    assert.match(read('scripts/db-migrate.mjs'), /readdirSync\(DB_DIR\)/);
});

check('AI video by the second: 4 a second when switched on, the flat weight until then (terms clause 5.2 notice)', () => {
    const was = process.env.AI_VIDEO_PRICED_BY_SECOND;
    try {
        delete process.env.AI_VIDEO_PRICED_BY_SECOND;
        assert.strictEqual(aiVideoTasks(10, DEFAULT_TASK_COSTS), DEFAULT_TASK_WEIGHTS.ai_video, 'off: a 10 s clip is the flat weight the terms state');
        assert.strictEqual(aiVideoTasks(5, DEFAULT_TASK_COSTS), DEFAULT_TASK_WEIGHTS.ai_video);
        process.env.AI_VIDEO_PRICED_BY_SECOND = 'on';
        assert.strictEqual(DEFAULT_TASK_COSTS.videoTasksPerSecond, 4);
        assert.strictEqual(aiVideoTasks(5, DEFAULT_TASK_COSTS), 20, 'a 5 s clip costs what it does today');
        assert.strictEqual(aiVideoTasks(6, DEFAULT_TASK_COSTS), 24);
        assert.strictEqual(aiVideoTasks(10, DEFAULT_TASK_COSTS), 40);
        assert.strictEqual(aiVideoTasks(3, DEFAULT_TASK_COSTS), 12);
        assert.strictEqual(aiVideoTasks(4.2, DEFAULT_TASK_COSTS), 20, 'a part second counts as a second');
        assert.strictEqual(aiVideoTasks(null, DEFAULT_TASK_COSTS), DEFAULT_TASK_WEIGHTS.ai_video, 'unknown length → the flat weight');
    } finally {
        if (was === undefined) delete process.env.AI_VIDEO_PRICED_BY_SECOND; else process.env.AI_VIDEO_PRICED_BY_SECOND = was;
    }
});

check('the length charged is the length the model bills', () => {
    assert.strictEqual(billedSecondsFor(6, 'fal-ai/kling-video/v3/pro/image-to-video'), 6);
    assert.strictEqual(billedSecondsFor(6, 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video'), 5, 'Kling 2.5 makes 5 or 10');
    assert.strictEqual(billedSecondsFor(8, 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video'), 10);
    assert.strictEqual(billedSecondsFor(5, 'off'), 6, 'Hailuo text-to-video makes 6 or 10');
});

check('every place an AI clip is charged passes its length', () => {
    assert.match(read('src/utils/ai-credits.ts'), /units: params\.tasks \?\? tasksForCredits\(params\.mediaType, params\.amount, await getTaskCosts\(\)\),/);
    const vp = read('src/utils/video-producer.ts');
    // A single AI clip with sound is 1.5× (ai-clip.ts) — still from the length the model billed.
    assert.match(vp, /tasks: clipTasksWithSound\(aiVideoTasks\(sub\.billedSeconds, await getTaskCosts\(\)\), sub\.withSound === true\) \};/);
    assert.match(vp, /await settle\(scene\.source === 'ai_video' \? 'video' : 'image', paid, !!made, made\?\.tasks\);/);
    assert.match(vp, /n \+= clipTasksWithSound\(aiVideoTasks\(billedSecondsFor\(aiClipSeconds\(s\.targetS, model\), model\), costs\),/, 'the estimate and hold use the same rule');
    const vb = read('src/utils/visual-briefs.ts');
    assert.strictEqual((vb.match(/aiVideoTasks\(billedSecondsFor\(BRIEF_CLIP_SECONDS\), /g) || []).length, 2, 'Brand Designer hold and settle');
    assert.match(read('src/utils/ai-video-job.ts'), /tasks: aiVideoTasks\(billedSecondsFor\(durationSeconds\), await getTaskCosts\(\)\)/);
    assert.match(read('netlify/functions/process-media-job-background.ts'), /tasks: aiVideoTasks\(job\.durationSeconds, await getTaskCosts\(\)\)/);
    assert.match(read('src/utils/work-metering.ts'), /CEIL\(COALESCE\(duration_seconds, 6\)\)::int \* \$\{costs\.videoTasksPerSecond\}::int/);
    assert.match(read('src/utils/task-balance.ts'), /SUM\(\$\{inFlightWeightSql\(await getTaskCosts\(\)\)\}\)/);
});

check('the per-second notice quotes the numbers the rule charges', () => {
    const cat = read('src/utils/notification-templates-catalog.ts');
    const tpl = cat.slice(cat.indexOf("templateKey: 'ai_video_per_second_notice'"), cat.indexOf("templateKey: 'social_disconnected'"));
    const was = process.env.AI_VIDEO_PRICED_BY_SECOND;
    process.env.AI_VIDEO_PRICED_BY_SECOND = 'on';
    try {
        assert.ok(tpl.includes(`${DEFAULT_TASK_COSTS.videoTasksPerSecond} tasks for each second`));
        assert.ok(tpl.includes(`a 5-second clip stays ${aiVideoTasks(5, DEFAULT_TASK_COSTS)}`));
        assert.ok(tpl.includes(`a 10-second clip becomes ${aiVideoTasks(10, DEFAULT_TASK_COSTS)}`));
        assert.ok(tpl.includes(`instead of ${DEFAULT_TASK_WEIGHTS.ai_video} for any clip`));
        const email = read('docs/ai-video-per-second-notice.md');
        for (const n of [3, 5, 6, 10]) assert.match(email, new RegExp(`\\| ${n} seconds \\| ${DEFAULT_TASK_WEIGHTS.ai_video} tasks \\| ${aiVideoTasks(n, DEFAULT_TASK_COSTS)} tasks \\|`));
    } finally {
        if (was === undefined) delete process.env.AI_VIDEO_PRICED_BY_SECOND; else process.env.AI_VIDEO_PRICED_BY_SECOND = was;
    }
});

check('the switches can be set ahead of the notice date and start on it, never before', () => {
    const before = new Date('2026-12-02T23:59:59Z'), on = new Date('2026-12-03T00:00:00Z');
    assert.strictEqual(switchedOn('on', before), true);
    assert.strictEqual(switchedOn('2026-12-03', before), false, 'the day before the notice date: off');
    assert.strictEqual(switchedOn('2026-12-03', on), true);
    for (const v of [undefined, '', 'off', 'true', '3 December', '2026-12-3']) assert.strictEqual(switchedOn(v, on), false, String(v));
    const was = { p: process.env.AI_VIDEO_PRICED_BY_SECOND, m: process.env.FAL_I2V_MODEL, f: process.env.FAL_I2V_MODEL_FROM };
    try {
        process.env.AI_VIDEO_PRICED_BY_SECOND = '2026-12-03';
        assert.strictEqual(videoPricedBySecond(before), false);
        assert.strictEqual(videoPricedBySecond(on), true);
        process.env.FAL_I2V_MODEL = 'fal-ai/kling-video/v3/pro/image-to-video';
        process.env.FAL_I2V_MODEL_FROM = '2026-12-03';
        assert.match(i2vModel(before), /v2\.5-turbo/, 'Kling 2.5 until the date');
        assert.match(i2vModel(on), /\/v3\//, 'Kling 3 from it');
        delete process.env.FAL_I2V_MODEL_FROM;
        assert.match(i2vModel(before), /\/v3\//, 'no date: the chosen model at once (staging)');
        delete process.env.FAL_I2V_MODEL;
        assert.match(i2vModel(on), /v2\.5-turbo/, 'unset: the default');
    } finally {
        for (const [k, v] of [['AI_VIDEO_PRICED_BY_SECOND', was.p], ['FAL_I2V_MODEL', was.m], ['FAL_I2V_MODEL_FROM', was.f]] as const) {
            if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
    }
});

check('terms 5.2 states the per-second rule with its start date', () => {
    const tos = read('terms_of_service.html');
    assert.ok(tos.includes('an AI-generated video as <span data-task-cost="ai_video_per_second">4 tasks a second</span> of video'));
    assert.ok(tos.includes('before 3 December 2026, 20 tasks for any clip'));
    assert.ok(tos.includes('The change to clause 5.2 takes effect on 3 December 2026'));
});

console.log(`\n${passed} checks passed.`);
