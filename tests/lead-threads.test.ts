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
import { landmark } from './landmark';
import {
    mintReplyToken, replyAddress, parseReplyToken, recipientFromParsePayload, inboundDomain,
} from '../src/utils/reply-address';
import {
    SEQUENCE_HALT_REASONS, SEQUENCE_HALT_REASON_LABELS, haltReasonLabel,
} from '../src/config/outreach-sequences';
import { openLeadThread } from '../src/utils/lead-threads';

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
    const branch = inboundText.slice(landmark(inboundText, 'Lead-reply branch'));
    assert.ok(branch.includes("return { statusCode: 200, body: 'Lead reply recorded.' }"),
        'a recorded reply must not also create a support lead');
    assert.ok(branch.includes("body: 'Unknown thread; skipped.'"),
        'an unresolvable token must ack, not retry forever');
});

check('a failure in the reply branch falls through rather than 500ing', () => {
    // A 500 makes SendGrid retry and eventually bounce a real prospect's reply.
    // The end anchor used to be 'Resolve/insert', a string that has never appeared in
    // inbound-email.ts — so this slice ran from the branch to END OF FILE and the check passed on
    // the support pipeline's own try/catch rather than the branch's. Anchored now on the first
    // statement after the branch closes.
    const branch = inboundText.slice(
        landmark(inboundText, 'Lead-reply branch'),
        landmark(inboundText, 'if (messageBody.length > MAX_BODY_CHARS)'),
    );
    assert.ok(/catch\s*\(err\)/.test(branch) && branch.includes('falling through to support'),
        'the branch must be wrapped and fall through on error');
});

check('an inbound message flips the thread to `replied` in the SAME call', () => {
    // This is what halts a sequence. A gap between "reply recorded" and "state updated" is a
    // window in which a follow-up could still go out to someone who just answered.
    const fn = threadsText.slice(landmark(threadsText, 'export async function recordInboundMessage'));
    assert.ok(fn.includes("state: 'replied'"), 'must set the state');
    assert.ok(landmark(fn, "state: 'replied'") < landmark(fn, '} catch'), 'inside the same try, not a later pass');
});

check('an outbound message never revives a replied thread', () => {
    const fn = threadsText.slice(
        landmark(threadsText, 'export async function recordOutboundMessage'),
        landmark(threadsText, 'export interface InboundMessageInput'));
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

// ── 7. The Conversations read surface ────────────────────────────────────────
// netlify/functions/lead-threads.ts + assistant-lead-threads.js — the screen that reads back
// what sections 1-6 record. Until it existed, outreach could be sent, replied to, classified and
// halted with no way for a user to see any of it.

const readApiText = readFileSync(join(root, 'netlify/functions/lead-threads.ts'), 'utf8');
const conversationsUiText = readFileSync(join(root, 'src/components/assistant-lead-threads.js'), 'utf8');
const registryText = readFileSync(join(root, 'src/components/assistant-dashboard-registry.js'), 'utf8');

/**
 * Strip comments so a source assertion tests CODE, not prose.
 *
 * Without this, documenting why a field is withheld ("replyToken is deliberately not selected")
 * fails the very check that enforces it — which teaches you to delete the comment. Naive but
 * sufficient here: these files contain no regex literals or strings holding `//`.
 */
function codeOnly(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

check('the read API never serialises a reply token', () => {
    // Section 1 establishes the token is a bearer credential. Every surface that reads threads
    // therefore has to leave it behind — a thread rendered with its token in the JSON hands any
    // viewer the ability to post into that conversation through the public Parse webhook.
    assert.ok(!/replyToken|reply_token/.test(codeOnly(readApiText)),
        'lead-threads.ts (function) must not select or return the reply token');
    assert.ok(!/replyToken|reply_token/.test(codeOnly(conversationsUiText)),
        'the Conversations UI must never receive or render a reply token');
});

check('the read API never writes the thread tables — that writer stays singular', () => {
    // ⚠️ This check used to forbid db.insert/db.update/db.delete OUTRIGHT, and the rule it was
    // guarding was narrower than the check: src/utils/lead-threads.ts is the only writer of
    // lead_threads and lead_messages, for the same reason recordEvent() is the only ledger writer.
    //
    // The Conversations tab gained two cadence controls ("Send the next one now", "Stop
    // follow-ups"), and those write `sequence_enrolments` — a DIFFERENT table, owned by
    // src/utils/outreach-sequences.ts. The blanket ban would have been satisfied by moving the same
    // write somewhere less obvious, which protects nothing. So the assertion now says what was
    // always meant: nothing in this file may insert or delete at all, and the one permitted UPDATE
    // target is sequence_enrolments.
    for (const verb of ['db.insert(', 'db.delete(']) {
        assert.ok(!readApiText.includes(verb),
            `lead-threads.ts (function) must not call ${verb} — src/utils/lead-threads.ts is the only writer`);
    }
    for (const m of readApiText.matchAll(/db\s*\n?\s*\.update\(([A-Za-z]+)\)/g)) {
        assert.strictEqual(m[1], 'sequenceEnrolments',
            `lead-threads.ts may only update sequenceEnrolments, never ${m[1]} — lead_threads and `
            + 'lead_messages have exactly one writer, and it is src/utils/lead-threads.ts');
    }
    // The halt goes through the sequence table's own owner rather than a hand-rolled UPDATE. That
    // helper writes the sequence_halted ledger row and clears next_send_at in the same act; a local
    // UPDATE would drop both and leave a "stopped" cadence that still had a due timestamp on it.
    assert.ok(/haltEnrolment\(db,/.test(readApiText),
        'stopping a cadence must call haltEnrolment, not update the row here');
});

check('every Conversations query is organisation-scoped', () => {
    for (const scope of [
        'eq(leadThreads.organisationId, orgId)',
        'eq(leadMessages.organisationId, orgId)',
        'eq(sequenceEnrolments.organisationId, orgId)',
    ]) {
        assert.ok(readApiText.includes(scope), `missing tenant scope: ${scope}`);
    }
    const idorAt = readApiText.indexOf('eq(aiAssistants.organisationId, orgId)');
    const threadsAt = landmark(readApiText, '.from(leadThreads)');
    assert.ok(idorAt > -1 && idorAt < threadsAt, 'the IDOR guard must run before any thread is read');
});

check('`get` scopes by assistant as well as org', () => {
    // Org scope alone would let one assistant's tab open another assistant's conversation by
    // guessing an id — same tenant, wrong assistant.
    const getBranch = readApiText.slice(landmark(readApiText, "action === 'get'"));
    assert.ok(getBranch.includes('eq(leadThreads.aiAssistantId, assistantId)'),
        'the get branch must scope by aiAssistantId as well as organisationId');
});

check('every halt reason has a user-facing label', () => {
    for (const reason of SEQUENCE_HALT_REASONS) {
        const label = SEQUENCE_HALT_REASON_LABELS[reason];
        assert.ok(typeof label === 'string' && label.length > 0,
            `SEQUENCE_HALT_REASONS includes '${reason}' with no label`);
        assert.notEqual(label, reason, `'${reason}' must have a phrase, not the raw enum key`);
    }
});

check('haltReasonLabel degrades to the raw value rather than to nothing', () => {
    assert.equal(haltReasonLabel(null), null);
    assert.equal(haltReasonLabel(undefined), null);
    assert.equal(haltReasonLabel(''), null);
    // A reason added to the CHECK constraint but not yet to the labels must still render.
    assert.equal(haltReasonLabel('some_future_reason'), 'some_future_reason');
    assert.equal(haltReasonLabel('replied'), SEQUENCE_HALT_REASON_LABELS.replied);
});

check('the label is resolved server-side, so the client holds no copy of the vocabulary', () => {
    assert.ok(readApiText.includes('haltReasonLabel('),
        'the function must resolve the label from src/config/outreach-sequences.ts');
    for (const reason of SEQUENCE_HALT_REASONS) {
        // 'replied' is the one key the UI may branch on: it is the success case and gets a
        // different colour, which is a presentation decision rather than a copy of the vocabulary.
        if (reason === 'replied') continue;
        assert.ok(!conversationsUiText.includes(`'${reason}'`),
            `the UI hardcodes halt reason '${reason}' — render haltReasonLabel from the server instead`);
    }
});

check('the thread list ships excerpts, not whole message bodies', () => {
    const listBranch = readApiText.slice(landmark(readApiText, "action === 'list'"), landmark(readApiText, "action === 'get'"));
    assert.ok(listBranch.includes('left(') && listBranch.includes('EXCERPT_CHARS'),
        'the list rollup must truncate bodies in SQL — a full page would otherwise ship every word exchanged');
    assert.ok(!/body: leadMessages\.body/.test(listBranch), 'the list must not select full bodies');
});

check('the paging cursor sorts on the same keys as the ORDER BY', () => {
    // A cursor that disagrees with the sort drops or repeats rows silently, which reads as flaky
    // data rather than as a bug.
    assert.ok(readApiText.includes('desc(leadThreads.updatedAt), desc(leadThreads.id)'),
        'threads must be ordered by (updatedAt DESC, id DESC)');
    assert.ok(readApiText.includes('lt(leadThreads.updatedAt, cursor.updatedAt)')
        && readApiText.includes('lt(leadThreads.id, cursor.id)'),
        'the cursor predicate must be the composite (updatedAt, id), matching the ORDER BY');
});

check('the UI escapes every server value it renders', () => {
    // The diff is the one place this component builds markup around message text, so every branch
    // that emits a run has to escape it. Asserted as "no raw interpolation of run text" rather
    // than by naming a helper call, so the check survives a refactor of the diff itself.
    const diffAt = conversationsUiText.indexOf('function diffWords');
    const diffBody = conversationsUiText.slice(diffAt, landmark(conversationsUiText, 'function messageItem'));
    assert.ok(diffAt > -1 && diffBody.includes('esc('), 'the diff must escape what it renders');
    for (const raw of ['${r.text}', '${trail}', '${a[i]}', '${b[j]}']) {
        assert.ok(!diffBody.includes(raw), `diffWords interpolates ${raw} without escaping it`);
    }
    for (const raw of ['${m.body}', '${t.title}', '${m.subject}', '${t.lastExcerpt}']) {
        assert.ok(!conversationsUiText.includes(raw), `${raw} must be escaped, not interpolated raw`);
    }
});

check('Conversations is registered for the lead role only', () => {
    const leadBlock = registryText.slice(landmark(registryText, 'lead_qualifier: {'));
    assert.ok(leadBlock.includes('conversationsTab'), 'lead_qualifier must declare conversationsTab');
    assert.equal((registryText.match(/conversationsTab:/g) || []).length, 1,
        'only lead_qualifier has lead threads — no other role should show this tab');
});

check('every utility class the Conversations UI uses is already compiled into style.css', () => {
    // The site has no build step: a class that isn't in the prebuilt style.css simply does nothing,
    // and rebuilding to add one churns unrelated selectors across the whole app. Tailwind escapes
    // ':' '[' ']' '.' in compiled selectors, so the lookup uses the escaped form.
    const cssText = readFileSync(join(root, 'style.css'), 'utf8');
    const tokens = new Set<string>();
    const addAll = (text: string) => {
        for (const raw of text.split(/\s+/)) if (raw) tokens.add(raw);
    };
    for (const m of conversationsUiText.matchAll(/class="([^"]*)"/g)) {
        const attr = m[1];
        // A class attribute in a template literal is part static text, part `${…}` expression.
        // Both halves carry real class names, and skipping the expressions would leave every
        // conditional class — the state chips, the active filter — unchecked. So: take the static
        // text directly, and take the quoted string literals out of each expression. No nested
        // braces appear in these templates, which is what makes the span match sound.
        addAll(attr.replace(/\$\{[^}]*\}/g, ' '));
        for (const expr of attr.matchAll(/\$\{[^}]*\}/g)) {
            for (const lit of expr[0].matchAll(/'([^']*)'/g)) addAll(lit[1]);
        }
    }
    // The chip palettes are class lists held in consts rather than written inline, so the attribute
    // scan above never sees them — they reach the DOM through `${cls}`. Named explicitly because
    // any "does this literal look like classes?" heuristic also matches the data-* selector names.
    for (const mapName of ['THREAD_CHIP', 'CLASS_CHIP', 'OUTCOME_CHIP']) {
        const at = conversationsUiText.indexOf(`const ${mapName} = {`);
        assert.ok(at > -1, `${mapName} not found — update this check if the palettes were renamed`);
        const bodyEnd = landmark(conversationsUiText, '};', at);
        for (const lit of conversationsUiText.slice(at, bodyEnd).matchAll(/'([^']*)'/g)) addAll(lit[1]);
    }

    assert.ok(tokens.size > 40, `expected a real class list, parsed ${tokens.size}`);
    const escapeSel = (t: string) => t.replace(/([:[\].])/g, '\\$1');
    const missing = [...tokens].filter((t) => !cssText.includes(escapeSel(t)));
    assert.deepEqual(missing, [], `not compiled into style.css: ${missing.join(', ')}`);
});

check('the Signal Inbox is the DECLARED landing tab, not an accident of tab order', () => {
    const leadBlock = registryText.slice(landmark(registryText, 'lead_qualifier: {'));
    assert.ok(/defaultMainTab:\s*'signals'/.test(leadBlock),
        "lead_qualifier must declare defaultMainTab: 'signals' rather than relying on the first-visible-tab fallback");
});

// ── 8. One token, one address ────────────────────────────────────────────────
//
// The reply_token printed in an outreach email is what lead-unsubscribe.ts resolves an opt-out
// against, and it suppresses the thread's contact_email. So the token must map to exactly ONE
// address for that thread's lifetime. openLeadThread used to write contact_email only on INSERT
// and ignore the recipient on the reuse path, so a lead whose address changed after its first send
// kept mailing the new address with the old address's token: the person who clicked unsubscribe was
// never suppressed, and a third party was. These run openLeadThread against a fake db — the branch
// is the whole behaviour, and it is not visible in the source text.
//
// ⚠️ These are the only ASYNC checks in the file, and the runner compiles it to CJS — no top-level
// await. They live in a function that the bottom of the file awaits before printing the count, so
// their results are inside the total rather than racing it.

interface FakeRow { id: number; replyToken: string; state: string; contactEmail: string | null }

function fakeDb(existing: FakeRow | null) {
    const updated: Record<string, unknown>[] = [];
    const inserted: Record<string, unknown>[] = [];
    const selectChain: Record<string, unknown> = {
        from: () => selectChain,
        where: () => selectChain,
        orderBy: () => selectChain,
        limit: async () => (existing ? [existing] : []),
    };
    const db = {
        select: () => selectChain,
        update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => { updated.push(v); } }) }),
        insert: () => ({
            values: (v: Record<string, unknown>) => ({
                returning: async () => { inserted.push(v); return [{ id: 99, replyToken: v.replyToken }]; },
            }),
        }),
    };
    return { db, updated, inserted };
}

const OPEN: FakeRow = { id: 7, replyToken: 'tok-existing', state: 'open', contactEmail: 'Mark@Example.com' };
const base = { organisationId: 58, aiAssistantId: 21, assistantRecordId: 135 };

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

async function runOneTokenOneAddressChecks(): Promise<void> {
    console.log('\n──── a reply token can only ever suppress the address it was sent to ────');

    await checkAsync('the same address reuses the thread, whatever its case or spacing', async () => {
        const { db, updated, inserted } = fakeDb(OPEN);
        const ref = await openLeadThread(db as never, { ...base, contactEmail: '  mark@example.com ' });
        assert.deepStrictEqual(ref, { id: 7, replyToken: 'tok-existing' }, 'must be the same conversation');
        assert.strictEqual(inserted.length, 0, 'a matching address must not fork the thread');
        assert.strictEqual(updated.length, 0, 'nothing to correct');
    });

    await checkAsync('a CHANGED address forks a new thread with a new token', async () => {
        const { db, updated, inserted } = fakeDb(OPEN);
        const ref = await openLeadThread(db as never, { ...base, contactEmail: 'someone.else@example.com' });
        assert.ok(ref && ref.id !== OPEN.id, 'must not hand back the thread bound to the old address');
        assert.ok(ref && ref.replyToken !== OPEN.replyToken,
            'a new address needs a NEW token — reusing it lets an unsubscribe suppress the wrong person');
        assert.strictEqual(inserted.length, 1, 'exactly one new thread');
        assert.strictEqual(inserted[0].contactEmail, 'someone.else@example.com', 'recorded against the new address');
        assert.strictEqual(inserted[0].assistantRecordId, 135, 'still the same lead record');
        assert.strictEqual(updated.length, 0,
            'the old row must be left alone — an unsubscribe from an already-delivered email still '
            + 'belongs to the address that received it');
    });

    await checkAsync('a thread with no recorded address adopts the one we are writing to', async () => {
        const { db, updated, inserted } = fakeDb({ ...OPEN, contactEmail: null });
        const ref = await openLeadThread(db as never, { ...base, contactEmail: ' new@example.com ' });
        assert.deepStrictEqual(ref, { id: 7, replyToken: 'tok-existing' }, 'nothing was bound, so no fork');
        assert.strictEqual(inserted.length, 0, 'adopting, not forking');
        assert.strictEqual(updated.length, 1, 'the address must be written, or unsubscribe can only 404');
        assert.strictEqual(updated[0].contactEmail, 'new@example.com', 'stored trimmed');
    });

    await checkAsync('a caller that does not know the address keeps the conversation', async () => {
        const { db, updated, inserted } = fakeDb(OPEN);
        const ref = await openLeadThread(db as never, { ...base });
        assert.deepStrictEqual(ref, { id: 7, replyToken: 'tok-existing' }, 'absence of an address is not a change of address');
        assert.strictEqual(inserted.length + updated.length, 0, 'nothing to do');
    });

    await checkAsync('a closed thread still starts a fresh one', async () => {
        const { db, inserted } = fakeDb({ ...OPEN, state: 'closed', contactEmail: 'mark@example.com' });
        const ref = await openLeadThread(db as never, { ...base, contactEmail: 'mark@example.com' });
        assert.ok(ref && ref.id !== OPEN.id, 'closed means closed');
        assert.strictEqual(inserted.length, 1, 'one new thread');
    });
}

// ── 9. Closing the lifecycle from the conversation ───────────────────────────
//
// A deal ending was recordable only from the Leads tab, which meant reading what the prospect
// actually said in one tab and recording what it meant in another. The thread now carries the same
// control. Everything here defends the two ways that could go wrong: a second implementation of the
// outcome rules, and this read-only screen quietly becoming a writer of the thread tables.

console.log('\n──── the deal outcome can be recorded where the evidence is ────');

const OUTCOME_MODAL = readFileSync(join(root, 'src/components/lead-outcome-modal.js'), 'utf8');
const WORKSPACE = readFileSync(join(root, 'workspace.html'), 'utf8');

check('both surfaces open ONE form — neither hand-rolls the outcome rules', () => {
    for (const [name, src] of [
        ['the Conversations tab', conversationsUiText],
        ['the Leads tab', readFileSync(join(root, 'src/components/assistant-data-hub.js'), 'utf8')],
    ] as const) {
        assert.ok(/window\.LeadOutcomeModal\?\.open\(/.test(src),
            `${name} must open the shared modal rather than building its own form`);
        // The tells of a second copy: the picker, the conditional fields, or the 409 dance.
        assert.ok(!/data-oc-outcomes|needsConfirmation/.test(src),
            `${name} has re-implemented the outcome form — the rules it mirrors (a loss needs a `
            + 'reason, only a win takes a value, a correction appends) must exist in one place');
    }
});

check('the modal is loaded before the two components that call it', () => {
    const modal = WORKSPACE.indexOf('/src/components/lead-outcome-modal.js');
    assert.notStrictEqual(modal, -1, 'workspace.html never loads the shared outcome modal');
    for (const dependent of ['assistant-data-hub.js', 'assistant-lead-threads.js']) {
        const at = WORKSPACE.indexOf(`/src/components/${dependent}`);
        assert.notStrictEqual(at, -1, `workspace.html no longer loads ${dependent}`);
        assert.ok(modal < at, `${dependent} is loaded before the modal it opens`);
    }
});

check('the outcome control is gated on there being a lead to record it against', () => {
    // set_outcome is keyed by the LEAD record, and assistant_record_id is ON DELETE SET NULL — a
    // thread outlives its record. Without this the button opens a form whose save can only 404.
    // ⚠️ `outcomeBar` became `actionBar` when the tab gained Add-note beside Record-outcome. Both
    // buttons are keyed by the same lead record and share the same gate, so the guard covers both.
    const at = landmark(conversationsUiText, 'function actionBar(');
    const body = conversationsUiText.slice(at, landmark(conversationsUiText, '\n  }', at));
    assert.ok(/if \(!t\.assistantRecordId\)/.test(body),
        'actionBar must refuse to offer the buttons when the thread has no linked lead');
    for (const control of ['[data-lt-outcome]', '[data-lt-note]']) {
        const handler = conversationsUiText.slice(landmark(conversationsUiText, `'${control}'`));
        assert.ok(/!t\.assistantRecordId\) return/.test(handler.slice(0, 400)),
            `the ${control} handler must also bail without a record id — the render gate alone is not the guard`);
    }
});

check('recording an outcome never writes the thread tables', () => {
    // The one write this screen has must stay off lead_threads / lead_messages: src/utils/
    // lead-threads.ts is their only writer, for the same reason recordEvent() is the only ledger
    // writer. set_outcome writes assistant_records.data instead, which is why this is allowed.
    assert.ok(/action: 'set_outcome'/.test(OUTCOME_MODAL),
        'the modal must post set_outcome');
    // Comment-stripped: the modal's header names assistant-lead-threads.js while EXPLAINING which
    // of its two callers this is, and a scan counting comment text would fail on the explanation.
    const code = codeOnly(OUTCOME_MODAL);
    assert.ok(!/leadThreads|lead_messages|lead-threads/.test(code),
        'the outcome path must not reach the thread tables');
    assert.ok(/lead-generation/.test(code),
        'the outcome path must go to lead-generation.ts set_outcome, which writes the LEAD record');
    assert.ok(/not a writer of lead_threads \/ lead_messages/i.test(conversationsUiText),
        'the component header must still state the invariant it is preserving — this screen now has '
        + 'several writes, and a later reader seeing them will otherwise take them as licence to '
        + 'write the thread tables too');
});

check('the correction path is preserved, not simplified away', () => {
    // The ledger is append-only: correcting an outcome appends a SECOND terminal row. The server
    // 409s unless confirmed, and dropping that handling would make a correction look like a failure.
    assert.ok(/res\.status === 409 && data\.needsConfirmation/.test(OUTCOME_MODAL),
        'the modal must handle the 409 that guards a correction');
    assert.ok(/confirmChange: true/.test(OUTCOME_MODAL),
        'confirming a change must send confirmChange');
});

check('the API returns the outcome but not the rest of the lead record', () => {
    // recordData is selected to reach dealOutcome. Returning the blob would put the outreach draft
    // and contact provenance on a response that is already careful about what it selects.
    assert.ok(/function dealOutcomeOf\(/.test(readApiText),
        'lead-threads.ts must lift dealOutcome through a single helper');
    assert.ok(!/recordData: t\.recordData|recordData: thread\.recordData/.test(readApiText),
        'the raw record data blob must never be returned to the browser');
    const responses = [...readApiText.matchAll(/dealOutcome: dealOutcomeOf\(/g)];
    assert.strictEqual(responses.length, 2,
        `both list and get must expose the outcome (found ${responses.length}) — a chip that only `
        + 'appears once the thread is open cannot answer "which of these are closed out?"');
});

void runOneTokenOneAddressChecks().then(() => {
    console.log(`\n${passed} checks passed.`);
});
