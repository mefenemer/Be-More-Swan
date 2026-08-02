// tests/lead-threads.test.ts
// Phase 2a of docs/lead-generator-revenue-engine-plan.md — reply routing and conversation state.
//
// The reply alias is the whole mechanism, and two properties of it are safety-critical:
//   1. It must NOT capture ordinary support mail. inbound-email.ts is live on prod and predates
//      this feature; a greedy match would silently divert real customer enquiries into a tenant's
//      lead thread, where nobody would ever see them.
//   2. The token is effectively a bearer credential — anyone who learns it can post into the
//      thread through a public webhook. It must be unguessable and never derived from an id.
//
// No database: address parsing is pure, and the write helpers are exercised through a fake.
// Run:  npx tsx tests/lead-threads.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    mintReplyToken, replyAddress, parseReplyToken, recipientFromParsePayload, inboundDomain,
} from '../src/utils/reply-address';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const inboundText = readFileSync(join(root, 'netlify/functions/inbound-email.ts'), 'utf8');
const threadsText = readFileSync(join(root, 'src/utils/lead-threads.ts'), 'utf8');
const leadGenText = readFileSync(join(root, 'netlify/functions/lead-generation.ts'), 'utf8');
const DOMAIN = inboundDomain();

// ── 1. Token minting ─────────────────────────────────────────────────────────

check('tokens are random, unguessable and not derived from an id', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) seen.add(mintReplyToken());
    assert.equal(seen.size, 500, 'every token must be distinct');
    const t = mintReplyToken();
    assert.ok(t.length >= 20, `token too short to resist guessing: ${t.length}`);
    assert.ok(/^[A-Za-z0-9_-]+$/.test(t), 'base64url only — must survive an email local part');
    assert.ok(!/^\d+$/.test(t), 'a numeric token would be enumerable');
});

check('the address is well-formed and round-trips', () => {
    const t = mintReplyToken();
    const addr = replyAddress(t);
    assert.equal(addr, `reply+${t}@${DOMAIN}`);
    assert.equal(parseReplyToken(addr), t, 'must survive its own format');
});

// ── 2. Parsing — the forms mail actually arrives in ──────────────────────────

check('parses bare, display-name and multi-recipient forms', () => {
    const t = mintReplyToken();
    assert.equal(parseReplyToken(replyAddress(t)), t, 'bare');
    assert.equal(parseReplyToken(`Nadia <${replyAddress(t)}>`), t, 'display name');
    assert.equal(parseReplyToken(`someone@else.com, ${replyAddress(t)}`), t, 'recipient list');
    assert.equal(parseReplyToken(` ${replyAddress(t)} `), t, 'whitespace');
});

check('the token keeps its case — base64url is case-sensitive', () => {
    // Lowercasing the whole address to compare the domain must not corrupt the token. A collision
    // here would route one prospect's reply into another prospect's thread.
    const mixed = 'aB9_-XyZaB9_-XyZaB9_';
    assert.equal(parseReplyToken(`reply+${mixed}@${DOMAIN}`), mixed);
    assert.notEqual(parseReplyToken(`reply+${mixed}@${DOMAIN}`), mixed.toLowerCase());
});

check('a mixed-case DOMAIN still matches', () => {
    const t = mintReplyToken();
    assert.equal(parseReplyToken(`reply+${t}@${DOMAIN.toUpperCase()}`), t, 'relays rewrite domain case');
});

// ── 3. It must NOT capture support mail ──────────────────────────────────────

check('ordinary support mail is NOT treated as a lead reply', () => {
    for (const addr of [
        `support@${DOMAIN}`,
        `hello@${DOMAIN}`,
        `reply@${DOMAIN}`,                       // right local part, no token
        `reply+@${DOMAIN}`,                      // empty token
        `notreply+${mintReplyToken()}@${DOMAIN}`, // wrong local part
        `xreply+${mintReplyToken()}@${DOMAIN}`,   // prefix must be exact, not a suffix match
        `reply+${mintReplyToken()}@evil.com`,     // right shape, wrong host
        `reply+short@${DOMAIN}`,                 // token below the minimum length
        `reply+has spaces here@${DOMAIN}`,
        '',
    ]) {
        assert.equal(parseReplyToken(addr), null, `must fall through to support: ${addr || '(empty)'}`);
    }
    assert.equal(parseReplyToken(null), null);
    assert.equal(parseReplyToken(undefined), null);
});

check('a token containing an @ cannot smuggle a different host', () => {
    assert.equal(parseReplyToken(`reply+abc@evil.com@${DOMAIN}`), null,
        'lastIndexOf("@") must resolve the real host, and the token must reject "@"');
});

// ── 4. Envelope preference ───────────────────────────────────────────────────

check('the SMTP envelope wins over the To header', () => {
    const t = mintReplyToken();
    // The To header can legitimately omit our alias (a BCC'd reply); the envelope is what the MX
    // actually received, so it is authoritative.
    const got = recipientFromParsePayload({
        envelope: JSON.stringify({ to: [replyAddress(t)], from: 'p@x.com' }),
        to: 'someone-else@example.com',
    });
    assert.equal(parseReplyToken(got), t);
});

check('a malformed envelope falls back to the To header instead of throwing', () => {
    const t = mintReplyToken();
    assert.equal(parseReplyToken(recipientFromParsePayload({ envelope: '{not json', to: replyAddress(t) })), t);
    assert.equal(recipientFromParsePayload({}), null);
});

// ── 5. Wiring guarantees ─────────────────────────────────────────────────────

check('the reply branch returns early and never falls into the support pipeline', () => {
    const branch = inboundText.slice(inboundText.indexOf('Lead-reply branch'));
    assert.ok(branch.includes("return { statusCode: 200, body: 'Lead reply recorded.' }"),
        'a recorded reply must not also create a support lead');
    assert.ok(branch.includes("body: 'Unknown thread; skipped.'"),
        'an unresolvable token must ack, not retry forever');
});

check('a failure in the reply branch falls through rather than 500ing', () => {
    // A 500 makes SendGrid retry and eventually bounce a real prospect's reply.
    const branch = inboundText.slice(inboundText.indexOf('Lead-reply branch'), inboundText.indexOf('Resolve/insert'));
    assert.ok(/catch\s*\(err\)/.test(branch) && branch.includes('falling through to support'),
        'the branch must be wrapped and fall through on error');
});

check('an inbound message flips the thread to `replied` in the SAME call', () => {
    // This is what halts a sequence. A gap between "reply recorded" and "state updated" is a
    // window in which a follow-up could still go out to someone who just answered.
    const fn = threadsText.slice(threadsText.indexOf('export async function recordInboundMessage'));
    assert.ok(fn.includes("state: 'replied'"), 'must set the state');
    assert.ok(fn.indexOf("state: 'replied'") < fn.indexOf('} catch'), 'inside the same try, not a later pass');
});

check('an outbound message never revives a replied thread', () => {
    const fn = threadsText.slice(
        threadsText.indexOf('export async function recordOutboundMessage'),
        threadsText.indexOf('export interface InboundMessageInput'));
    assert.ok(!fn.includes("state:"), 'recordOutboundMessage must not touch state — the prospect owns it');
});

check('every thread helper is best-effort and cannot throw', () => {
    for (const fn of ['openLeadThread', 'recordOutboundMessage', 'recordInboundMessage', 'findThreadByReplyToken']) {
        const start = threadsText.indexOf(`export async function ${fn}`);
        assert.ok(start >= 0, `${fn} not found`);
        // Slice to the NEXT top-level export, not the next `\n}` — a multi-line return type
        // annotation contains one and would truncate the body before its try/catch.
        const rest = threadsText.slice(start + 1);
        const nextExport = rest.indexOf('\nexport ');
        const body = nextExport >= 0 ? rest.slice(0, nextExport) : rest;
        assert.ok(/catch\s*\(/.test(body), `${fn} must swallow its errors`);
        assert.ok(body.includes('return null') || body.includes('?? null'),
            `${fn} must resolve to null on failure rather than rethrowing`);
    }
});

check('the send still happens when the thread could not be created', () => {
    // Losing reply tracking is recoverable; a lead who never hears from us is not.
    assert.ok(leadGenText.includes('...(thread ? { replyTo: replyAddress(thread.replyToken) } : {})'),
        'Reply-To must be conditional, not required');
    assert.ok(leadGenText.includes('if (thread) {'),
        'message recording must be skipped rather than blocking the send');
});

check('Reply-To is threaded through BOTH providers', () => {
    const gmail = readFileSync(join(root, 'src/utils/gmail.ts'), 'utf8');
    const outlook = readFileSync(join(root, 'src/utils/outlook.ts'), 'utf8');
    assert.ok(gmail.includes('`Reply-To: ${replyTo}`'), 'gmail MIME header');
    assert.ok(gmail.includes("replyTo.replace(/[\\r\\n]+/g, ' ')"), 'gmail must strip CR/LF — header injection');
    assert.ok(outlook.includes('replyTo: [{ emailAddress:'), 'outlook Graph replyTo');
});

// ── 6. Migration hygiene ─────────────────────────────────────────────────────

check('the migration is guarded and carries an accurate deploy warning', () => {
    const sql = readFileSync(join(root, 'db/lead-threads.sql'), 'utf8');
    for (const t of ['lead_threads', 'lead_messages', 'template_feedback']) {
        assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS ${t}`), `${t} create must be guarded`);
    }
    const creates = [...sql.matchAll(/CREATE INDEX/g)].length;
    assert.equal(creates, [...sql.matchAll(/CREATE INDEX IF NOT EXISTS/g)].length, 'indexes guarded');
    assert.ok(sql.includes('reply_token         text NOT NULL UNIQUE'),
        'the routing key must be UNIQUE — a collision cross-delivers replies');
    assert.ok(sql.includes('--url-var PROD_DATABASE_URL'),
        'prod apply instructions must be explicit; the runner defaults to staging');
});

console.log(`\n${passed} checks passed.`);
