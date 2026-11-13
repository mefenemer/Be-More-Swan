// tests/footage-scene-poster.test.ts
// Owner, 2026-11-13 (after #49/#50): footage scenes show a still straight away, in every browser. A footage scene's
// box is a <video> of the whole upload; until it loads (and in Safari, until it plays) nothing is painted. Its
// poster is now the frame read at analysis nearest the scene start (footage.ts ?frame=…&t=…). #50's own fix
// (stable signed URLs, PR #574) stops the boxes reloading; this makes them show a picture from the first moment.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { nearestFrame } from '../src/utils/footage-review';

const js = readFileSync('src/components/assistant-videos.js', 'utf8');
const grab = (name: string) => {
    const at = js.indexOf(`function ${name}(`);
    assert.notStrictEqual(at, -1, `${name} is in assistant-videos.js`);
    let depth = 0, i = js.indexOf('{', at);
    for (; i < js.length; i++) { if (js[i] === '{') depth++; else if (js[i] === '}' && --depth === 0) break; }
    return js.slice(at, i + 1);
};
const sceneHtml = new Function(`
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const SOURCE = { own_video: 'Your footage' }; const BEAT = {}; const MOVING = ['own_video', 'stock_video', 'ai_video'];
    const state = { editing: null, busy: new Set() };
    const mmss = (s) => String(s); const ownName = () => 'clip'; const textSummary = () => ''; const tightenHtml = () => '';
    const chatPaneAvailable = () => false;
    const FOOTAGE_API = '/.netlify/functions/footage';
    ${grab('footagePosterUrl')}
    ${grab('sceneHtml')}
    return sceneHtml;
`)();
const v = { id: 1, status: 'ready', sceneThumbs: { s2: 'https://r2.example/presigned/footage.mp4?sig=x', s3: 'https://r2.example/stock.mp4' }, momentNotes: [] };
const own = /<video[^>]*>/.exec(sceneHtml(v, { id: 's2', source: 'own_video', assetId: 2660, inS: 12.5, outS: 18, beat: 'problem', targetS: 5, voiceover: 'x' }, 1))?.[0] ?? '';
assert.match(own, /poster="\/\.netlify\/functions\/footage\?frame=2660&amp;t=12\.5"/, 'a footage scene shows its still from the scene start');
const stock = /<video[^>]*>/.exec(sceneHtml(v, { id: 's3', source: 'stock_video', beat: 'proof', targetS: 5, voiceover: 'y' }, 2))?.[0] ?? '';
assert.ok(stock && !/poster=/.test(stock), 'stock clips are unchanged');

assert.deepStrictEqual(nearestFrame([{ t: 0, data: 'a' }, { t: 10, data: 'b' }, { t: 14, data: 'c' }], 12.5), { t: 14, data: 'c' });
assert.strictEqual(nearestFrame([], 3), null);
const fn = readFileSync('netlify/functions/footage.ts', 'utf8');
assert.ok(fn.includes('await ownVideos(db, orgId, [assetId])') && fn.includes("'Content-Type': 'image/jpeg'"), 'only the workspace\'s own video, as a JPEG');
console.log('footage-scene-poster: passed');
