// tests/upload-mime.test.ts
// What content-upload-url will and will not accept.
//
// This exists because of one specific failure: MediaRecorder reports its output as
// `audio/webm;codecs=opus`, and the allow-list is a Set of bare types. An exact-match test therefore
// rejected every voice note recorded in Chrome or Firefox while happily accepting the identical file
// dragged in from disk — a rejection that looks like a broken microphone, not a broken allow-list.
//
// Run:  npx tsx tests/upload-mime.test.ts

import assert from 'node:assert';
import { isAllowedUploadType, baseMime } from '../netlify/functions/content-upload-url';

let passed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};

console.log('\ncontent-upload-url — accepted media types\n');

test('a browser recording’s parameterised type is accepted', () => {
    // Exactly what MediaRecorder reports in Chrome and Firefox.
    assert.equal(isAllowedUploadType('audio/webm;codecs=opus'), true);
    // Safari records mp4/aac, and may include the codec string too.
    assert.equal(isAllowedUploadType('audio/mp4'), true);
    assert.equal(isAllowedUploadType('audio/mp4; codecs="mp4a.40.2"'), true);
});

test('the same types are still accepted bare', () => {
    for (const t of ['audio/mpeg', 'audio/wav', 'audio/webm', 'audio/ogg', 'image/png', 'video/mp4']) {
        assert.equal(isAllowedUploadType(t), true, `${t} should be allowed`);
    }
});

test('parameters do not smuggle a disallowed type through', () => {
    // The essence is what is checked — a parameter cannot make a forbidden type acceptable, and a
    // permitted parameter cannot rescue a forbidden essence.
    assert.equal(isAllowedUploadType('application/x-msdownload;codecs=opus'), false);
    assert.equal(isAllowedUploadType('text/html'), false);
    assert.equal(isAllowedUploadType('audio/aiff'), false);
});

test('casing and stray whitespace are normalised, not rejected', () => {
    assert.equal(isAllowedUploadType('AUDIO/WEBM'), true);
    assert.equal(isAllowedUploadType('  audio/mpeg  '), true);
    assert.equal(baseMime('Audio/WebM ;codecs=opus'), 'audio/webm');
});

test('junk is refused rather than throwing', () => {
    assert.equal(isAllowedUploadType(''), false);
    assert.equal(isAllowedUploadType(';;;'), false);
    assert.equal(isAllowedUploadType(undefined as unknown as string), false);
});

console.log(`\n${passed}/5 passed\n`);
