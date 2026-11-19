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
import { allowsLongLength, scriptTooLong, storyboardUserPrompt, enforceStoryboard, LONG_SCRIPT_CHARS, type VideoBrief } from '../src/lib/storyboard';
import { readBrief, scriptUnderBudget } from '../src/utils/video-producer';

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
    assert.match(p, /a 5 minutes walkthrough video \(300 seconds at most\), 4–20 scenes/, 'at least one chapter per ~75 s (review of #761)');
    assert.match(p, /never more than 1200 characters a scene/);
    assert.match(p, /told in CHAPTERS/);
    assert.match(p, /a 30-second chapter is about 75 words/);
});

check('a script too long to speak is refused with how much to cut; short videos and own sound are never refused', () => {
    const scenes = (n: number, chars: number) => ({ scenes: Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, voiceover: 'x'.repeat(chars) })) }) as never;
    const msg = scriptTooLong(scenes(12, 1000), { lengthS: 600, voiceover: true });
    assert.ok(msg && /more than the 10,000/.test(msg) && /by 2,011 characters/.test(msg), String(msg));
    assert.strictEqual(scriptTooLong(scenes(9, 1000), { lengthS: 600, voiceover: true }), null);
    assert.strictEqual(scriptTooLong(scenes(12, 1000), { lengthS: 600, voiceover: false }), null, 'own sound: no voiceover to speak');
    assert.strictEqual(LONG_SCRIPT_CHARS, 10_000);
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
    assert.match(vp, /shorter than the \$\{lengthLabel\(brief\.lengthS\)\} you chose — the video is as long as what is said/);
    const p = storyboardUserPrompt({ brief, businessName: 'B', library: [], today: '2026-11-19' } as never);
    assert.match(p, /the whole voiceover about 300 words in all, because the voice sets the video's length/);
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
