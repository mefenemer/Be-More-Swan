// tests/ai-presenter.test.ts
// The AI presenter in a video (docs/video-producer-screen-walkthrough-plan.md §11, Phase A2): the brief, the
// storyboard rules, the price (D-A3: per second on screen), the labels (§11.6), the flag that keeps it off for
// customers until the Terms notice has run, and the wiring of the build, the Videos tab and the chat.
//
// Run:  npx tsx tests/ai-presenter.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { readBrief, buildTasks, sceneOverlays, assetsForShape } from '../src/utils/video-producer';
import { enforceStoryboard, estimateCredits, presenterBlock, type Scene, type VideoBrief } from '../src/lib/storyboard';
import { PRESENTER_KEY_SCENES, briefForWorkspace, presenterAudioWindow, presenterFaceKey, presenterTasks, readBriefPresenter, AI_PRESENTER_FLAG } from '../src/lib/presenters';
import { containsAi, containsRealisticAi } from '../src/utils/video-render';
import { DEFAULT_TASK_WEIGHTS, formatCost } from '../src/config/task-weights';
import { mediaCostUsd } from '../src/utils/ai-usage';
import { workKindForMedia, creditCostFor } from '../src/utils/ai-credits';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

check('the brief: a presenter turns the voiceover on in their own voice for the language, never with footage', () => {
    const r = readBrief({ message: 'A tour of our booking system for new clients', presenter: { id: 'amara' }, voiceover: false, voice: 'en_us_mark', ownVoice: true });
    assert.ok('brief' in r);
    const b = r.brief;
    assert.deepStrictEqual(b.presenter, { id: 'amara' });
    assert.strictEqual(b.voiceover, true, 'a presenter always speaks');
    assert.strictEqual(b.voice, 'british_woman', 'her own English voice, not the one chosen');
    assert.strictEqual(b.ownVoice, undefined);
    const fr = readBrief({ message: 'Une visite de notre système de réservation', presenter: { id: 'kwame', throughout: true }, language: 'fr' });
    assert.ok('brief' in fr && fr.brief.voice === 'fr_nicolas' && fr.brief.presenter?.throughout === true, 'French: the French voice of his gender');
    const footage = readBrief({ message: 'A tour of our booking system for new clients', presenter: { id: 'amara' }, footageAssetIds: [5] });
    assert.ok('brief' in footage && !footage.brief.presenter, 'never with own footage');
    const nobody = readBrief({ message: 'A tour of our booking system for new clients', presenter: { id: 'someone-real' } });
    assert.ok('brief' in nobody && !nobody.brief.presenter);
    assert.strictEqual(readBriefPresenter({ id: 'priya', throughout: 'yes' })?.throughout, undefined);
});

const brief = (o: Partial<VideoBrief> = {}): VideoBrief => ({ purpose: 'promo', lengthS: 30, message: 'Booking made easy', voiceover: true, allowAi: 'stock_and_ai', ...o });
const scene = (source: string, voiceover = 'A line to say.') => ({ beat: 'value', voiceover, source, keywords: 'office', targetS: 5 });

check('the storyboard: presenter scenes only with a presenter, only with words, at the key moments unless throughout', () => {
    const none = enforceStoryboard({ title: 't', caption: 'c', scenes: [scene('ai_presenter'), scene('stock_video'), scene('ai_presenter')] }, brief());
    assert.ok(none.storyboard.scenes.every((s) => s.source !== 'ai_presenter'));
    assert.ok(none.changes.some((c) => /no presenter/.test(c)));
    const silent = enforceStoryboard({ title: 't', caption: 'c', scenes: [scene('ai_presenter', ''), scene('stock_video'), scene('brand_card')] }, brief({ presenter: { id: 'amara' } }));
    assert.strictEqual(silent.storyboard.scenes[0].source, 'stock_video', 'the presenter needs words to say');
    const many = Array.from({ length: 6 }, () => scene('ai_presenter'));
    const key = enforceStoryboard({ title: 't', caption: 'c', scenes: many }, brief({ presenter: { id: 'amara' } }));
    const kept = key.storyboard.scenes.map((s) => s.source === 'ai_presenter');
    assert.strictEqual(kept.filter(Boolean).length, PRESENTER_KEY_SCENES, 'three in all: the opening, one key moment and the call to action');
    assert.ok(kept[0] && kept[kept.length - 1], 'the opening and the call to action keep the presenter');
    const all = enforceStoryboard({ title: 't', caption: 'c', scenes: many }, brief({ presenter: { id: 'amara', throughout: true } }));
    assert.ok(all.storyboard.scenes.every((s) => s.source === 'ai_presenter'), 'throughout: every scene');
    assert.ok(/at the key moments only/.test(presenterBlock(brief({ presenter: { id: 'amara' } }))) && /Amara/.test(presenterBlock(brief({ presenter: { id: 'amara' } }))));
    assert.strictEqual(presenterBlock(brief()), '');
    assert.strictEqual(presenterBlock(brief({ presenter: { id: 'amara' }, footageAssetIds: [1] })), '');
});

check('the price: 2 tasks per second on screen, rounded up, shown before making (D-A3)', () => {
    assert.strictEqual(DEFAULT_TASK_WEIGHTS.ai_presenter, 2);
    assert.strictEqual(presenterTasks(4.2, 2), 10);
    assert.strictEqual(presenterTasks(0.2, 2), 2, 'at least one second');
    const sb = { title: 't', caption: 'c', scenes: [{ id: 's1', beat: 'hook', voiceover: 'Hi', source: 'ai_presenter', targetS: 4.2 }, { id: 's2', beat: 'cta', voiceover: 'Book', source: 'brand_card', targetS: 3 }] } as unknown as Parameters<typeof buildTasks>[0];
    const costs = { weights: { ...DEFAULT_TASK_WEIGHTS }, videoTasksPerSecond: 4, chatMessagesPerTask: 10 } as unknown as Parameters<typeof buildTasks>[2];
    assert.strictEqual(buildTasks(sb, brief({ presenter: { id: 'amara' } }), costs), 10 + DEFAULT_TASK_WEIGHTS.ai_voiceover);
    assert.strictEqual(buildTasks(sb, brief({ presenter: { id: 'amara' } }), costs, { sceneAssets: { s1: 9 }, voiceoverAssetId: 3 } as never), 0, 'nothing already made is charged again');
    assert.strictEqual(estimateCredits(sb, brief(), { image: 1, video: 5, voiceover: 1 }), 6);
    assert.strictEqual(formatCost('ai_presenter', 2), '2 tasks a second');
    assert.strictEqual(workKindForMedia('presenter', 5), 'ai_presenter', 'recorded as its own kind of work');
    assert.strictEqual(creditCostFor('presenter'), 5);
    assert.strictEqual(mediaCostUsd('fal-ai/kling-video/ai-avatar/v2/standard', { durationSeconds: 10 }), '0.562000');
    assert.ok(read('task-costs.js').includes("kind === 'ai_presenter' ? plural(n) + ' a second'"), 'the browser words it the same');
});

check('the audio and the face: the scene\'s stretch plus a short tail, the face cropped for the shape', () => {
    assert.deepStrictEqual(presenterAudioWindow(3, 7.2, 20), { startS: 3, endS: 7.5 });
    assert.deepStrictEqual(presenterAudioWindow(17, 19.9, 20), { startS: 17, endS: 20 }, 'never past the end of the voice');
    assert.strictEqual(presenterFaceKey('amara', '9:16'), 'presenters/amara-9x16.jpg');
    assert.strictEqual(presenterFaceKey('amara', '1:1'), 'presenters/amara-1x1.jpg');
    assert.strictEqual(presenterFaceKey('amara', null), 'presenters/amara-16x9.jpg');
    const script = read('scripts/make-presenters.mjs');
    assert.ok(script.includes("'9x16': 'crop=608:1080:656:0,scale=1080:1920'") && script.includes('Key: `presenters/${p.id}-${shape}.jpg`'), 'the script uploads the same keys');
});

check('the labels: always realistic AI, and a small "AI presenter" note where they first appear (§11.6)', () => {
    const sb = { title: 't', caption: 'c', scenes: [{ id: 's1', beat: 'hook', voiceover: 'x', source: 'stock_video', targetS: 3 }, { id: 's2', beat: 'value', voiceover: 'y', source: 'ai_presenter', targetS: 5 }] } as unknown as Parameters<typeof containsAi>[0];
    assert.strictEqual(containsAi(sb), true);
    assert.strictEqual(containsRealisticAi(sb, { clip: null }), true);
    const ov = sceneOverlays(sb!.scenes as Scene[], [3, 5]).find((o) => o.id === 'vp_aip_s2');
    assert.ok(ov && ov.text === 'AI presenter' && ov.startS === 3 && ov.endS === 6, 'from where they appear, for 3 seconds');
    assert.strictEqual(sceneOverlays([{ id: 's1', beat: 'hook', voiceover: 'x', source: 'stock_video', targetS: 3 }] as Scene[], [3]).some((o) => o.id.startsWith('vp_aip_')), false);
});

check('the flag: off for customers until the Terms notice, and the server never takes a presenter without it', () => {
    assert.strictEqual(AI_PRESENTER_FLAG, 'ai_presenter');
    const sql = read('db/z-ai-presenter.sql');
    assert.ok(/VALUES \('ai_presenter', FALSE, 0, NULL,/.test(sql) && sql.includes("(1, 'ai_presenter', 2)") && /ON CONFLICT \(key\) DO NOTHING/.test(sql));
    assert.ok(read('db/z-task-costs.sql').includes("(1, 'ai_presenter', 2)"));
    const fn = read('netlify/functions/video-projects.ts');
    assert.ok(fn.includes('const rawBrief = briefForWorkspace(body.brief, !hasPresenter || await isFeatureEnabled(orgId, AI_PRESENTER_FLAG).catch(() => false));'));
    assert.ok(fn.includes('aiPresenter: await isFeatureEnabled(orgId, AI_PRESENTER_FLAG).catch(() => false),'));
    const vp = read('src/utils/video-producer.ts');
    assert.ok(vp.includes("if (!await isFeatureEnabled(orgId, AI_PRESENTER_FLAG).catch(() => false)) return '';"), 'the chat lists presenters only with the flag');
});

check('the build makes presenter scenes in parallel, charged per second only when made', () => {
    const vp = read('src/utils/video-producer.ts');
    assert.ok(vp.includes("if (scene.source === 'ai_presenter') return makePresenterScene(i);"));
    assert.ok(vp.includes("await settle('presenter', VIDEO_CREDIT_COST, !!clip, Math.min("), 'settled as presenter work, only when made');
    assert.ok(vp.includes("storyboard.scenes[i].source === 'ai_video' || storyboard.scenes[i].source === 'ai_presenter'"), 'alongside the AI clips');
    assert.ok(vp.includes('presignR2Get(presenterFaceKey(p.id, args.shape), 3600)') && vp.includes('falSubmit(PRESENTER_MODEL, { image_url: imageUrl, audio_url: audioUrl })'));
    assert.ok(vp.includes("renderParams: { kind: 'ai_presenter', presenterId: p.id, aiStyle: 'realistic' }"));
});

check('the Videos tab and the chat offer a presenter only where the flag is on', () => {
    const ui = read('src/components/assistant-videos.js');
    assert.ok(ui.includes("if (!state.aiPresenter || !window.PresenterPicker) return '';"));
    assert.ok(ui.includes("state.aiPresenter = data.aiPresenter === true;"));
    assert.ok(ui.includes("presenter: { id: String(fd.get('presenterId'))"));
    assert.ok(read('workspace.html').includes('<script src="/src/components/presenter-picker.js"></script>'));
    const chat = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(chat.includes('"presenter": "<presenter id>"') && chat.includes('Only when "AI PRESENTERS" are listed above'));
    assert.ok(read('src/components/disruptive-ui-registry.js').includes("typeof ui.presenter === 'string' && /^[a-z]{2,20}$/.test(ui.presenter)"));
    // A pick is never lost when the form re-renders while the picker is open (A1 review note).
    assert.ok(read('src/components/presenter-picker.js').includes('if (!row.isConnected) {'));
});

check('review of #721: the gate strips the brief that is SAVED, not a copy', () => {
    const raw = { message: 'A tour of our booking system for new clients', presenter: { id: 'amara' }, voice: 'en_gb_archer' };
    const off = briefForWorkspace(raw, false) as Record<string, unknown>;
    assert.ok(!('presenter' in off) && off.voice === 'en_gb_archer' && 'presenter' in raw, 'a copy without the presenter; the request is untouched');
    assert.strictEqual(briefForWorkspace(raw, true), raw);
    const saved = readBrief(off);
    assert.ok('brief' in saved && !saved.brief.presenter && saved.brief.voice === 'en_gb_archer', 'saved without a presenter, in the voice chosen');
    const fn = read('netlify/functions/video-projects.ts');
    assert.ok(fn.includes('brief: rawBrief, onboardingContext: a.onboardingContext,'), 'startProject gets the stripped brief');
    assert.ok(!fn.includes('brief: body.brief, onboardingContext'), 'never the raw request');
});

check('review of #721: a new voiceover remakes every presenter clip, and the cost shown counts them', () => {
    const sb = { title: 't', caption: 'c', scenes: [{ id: 's1', beat: 'hook', voiceover: 'Hi', source: 'ai_presenter', targetS: 3 }] } as unknown as Parameters<typeof buildTasks>[0];
    const costs = { weights: { ...DEFAULT_TASK_WEIGHTS }, videoTasksPerSecond: 4, chatMessagesPerTask: 10 } as unknown as Parameters<typeof buildTasks>[2];
    assert.strictEqual(buildTasks(sb, brief({ presenter: { id: 'amara' } }), costs, { sceneAssets: { s1: 9 }, voiceoverAssetId: null } as never), 6 + DEFAULT_TASK_WEIGHTS.ai_voiceover,
        'a kept clip with the voiceover to be made again is counted');
    const vp = read('src/utils/video-producer.ts');
    assert.ok(vp.includes("for (const s of storyboard.scenes) if (s.source === 'ai_presenter') delete done[s.id];"));
});

check('review of #721: the clip covers the last scene, the charge never exceeds the cost shown, other shapes remake it, the voice\'s language is followed', () => {
    const vp = read('src/utils/video-producer.ts');
    assert.ok(vp.includes('const want = Math.ceil((args.endS - w.startS + PRESENTER_AUDIO_TAIL_S) * rate);'), 'padded with silence past the voice file');
    assert.ok(vp.includes("s.source === 'stock_video' || s.source === 'ai_video' || s.source === 'ai_presenter').map((s) => done[s.id])"), 'its real length is known to the timeline');
    assert.ok(vp.includes('Math.min(presenterTasks(durations[i], presenterPerSecond), presenterTasks(scene.targetS, presenterPerSecond))'));
    const sb = { title: 't', caption: 'c', scenes: [{ id: 's1', beat: 'hook', voiceover: 'Hi', source: 'ai_presenter', targetS: 3 }, { id: 's2', beat: 'value', voiceover: 'x', source: 'stock_video', targetS: 3 }] } as unknown as Parameters<typeof assetsForShape>[0];
    assert.deepStrictEqual(assetsForShape(sb, { s1: 9, s2: 10 }), { s2: 10 }, 'a presenter clip is made again for the new shape');
    const fr = readBrief({ message: 'Une visite de notre système de réservation', presenter: { id: 'amara' }, voice: 'fr_nicolas' });
    assert.ok('brief' in fr && fr.brief.voice === 'fr_adina', 'a French voice chosen → she speaks French, in the French woman\'s voice');
});

console.log(`\nai-presenter: ${passed} passed`);
