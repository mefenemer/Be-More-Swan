// tests/video-ai-clip.test.ts
// The 2026-11-11 Video Producer follow-ups: an AI clip on its own (plan Phase 5), the planner placing
// words on scenes, "my own voice" on the footage form, and the public copy saying so.
//
// Run:  npx tsx tests/video-ai-clip.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { clipPrompt, clipRefusal, clipTargetS, isClipLength, isClipStyle, CLIP_STYLES } from '../src/lib/ai-clip';
import { plannedClearOfCaptions } from '../src/lib/scene-text';
import { aiClipSeconds, buildTasks } from '../src/utils/video-producer';
import { minScenesFor, storyboardSystemPrompt, storyboardUserPrompt, type Storyboard, type VideoBrief } from '../src/lib/storyboard';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

check('styles, lengths, and the model is asked for exactly the length', () => {
    assert.deepStrictEqual([...CLIP_STYLES], ['realistic', 'cinematic', 'animated3d', 'cartoon2d', 'product']);
    assert.ok(isClipStyle('cartoon2d') && !isClipStyle('anime'));
    assert.ok(isClipLength(5) && isClipLength('10') && !isClipLength(7));
    assert.strictEqual(aiClipSeconds(clipTargetS(5), 'fal-ai/kling-video/v3/pro/image-to-video'), 5);
    assert.strictEqual(aiClipSeconds(clipTargetS(10), 'fal-ai/kling-video/v3/pro/image-to-video'), 10);
    assert.ok(clipPrompt('cinematic', 'A lighthouse at dawn').includes('No words, letters, logos or signs'));
});

check('fictional people only; no realistic children', () => {
    assert.match(clipRefusal('realistic', 'A man who looks like Tom Hanks pouring coffee')!, /made-up people/);
    assert.match(clipRefusal('cinematic', 'A famous footballer scoring at dusk')!, /made-up people/);
    assert.match(clipRefusal('realistic', 'Two children playing on a beach')!, /can’t show children/);
    assert.strictEqual(clipRefusal('cartoon2d', 'Two children playing on a beach'), null, 'a cartoon may');
    assert.strictEqual(clipRefusal('realistic', 'Steam rising from a cup of coffee on a café table'), null);
    assert.ok(clipRefusal('product', 'mug'), 'too short to make');
});

check('a clip is one scene, priced as an AI clip by its length', () => {
    const brief = { message: 'x', lengthS: 15, voiceover: false, allowAi: 'ai_first', musicMood: 'none', captions: false, clip: { style: 'cinematic', lengthS: 5, description: 'x' } } as unknown as VideoBrief;
    assert.strictEqual(minScenesFor(brief), 1);
    const sb: Storyboard = { title: 't', caption: '', scenes: [{ id: 's1', beat: 'value', voiceover: '', source: 'ai_video', prompt: 'p', targetS: clipTargetS(5) }] };
    assert.ok(buildTasks(sb, brief) > 0, 'the clip costs');
    assert.strictEqual(buildTasks(sb, { ...brief, musicMood: 'none' }), buildTasks(sb, brief), 'no music, no voiceover');
});

check('server: create is free and moderated; the frame holds 1 task and refunds on failure; Make waits for it', () => {
    const fn = read('netlify/functions/video-projects.ts');
    const create = fn.slice(fn.indexOf("if (action === 'clip_create') {"), fn.indexOf("if (action === 'from_post') {"));
    assert.ok(create.includes('await startClip(db, {'), 'one helper inserts it');
    assert.ok(create.includes('const refused = clipRefusal(style, description);'));
    assert.ok(create.includes('await enforcePromptModeration({ text: description'));
    assert.ok(!create.includes('holdCredits'), 'saving a clip spends nothing');
    const frame = fn.slice(fn.indexOf("if (action === 'clip_frame') {"), fn.indexOf('// A finished video is never changed in place'));
    assert.ok(frame.includes("holdCredits(db, { orgId, amount: IMAGE_CREDIT_COST, mediaType: 'image' })"));
    assert.ok(frame.includes("settleHold(db, { orgId, amount: IMAGE_CREDIT_COST, success: false, mediaType: 'image', userId })"));
    assert.ok(fn.includes("return json(409, { error: 'See the first frame first.' });"));
    assert.ok(fn.includes("An AI clip can’t be planned again."), 'the planner never turns a clip into a promo');
    assert.ok(fn.indexOf("if (action === 'clip_create') {") > fn.indexOf('// The gate, before anything is planned or spent.'), 'clips need a plan with video');
});

check('the build animates the frame the owner saw', () => {
    const vp = read('src/utils/video-producer.ts');
    const ai = vp.slice(vp.indexOf("case 'ai_video': {"), vp.indexOf("case 'ai_video': {") + 1600);
    assert.ok(ai.includes("eq(contentAssets.assetType, 'image')"));
    assert.ok(ai.indexOf('let frameUrl') < ai.indexOf('submitFramedVideo('), 'the frame is ready before the clip is asked for');
    assert.ok(vp.includes('clipFrameUrl: (row.brief as VideoBrief).clip ? await clipFrameUrl(db, orgId, sb) : null,'));
});

check('tab and chat: New AI clip, frame then make, a card that never spends', () => {
    const tab = read('src/components/assistant-videos.js');
    assert.ok(tab.includes('data-vid-act="clip-new"') && tab.includes('data-vid-clip-form'));
    assert.ok(tab.includes("'Try another frame — 1 task' : 'See the first frame — 1 task'"));
    assert.ok(tab.includes('${v.clipFrameUrl ? `<button type="button" data-vid-act="build"'), 'Make the clip only once there is a frame');
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.ok(reg.includes("register('video_clip_proposal', renderVideoClipProposalCard);"));
    assert.ok(read('src/components/chat-session.js').includes("'delete', 'clip_create'];"));
    assert.ok(!read('src/components/chat-session.js').includes("'clip_frame'"), 'no card makes a frame (it spends)');
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('"type": "video_clip_proposal"'));
});

check('planner: may place words, is told where captions sit, and its clash is dropped', () => {
    assert.ok(storyboardSystemPrompt().includes('"textWhen" scene | first | last | words'));
    const up = storyboardUserPrompt({ brief: { message: 'x', lengthS: 15, voiceover: true, captionStyle: { position: 'top' } } as unknown as VideoBrief, businessName: 'B', businessFacts: '', library: [], today: '2026-11-11' });
    assert.ok(up.includes('CAPTIONS: at the top of the frame — never put textPos there.'));
    const sb = { scenes: [{ id: 's1', textPos: 'bottom' as const }, { id: 's2', textPos: 'top' as const }] };
    assert.deepStrictEqual(plannedClearOfCaptions(sb, {}).scenes.map((s) => s.textPos), [undefined, 'top']);
    assert.deepStrictEqual(plannedClearOfCaptions(sb, { captions: false }).scenes.map((s) => s.textPos), ['bottom', 'top']);
    assert.ok(read('src/utils/video-producer.ts').includes('if (!mode) storyboard = plannedClearOfCaptions(storyboard, brief);'), 'a words-only rewrite keeps the owner’s own');
});

check('footage form: a voiceover in my own voice', () => {
    const tab = read('src/components/assistant-videos.js');
    assert.ok(tab.includes('name="sound" value="myvoice"'));
    assert.ok(tab.includes("...(ownVoice && voice ? { ownVoice: true } : {}),"));
});

check('copy says it: FAQ, description, showcase, help', () => {
    const faq = read('faq.html');
    assert.ok(faq.includes('You can read the voiceover yourself instead of an AI voice'));
    assert.ok(faq.includes('from 3 December 2026, 4 tasks for each second of clip'));
    assert.ok(faq.includes('make single 5 or 10 second AI clips'));
    assert.ok(read('seed/data/master_assistants.json').includes('adds a voiceover (an AI voice or your own) and captions'));
    assert.ok(read('db/z-video-producer-own-voice-copy.sql').includes('(an AI voice or your own)'));
    assert.ok(read('db/assistant-showcases.json').includes('Read the voiceover yourself if you prefer'));
    const sql = read('db/help-articles-2026-12zzzzzzzzzzzzzzzzzzzzzzzzzzz-video-ai-clip.sql');
    assert.ok(!sql.slice(sql.indexOf('$$') + 2, sql.lastIndexOf('$$')).includes(';'));
});

console.log(`\n${passed} passed`);
