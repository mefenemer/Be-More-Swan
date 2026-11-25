// Note Taker launch (27 November 2026): DPA 1.2, Terms 2.5, Trust/privacy carve-out and retention wording match what the
// code does (legal review 2026-11-25, docs/note-taker-bot-legal.md §1 note). Run: npx tsx tests/note-taker-launch-legal.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CURRENT_DPA_VERSION, DPA_VERSIONS_STILL_VALID } from '../netlify/functions/accept-dpa';
import { CURRENT_TOS_VERSION } from '../netlify/functions/accept-tos';
import { DPA_EFFECTIVE_DATES, DPA_VERSIONS } from '../netlify/functions/get-dpa-content';
import { BOT_DPA_VERSIONS, BOT_TOS_VERSIONS } from '../src/utils/meeting-bot-db';

let passed = 0;
const test = (name: string, fn: () => void) => { try { fn(); passed++; } catch (e) { console.error(`✗ ${name}`); throw e; } };
const read = (p: string) => readFileSync(p, 'utf8');
const dpaSrc = read('netlify/functions/get-dpa-content.ts');
const v12 = dpaSrc.slice(dpaSrc.indexOf('const DPA_1_2_HTML = `'), dpaSrc.indexOf('`;', dpaSrc.indexOf('const DPA_1_2_HTML = `')));

test('versions: DPA 1.2 and Terms 2.5 are current, and they are what the bot requires', () => {
    assert.equal(CURRENT_DPA_VERSION, '1.2');
    assert.equal(CURRENT_TOS_VERSION, '2.5');
    assert.deepEqual(BOT_DPA_VERSIONS, ['1.2']);
    assert.deepEqual(BOT_TOS_VERSIONS, ['2.5']);
    assert.ok(DPA_VERSIONS.includes('1.2') && DPA_VERSIONS.includes('1.1') && DPA_VERSIONS.includes('1.0'), 'every version stays readable');
    assert.equal(DPA_EFFECTIVE_DATES['1.2'], '2026-11-27');
    assert.deepEqual(DPA_VERSIONS_STILL_VALID, ['1.0', '1.1', '1.2'], 'accepting 1.2 is never needed to keep working');
});

test('DPA 1.2 clause 5 names Recall.ai and AssemblyAI as SPECIFICALLY authorised (the fast-launch basis)', () => {
    assert.ok(v12.length > 1000);
    const c5 = v12.slice(v12.indexOf('<h3>5. Sub-processors'), v12.indexOf('<h3>6.'));
    assert.match(c5, /specific written authorisation/);
    assert.match(c5, /Recall\.ai \(Hyperdoc Inc\.\)/);
    assert.match(c5, /AssemblyAI, Inc\./);
    assert.match(c5, /Note Taker meeting feature only/);
    assert.match(c5, /notice period in the paragraph above does\s+not apply to them/);
    assert.match(c5, /within\s+2 business days/, 'passes on its sub-processors\' own changes');
});

test('DPA 1.2 never promises a stored transcript (the code keeps none) and keeps the 48-hour Recall backstop', () => {
    assert.ok(!/transcript is deleted after 30 days|transcripts deleted after 30 days/.test(v12));
    assert.match(v12, /we do not\s+keep the transcript ourselves/);
    assert.match(v12, /48 hours/);
    // The engine stores no transcript text (schema comment + no column).
    const schema = read('db/schema.ts');
    const imports = schema.slice(schema.indexOf('export const meetingImports'), schema.indexOf('export const meetingBots'));
    assert.ok(!/transcript(Text|Body|_text)/i.test(imports), 'meeting_imports has no transcript column');
});

test('Terms 2.5: clause 5.2 has the bot weight with its free period; clause 9.3 puts the consent duty on the customer', () => {
    const t = read('terms_of_service.html');
    assert.match(t, /Version 2\.5 &middot; Last updated: 27 November 2026/);
    assert.match(t, /the Note Taker joining an online meeting as 1 task for each started 5 minutes it is in the call with you \(a 1-hour meeting is 12 tasks;[^)]*before 1 January 2027, no tasks\)/);
    assert.match(t, /<strong>9\.3 — Meetings\.<\/strong> When you send the Note Taker to a meeting, you must tell the people in it/);
    assert.match(t, /several US states, every participant must agree/);
});

test('Trust and privacy: the Recall row and the SAME carve-out sentence; privacy anchor the bot links to exists', () => {
    const carve = 'The exception is a sub-processor used only by an optional feature that you switch on by accepting a DPA';
    const trust = read('trust.html').replace(/\s+/g, ' ');
    const priv = read('privacy.html').replace(/\s+/g, ' ');
    for (const [name, page] of [['trust', trust], ['privacy', priv]] as const) {
        assert.ok(page.includes(carve), `${name}: carve-out`);
        assert.ok(page.includes('Recall.ai (with AssemblyAI)'), `${name}: row`);
        assert.ok(page.includes('if that deletion fails, the audio and text are deleted within 3 days'), `${name}: exact AssemblyAI wording`);
        assert.ok(!/within 3 days at most/.test(page), `${name}: no over-promise`);
        assert.ok(!/Zoom calls you send it to/.test(page), `${name}: no Zoom until it ships`);
    }
    assert.match(read('privacy.html'), /<li id="note-taker">/);
    assert.match(read('src/utils/meeting-bot.ts'), /bemoreswan\.com\/privacy\.html#note-taker/);
});

test('acceptance screens: DPA modal and wizard say v1.2 and name the sub-processors; Terms modal says v2.5', () => {
    const ws = read('workspace.html');
    assert.match(ws, /What changed in version 1\.2 \(27 November 2026\)/);
    assert.match(ws, /\(v1\.2\) on behalf of my organisation, including the sub-processors named in clause 5\./);
    assert.match(ws, /What changed in Terms v2\.5/);
    assert.match(ws, /Terms of Service<\/a> \(v2\.5\)\./);
    assert.ok(!/\(v1\.1\) on behalf of my organisation/.test(ws));
    assert.match(read('onboarding-social-media.html'), /\(v1\.2\) on behalf of my organisation, including the sub-processors named in clause 5/);
});

test('help article and Pricing say free until 1 January 2027, Meet + Teams only, and the honest task-run-out rule', () => {
    const h = read('db/help-articles-note-taker-bot-2026-11-27.sql');
    assert.match(h, /WHERE NOT EXISTS \(SELECT 1 FROM help_articles WHERE title = 'The Note Taker Joining Your Calls'\)/);
    assert.match(h, /free until \*\*1 January 2027\*\*/);
    assert.match(h, /Zoom is coming later/);
    assert.match(h, /they wait for up to a day/);
    assert.match(h, /We don't keep the transcript/);
    assert.match(read('pricing.html'), /Free until 1 January 2027, and nothing if it isn&rsquo;t let in/);
});

console.log(`note-taker-launch-legal: ${passed} passed`);
