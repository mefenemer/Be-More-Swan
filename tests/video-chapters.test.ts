// tests/video-chapters.test.ts — chapters and skip buttons on a finished Video Producer video (2026-11-11).
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
    videoChapters, defaultChapterTitle, cleanChapterTitle, chapterTime, youtubeChapters, youtubeChapterLines,
    hasChapterLines, withChapterLines, renameChapter, chaptersFor,
} from '../src/lib/video-chapters';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (e) { console.error(`  ✗ ${name}`); throw e; }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

type B = 'hook' | 'problem' | 'value' | 'proof' | 'cta';
const sc = (id: string, beat: B, voiceover: string, onScreenText?: string) => ({ id, beat, voiceover, ...(onScreenText ? { onScreenText } : {}) });
// A 60-second video: hook 0–6, problem 6–18 (two scenes), value 18–36 (two), proof 36–48, cta 48–60.
const scenes = [
    sc('s1', 'hook', 'Tired of cold coffee?', 'Cold coffee again?'),
    sc('s2', 'problem', 'Every morning it goes cold before you drink it. And reheating ruins it.'),
    sc('s3', 'problem', 'The microwave makes it bitter.'),
    sc('s4', 'value', 'Our mug keeps it hot for three hours, from the first sip to the last.'),
    sc('s5', 'value', 'It charges on its own little coaster.'),
    sc('s6', 'proof', 'Over two thousand five-star reviews.'),
    sc('s7', 'cta', 'Order yours today at our shop.'),
];
const times = [
    { sceneId: 's1', startS: 0, endS: 6 }, { sceneId: 's2', startS: 6, endS: 12 }, { sceneId: 's3', startS: 12, endS: 18 },
    { sceneId: 's4', startS: 18, endS: 27 }, { sceneId: 's5', startS: 27, endS: 36 }, { sceneId: 's6', startS: 36, endS: 48 },
    { sceneId: 's7', startS: 48, endS: 60 },
];

check('a chapter is a run of scenes with one beat, placed by the scene times', () => {
    const ch = videoChapters(scenes, times);
    assert.deepStrictEqual(ch.map((c) => [c.sceneId, c.startS, c.endS, c.scenes]), [
        ['s1', 0, 6, [1]], ['s2', 6, 18, [2, 3]], ['s4', 18, 36, [4, 5]], ['s6', 36, 48, [6]], ['s7', 48, 60, [7]],
    ]);
    assert.ok(ch.every((c) => !c.named));
});

check('its name comes from the words on screen, else the voiceover’s first phrase, else its beat', () => {
    assert.strictEqual(defaultChapterTitle(scenes[0]), 'Cold coffee again?');
    assert.strictEqual(defaultChapterTitle(scenes[1]), 'Every morning it goes cold before you drink it');
    assert.strictEqual(defaultChapterTitle(scenes[3]), 'Our mug keeps it hot for three hours, from the…', 'long phrases cut at a word');
    assert.strictEqual(defaultChapterTitle(sc('x', 'cta', '')), 'What to do next');
});

check('names are cleaned: one line, no leading timestamp, no angle brackets, 60 characters', () => {
    assert.strictEqual(cleanChapterTitle('0:30 - The <b>bit</b>\nhere'), 'The bbit/b here');
    assert.strictEqual(cleanChapterTitle('x'.repeat(80)).length, 60);
    assert.strictEqual(cleanChapterTitle(42), '');
});

check('YouTube lines: first at 0:00, short chapters folded in, at least 3 of 10 s', () => {
    const ch = videoChapters(scenes, times);
    // The 6-second hook joins the problem (keeping the hook's name).
    assert.strictEqual(youtubeChapterLines(ch, 60), '0:00 Cold coffee again?\n0:18 Our mug keeps it hot for three hours, from the…\n0:36 Over two thousand five-star reviews\n0:48 Order yours today at our shop');
    // A 15-second video can't have 3 chapters of 10 s.
    const short = videoChapters(scenes.slice(0, 3), [{ sceneId: 's1', startS: 0, endS: 4 }, { sceneId: 's2', startS: 4, endS: 9 }, { sceneId: 's3', startS: 9, endS: 15 }]);
    assert.strictEqual(youtubeChapters(short, 15), null);
    assert.strictEqual(chapterTime(3725), '1:02:05');
});

check('the description gets the lines at the end, never twice, within the limit', () => {
    const lines = '0:00 A\n0:10 B\n0:20 C';
    assert.strictEqual(withChapterLines('Hello', lines, 5000), 'Hello\n\nChapters\n0:00 A\n0:10 B\n0:20 C');
    assert.ok(hasChapterLines('Intro\n00:00 Start'));
    assert.strictEqual(withChapterLines('Mine:\n0:00 Start\n0:30 End', lines, 5000), 'Mine:\n0:00 Start\n0:30 End', 'their own chapters win');
    const long = withChapterLines('x'.repeat(5000), lines, 5000);
    assert.strictEqual(long.length, 5000);
    assert.ok(long.endsWith('0:20 C'), 'the caption is cut, not the chapters');
    assert.strictEqual(withChapterLines('Hi', null, 5000), 'Hi');
});

check('renaming a chapter keeps the name by its first scene; "" puts its own name back', () => {
    const ch = videoChapters(scenes, times);
    const r = renameChapter(ch, {}, { n: 3 }, '  How it works  ');
    assert.ok(!('error' in r));
    assert.deepStrictEqual((r as { titles: Record<string, string> }).titles, { s4: 'How it works' });
    const again = videoChapters(scenes, times, (r as { titles: Record<string, string> }).titles);
    assert.strictEqual(again[2].title, 'How it works');
    assert.ok(again[2].named);
    const back = renameChapter(again, { s4: 'How it works', gone: 'x' }, { sceneId: 's4' }, '');
    assert.deepStrictEqual((back as { titles: Record<string, string> }).titles, {}, 'a name for a scene no longer a chapter start is dropped');
    assert.ok('error' in renameChapter(ch, {}, { n: 9 }, 'x'));
    assert.ok('error' in renameChapter(ch, {}, { n: 1 }, '<>'));
});

check('only a wide video gets YouTube lines; vertical and square become Shorts', () => {
    const row = (shape: string) => ({ timeline: { durationS: 60, sceneTimes: times }, brief: { shape }, storyboard: { scenes } });
    const wide = chaptersFor(row('16:9'));
    assert.ok(wide.youtubeChapters?.startsWith('0:00 '));
    assert.strictEqual(wide.chaptersWhyNot, null);
    const tall = chaptersFor(row('9:16'));
    assert.strictEqual(tall.youtubeChapters, null);
    assert.strictEqual(tall.chaptersWhyNot, 'not_wide');
    assert.strictEqual(tall.chapters.length, 5, 'still listed on the Videos tab');
    assert.deepStrictEqual(chaptersFor({ timeline: null, brief: {}, storyboard: { scenes } }).chapters, []);
});

check('wired through: Videos tab, API, YouTube publish, chat card', () => {
    const tab = read('src/components/assistant-videos.js');
    assert.ok(tab.includes('data-vid-act="skip"') && tab.includes('data-by="-10"') && tab.includes('data-by="10"'), 'skip buttons');
    assert.ok(tab.includes("case 'skip':") && tab.includes('function chaptersHtml(v)') && tab.includes("action: 'rename_chapter'"));
    assert.ok(tab.includes("document.addEventListener('timeupdate'") , 'the playing chapter is marked');
    const api = read('netlify/functions/video-projects.ts');
    assert.ok(api.includes("if (action === 'rename_chapter')") && api.includes('chapterTitles: done.titles'));
    const yt = read('netlify/functions/publish-youtube-background.ts');
    assert.ok(yt.includes('withChapterLines(meta.description, chapterLines, YOUTUBE_DESCRIPTION_MAX)') && yt.includes('!isYoutubeShortFormat(post.formatKey)'));
    const vp = read('src/utils/video-producer.ts');
    assert.ok(vp.includes('...chaptersOf(row, sb, outputDurationS)') && vp.includes('timeline.chapterTitles = chapterTitles'), 'view + names kept on a new version');
    assert.ok(read('src/components/disruptive-ui-registry.js').includes("register('video_chapter_proposal'"));
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('"type": "video_chapter_proposal"'));
    assert.ok(read('src/components/chat-session.js').includes("'add_note', 'rename_chapter', 'remove_translation',"));
});

console.log(`\nvideo chapters: ${passed} passed`);
