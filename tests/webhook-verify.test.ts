// tests/webhook-verify.test.ts
// Inbound webhook signature verification (src/utils/webhook-verify.ts).
//
// Run:  npx tsx tests/webhook-verify.test.ts
//
// Security-critical: a forged/replayed/tampered request must be rejected, a genuine
// one accepted. Pure crypto — no network or DB.

import assert from 'node:assert';
import { createHmac } from 'node:crypto';
import { verifySlackSignature, verifyZendeskSignature } from '../src/utils/webhook-verify';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const SLACK_SECRET = 'slack-test-signing-secret';
const NOW = 1_700_000_000;
const slackSig = (ts: string, body: string) =>
    'v0=' + createHmac('sha256', SLACK_SECRET).update(`v0:${ts}:${body}`).digest('hex');

check('Slack: genuine signature accepted', () => {
    const body = '{"type":"event_callback","event":{"type":"message"}}';
    const ts = String(NOW);
    assert.equal(verifySlackSignature({ signingSecret: SLACK_SECRET, timestamp: ts, signature: slackSig(ts, body), rawBody: body, nowSec: NOW }), true);
});

check('Slack: tampered body rejected', () => {
    const ts = String(NOW);
    const sig = slackSig(ts, '{"a":1}');
    assert.equal(verifySlackSignature({ signingSecret: SLACK_SECRET, timestamp: ts, signature: sig, rawBody: '{"a":2}', nowSec: NOW }), false);
});

check('Slack: replayed (stale timestamp) rejected', () => {
    const body = '{"x":1}';
    const ts = String(NOW - 10_000); // > 5 min old
    assert.equal(verifySlackSignature({ signingSecret: SLACK_SECRET, timestamp: ts, signature: slackSig(ts, body), rawBody: body, nowSec: NOW }), false);
});

check('Slack: missing secret/headers rejected', () => {
    assert.equal(verifySlackSignature({ signingSecret: undefined, timestamp: String(NOW), signature: 'v0=x', rawBody: '{}', nowSec: NOW }), false);
    assert.equal(verifySlackSignature({ signingSecret: SLACK_SECRET, timestamp: undefined, signature: undefined, rawBody: '{}', nowSec: NOW }), false);
});

check('Zendesk: genuine signature accepted, tampered rejected', () => {
    const secret = 'zendesk-secret';
    const ts = '2026-06-20T00:00:00Z';
    const body = '{"type":"ticket.created"}';
    const sig = createHmac('sha256', secret).update(`${ts}${body}`).digest('base64');
    assert.equal(verifyZendeskSignature({ secret, timestamp: ts, signature: sig, rawBody: body }), true);
    assert.equal(verifyZendeskSignature({ secret, timestamp: ts, signature: sig, rawBody: '{"type":"ticket.deleted"}' }), false);
});

console.log(`\n${passed} checks passed.`);
