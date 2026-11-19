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
import { allowsLongLength, scriptTooLong, storyboardUserPrompt, LONG_SCRIPT_CHARS, type VideoBrief } from '../src/lib/storyboard';
import { readBrief } from '../src/utils/video-producer';

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
    assert.match(p, /a 5 minutes walkthrough video \(300 seconds at most\), 3–20 scenes/);
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
