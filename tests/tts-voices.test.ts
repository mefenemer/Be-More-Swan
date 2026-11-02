// tests/tts-voices.test.ts
// The voiceover voices (src/lib/tts.ts VOICES). An accented voice is an OpenAI voice plus an accent
// line in the delivery note; sending our own id to OpenAI as the voice would fail every voiceover.
// The Videos tab and the onboarding question list the same ids, or a pick would silently fall back
// to the default voice.
//
// Run:  npx tsx tests/tts-voices.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VOICES, voiceRequest, VOICEOVER_INSTRUCTIONS, synthesizeSpeech } from '../src/lib/tts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

(async () => {
const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];

await check('every voice reaches OpenAI as a real OpenAI voice', () => {
    for (const v of VOICES) assert.ok(OPENAI_VOICES.includes(voiceRequest(v.id).speaker), v.id);
});

await check('the British voices carry their accent; the plain ones the plain delivery note', () => {
    assert.strictEqual(voiceRequest('coral').instructions, VOICEOVER_INSTRUCTIONS);
    assert.match(voiceRequest('british_woman').instructions, /British English accent/);
    assert.match(voiceRequest('london_man').instructions, /London accent/);
    assert.strictEqual(voiceRequest('london_man').speaker, 'ballad');
});

await check('the request body sends the OpenAI voice and the accent', async () => {
    const was = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'test';
    let body: any = null;
    try {
        await synthesizeSpeech('Hello', 'london_man', (async (_u: any, init: any) => { body = JSON.parse(init.body); return new Response(new Uint8Array([1])); }) as typeof fetch);
    } finally { if (was === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = was; }
    assert.strictEqual(body.voice, 'ballad');
    assert.match(body.instructions, /London accent/);
});

await check('the Videos tab and the onboarding question offer the same voices', () => {
    const tab = read('src/components/assistant-videos.js');
    const onboarding = read('src/public/assistant-onboarding-schemas.js');
    for (const v of VOICES) {
        assert.ok(tab.includes(`['${v.id}', '${v.label}']`), `Videos tab: ${v.id}`);
        assert.ok(onboarding.includes(`{ value: '${v.id}', label: '${v.label}' }`), `onboarding: ${v.id}`);
    }
});

console.log(`\n${passed} checks passed`);
})();
