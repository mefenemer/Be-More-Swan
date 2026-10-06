// tests/campaign-stats-voice-builder.test.ts
// 2026-10-06 round: email-campaign settings + industry-standard stats, the Voice builder, ToS 2.1,
// the Swan Index byline, and in-use music tracks being withdrawn rather than deleted.
//
// Run:  npx tsx tests/campaign-stats-voice-builder.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { voiceDirective, normaliseVoice, findNeverSay, DEFAULT_NEVER_SAY } from '../src/utils/voice-profile';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');

check('campaign emails are recorded per send, and recording can never fail a send', () => {
    const seq = read('src/utils/newsletter-sequence.ts');
    assert.match(seq, /const messageId = await deliverStep\(/);
    assert.match(seq, /await recordSequenceSend\(db, \{/);
    assert.match(seq, /async function recordSequenceSend[\s\S]*?catch \(err\)[\s\S]*?42P01/);
    assert.match(read('db/newsletter-sequence-sends.sql'), /CREATE TABLE IF NOT EXISTS newsletter_sequence_sends/);
    assert.match(read('db/schema.ts'), /export const newsletterSequenceSends = pgTable\("newsletter_sequence_sends"/);
});

check('provider events reach campaign emails when they are not one-off emails', () => {
    const wh = read('netlify/functions/newsletter-webhook.ts');
    assert.match(wh, /if \(!row && messageId\) \{\s*const handled = await handleSequenceEvent\(/);
    assert.match(wh, /haltEnrolmentsForContact\(db, \{ organisationId: seqRow\.organisationId, email: address, reason: 'complained' \}\)/);
});

check('the campaign API returns settings (forms + segments) and standard stats, tolerating no table', () => {
    const fn = read('netlify/functions/newsletter-sequences.ts');
    assert.match(fn, /return json\(200, \{ sequence, steps, enrolments, halted, forms: formRows, stats, sequences \}\);/);
    for (const k of ['openRate', 'clickRate', 'clickToOpenRate', 'bounceRate', 'complaintRate', 'unsubscribeRate', 'deliveryRate']) assert.ok(fn.includes(`${k}:`), k);
    assert.match(fn, /async function sequenceStats[\s\S]*?if \(code === '42P01'\) return null;/);
    const ui = read('newsletter.js');
    assert.match(ui, /\$\{renderSeqSettings\(seq\)\}\s*\$\{renderSeqStats\(seqState\.stats\)\}/);
});

check('Voice builder: settings become rules; the default never-say list applies to everyone', () => {
    const d = voiceDirective('', { surface: 'social', voice: { personalities: ['professional'], energy: 1, exclamations: 'never', spelling: 'british' } });
    assert.match(d, /PROFESSIONAL means:/);
    assert.match(d, /Understated: calm and matter-of-fact/);
    assert.match(d, /No exclamation marks at all\./);
    assert.match(d, /British English spelling/);
    assert.match(voiceDirective('Casual', { surface: 'blog' }), /NEVER use these words or phrases[^\n]*"game-changer"/);
    assert.doesNotMatch(voiceDirective('Casual', { surface: 'blog', voice: { neverSay: [] } }), /NEVER use these words/);
    assert.deepStrictEqual(findNeverSay('A real game-changer for you', null), ['game-changer']);
    assert.strictEqual(normaliseVoice({ formality: 99, personalities: ['x', 'witty', 'casual', 'bold'] })!.formality, 3);
    assert.deepStrictEqual(normaliseVoice({ personalities: ['x', 'witty', 'casual', 'bold'] })!.personalities, ['witty', 'casual']);
    assert.ok(DEFAULT_NEVER_SAY.length >= 10);
});

check('every generator passes the stored voice; social re-asks once on a never-say hit', () => {
    assert.match(read('netlify/functions/process-content-jobs.ts'), /voice: brandCtx\.voice \}\)/);
    assert.match(read('netlify/functions/process-content-jobs.ts'), /const hits = findNeverSay\(/);
    assert.match(read('src/utils/blog-generate.ts'), /voice: voiceSettings \}\)/);
    assert.strictEqual((read('src/utils/newsletter-generate.ts').match(/fallback: DEFAULT_TONE, voice \}\)/g) || []).length, 3);
    assert.match(read('netlify/functions/update-assistant-context.ts'), /'allowed_article_types', 'voice'\]/);
    assert.match(read('src/generated/platform-constants.js'), /window\.VoiceBuilder = \{/);
    assert.match(read('assistant-detail.html'), /<input type="hidden" id="edit_voice_json" value="">/);
});

check('Terms 2.1: a version bump that users can actually accept', () => {
    assert.match(read('netlify/functions/accept-tos.ts'), /export const CURRENT_TOS_VERSION = '2\.1';/);
    assert.match(read('netlify/functions/accept-tos.ts'), /const version = CURRENT_TOS_VERSION;/);
    assert.doesNotMatch(read('workspace.html'), /version: '2\.0'/);
    assert.match(read('terms_of_service.html'), /Version 2\.1 &middot;/);
    assert.match(read('terms_of_service.html'), /Within 5 working days of receiving your request/);
});

check('the Swan Index byline stays editable; the connection does not', () => {
    const i = read('integrations.js');
    assert.match(i, /if \(_assistantScoped\) grid\.insertAdjacentHTML\('beforeend', _swanBylineCard\(_swanDest\)\);/);
    assert.match(i, /function _swanBylineCard\(d\) \{\s*if \(!d \|\| !d\.connected \|\| !d\.profile\) return '';/);
});

console.log(`\n${passed} checks passed`);
