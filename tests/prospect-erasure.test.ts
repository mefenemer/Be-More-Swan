// tests/prospect-erasure.test.ts
// "Delete everything you hold about me" — from someone who never signed up.
//
// A prospect is the weakest-footed data in this product. They have no account, no login and no
// contract with anyone; their name, address, job title and a paragraph of scraped research were
// collected from their own website or bought from a broker, and the first they heard of any of it
// was a cold email from a stranger. Until this shipped there was no route to erase them at all:
// admin-gdpr-erase.ts erases a Be More Swan USER, which a prospect is not, and every other control
// on the lead — Delete, do-not-contact, the retention sweep — either keeps the personal data or
// keeps it and stops the sending. None of them removes the person.
//
// Two failures here are silent and worse than doing nothing, which is why most of this file is
// about them:
//
//   1. ERASING THE OPT-OUT TOO. lead_opt_outs is keyed on the very address the request names. Take
//      it out and the next discovery run re-finds the company, re-scrapes the address and emails the
//      person who asked to be forgotten — the erasure directly causing the harm it was meant to end.
//   2. ERASING THE DATA AND FAILING TO RECORD THE BLOCK. Same outcome, reached from the other side:
//      every trace gone, nothing left to stop the re-discovery.
//
// Both pass a typecheck, both look like success on screen, and neither shows up until a stranger
// receives a second cold email they explicitly asked not to get.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    accountMemory, accountNodes, assistantRecords, discoveredLeads, discoveryGuardrails,
    leadMessages, leadOptOuts, leadThreads, sequenceEnrolments,
} from '../db/schema';
import { ERASED_TEXT, eraseProspect } from '../src/utils/prospect-erasure';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

let passed = 0;
function check(name: string, fn: () => void | Promise<void>) {
    const ok = () => { passed++; console.log(`  ✓ ${name}`); };
    const bad = (err: unknown) => {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
        process.exitCode = 1;
    };
    try {
        const out = fn();
        if (out && typeof (out as Promise<void>).then === 'function') {
            return (out as Promise<void>).then(ok, bad);
        }
        ok();
    } catch (err) { bad(err); }
    return Promise.resolve();
}

const ERASURE = read('src/utils/prospect-erasure.ts');
const LEAD_GEN = read('netlify/functions/lead-generation.ts');
const THREADS_UI = read('src/components/assistant-lead-threads.js');
const HUB_UI = read('src/components/assistant-data-hub.js');

// ── A fake db that records what was asked of it ─────────────────────────────
// Enough drizzle to run the real function: every builder method returns the chain, and awaiting it
// yields whatever rows the test configured for that operation on that table. The point is not to
// simulate Postgres — it is to see WHICH tables were written, in WHICH order, and what happens to
// the rest when one of them throws.

const TABLES = new Map<unknown, string>([
    [accountMemory, 'account_memory'], [accountNodes, 'account_nodes'],
    [assistantRecords, 'assistant_records'], [discoveredLeads, 'discovered_leads'],
    [leadMessages, 'lead_messages'], [leadOptOuts, 'lead_opt_outs'],
    [leadThreads, 'lead_threads'], [sequenceEnrolments, 'sequence_enrolments'],
    [discoveryGuardrails, 'discovery_guardrails'],
]);

interface FakeOpts {
    /** "op:table" → the rows that await should yield. Defaults to []. */
    rows?: Record<string, unknown[]>;
    /** "op:table" that should throw instead of resolving. */
    throwOn?: string;
}

function fakeDb(opts: FakeOpts = {}) {
    const calls: string[] = [];
    const setValues: Record<string, unknown>[] = [];

    const chain = (op: string) => {
        let table = '';
        // ⚠️ `.limit()` is HONOURED, not swallowed. A fake that ignores it cannot tell a query that
        // reads every row from one that reads the first — and "every search in the org, not just
        // the one that found them" is precisely the property the exclusion below has to have.
        let take: number | null = null;
        const key = () => `${op}:${table}`;
        // The table arrives at different points depending on the builder — `db.update(t)` names it
        // immediately, `db.select({…}).from(t)` two calls later — so every call is scanned for one.
        const record = (args: unknown[]) => {
            for (const a of args) {
                const named = TABLES.get(a);
                if (named) table = named;
            }
            return proxy;
        };
        // The target is a FUNCTION because the entry points are called with the table
        // (`db.insert(leadOptOuts)`), so the proxy has to be callable as well as gettable.
        const proxy: any = new Proxy(function () { /* drizzle builder stand-in */ } as never, {
            apply(_t, _this, args: unknown[]) { return record(args); },
            get(_t, prop) {
                if (prop === 'then') {
                    return (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
                        calls.push(key());
                        if (opts.throwOn === key()) return Promise.reject(new Error(`boom: ${key()}`)).then(res, rej);
                        const rows = opts.rows?.[key()] ?? [];
                        return Promise.resolve(take === null ? rows : rows.slice(0, take)).then(res, rej);
                    };
                }
                return (...args: unknown[]) => {
                    if (prop === 'limit' && typeof args[0] === 'number') take = args[0];
                    if (prop === 'set' || prop === 'values') {
                        setValues.push((args[0] || {}) as Record<string, unknown>);
                    }
                    return record(args);
                };
            },
        });
        return proxy;
    };

    const db = {
        insert: (t: unknown) => chain('insert')(t),
        select: (cols: unknown) => chain('select')(cols),
        update: (t: unknown) => chain('update')(t),
        delete: (t: unknown) => chain('delete')(t),
    };

    return { db: db as never, calls, setValues };
}

async function main() {
    console.log('\n──── 1. the opt-out is the point, not a leftover ────');

    await check('the address is put beyond re-discovery BEFORE anything is removed', async () => {
        const { db, calls } = fakeDb();
        await eraseProspect(db, { organisationId: 7, email: 'Sam@Example.com' });
        // ⚠️ Ordering, not merely presence. An erasure that dies halfway must leave them PROTECTED; the
        // opposite order strips every trace and leaves nothing to stop the next discovery run.
        //
        // The first WRITE, not the first call: the reads ahead of it resolve the address and the
        // domain, which is what decides WHICH block to take, and they change nothing if they fail.
        const writes = calls.filter((c) => !c.startsWith('select:'));
        assert.strictEqual(writes[0], 'insert:lead_opt_outs',
            `the do-not-contact row must be written before anything is removed — got ${writes[0] || 'nothing'}`);
    });

    await check('the opt-out row is created, never deleted, and the caller is told', async () => {
        const { db, calls, setValues } = fakeDb();
        const res = await eraseProspect(db, { organisationId: 7, email: 'sam@example.com' });
        assert.ok(!calls.includes('delete:lead_opt_outs'),
            'deleting the suppression row is the one change that would make erasure cause the harm it ends');
        assert.strictEqual(res.optOutRetained, true,
            'the result must say a block is in place — silence about a row deliberately left behind reads '
            + 'as an incomplete erasure to whoever has to answer the data subject');
        const optOut = setValues.find((v) => v.reason === 'erasure_request');
        assert.ok(optOut, 'the row must record WHY it exists, or the next reader deletes it as noise');
        assert.strictEqual(optOut!.email, 'sam@example.com', 'stored at the normalised address grain');
    });

    await check('a failed opt-out ABORTS — nothing is erased', async () => {
        // The one outcome strictly worse than doing nothing: their data gone AND no record stopping the
        // next email. If the block cannot be written, the erasure must not proceed.
        const { db, calls } = fakeDb({ throwOn: 'insert:lead_opt_outs' });
        const res = await eraseProspect(db, { organisationId: 7, email: 'sam@example.com' });
        assert.deepStrictEqual(res.failures, ['opt_out']);
        assert.strictEqual(res.optOutRetained, false);
        assert.deepStrictEqual(res.redacted, {}, 'no step may run once the block has failed');
        for (const c of calls) {
            assert.ok(!c.startsWith('update:') && !c.startsWith('delete:'),
                `nothing may be written after a failed opt-out — saw ${c}`);
        }
    });

    console.log('\n──── 2. what it removes, and what it deliberately does not ────');

    await check('the address is matched case-insensitively at every table', () => {
        // Addresses arrive from mail headers in whatever case the client felt like. A case-sensitive
        // match silently erases nothing and reports success.
        assert.ok(!/eq\(discoveredLeads\.contactEmail,/.test(ERASURE),
            'discovered_leads must be matched on lower(contact_email), not a raw equality');
        assert.match(ERASURE, /lower\(\$\{discoveredLeads\.contactEmail\}\)/);
        assert.match(ERASURE, /lower\(\$\{assistantRecords\.data\} ->> 'contactEmail'\)/);
        assert.match(ERASURE, /lower\(\$\{sequenceEnrolments\.contactEmail\}\)/);
    });

    await check('the funnel history survives — rows are redacted, not deleted', async () => {
        const { db, calls } = fakeDb({
            rows: { 'select:lead_threads': [{ id: 1, assistantRecordId: 5, discoveredLeadId: 9 }] },
        });
        await eraseProspect(db, { organisationId: 7, email: 'sam@example.com' });
        // The ledger events saying a lead was found, approached and lost are the ORG's records about its
        // own activity. Destroying them to erase a third party takes something that was never theirs.
        for (const t of ['assistant_records', 'discovered_leads', 'lead_threads', 'lead_messages']) {
            assert.ok(!calls.includes(`delete:${t}`), `${t} must be redacted in place, never deleted`);
            assert.ok(calls.includes(`update:${t}`), `${t} was not redacted at all`);
        }
    });

    await check('the embedded memory is DELETED, because a vector is still a copy', async () => {
        const { db, calls } = fakeDb({ rows: { 'select:account_nodes': [{ id: 3 }] } });
        await eraseProspect(db, { organisationId: 7, email: 'sam@example.com' });
        // account_memory holds the message text AND its embedding. A blanked row with a live vector is a
        // searchable copy of what they said, so this is the one place deletion is the honest answer.
        assert.ok(calls.includes('delete:account_memory'), 'the memory rows must go, not be blanked');
        assert.ok(!calls.includes('update:account_memory'));
        assert.ok(calls.includes('delete:account_nodes'), 'the contact node IS the person');
    });

    await check('a redacted message says a person asked, not that we lost it', () => {
        assert.match(ERASED_TEXT, /request/i,
            'an empty body reads as data loss and generates a support ticket; the replacement has to '
            + 'explain itself');
        const branch = ERASURE.slice(landmark(ERASURE, 'update(leadMessages)'), landmark(ERASURE, 'update(leadThreads)'));
        assert.match(branch, /body: ERASED_TEXT/, 'the body is what they wrote — it is the first thing to go');
        assert.match(branch, /generatedBody: null/,
            'the pre-edit draft is a second copy of the same message and is missed by eye every time');
    });

    await check('the reply alias is ROTATED, not cleared', async () => {
        const { db, setValues } = fakeDb({
            rows: { 'select:lead_threads': [{ id: 1, assistantRecordId: null, discoveredLeadId: null }] },
        });
        await eraseProspect(db, { organisationId: 7, email: 'sam@example.com' });
        const patch = setValues.find((v) => 'replyToken' in v);
        assert.ok(patch, 'the thread patch must touch the alias at all');
        // The column is NOT NULL and unique, so it cannot simply be blanked — and rotating it is the
        // part that matters anyway: mail to the alias they were given stops resolving to anything.
        assert.ok(typeof patch!.replyToken === 'string' && (patch!.replyToken as string).length >= 16,
            'a fresh unguessable token, not null and not the old one');
        assert.strictEqual(patch!.contactEmail, null);
    });

    await check('the company survives by default and goes only when asked', () => {
        // A limited company is not a data subject. A sole trader whose company IS their name is one, and
        // only a human can tell those apart — so the caller decides and the default is the safe half.
        const keys = ERASURE.slice(landmark(ERASURE, 'const COMPANY_RECORD_KEYS'), landmark(ERASURE, 'export interface EraseProspectInput'));
        for (const k of ['website', 'companyName', 'domain']) {
            assert.ok(keys.includes(`'${k}'`), `${k} belongs in the company set`);
        }
        const record = ERASURE.slice(landmark(ERASURE, "step('assistant_records'"), landmark(ERASURE, "step('sequence_enrolments'"));
        assert.match(record, /scope === 'full'\s*\n?\s*\?\s*\[\.\.\.PERSONAL_RECORD_KEYS, \.\.\.COMPANY_RECORD_KEYS\]/,
            'the company keys must be reachable ONLY through scope full');
    });

    await check('the research is erased, not just the address', () => {
        // The address alone is the obvious half. `intel` and `hooks` are free text about a named human,
        // `outreachDraft` is an email addressed to them, `people` names their colleagues — leaving any of
        // these behind means the record still identifies them and the erasure was cosmetic.
        const keys = ERASURE.slice(landmark(ERASURE, 'const PERSONAL_RECORD_KEYS'), landmark(ERASURE, 'const COMPANY_RECORD_KEYS'));
        for (const k of ['contactEmail', 'contactName', 'socialHandles', 'people', 'intel', 'hooks', 'notes', 'outreachDraft', 'draftOriginal', 'lead']) {
            assert.ok(keys.includes(`'${k}'`), `${k} identifies the person and must be stripped`);
        }
    });

    await check('anything queued to email them is cancelled', async () => {
        const { db, calls, setValues } = fakeDb();
        await eraseProspect(db, { organisationId: 7, email: 'sam@example.com' });
        assert.ok(calls.includes('update:sequence_enrolments'), 'a live enrolment holds its own copy of the address');
        const patch = setValues.find((v) => v.state === 'cancelled');
        assert.ok(patch && patch.contactEmail === null,
            'the enrolment must be stopped AND stripped — the sender reads that column');
    });

    console.log('\n──── 3. it reports what it did, and never throws ────');

    await check('a broken step is collected, not raised', async () => {
        // Whoever has to answer the data subject needs to know exactly how far it got. An exception
        // leaves them guessing, and guessing means claiming more than was done.
        const { db } = fakeDb({ throwOn: 'update:discovered_leads' });
        const res = await eraseProspect(db, { organisationId: 7, email: 'sam@example.com' });
        assert.deepStrictEqual(res.failures, ['discovered_leads']);
        assert.strictEqual(res.optOutRetained, true, 'the block still stands');
        assert.ok(res.redacted.assistant_records !== undefined,
            'the steps after the failure must still run — one unreachable table cannot cancel the rest');
    });

    await check('a junk address does nothing at all', async () => {
        const { db, calls } = fakeDb();
        const res = await eraseProspect(db, { organisationId: 7, email: 'not-an-address' });
        assert.deepStrictEqual(res.failures, ['invalid_email']);
        assert.strictEqual(calls.length, 0, 'no write may be attempted on an address we cannot match');
    });

    await check('counts come back per table', async () => {
        const { db } = fakeDb({ rows: { 'update:assistant_records': [{ id: 1 }, { id: 2 }] } });
        const res = await eraseProspect(db, { organisationId: 7, email: 'sam@example.com' });
        assert.strictEqual(res.redacted.assistant_records, 2,
            '"what did you actually remove?" is the question the tenant will be asked, verbatim');
    });

    console.log('\n──── 4. the route in: a tenant action, confirmed and audited ────');

    const eraseAction = () => LEAD_GEN.slice(
        landmark(LEAD_GEN, "action === 'erase_prospect'"),
        landmark(LEAD_GEN, "action === 'set_outreach_provider'"),
    );

    await check('it is a TENANT action, because that is where the request arrives', () => {
        // The prospect replies to the tenant, whose name was on the email. They have never heard of Be
        // More Swan, so routing this through an admin screen would mean the only person who receives the
        // request cannot action it.
        assert.ok(LEAD_GEN.includes("action === 'erase_prospect'"),
            'the erasure route must hang off the tenant-facing lead function');
        const act = eraseAction();
        assert.match(act, /organisationId: orgId/, 'the erasure is org-scoped');
        assert.match(act, /eq\(assistantRecords\.organisationId, orgId\)/,
            'and the record lookup must be too — a bare recordId would reach another tenant’s lead');
    });

    await check('an irreversible act needs an explicit confirmation', () => {
        const act = eraseAction();
        assert.match(act, /body\.confirmErase !== true/,
            'a caller must state its intent — this is not undoable and there is no copy to restore from');
        assert.match(act, /needsConfirmation: true/, 'and the refusal must be machine-readable');
    });

    await check('the audit row proves it happened WITHOUT re-creating the record', () => {
        const act = eraseAction();
        assert.match(act, /adminAuditLog/,
            'an erasure is precisely the act you must be able to evidence later, and every other copy of '
            + 'the evidence has just been deleted on purpose');
        // ⚠️ An audit row naming the person would re-create, in a table nothing erases, exactly the
        // record the request asked us to remove. A hash answers "did you action this address?" without
        // holding it.
        assert.match(act, /createHash\('sha256'\)/);
        assert.ok(!/emailAddress|email: (result\.email|email)\b/.test(act),
            'the address itself must not be written to the audit log');
    });

    await check('a failed audit write does not fail the erasure', () => {
        const act = eraseAction();
        const auditAt = landmark(act, 'adminAuditLog');
        assert.ok(act.slice(0, auditAt).includes('await eraseProspect('),
            'erase first, audit second — the data subject’s request outranks our bookkeeping');
        assert.match(act.slice(auditAt), /catch \(err\)/,
            'and an unwritable audit row must not turn a completed erasure into a 500 the user retries');
    });

    await check('a partial erasure says so, and says they are still blocked', () => {
        const act = eraseAction();
        assert.match(act, /Partly erased/,
            'reporting "done" over a half-finished erasure is what makes a tenant tell a data subject '
            + 'something untrue');
        assert.match(act, /failures: result\.failures/, 'and the caller gets the list, not just a flag');
    });

    console.log('\n──── 5. the control sits where the request is read ────');

    await check('a conversation offers the erasure', () => {
        assert.match(THREADS_UI, /data-lt-erase/,
            '"delete my data" arrives as a reply in a thread — the control belongs beside it, not in a '
            + 'settings page the reader has to go and find');
        const bar = THREADS_UI.slice(landmark(THREADS_UI, 'function erasureBar'), landmark(THREADS_UI, '// ── Controls ─'));
        assert.match(bar, /do-not-contact/,
            'the copy must say the block is kept, or the button looks like it un-protects them');
    });

    await check('the erasure is confirmed in the UI too, and scope is a question', () => {
        const fn = THREADS_UI.slice(landmark(THREADS_UI, 'async function eraseProspectData'), landmark(THREADS_UI, 'function wireControls'));
        assert.match(fn, /window\.choiceModal/, 'contact-only vs the company as well is a human judgement');
        assert.match(fn, /window\.confirmModal/, 'and then the irreversible-act confirmation');
        // ⚠️ Every other prompt in this file degrades to "carry on without it". Here the prompt IS the
        // safeguard, so a missing dialog must stop the action rather than wave it through.
        const guard = fn.slice(0, landmark(fn, 'action: \'erase_prospect\''));
        assert.match(guard, /if \(!window\.choiceModal \|\| !window\.confirmModal\)/,
            'a missing dialog must abort, never fall through to a silent erasure');
    });

    await check('the screen does not keep showing what it just erased', () => {
        const fn = THREADS_UI.slice(landmark(THREADS_UI, 'async function eraseProspectData'), landmark(THREADS_UI, 'function wireControls'));
        assert.match(fn, /call\('get', \{ threadId: t\.id \}\)/,
            'the transcript on screen is the pre-erasure one; it has to be refetched or the user is '
            + 'looking at the thing they were told was gone');
        assert.match(fn, /delete state\.open\[t\.id\]/,
            'and if the refetch fails, the cached copy must be dropped rather than repainted from');
        assert.match(fn, /delete state\.replyDraft\[t\.id\]/,
            'a half-written reply to someone who asked to be forgotten must not survive the erasure');
    });

    console.log('\n──── 6. the Leads table offers it too, without becoming a second Delete ────');

    const hubStrip = () => HUB_UI.slice(
        landmark(HUB_UI, 'function erasureStrip'),
        landmark(HUB_UI, 'function failureBanner'),
    );

    await check('a lead can be erased from the table it is read in', () => {
        // Not every request arrives as a reply. A phone call, a letter, or a forward from a colleague
        // all reach a user who is looking at the LEAD, with no conversation to act from.
        assert.match(HUB_UI, /data-hub-erase\b/,
            'the Leads tab needs its own entry point, or half the requests have nowhere to go');
        assert.match(hubStrip(), /action: 'erase_prospect'/,
            'and it must go through the same server action — a second erasure path is a second set of '
            + 'tables to forget about');
    });

    await check('it is NOT a second red button beside Delete', () => {
        // Delete IS the rejection here, and its confirmation promises the lead is KEPT. Erasing
        // promises the opposite. Two red buttons an inch apart, differing only in a word, is the trap
        // that had Reject removed from this tab.
        const bar = HUB_UI.slice(landmark(HUB_UI, 'function detailActions'), landmark(HUB_UI, 'function failureBanner'));
        const barOnly = bar.slice(0, landmark(bar, 'function erasureStrip'));
        assert.ok(!barOnly.includes('data-hub-erase'),
            'the erasure must not be pushed into the action bar’s button list');
        assert.match(hubStrip(), /border-t border-gray-100/,
            'it gets its own strip at the foot of the panel');
    });

    await check('the same two questions are asked here', () => {
        const fn = HUB_UI.slice(landmark(HUB_UI, 'async function eraseLeadProspect'), landmark(HUB_UI, 'function failureBanner'));
        assert.match(fn, /window\.choiceModal/, 'scope is a human judgement on both surfaces');
        assert.match(fn, /window\.confirmModal/);
        const guard = fn.slice(0, landmark(fn, "action: 'erase_prospect'"));
        assert.match(guard, /if \(!window\.choiceModal \|\| !window\.confirmModal\)/,
            'a missing dialog must abort here too, not wave a silent erasure through');
    });

    await check('the panel is rebuilt from the server, not patched', () => {
        const fn = HUB_UI.slice(landmark(HUB_UI, 'async function eraseLeadProspect'), landmark(HUB_UI, 'function failureBanner'));
        assert.match(fn, /await refresh\(\)/,
            'the erasure rewrote data server-side — address, intel, hooks, draft and possibly the '
            + 'title — and patching the fields this browser knows about would leave the rest on screen');
        assert.match(fn, /state\.pendingFocusId = record\.id/,
            'and the row must be re-opened, or the whole visible result is a row changing in a list');
    });

    await check('an erased lead says so, and says when', () => {
        const strip = hubStrip();
        assert.match(strip, /isErasedLead\(record\)/, 'the strip must recognise an already-erased lead');
        assert.match(strip, /fmtDate\(record\.data\.erasedAt\)/,
            '"did we action that request, and when?" is the question the record now exists to answer');
    });

    console.log('\n──── 7. an erased lead cannot be researched back into existence ────');

    await check('the erasure leaves the one marker the re-collection routes can read', () => {
        // Everything identifying is stripped, so an erased lead is otherwise indistinguishable from
        // one nobody has looked at — which is exactly the shape "Look again" is offered ON.
        assert.match(ERASURE, /jsonb_build_object\('erasedAt'/,
            'the stamp is what every guard below tests; without it they cannot tell the two apart');
    });

    await check('the server refuses all three re-collection routes', () => {
        // The opt-out stops us EMAILING them. Nothing stopped us going back to the same website and
        // re-scraping the name, the address and a paragraph about them.
        for (const act of ['look_again', 'send_back_for_enrichment', 'enrich_lead']) {
            const branch = LEAD_GEN.slice(landmark(LEAD_GEN, `action === '${act}'`));
            const next = branch.indexOf("        if (action === '", 10);
            assert.match(branch.slice(0, next === -1 ? branch.length : next), /isErasedLead\(/,
                `${act} would re-collect what the erasure removed and must refuse`);
        }
    });

    await check('look_again checks the erasure BEFORE the no-address check', () => {
        const branch = LEAD_GEN.slice(landmark(LEAD_GEN, "action === 'look_again'"), landmark(LEAD_GEN, "action === 'send_back_for_enrichment'"));
        assert.ok(landmark(branch, 'isErasedLead(') < landmark(branch, 'already has an address'),
            'an erased lead HAS no address — that is what erasing it did — so a later check never runs');
    });

    await check('the tab stops offering what the server will refuse', () => {
        const actions = HUB_UI.slice(landmark(HUB_UI, 'function detailActions'), landmark(HUB_UI, 'function erasureStrip'));
        assert.match(actions, /const erased = isErasedLead\(record\)/);
        for (const gated of ["!erased && !contactEmailOf(record)", "!erased && contactState(record) === 'none'", 'if (!erased) buttons.push({']) {
            assert.ok(actions.includes(gated), `a re-collection button is still offered on an erased lead: ${gated}`);
        }
    });

    await check('the next-step footer does not promote a button the bar no longer draws', () => {
        // ⚠️ The footer OWNS the promoted button and the bar hides its copy. An erased lead has no
        // address, so without this it falls through to "Add an address" — a promoted control that
        // does nothing when pressed.
        const fn = HUB_UI.slice(landmark(HUB_UI, 'function nextStepGuidance'), landmark(HUB_UI, 'function syncNextStepFooter'));
        assert.ok(landmark(fn, 'isErasedLead(record)') < landmark(fn, '!contactEmailOf(record)'),
            'the erased case must be answered before the no-address case');
        const branch = fn.slice(landmark(fn, 'isErasedLead(record)'));
        assert.match(branch.slice(0, 400), /action: null/, 'an erased lead has no next step');
    });

    console.log('\n──── 8. the lead with no address — which is most of them ────');

    // Enrichment finds an address for roughly one lead in three. The other two still hold a person:
    // a name, a job title, the colleagues found on their site, a paragraph of research quoting them.
    // Until this ran from the RECORD, those people had no route at all — the only key was an address
    // they had never given us.
    const noAddress = (extra: FakeOpts['rows'] = {}) => fakeDb({
        rows: {
            'select:discovered_leads': [{ id: 4, domain: 'acme.co.uk', contactEmail: null }],
            'select:assistant_records': [{ data: { website: 'https://www.acme.co.uk/contact' } }],
            'select:lead_threads': [],
            'select:discovery_guardrails': [{ id: 1, excludedDomains: [] }, { id: 2, excludedDomains: ['other.com'] }],
            ...extra,
        },
    });

    await check('a lead with no address can still be erased', async () => {
        const { db, calls } = noAddress();
        const res = await eraseProspect(db, { organisationId: 7, assistantRecordId: 55 });
        assert.strictEqual(res.email, null, 'there was no address, and the result must not invent one');
        assert.strictEqual(res.assistantRecordId, 55);
        assert.deepStrictEqual(res.failures, []);
        assert.ok(calls.includes('update:assistant_records'), 'the record must still be redacted');
    });

    await check('with no address, the block is the DOMAIN — and it is org-wide', async () => {
        // `lead_opt_outs` is keyed on an address that does not exist here, so the only handle on
        // "and do not come back" is the company. ⚠️ excluded_domains lives PER CAMPAIGN, so blocking
        // the one search that found them leaves every other search free to find them next week.
        const { db, calls, setValues } = noAddress();
        const res = await eraseProspect(db, { organisationId: 7, assistantRecordId: 55 });
        assert.strictEqual(res.blockedBy, 'domain_exclusion');
        assert.strictEqual(res.domainExcluded, 'acme.co.uk');
        assert.strictEqual(res.campaignsBlocked, 2, 'every search in the org, not just the one that found them');
        assert.ok(!calls.includes('insert:lead_opt_outs'),
            'an opt-out row keyed on nothing would be a block that protects nobody');
        const patch = setValues.find((v) => Array.isArray(v.excludedDomains));
        assert.ok((patch!.excludedDomains as string[]).includes('acme.co.uk'));
        assert.ok((patch!.excludedDomains as string[]).length >= 1);
    });

    await check('the domain is stored at the grain discovery compares against', async () => {
        // The discovery side normalises on insert (lowercase, no scheme, no www) and compares the
        // exclusion list against that form. An entry in any other shape never matches — a block that
        // reads as applied and stops nothing.
        const { db } = fakeDb({
            rows: {
                'select:discovered_leads': [{ id: 4, domain: null, contactEmail: null }],
                'select:assistant_records': [{ data: { website: 'HTTPS://WWW.Acme.co.uk/contact?utm=1' } }],
                'select:discovery_guardrails': [{ id: 1, excludedDomains: [] }],
            },
        });
        const res = await eraseProspect(db, { organisationId: 7, assistantRecordId: 55 });
        assert.strictEqual(res.domainExcluded, 'acme.co.uk');
    });

    await check('a domain already excluded is not added twice', async () => {
        const { db, setValues } = noAddress({ 'select:discovery_guardrails': [{ id: 1, excludedDomains: ['acme.co.uk'] }] });
        const res = await eraseProspect(db, { organisationId: 7, assistantRecordId: 55 });
        assert.strictEqual(res.campaignsBlocked, 0, 'a second erasure on the same company is not an error');
        assert.strictEqual(res.blockedBy, 'domain_exclusion', 'the block still stands — it was already there');
        assert.ok(!setValues.some((v) => Array.isArray(v.excludedDomains)),
            'and the array must not grow a duplicate entry');
    });

    await check('a failed exclusion ABORTS, exactly as a failed opt-out does', async () => {
        // Same rule as the address path: data gone with nothing blocking re-discovery is the one
        // outcome worse than doing nothing. With no address there is no opt-out to fall back on.
        const { db, calls } = fakeDb({
            rows: {
                'select:discovered_leads': [{ id: 4, domain: 'acme.co.uk', contactEmail: null }],
                'select:assistant_records': [{ data: {} }],
                'select:discovery_guardrails': [{ id: 1, excludedDomains: [] }],
            },
            throwOn: 'update:discovery_guardrails',
        });
        const res = await eraseProspect(db, { organisationId: 7, assistantRecordId: 55 });
        assert.deepStrictEqual(res.failures, ['domain_exclusion']);
        assert.strictEqual(res.blockedBy, 'none');
        assert.deepStrictEqual(res.redacted, {}, 'nothing may be removed once the block has failed');
        for (const c of calls) {
            assert.ok(c !== 'update:assistant_records' && c !== 'update:lead_threads',
                `nothing may be written after a failed block — saw ${c}`);
        }
    });

    await check('no address AND no website is allowed, and says so', async () => {
        // A name somebody typed into the Add-a-lead form. Nothing can email them and no search can
        // re-find them, so there is genuinely nothing to block — but that must be STATED, never
        // inferred from a silent success.
        const { db } = fakeDb({
            rows: {
                'select:discovered_leads': [],
                'select:assistant_records': [{ data: { companyName: 'Someone from a conference' } }],
            },
        });
        const res = await eraseProspect(db, { organisationId: 7, assistantRecordId: 55 });
        assert.strictEqual(res.blockedBy, 'none');
        assert.deepStrictEqual(res.failures, [], 'this is a legitimate erasure, not a failed one');
        assert.ok(res.redacted.assistant_records !== undefined, 'and it must actually run');
    });

    await check('an address hiding on the discovery row is found and used', async () => {
        // The record's `data` and its discovery row disagree more often than you would like. An
        // erasure that can reach lead_opt_outs is always the better one — it blocks the PERSON and
        // leaves the company a legitimate prospect — so it is worth the lookup.
        const { db, calls, setValues } = fakeDb({
            rows: {
                'select:discovered_leads': [{ id: 4, domain: 'acme.co.uk', contactEmail: 'Sam@Acme.co.uk' }],
                'select:assistant_records': [{ data: {} }],
                'select:lead_threads': [],
            },
        });
        const res = await eraseProspect(db, { organisationId: 7, assistantRecordId: 55 });
        assert.strictEqual(res.email, 'sam@acme.co.uk', 'normalised, and used as the key');
        assert.strictEqual(res.blockedBy, 'opt_out');
        assert.ok(calls.includes('insert:lead_opt_outs'));
        // ⚠️ And the company must NOT be blocked: they asked to erase a person, and the opt-out
        // covers that person. Excluding the domain would remove a legitimate prospect from the
        // pipeline for a request that never asked for it.
        assert.ok(!setValues.some((v) => Array.isArray(v.excludedDomains)),
            'an address-grain block is the whole reason not to take a company-grain one');
    });

    await check('naming neither a lead nor an address does nothing', async () => {
        const { db, calls } = fakeDb();
        const res = await eraseProspect(db, { organisationId: 7 });
        assert.deepStrictEqual(res.failures, ['no_target']);
        assert.strictEqual(calls.length, 0);
    });

    console.log('\n──── 9. two ways the erasure could quietly undo itself ────');

    await check('an erased lead is stamped ineligible for the enrichment sweep', async () => {
        // ⚠️ The nightly batch selects `contact_email IS NULL AND signals->>enrichAttemptedAt IS
        // NULL` — which is precisely what an erased lead now looks like. Without the stamp the very
        // pass that found them walks back to their website and scrapes the address again.
        const { db, calls } = noAddress();
        await eraseProspect(db, { organisationId: 7, assistantRecordId: 55 });
        assert.ok(calls.includes('update:discovered_leads'), 'the discovered_leads redaction must still run');
        // The stamp itself is SQL text, so it is read from the source rather than from the builder
        // object the fake collected — that is the only place the operator order is actually legible.
        const dl = ERASURE.slice(landmark(ERASURE, "step('discovered_leads'"), landmark(ERASURE, "step('assistant_records'"));
        assert.match(dl, /jsonb_build_object\('enrichAttemptedAt'/,
            'the stamp is what makes an erased lead permanently ineligible for re-scraping');
        assert.ok(!/- 'enrichAttemptedAt'/.test(dl),
            'and it must be STAMPED, not stripped — stripping it re-opens the lead to the nightly pass');
    });

    await check("scope 'full' blocks the domain BEFORE nulling it", () => {
        // discovered_leads dedupes on (campaign, domain). Nulling the domain drops the row out of
        // that partial unique index, so the next run inserts the same company as a brand-new lead —
        // the erasure making them re-discoverable. The exclusion written first is what covers it.
        const full = ERASURE.slice(landmark(ERASURE, 'if (recordDomain && (!email'), landmark(ERASURE, "patch.companyName = ERASED_TEXT"));
        assert.match(full, /excludeDomainOrgWide/, 'the exclusion must be taken on a full erasure too');
        assert.ok(landmark(ERASURE, 'excludeDomainOrgWide(db, orgId, recordDomain)')
            < landmark(ERASURE, 'patch.domain = null'),
            'the block must be in place before the dedupe key is destroyed');
    });

    console.log('\n──── 10. the two screens ask on a lead with no address too ────');

    await check('the API does not refuse a request that names only a lead', () => {
        const act = eraseAction();
        assert.match(act, /!email && !Number\.isInteger\(recordId\)/,
            'no address must stop being a 400 — it is the common case, not the broken one');
        assert.match(act, /assistantRecordId: Number\.isInteger\(recordId\)/,
            'and the record has to reach the module as a key, not just as an audit label');
    });

    await check('both screens say which block they are about to take', () => {
        // Excluding a domain removes the whole COMPANY from every search — a bigger consequence than
        // the request asked for. A tenant who is not told finds out when a company stops appearing.
        for (const [name, src, anchor, end] of [
            ['Conversations', THREADS_UI, 'async function eraseProspectData', 'function wireControls'],
            ['Leads', HUB_UI, 'async function eraseLeadProspect', 'function failureBanner'],
        ] as [string, string, string, string][]) {
            const fn = src.slice(landmark(src, anchor), landmark(src, end));
            assert.match(fn, /excluded from every one of your searches/,
                `${name}: the confirmation must state the company-grain block before it is taken`);
            assert.match(fn, /email \? 'Erase and keep them blocked\?' : 'Erase and block this company\?'/,
                `${name}: and the title must not promise a do-not-contact block that cannot be made`);
        }
    });

    await check('an already-erased conversation is told so by the server, not guessed', () => {
        // An erased thread has no address BECAUSE it was erased. Inferring "no address, nothing to
        // erase" would offer the whole thing again on the one lead where the work is finished.
        assert.match(read('netlify/functions/lead-threads.ts'), /erasedAt: erasedAtOf\(thread\.recordData\)/,
            'the thread payload must carry the erasure stamp');
        const bar = THREADS_UI.slice(landmark(THREADS_UI, 'function erasureBar'), landmark(THREADS_UI, '// ── Controls ─'));
        assert.ok(landmark(bar, 'if (erasedAt)') < landmark(bar, 'if (!target)'),
            'the already-erased branch must be answered before the nothing-to-key-on branch');
    });

    await check('a thread that outlived its lead is the only "nothing to erase"', () => {
        // The FK is ON DELETE SET NULL, so a thread survives the lead it belonged to. No address and
        // no record is the one case where there is genuinely nothing to key an erasure on.
        const bar = THREADS_UI.slice(landmark(THREADS_UI, 'function erasureBar'), landmark(THREADS_UI, '// ── Controls ─'));
        assert.match(bar, /const target = email \|\| t\.assistantRecordId/,
            'the control must be offered whenever EITHER key exists');
        assert.match(bar, /No address and no lead record/,
            'and the empty state has to name both, or it reads as a bug on a lead that has research on it');
    });

    console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
