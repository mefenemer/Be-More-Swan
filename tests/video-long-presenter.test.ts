// tests/video-long-presenter.test.ts
// Phase 4c-3 (docs/video-producer-screen-walkthrough-plan.md §12, "4c design"): an AI presenter walking through the
// owner's screen recordings can be 2, 5 or 10 minutes, told in chapters. A presenter with nothing to show, and stock
// or AI-only videos, stay short. A script too long to speak is refused before anything is spent, never cut.
//
// Run:  npx tsx tests/video-long-presenter.test.ts

import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowsLongLength, scriptTooLong, storyboardUserPrompt, enforceStoryboard, wordsPerSecondFor, LONG_SCRIPT_CHARS, type VideoBrief } from '../src/lib/storyboard';
import { readBrief, scriptUnderBudget, scriptOverBudget } from '../src/utils/video-producer';
import { voicePace } from '../src/lib/tts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

console.log('who may be long');

check('a presenter with screen recordings may be long; a presenter alone, or stock, may not', () => {
    assert.ok(allowsLongLength({ voiceover: true, presenter: { id: 'amara' }, screenAssetIds: [5] }));
    assert.ok(!allowsLongLength({ voiceover: true, presenter: { id: 'amara' } }), 'nothing to walk through');
    assert.ok(!allowsLongLength({ voiceover: true }), 'stock with an AI voice');
    assert.ok(allowsLongLength({ voiceover: false, footageAssetIds: [1] }), 'own footage in its own sound (4b) still may');
});

check('readBrief keeps 10 minutes for a presenter with screens, and makes a presenter alone 60 s', () => {
    const ok = (b: Record<string, unknown>) => { const r = readBrief({ message: 'A tour of our booking system for new clients', ...b }); assert.ok('brief' in r); return r.brief; };
    const walk = ok({ lengthS: 600, presenter: { id: 'amara' }, screenAssetIds: [5] });
    assert.strictEqual(walk.presenter?.id, 'amara');
    assert.strictEqual(walk.lengthS, 600);
    assert.strictEqual(ok({ lengthS: 600, presenter: { id: 'amara' } }).lengthS, 60);
});

console.log('the plan and the script');

check('the planner is told a long presenter video is in chapters, written to each chapter\'s length', () => {
    const brief: VideoBrief = { purpose: 'walkthrough', lengthS: 300, message: 'A tour of the booking system', voiceover: true, allowAi: 'stock_only', presenter: { id: 'amara' }, screenAssetIds: [5] };
    const p = storyboardUserPrompt({ brief, businessName: 'B', library: [], today: '2026-11-19' } as never);
    assert.match(p, /a 5 minutes walkthrough video \(300 seconds at most\), 5–20 scenes/, 'enough chapters for the words: ~180 words each (reviews of #761, #765)');
    assert.match(p, /never more than 1200 characters a scene/);
    assert.match(p, /told in CHAPTERS/);
    assert.match(p, /a 30-second chapter is about 75 words/);
});

check('a script too long to speak is refused with how much to cut; short videos and own sound are never refused', () => {
    const scenes = (n: number, chars: number) => ({ scenes: Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, voiceover: 'x'.repeat(chars) })) }) as never;
    const msg = scriptTooLong(scenes(17, 1000), { lengthS: 600, voiceover: true });
    assert.ok(msg && /more than the 15,000/.test(msg) && /by 2,016 characters/.test(msg), String(msg));
    assert.strictEqual(scriptTooLong(scenes(14, 1000), { lengthS: 600, voiceover: true }), null);
    assert.strictEqual(scriptTooLong(scenes(17, 1000), { lengthS: 600, voiceover: false }), null, 'own sound: no voiceover to speak');
    assert.strictEqual(LONG_SCRIPT_CHARS, 15_000, 'the fastest voices need ~13,000 characters for 10 minutes');
    const vp = read('src/utils/video-producer.ts');
    const refuse = vp.indexOf('const tooLong = scriptTooLong(storyboard, brief);');
    assert.ok(refuse > 0 && refuse < vp.indexOf('const script = cleanScript(scriptOf(storyboard)'), 'refused before the voiceover is made');
    assert.match(vp, /\(Couldn't find pictures\|The person who started\|The script is\)/, 'the owner\'s to fix, not a platform incident');
});

check('a long chapter over 1200 characters is cut at a sentence end, with a note (review of #761)', () => {
    const brief: VideoBrief = { purpose: 'walkthrough', lengthS: 600, message: 'A tour', voiceover: true, allowAi: 'stock_only', presenter: { id: 'amara' }, screenAssetIds: [5] };
    const line = 'This is one spoken sentence about the booking page. '.repeat(30).trim();   // ~1550 characters
    const out = enforceStoryboard({ title: 'T', caption: 'C', scenes: [{ beat: 'hook', voiceover: 'Hello.', source: 'ai_presenter', targetS: 10 }, { beat: 'value', voiceover: line, source: 'ai_presenter', targetS: 90 }, { beat: 'cta', voiceover: 'Book now.', source: 'ai_presenter', targetS: 5 }] }, brief, [], [{ id: 5, name: 's', durationS: 300 }]);
    const v = out.storyboard.scenes[1].voiceover;
    assert.ok(v.length <= 1200 && v.endsWith('.'), `ends mid-sentence: …${v.slice(-20)}`);
    assert.ok(out.changes.some((c) => /Scene 2: its voiceover was longer than 1,200 characters/.test(c)));
    // A full stop on character 1201: never a line one over the limit (second review of #761).
    const edge = 'a'.repeat(1200) + '. More words follow here.';
    const e = enforceStoryboard({ title: 'T', caption: 'C', scenes: [{ beat: 'hook', voiceover: 'Hi.', source: 'ai_presenter', targetS: 5 }, { beat: 'value', voiceover: edge, source: 'ai_presenter', targetS: 80 }, { beat: 'cta', voiceover: 'Go.', source: 'ai_presenter', targetS: 5 }] }, brief, [], [{ id: 5, name: 's', durationS: 300 }]);
    assert.ok(e.storyboard.scenes[1].voiceover.length <= 1200, `${e.storyboard.scenes[1].voiceover.length} characters`);
});

check('an over-long script is refused when "Make the video" is pressed, before tasks are held; markdown and links don\'t count', () => {
    const fn = read('netlify/functions/video-projects.ts');
    const refuse = fn.indexOf('const tooLong = scriptTooLong(row.storyboard as Storyboard, row.brief as VideoBrief);');
    assert.ok(refuse > 0 && refuse < fn.indexOf('const hold = await holdBuild(db, orgId, row.storyboard as Storyboard'), 'before holdBuild');
    const scenes = { scenes: [{ id: 's1', voiceover: 'x'.repeat(9_990) + ' https://example.com/a-very-long-link-that-is-not-spoken' }] } as never;
    assert.strictEqual(scriptTooLong(scenes, { lengthS: 600, voiceover: true }), null, 'the link is not spoken, so it does not count');
    assert.match(read('src/lib/storyboard.ts'), /A LONG video \(2, 5 or 10 minutes; only from the business's own footage, or an AI presenter walking through their screen recordings\)/);
});

check('a long voiced script well short of its length is planned once more, then said on the card (staging project 50)', () => {
    const brief: VideoBrief = { purpose: 'walkthrough', lengthS: 120, message: 'A tour', voiceover: true, allowAi: 'stock_only', presenter: { id: 'amara' }, screenAssetIds: [5] };
    const sb = (words: number) => ({ title: 'T', caption: 'C', scenes: [{ id: 's1', beat: 'hook', voiceover: Array.from({ length: words }, () => 'word').join(' '), source: 'ai_presenter', targetS: 120 }] }) as never;
    assert.deepStrictEqual(scriptUnderBudget(sb(160), brief), { words: 160, budget: 300 }, 'project 50: 160 words for 2 minutes');
    assert.strictEqual(scriptUnderBudget(sb(240), brief), null, 'three quarters or more is fine');
    assert.strictEqual(scriptUnderBudget(sb(20), { ...brief, lengthS: 30 }), null, 'a short video may run short');
    assert.strictEqual(scriptUnderBudget(sb(20), { ...brief, voiceover: false }), null, 'own sound: nothing to measure');
    const vp = read('src/utils/video-producer.ts');
    assert.match(vp, /const under = scriptUnderBudget\(storyboard, brief\);/);
    assert.match(vp, /if \(under && !over && !mode\) \{/, 'never a third call, never on a words-only change (review of #763)');
    assert.match(vp, /wordsOf\(again\.storyboard\) > under\.words && !scriptOverBudget\(again\.storyboard, brief\)\)/, 'a fuller plan that now runs too long is not kept');
    assert.match(vp, /shorter than the \$\{lengthLabel\(brief\.lengthS\)\} you chose — the video is as long as what is said/);
    const p = storyboardUserPrompt({ brief, businessName: 'B', library: [], today: '2026-11-19' } as never);
    assert.match(p, /the whole voiceover about 300 words in all, because the voice sets the video's length/);
});

check('a long voiced video writes to its voice\'s measured pace (staging project 51: Priya spoke 302 words in 84 s)', () => {
    assert.strictEqual(voicePace('en_gb_lucy'), 3.83, 'Priya\'s English voice, measured');
    assert.strictEqual(voicePace('ja_kyoko'), null, 'Japanese: no words-a-second figure');
    assert.strictEqual(voicePace('no_such_voice'), null);
    const long = { lengthS: 120, voiceover: true, voice: 'en_gb_lucy' } as never;
    assert.strictEqual(wordsPerSecondFor(long), 3.64, 'the measured pace less 5% for the gaps between scenes');
    assert.strictEqual(wordsPerSecondFor({ lengthS: 30, voiceover: true, voice: 'en_gb_lucy' } as never), 2.5, 'short videos as before');
    assert.strictEqual(wordsPerSecondFor({ lengthS: 120, voiceover: true, voice: 'ja_kyoko' } as never), 2.5, 'not measured: the default');
    // 2 minutes with Priya: ~437 words is right, not "over budget" against the old 2.5 (300 × 1.2 = 360).
    const brief: VideoBrief = { purpose: 'walkthrough', lengthS: 120, message: 'A tour', voiceover: true, voice: 'en_gb_lucy' as never, allowAi: 'stock_only', presenter: { id: 'priya' }, screenAssetIds: [5] };
    const sb = (words: number) => ({ title: 'T', caption: 'C', scenes: [{ id: 's1', beat: 'hook', voiceover: Array.from({ length: words }, () => 'word').join(' '), source: 'ai_presenter', targetS: 120 }] }) as never;
    assert.strictEqual(scriptOverBudget(sb(437), brief), null);
    assert.deepStrictEqual(scriptUnderBudget(sb(302), brief), { words: 302, budget: 437 }, 'project 51\'s 302 words are now short for Priya');
    const p = storyboardUserPrompt({ brief, businessName: 'B', library: [], today: '2026-11-19' } as never);
    assert.match(p, /this voice speaks about 3\.64 words a second — a 30-second chapter is about 109 words/);
    assert.match(p, /the whole voiceover about 437 words in all/);
    // Every voice that can speak a long video's language (all but Japanese) is measured.
    const cat = JSON.parse(read('src/public/voice-catalogue.json'));
    const missing = cat.voices.filter((v: { lang: string; wps?: number }) => v.lang !== 'ja' && !(v.wps! > 0)).map((v: { id: string }) => v.id);
    assert.deepStrictEqual(missing, [], 'run scripts/measure-voice-pace.mjs --write for new voices');
});

check('review of #765: the card counts seconds at the voice\'s pace; nothing past 10 minutes; chapters from the word budget', () => {
    assert.match(read('src/utils/video-producer.ts'), /wordsPerSecond: row\.brief \? wordsPerSecondFor\(row\.brief as VideoBrief\) : WORDS_PER_SECOND,/);
    assert.match(read('src/components/assistant-videos.js'), /about \$\{Math\.round\(n \/ \(Number\(v\.wordsPerSecond\) > 0 \? Number\(v\.wordsPerSecond\) : 2\.5\)\)\} seconds spoken/);
    const priya = (lengthS: number) => ({ purpose: 'walkthrough', lengthS, message: 'A tour', voiceover: true, voice: 'en_gb_lucy', allowAi: 'stock_only', presenter: { id: 'priya' }, screenAssetIds: [5] }) as VideoBrief;
    const sb = (words: number) => ({ title: 'T', caption: 'C', scenes: [{ id: 's1', beat: 'hook', voiceover: Array.from({ length: words }, () => 'word').join(' '), source: 'ai_presenter', targetS: 600 }] }) as never;
    // 10 minutes for Priya: budget 2184 words, no 20% allowance (it would run ~11 minutes).
    assert.ok(scriptOverBudget(sb(2300), priya(600)), 'over the budget at 10 minutes is over');
    assert.strictEqual(scriptOverBudget(sb(2150), priya(600)), null);
    assert.strictEqual(scriptOverBudget(sb(500), priya(120)), null, '2 minutes keeps the 20% (437 → 524)');
    // Spoken past 10 minutes in this voice: refused, with words to cut.
    const msg = scriptTooLong(sb(2400), priya(600));
    assert.ok(msg && /minutes of speech in this voice, more than the 10/.test(msg), String(msg));
    assert.strictEqual(scriptTooLong(sb(2200), priya(600)), null);
    // Enough chapters for the words: 10 minutes with Priya needs 13 (2184 / 180).
    const p = storyboardUserPrompt({ brief: priya(600), businessName: 'B', library: [], today: '2026-11-19' } as never);
    assert.match(p, /a 10 minutes walkthrough video \(600 seconds at most\), 13–20 scenes/);
});

console.log('form, chat and help');

check('the New video form opens 2, 5 and 10 minutes only for a presenter with a screen ticked', () => {
    const v = read('src/components/assistant-videos.js');
    assert.match(v, /data-vid-new-length/);
    assert.match(v, /o\.disabled = !\(presenter && screen\);/);
    assert.match(v, /if \(t && t\.name === 'screenIds' && host\(\) && host\(\)\.contains\(t\) && t\.form\) paintNewLongLengths\(t\.form\);/);
    assert.match(v, /paintNewLongLengths\(form\);/, 'repainted when the presenter changes');
});

check('the chat says long walkthroughs are chosen on the form; its card stays short', () => {
    const c = read('netlify/functions/chat-orchestrator.ts');
    assert.match(c, /or an AI PRESENTER walking through their screen recordings: those can be 2, 5 or 10 minutes/);
    assert.match(c, /Your brief card is always 15, 30 or 60 seconds\./);
    assert.match(read('src/components/disruptive-ui-registry.js'), /lengthS: \[15, 30, 60\]\.includes\(Number\(ui\.lengthS\)\) \? Number\(ui\.lengthS\) : 30,/);
});

check('the help section is guarded, typed (no token), and sorts after the other video articles', () => {
    const files = readdirSync(join(root, 'db')).filter((f) => f.startsWith('help-articles-')).sort();
    const mine = files.findIndex((f) => f.endsWith('-video-long-presenter.sql'));
    assert.ok(mine >= 0 && files.findIndex((f) => f.endsWith('-video-long-own-footage.sql')) < mine);
    const s = read(`db/${files[mine]}`);
    assert.match(s, /AND content_md NOT LIKE '%## Long walkthroughs with an AI presenter%';/);
    const body = s.match(/\$\$[\s\S]*?\$\$/)![0];
    assert.ok(!body.includes('{{tasks.ai_presenter}}') && !body.includes("''") && !body.includes(';'));
});

console.log(`\n${passed} checks passed.`);
