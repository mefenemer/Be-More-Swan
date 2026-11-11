// tests/video-next-steps.test.ts — after the Vimeo / YouTube Studio comparison (2026-11-11):
// YouTube thumbnail + caption tracks + results, translated caption files, guest review of a video,
// editing by deleting words, and the teleprompter.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
    youtubeScopes, hasScope, YT_SCOPE_CAPTIONS, YT_SCOPE_ANALYTICS, captionLines, toSrt, toVtt, readCaptionLines, mergeTranslation,
    isCaptionLanguage, readStats, readRetention, biggestDrop, watchedToEndPct,
} from '../src/lib/youtube-extras';
import { parseTranslationReply, translationPrompt } from '../src/utils/caption-translate';
import { validateVideoResponse, videoGuestProjection, videoContentHash } from '../src/utils/video-review-links';
import { tightenSegment, findPhrase, type SpokenWord } from '../src/lib/footage';
import { readCutWords } from '../src/lib/storyboard';
import { DEFAULT_TASK_WEIGHTS, WORK_KIND_LABELS } from '../src/config/task-weights';
import { hasCaptionedVoice } from '../src/utils/video-producer';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}`); throw e; }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

// ── YouTube permissions ──
check('the consent screen asks for the two new permissions only when the switch is on', () => {
    assert.ok(!youtubeScopes(false).includes('force-ssl') && !youtubeScopes(false).includes('yt-analytics'));
    assert.ok(youtubeScopes(true).includes(YT_SCOPE_CAPTIONS) && youtubeScopes(true).includes(YT_SCOPE_ANALYTICS));
    assert.ok(hasScope(`a ${YT_SCOPE_CAPTIONS} b`, YT_SCOPE_CAPTIONS));
    assert.ok(!hasScope(null, YT_SCOPE_CAPTIONS));
    const oauth = read('netlify/functions/oauth-integrations.ts');
    assert.ok(oauth.includes('isFeatureEnabled(Number(organisationId), YT_EXTENDED_SCOPES_FLAG)'));
    assert.ok(read('db/z-youtube-extended-scopes-flag.sql').includes("('youtube_extended_scopes', FALSE, 0, NULL"), 'ships off');
});

// ── Caption files ──
const words = [
    { word: 'Hello', startS: 0.2, endS: 0.5 }, { word: 'there.', startS: 0.55, endS: 0.9 },
    { word: 'Our', startS: 1.0, endS: 1.2 }, { word: 'mug', startS: 1.25, endS: 1.5 }, { word: 'keeps', startS: 1.55, endS: 1.8 },
    { word: 'it', startS: 2.9, endS: 3.0 }, { word: 'hot.', startS: 3.05, endS: 3.4 },
];
check('caption file lines break at sentence ends and pauses', () => {
    const lines = captionLines(words);
    assert.deepStrictEqual(lines.map((l) => l.t), ['Hello there.', 'Our mug keeps', 'it hot.']);
    assert.strictEqual(lines[0].s, 0.2);
});
check('SRT and VTT are well formed, and text can’t break the format', () => {
    const lines = [{ s: 0.2, e: 0.9, t: 'Hello --> there' }, { s: 61.5, e: 62, t: 'Bye' }];
    const srt = toSrt(lines);
    assert.ok(srt.startsWith('1\n00:00:00,200 --> 00:00:00,900\nHello → there\n'));
    assert.ok(srt.includes('2\n00:01:01,500 --> 00:01:02,000\nBye'));
    const vtt = toVtt(lines);
    assert.ok(vtt.startsWith('WEBVTT\n\n00:00:00.200 --> 00:00:00.900\n'));
    assert.deepStrictEqual(readCaptionLines([{ s: 1, e: 2, t: 'x' }, { s: 'a' }, null]), [{ s: 1, e: 2, t: 'x' }]);
});
check('a translation keeps every line’s timing, and is refused if it doesn’t line up', () => {
    const en = [{ s: 0, e: 1, t: 'Hello' }, { s: 1, e: 2, t: 'Bye' }];
    assert.deepStrictEqual(mergeTranslation(en, ['Bonjour', 'Au revoir']), [{ s: 0, e: 1, t: 'Bonjour' }, { s: 1, e: 2, t: 'Au revoir' }]);
    assert.ok('error' in (mergeTranslation(en, ['Bonjour']) as object));
    assert.ok('error' in (mergeTranslation(en, ['Bonjour', '']) as object));
    assert.deepStrictEqual(parseTranslationReply('Sure:\n["a","b"]'), ['a', 'b']);
    assert.strictEqual(parseTranslationReply('nope'), null);
    assert.ok(translationPrompt(en, 'French').system.includes('JSON array'));
    assert.ok(isCaptionLanguage('cy') && isCaptionLanguage('fr') && !isCaptionLanguage('xx'));
});
check('a translation costs caption_translation, 1 task by default, labelled for Admin', () => {
    assert.strictEqual(DEFAULT_TASK_WEIGHTS.caption_translation, 1);
    assert.strictEqual(WORK_KIND_LABELS.caption_translation, 'Caption translations');
    const t = read('src/utils/caption-translate.ts');
    assert.ok(t.indexOf('await hasTaskCapacity(') < t.indexOf('await gatewayGenerate(') && t.indexOf('await hasTaskCapacity(') > 0 && t.indexOf("recordCompletedWork(db, row.organisationId, 'caption_translation'") > t.indexOf('db.update(videoProjects)'), 'checked first, charged after saving');
    assert.ok(!read('src/components/chat-session.js').includes("'translate_captions'"), 'no chat card spends a task');
});
check('caption files exist only for a timeline with a captioned voice track', () => {
    assert.ok(hasCaptionedVoice({ audio: [{ id: 'vp_vo_12', assetId: 12, volume: 1 }] }));
    assert.ok(hasCaptionedVoice({ audio: [{ id: 'vp_cap_9', assetId: 9, volume: 0, captions: true }] }));
    assert.ok(!hasCaptionedVoice({ audio: [{ id: 'vp_vo_12', assetId: 12, volume: 1, captions: false }] }));
    assert.ok(!hasCaptionedVoice({ audio: [{ id: 'music', assetId: 3, volume: 1 }] }));
});

// ── Results ──
check('YouTube statistics and the drop-off curve are read safely', () => {
    assert.deepStrictEqual(readStats({ statistics: { viewCount: '120', likeCount: '7' } }), { views: 120, likes: 7, comments: null });
    assert.strictEqual(readStats({}), null);
    const curve = readRetention({ rows: [[0, 1], [0.1, 0.95], [0.2, 0.6], [0.3, 0.55], [0.4, 0.5], [0.5, 0.48], [1, 0.3]] });
    assert.strictEqual(curve.length, 7);
    const drop = biggestDrop(curve, 60);
    assert.deepStrictEqual(drop, { atS: 6, lostPct: 37 }, 'the steepest fall: 0.95 → 0.6 from 6 s');
    assert.strictEqual(watchedToEndPct(curve), 30);
    assert.strictEqual(biggestDrop(curve.slice(0, 3), 60), null);
});

// ── Guest review of a video ──
check('a guest comment may name a moment inside the video; the guest sees only the projection', () => {
    const ok = validateVideoResponse({ name: ' Sarah ', decision: 'comment', body: 'Too fast', atS: 12.34 }, 60);
    assert.deepStrictEqual(ok, { ok: true, name: 'Sarah', decision: 'comment', body: 'Too fast', atS: 12.3 });
    assert.ok(!validateVideoResponse({ name: 'S', decision: 'comment', body: 'x', atS: 90 }, 60).ok);
    assert.ok(!validateVideoResponse({ name: 'S', decision: 'comment', body: '' }, 60).ok);
    assert.ok(validateVideoResponse({ name: 'S', decision: 'approved' }, 60).ok);
    const view = videoGuestProjection({ workspaceName: null, title: 'Mug', url: 'https://x/y.mp4', shape: 'weird', durationS: 30, chapters: [{ startS: 0, title: 'Intro' }] });
    assert.deepStrictEqual(Object.keys(view).sort(), ['chapters', 'kind', 'title', 'video', 'workspaceName']);
    assert.strictEqual(view.video.shape, '9:16');
    assert.notStrictEqual(videoContentHash({ id: 1, outputAssetId: 5, version: 1 }), videoContentHash({ id: 1, outputAssetId: 6, version: 2 }));
});
check('video links are wired through both endpoints, the page and the tab, with SQL before code', () => {
    const pub = read('netlify/functions/review-link-public.ts');
    assert.ok(pub.includes('resolveVideoReviewLink(db, body.token)') && pub.includes('validateVideoResponse('));
    const signed = read('netlify/functions/review-link.ts');
    assert.ok(signed.includes('createVideoReviewLink(') && signed.includes('listVideoReviewLinks('));
    const page = read('shared-review.html');
    assert.ok(page.includes("data.kind === 'video'") && page.includes("decision: 'comment', body: text, atS:"));
    const tab = read('src/components/assistant-videos.js');
    assert.ok(tab.includes('function guestReviewHtml(v)') && tab.includes("case 'review-to-note':"));
    const sql = read('db/z-review-link-video.sql');
    assert.ok(sql.includes("'video_project'") && sql.includes('ADD COLUMN IF NOT EXISTS at_s REAL'));
    assert.ok(read('src/components/disruptive-ui-registry.js').includes("register('video_share_review_proposal'"));
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('"type": "video_share_review_proposal"'));
});

// ── Editing by deleting words ──
const said: SpokenWord[] = [
    { word: 'So', start: 0.0, end: 0.2 }, { word: 'basically', start: 0.25, end: 0.7 }, { word: 'our', start: 0.75, end: 0.9 },
    { word: 'mug', start: 0.95, end: 1.2 }, { word: 'is', start: 1.25, end: 1.35 }, { word: 'great.', start: 1.4, end: 1.8 },
];
check('a struck-out word is cut, even with automatic tightening off', () => {
    const r = tightenSegment(0, 2, said, undefined, { cutWords: [{ start: 0.25, end: 0.7 }], auto: false });
    assert.strictEqual(r.stats.removed, 1);
    assert.ok(r.pieces.length >= 2 && r.pieces.every((p) => p.outS <= 0.25 + 0.2 || p.inS >= 0.7 - 0.2), 'the cut falls where “basically” was');
    const none = tightenSegment(0, 2, said, undefined, { auto: false });
    assert.deepStrictEqual(none.pieces, [{ inS: 0, outS: 2 }], 'nothing struck, no auto: plays as filmed');
});
check('struck words are kept to the segment; a chat phrase is found as said', () => {
    assert.deepStrictEqual(readCutWords([{ start: 0.25, end: 0.7 }, { start: 5, end: 6 }, { start: 1, end: 0.5 }, 'x'], 0, 2), [{ start: 0.25, end: 0.7 }]);
    assert.deepStrictEqual(findPhrase(said, 'Basically, our').map((w) => w.word), ['basically', 'our']);
    assert.deepStrictEqual(findPhrase(said, 'not said'), []);
    const api = read('netlify/functions/video-projects.ts');
    assert.ok(api.includes('qs.sceneWords') && api.includes('readCutWords(patch.cutWords, scene.inS, scene.outS)') && api.includes('findPhrase('));
    assert.ok(read('src/components/assistant-videos.js').includes("case 'save-words':"));
});

// ── Teleprompter ──
check('the teleprompter scrolls over the preview and is never part of the recording', () => {
    const rec = read('src/components/video-recorder.js');
    assert.ok(rec.includes('data-prompter') && rec.includes('data-script') && rec.includes('startScroll()'));
    assert.ok(/new MediaRecorder\(stream/.test(rec), 'records the camera stream, not the page');
});

console.log(`\nvideo next steps: ${passed} passed`);
