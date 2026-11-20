// tests/screen-recorder.test.ts
// "Record my screen" (docs/video-producer-screen-walkthrough-plan.md Phase 3): the screen recorder, where it is
// offered (New video form beside the AI presenter's screens, "Use my own footage"), and its chat card.
//
// Run:  npx tsx tests/screen-recorder.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { MAX_FOOTAGE_S, MAX_FOOTAGE_BYTES } from '../src/lib/footage';
import { GENERATED_CHAT_MANIFEST } from '../src/config/chat-capabilities.generated';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
/** The text from the first `from` to the next `to` after it; throws when either is missing. */
const between = (src: string, from: string, to: string) => {
    const a = src.indexOf(from);
    assert.ok(a >= 0, `missing: ${from}`);
    const b = src.indexOf(to, a + from.length);
    assert.ok(b >= 0, `missing after ${from}: ${to}`);
    return src.slice(a, b);
};

const SRC = read('src/components/screen-recorder.js');
const VIDEOS = read('src/components/assistant-videos.js');
const REG = read('src/components/disruptive-ui-registry.js');
const ORCH = read('netlify/functions/chat-orchestrator.ts');
const READER = read('src/components/footage-reader.js');

/** Load screen-recorder.js in a sandbox with the given browser and return window.ScreenRecorder. */
function load(nav: Record<string, unknown>, withRecorder = true) {
    const win: Record<string, unknown> = {};
    if (withRecorder) win.MediaRecorder = function MediaRecorder() { /* stub */ };
    vm.runInNewContext(SRC, { window: win, navigator: nav, document: {} });
    return win.ScreenRecorder as { supported(): boolean; unsupportedReason(): string; open: unknown };
}
const DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const share = { getDisplayMedia() { /* stub */ }, getUserMedia() { /* stub */ } };

check('a computer whose browser can share the screen can record', () => {
    const r = load({ userAgent: DESKTOP, maxTouchPoints: 0, mediaDevices: share });
    assert.strictEqual(r.supported(), true);
    assert.strictEqual(r.unsupportedReason(), '');
});

check('phones and tablets get the reason, never the button (D-W5)', () => {
    const iphone = load({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148', maxTouchPoints: 5, mediaDevices: { getUserMedia() {} } });
    assert.strictEqual(iphone.supported(), false);
    assert.match(iphone.unsupportedReason(), /phone or tablet/);
    // iPadOS reports a Mac, with touch points.
    const ipad = load({ userAgent: DESKTOP.replace('Chrome/131.0 ', ''), maxTouchPoints: 5, mediaDevices: share });
    assert.strictEqual(ipad.supported(), false);
    assert.match(ipad.unsupportedReason(), /own screen recorder/);
    const android = load({ userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 7) Chrome/131.0 Mobile Safari/537.36', maxTouchPoints: 5, mediaDevices: share });
    assert.strictEqual(android.supported(), false);
});

check('a desktop browser without screen sharing or MediaRecorder says which browsers work', () => {
    const noShare = load({ userAgent: DESKTOP, maxTouchPoints: 0, mediaDevices: { getUserMedia() {} } });
    assert.strictEqual(noShare.supported(), false);
    assert.match(noShare.unsupportedReason(), /Chrome, Edge, Firefox or Safari on a computer/);
    assert.strictEqual(load({ userAgent: DESKTOP, maxTouchPoints: 0, mediaDevices: share }, false).supported(), false);
});

check('limits match the footage limits: 10 minutes, under 500 MB', () => {
    assert.strictEqual(MAX_FOOTAGE_S, 600);
    assert.match(SRC, /const MAX_SECONDS = 600;/);
    const maxBytes = Number(eval(SRC.match(/const MAX_BYTES = ([^;]+);/)![1]));
    assert.ok(maxBytes < MAX_FOOTAGE_BYTES, 'stops before the footage size limit');
    // 10 minutes at the chosen bit rate fits easily.
    const bps = Number(SRC.match(/const VIDEO_BPS = (\d+);/)![1]);
    assert.ok(((bps + 128000) / 8) * MAX_FOOTAGE_S < maxBytes);
});

check('the screen’s own sound is OFF by default, the microphone only when asked (D-W6)', () => {
    assert.match(SRC, /<input type="checkbox" data-sound style/);
    assert.ok(!/data-sound checked/.test(SRC));
    assert.match(SRC, /data-mic\$\{o\.mic \? ' checked' : ''\}/);
    // Without "Keep the screen's sound", any audio the browser shares is dropped before recording.
    assert.match(SRC, /if \(!keepSound\) display\.getAudioTracks\(\)\.forEach/);
    assert.match(SRC, /audio: keepSound,/);
});

check('the share picker is opened straight from the click, before the microphone', () => {
    const start = between(SRC, 'async function start()', 'startBtn.addEventListener');
    assert.ok(start.indexOf('getDisplayMedia(') > 0 && start.indexOf('getDisplayMedia(') < start.indexOf('getUserMedia('));
    // Ending the share in the browser's own bar stops the recording.
    assert.match(start, /video\.addEventListener\('ended', stop\)/);
});

check('the privacy line is on the recorder', () => {
    assert.match(SRC, /Only share the window or tab you need\./);
    assert.match(SRC, /close emails, customer details and passwords first/);
    assert.match(SRC, /saved only to your own My Content/);
});

check('a recording is named from what the owner typed, safely', () => {
    const safe = between(SRC, 'const safeName', '\n');
    assert.match(safe, /\\\\\/:\*\?"<>\|/);
    assert.match(safe, /slice\(0, 80\)/);
});

check('the footage reader uses the timed length when a WebM reports none', () => {
    assert.match(READER, /async function upload\(file, opts\)/);
    assert.match(READER, /if \(!\(durationS > 0\) && timed > 0 && timed <= MAX_S \+ 1\) durationS = timed;/);
});

check('the Videos tab offers it in both places and reads a presenter screen once', () => {
    assert.match(between(VIDEOS, 'function presenterFieldHtml', 'function screenRecordButtonHtml'), /screenRecordButtonHtml\('record-screen-presenter'\)/);
    assert.match(between(VIDEOS, 'function footageFormHtml', 'async function addFootageFiles'), /screenRecordButtonHtml\('record-screen'\)/);
    const save = between(VIDEOS, 'async function saveScreenRecording', 'function recordScreen(');
    assert.ok(save.indexOf('FootageReader.upload(') < save.indexOf('FootageReader.prepare('), 'uploaded, then read');
    assert.match(save, /state\.pendingScreens\.add\(a\.id\)/);
    const rec = between(VIDEOS, 'function recordScreen(purpose)', '\n  }\n');
    assert.match(rec, /mic: false, onDone/);   // a presenter talks over the screen
    assert.match(rec, /mic: true, onDone/);    // their own voice for own footage
    assert.match(rec, /purpose === 'presenter' && state\.aiPresenter/);
    // The stale "5 minutes" copy is gone.
    assert.ok(!VIDEOS.includes('Videos up to 5 minutes'));
});

check('a new recording is ticked when the screen list draws, keeping earlier ticks', () => {
    const list = between(VIDEOS, 'function loadScreens', 'async function saveScreenRecording');
    assert.match(list, /ticked\.has\(Number\(id\)\) \|\| state\.pendingScreens\.has\(Number\(id\)\)/);
    assert.match(list, /Number\(x\.durationS\) > 0/);   // only measured recordings (review of #725)
    assert.match(list, /paintNewLongLengths\(form\)/);
});

check('the page loads the recorder', () => {
    assert.match(read('workspace.html'), /<script src="\/src\/components\/screen-recorder\.js"><\/script>/);
});

check('the chat can start it: card registered, prompt names it, manifest lists it', () => {
    assert.match(REG, /register\('screen_recording_proposal', renderScreenRecordingProposalCard\);/);
    const card = between(REG, 'function renderScreenRecordingProposalCard', "register('screen_recording_proposal'");
    assert.match(card, /AssistantVideos\.recordScreen\(purpose\)/);
    assert.match(card, /sessionStorage\.setItem\('bms-screen-record', purpose\)/);
    assert.match(card, /unsupportedReason\(\)/);
    assert.match(VIDEOS, /sessionStorage\.getItem\('bms-screen-record'\)/);
    assert.match(ORCH, /RECORDING THEIR SCREEN\./);
    assert.match(ORCH, /"type": "screen_recording_proposal", "purpose": "presenter" \| "footage"/);
    assert.ok(GENERATED_CHAT_MANIFEST.routes.video_producer.cards.includes('screen_recording_proposal'));
    assert.ok(GENERATED_CHAT_MANIFEST.uiCards.includes('screen_recording_proposal'));
});

console.log(`\n${passed} passed`);
