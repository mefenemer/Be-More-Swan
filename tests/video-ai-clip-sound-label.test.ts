// tests/video-ai-clip-sound-label.test.ts
// Video Producer plan Phases 6–8 (2026-11-11): an AI clip "with sound", a model per clip style, and AI video
// declared to YouTube as synthetic content.
//
// Run:  npx tsx tests/video-ai-clip-sound-label.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { imageToVideoInput, i2vModel, clipSoundAvailable } from '../src/lib/fal-gateway';
import { clipTasksWithSound, CLIP_SOUND_PRICE, CLIP_SOUND_PROMPT } from '../src/lib/ai-clip';
import { isAiVideo } from '../src/utils/ai-disclosure';
import { buildTasks as buildTasksAt } from '../src/utils/video-producer';
import { DEFAULT_TASK_COSTS } from '../src/config/task-weights';
import type { Storyboard, VideoBrief } from '../src/lib/storyboard';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const V3 = 'fal-ai/kling-video/v3/pro/image-to-video';
const V25 = 'fal-ai/kling-video/v2.5-turbo/pro/image-to-video';

check('sound is asked of the model only when wanted, and only v3 can make it', () => {
    assert.strictEqual(imageToVideoInput(V3, { imageUrl: 'u', prompt: 'p', durationSeconds: 5 }).input.generate_audio, false);
    assert.strictEqual(imageToVideoInput(V3, { imageUrl: 'u', prompt: 'p', durationSeconds: 5, withSound: true }).input.generate_audio, true);
    assert.strictEqual(imageToVideoInput(V25, { imageUrl: 'u', prompt: 'p', durationSeconds: 5, withSound: true }).input.generate_audio, undefined, 'v2.5 has no sound');
    assert.ok(clipSoundAvailable(V3) && !clipSoundAvailable(V25));
    assert.ok(/no speech/.test(CLIP_SOUND_PROMPT));
});

check('a clip with sound costs 1.5×, rounded up', () => {
    assert.strictEqual(CLIP_SOUND_PRICE, 1.5);
    assert.strictEqual(clipTasksWithSound(20, true), 30);
    assert.strictEqual(clipTasksWithSound(21, true), 32);
    assert.strictEqual(clipTasksWithSound(20, false), 20);
});

check('a style can have its own model; unset falls back', () => {
    const prev = { ...process.env };
    process.env.FAL_I2V_MODEL = V25; delete process.env.FAL_I2V_MODEL_FROM;
    process.env.FAL_I2V_MODEL_CINEMATIC = 'bytedance/seedance-2.5/us/image-to-video';
    try {
        assert.strictEqual(i2vModel(new Date(), 'cinematic'), 'bytedance/seedance-2.5/us/image-to-video');
        assert.strictEqual(i2vModel(new Date(), 'realistic'), V25);
        assert.strictEqual(i2vModel(new Date()), V25);
        assert.strictEqual(i2vModel(new Date(), 'bad style!'), V25, 'only plain style names are read');
    } finally { process.env = prev; }
});

check('the estimate charges sound only where the style’s model can make it', () => {
    const prev = { ...process.env };
    process.env.FAL_I2V_MODEL = V3; delete process.env.FAL_I2V_MODEL_FROM;
    try {
        const sb: Storyboard = { title: 't', caption: '', scenes: [{ id: 's1', beat: 'value', voiceover: '', source: 'ai_video', prompt: 'p', targetS: 4.7 }] };
        const brief = (sound: boolean) => ({ voiceover: false, musicMood: 'none', clip: { style: 'cinematic', lengthS: 5, description: 'x', sound } }) as unknown as VideoBrief;
        const quiet = buildTasksAt(sb, brief(false), DEFAULT_TASK_COSTS);
        assert.strictEqual(buildTasksAt(sb, brief(true), DEFAULT_TASK_COSTS), clipTasksWithSound(quiet, true));
        process.env.FAL_I2V_MODEL = V25;
        assert.strictEqual(buildTasksAt(sb, brief(true), DEFAULT_TASK_COSTS), buildTasksAt(sb, brief(false), DEFAULT_TASK_COSTS), 'v2.5: no sound, no extra');
    } finally { process.env = prev; }
});

check('build, server, tab and chat carry it', () => {
    const vp = read('src/utils/video-producer.ts');
    assert.ok(vp.includes("style: args.clip?.style ?? null, withSound: args.clip?.sound === true,"));
    assert.ok(vp.includes('clipTasksWithSound(aiVideoTasks(sub.billedSeconds, await getTaskCosts()), sub.withSound === true)'), 'charged only if it really had sound');
    const fn = read('netlify/functions/video-projects.ts');
    assert.ok(fn.includes("...(body.sound === true && clipSoundAvailable(i2vModel(new Date(), style)) ? { sound: true } : {})"));
    assert.ok(fn.includes('clipSound: Object.fromEntries(CLIP_STYLES.map((st) => [st, clipSoundAvailable(i2vModel(new Date(), st))])),'));
    const tab = read('src/components/assistant-videos.js');
    assert.ok(tab.includes('data-vid-clip-sound') && tab.includes("sound: !!fd.get('sound') && !!state.clipSound[String(fd.get('style'))]"));
    assert.ok(read('src/components/disruptive-ui-registry.js').includes('sound: ui.sound === true } : null,'));
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('"sound": true | false'));
});

check('AI video is declared to YouTube', () => {
    assert.ok(isAiVideo({ assetType: 'video', provider: 'fal', renderParams: null }));
    assert.ok(isAiVideo({ assetType: 'video', provider: null, renderParams: { kind: 'video_producer', containsAi: true } }));
    assert.ok(!isAiVideo({ assetType: 'video', provider: null, renderParams: { containsAi: false } }));
    assert.ok(!isAiVideo({ assetType: 'image', provider: 'fal', renderParams: null }), 'AI pictures are not covered by this field');
    const sp = read('src/utils/social-publish.ts');
    assert.ok(sp.includes("...(opts.containsSyntheticMedia ? { containsSyntheticMedia: true } : {})"));
    const bg = read('netlify/functions/publish-youtube-background.ts');
    assert.ok(bg.includes('const synthetic = await postHasAiVideo(db, post.organisationId!, post.contentAssetIds);'));
    assert.ok(bg.includes('...(synthetic ? { containsSyntheticMedia: true } : {}),'));
});

check('copy: samples intro, FAQ, help', () => {
    assert.ok(read('assistant.html').includes('or make one on its own with New AI clip'));
    assert.ok(read('faq.html').includes('one and a half times that for a single AI clip with sound'));
    const sql = read('db/help-articles-2026-12zzzzzzzzzzzzzzzzzzzzzzzzzzzz-video-ai-clip-sound-label.sql');
    assert.ok(!sql.slice(sql.indexOf('$$') + 2, sql.lastIndexOf('$$')).includes(';'));
    assert.ok(sql.includes("AND content_md NOT LIKE '%## AI clips with sound, and AI labels%'"));
});

console.log(`\n${passed} passed`);
