// tests/video-music-level.test.ts
// Music volume on a Video Producer video (docs/video-producer-manual-controls-plan.md Phase 1, 2026-11-10):
// Quiet / Normal / Loud, on the options row and a chat card, scaling the bed and its ducked level together.
//
// Run:  npx tsx tests/video-music-level.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { isMusicLevel, musicLevelGain, MUSIC_LEVELS } from '../src/lib/video-music';
import { readBrief } from '../src/utils/video-producer';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

check('three levels; anything else is Normal', () => {
    assert.deepStrictEqual([...MUSIC_LEVELS], ['quiet', 'normal', 'loud']);
    assert.strictEqual(musicLevelGain('quiet'), 0.5);
    assert.strictEqual(musicLevelGain('normal'), 1);
    assert.strictEqual(musicLevelGain('loud'), 1.6);
    assert.strictEqual(musicLevelGain(undefined), 1, 'every brief before 2026-11-10');
    assert.strictEqual(musicLevelGain('max'), 1);
    assert.ok(isMusicLevel('loud') && !isMusicLevel('LOUD') && !isMusicLevel(null));
});

check('the brief keeps a level only when it is not Normal', () => {
    const base = { message: 'Our summer roast is back for July.' };
    const q = readBrief({ ...base, musicLevel: 'quiet' });
    const n = readBrief({ ...base, musicLevel: 'normal' });
    const x = readBrief({ ...base, musicLevel: 'deafening' });
    assert.ok('brief' in q && q.brief.musicLevel === 'quiet');
    assert.ok('brief' in n && n.brief.musicLevel === undefined);
    assert.ok('brief' in x && x.brief.musicLevel === undefined);
});

check('the build scales the bed and the ducked level together, before the peak cap', () => {
    const vp = read('src/utils/video-producer.ts');
    const at = vp.indexOf('const owned = musicLevelGain(brief.musicLevel);');
    assert.ok(at > 0);
    assert.ok(at < vp.indexOf('// A bed is never raised past its own peaks'), 'the peak cap still has the last word');
    assert.ok(vp.includes('levels.music = Math.round(levels.music * owned * 1000) / 1000; levels.musicUnder = Math.round(levels.musicUnder * owned * 1000) / 1000;'));
});

check('set_options takes it (Normal clears it), and the tab and chat offer it', () => {
    assert.ok(read('netlify/functions/video-projects.ts').includes("if (isMusicLevel(body.musicLevel)) { if (body.musicLevel === 'normal') delete brief.musicLevel; else brief.musicLevel = body.musicLevel; }"));
    const tab = read('src/components/assistant-videos.js');
    assert.ok(tab.includes('data-vid-opt="musicLevel"'));
    assert.ok(tab.includes("${mood === 'none' ? 'disabled title=\"No music on this video\"' : ''}"), 'no volume to set without music');
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.ok(reg.includes('if (VIDEO_MUSIC_LEVELS[ui.musicLevel]) body.musicLevel = ui.musicLevel;'));
    assert.ok(read('netlify/functions/chat-orchestrator.ts').includes('"musicLevel": "quiet" | "normal" | "loud"'));
    assert.ok(read('src/utils/video-producer.ts').includes(', volume ${MUSIC_LEVEL_LABELS[brief.musicLevel].toLowerCase()}'), 'the chat sees it');
});

check('help section is guarded with no semicolons in its body', () => {
    const sql = read('db/help-articles-2026-12zzzzzzzzzzzzzzzzzzzzzzzz-video-music-volume.sql');
    assert.ok(!sql.slice(sql.indexOf('$$') + 2, sql.lastIndexOf('$$')).includes(';'));
    assert.ok(sql.includes("AND content_md NOT LIKE '%## Music volume%'"));
});

console.log(`\n${passed} passed`);
