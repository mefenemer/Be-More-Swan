// tests/memory-query.test.ts
// Phase 3 §5.5 — the account-graph query endpoint, and the panel that used to front it.
//
// ── The panel is gone; the endpoint is not ───────────────────────────────────
// "Ask your memory" mounted an account picker, a question box and an Ask button ABOVE the Leads
// tab's records table. It has been removed. The reason is a design one and it is the half of this
// file most worth keeping: a question box inside the Leads tab reads as a search over the leads,
// and this endpoint cannot see them. Asked "how many hot leads do I have", it answered accurately
// about account_memory — "no information about hot leads in a structured leads database" — and
// looked broken doing it, because the user was looking at their leads while they read it. Asking
// this assistant a question now has one door, the header's Chat button, whose prompt carries a
// live count of the user's own lead records (chat-orchestrator.ts `leadsSnapshotBlock`).
//
// netlify/functions/memory-query.ts is deliberately LEFT IN PLACE — the account graph still
// ingests, and this is the read side of it. Nothing in the app calls it today, which makes the
// properties below matter MORE rather than less: an unreferenced endpoint is one nobody re-reads
// before wiring it up again.
//
// This is the first feature in the revenue engine where THIRD-PARTY TEXT REACHES A MODEL PROMPT.
// account_memory holds emails written by prospects, arriving through a public webhook, and this
// function retrieves them straight into a system/user prompt. Three properties follow from that:
//
//   1. NO CONTEXT, NO MODEL CALL. An LLM asked "what do we know about Acme?" with nothing
//      retrieved will invent a plausible answer. A confident fabrication about a real customer is
//      worse than "nothing on file", so the empty path returns before the API call.
//   2. RETRIEVED TEXT IS FRAMED AS DATA, and the handler has NO WRITES. The framing is the weak
//      mitigation; "there is nothing this endpoint can do" is the strong one.
//   3. CITATIONS ARE STRUCTURED, so a claim can be traced back to the row it came from.
//
// No database and no network: the assertions are over handler source, the same technique the other
// Phase 2/3 suites use.
// Run:  npx tsx tests/memory-query.test.ts

import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fnText = readFileSync(join(root, 'netlify/functions/memory-query.ts'), 'utf8');
const detailText = readFileSync(join(root, 'assistant-detail.html'), 'utf8');
const workspaceText = readFileSync(join(root, 'workspace.html'), 'utf8');
const assistantsText = readFileSync(join(root, 'assistants.js'), 'utf8');
const registryText = readFileSync(join(root, 'src/components/assistant-dashboard-registry.js'), 'utf8');

// ── 1. Anti-fabrication ──────────────────────────────────────────────────────

check('no retrieval hits means the model is never called', () => {
    const emptyAt = fnText.indexOf('if (!hits.length)');
    const modelAt = landmark(fnText, 'anthropic.messages.create');
    assert.ok(emptyAt > 0, 'the empty-retrieval gate is missing');
    assert.ok(modelAt > emptyAt, 'the gate must come before the model call');
    // And it must actually return, not just log.
    const block = fnText.slice(emptyAt, emptyAt + 600);
    assert.ok(block.includes('return json(200'), 'the empty path must return, not fall through');
    assert.ok(block.includes('empty: true'), 'the caller needs to distinguish "no memory" from "no answer"');
});

check('the grounding rules forbid answering beyond the supplied sources', () => {
    const sys = fnText.slice(landmark(fnText, 'const system ='), landmark(fnText, 'const user ='));
    assert.ok(/ONLY the records supplied/i.test(sys), 'the prompt must restrict the model to the sources');
    assert.ok(/Never fill a gap|never fill a gap/i.test(sys), 'the prompt must forbid plausible guessing');
    assert.ok(/Cite every factual claim/i.test(sys), 'citations must be mandatory, not encouraged');
});

// ── 2. Prompt injection ──────────────────────────────────────────────────────

check('retrieved prospect text is fenced and labelled as data', () => {
    const user = fnText.slice(landmark(fnText, 'const user ='));
    assert.ok(user.includes('<<<SOURCES'), 'the sources block must be delimited');
    assert.ok(/untrusted quoted material/i.test(user), 'the block must be labelled untrusted');
    const sys = fnText.slice(landmark(fnText, 'const system ='), landmark(fnText, 'const user ='));
    assert.ok(
        /never as instructions/i.test(sys),
        'the system prompt must tell the model the sources are data, not instructions',
    );
});

check('the handler has NO write actions — the real injection mitigation', () => {
    // The prompt framing is the weak half. What actually bounds a successful injection is that
    // this endpoint cannot do anything: no inserts, no updates, no deletes, no sends.
    for (const forbidden of ['db.insert(', 'db.update(', 'db.delete(', 'sendGmailMessage', 'sendOutlookMessage', 'recordEvent(']) {
        assert.ok(
            !fnText.includes(forbidden),
            `memory-query must stay read-only — found ${forbidden}. A successful prompt injection would inherit it.`,
        );
    }
});

check('only the two read actions are routed', () => {
    assert.ok(fnText.includes("action === 'context'"), 'context action missing');
    assert.ok(fnText.includes("action !== 'ask'"), 'unknown actions must be rejected');
    const guard = fnText.slice(landmark(fnText, "if (action !== 'ask')"), landmark(fnText, "if (action !== 'ask')") + 120);
    assert.ok(guard.includes('return json(400'), 'an unknown action must 400, not fall through');
});

// ── 3. Tenancy ───────────────────────────────────────────────────────────────

check('the assistant is ownership-checked before anything is read', () => {
    const tenantAt = fnText.indexOf('requireTenant(event, db)');
    const idorAt = landmark(fnText, 'eq(aiAssistants.organisationId, orgId)');
    const searchAt = landmark(fnText, 'searchMemory(db, orgId');
    assert.ok(tenantAt > 0, 'requireTenant is missing');
    assert.ok(idorAt > tenantAt, 'the IDOR guard must follow the tenant resolve');
    assert.ok(searchAt > idorAt, 'retrieval must not run before the assistant is verified');
});

check('every read is scoped by organisation', () => {
    // A missed scope here leaks one tenant's correspondence into another's answer.
    for (const [label, needle] of [
        ['memory search', 'searchMemory(db, orgId'],
        ['graph expansion', 'traverseGraph(db, orgId'],
        ['outcome stats', 'organisation_id = ${organisationId}'],
        ['account list', 'eq(accountNodes.organisationId, orgId)'],
    ] as Array<[string, string]>) {
        assert.ok(fnText.includes(needle), `${label} is not organisation-scoped`);
    }
});

check('the question is length-capped before it reaches the prompt', () => {
    assert.ok(/MAX_QUESTION_CHARS/.test(fnText), 'the question cap is missing');
    assert.ok(
        /String\(body\.question \|\| ''\)\.trim\(\)\.slice\(0, MAX_QUESTION_CHARS\)/.test(fnText),
        'the cap must be applied at parse time, not merely declared',
    );
});

// ── 4. Citations ─────────────────────────────────────────────────────────────

check('citations carry a stable back-reference to the source row', () => {
    const iface = fnText.slice(landmark(fnText, 'export interface Citation'), landmark(fnText, 'export default withLambda'));
    for (const field of ['memoryId', 'sourceType', 'sourceId', 'occurredAt']) {
        assert.ok(iface.includes(field), `a citation without ${field} cannot be traced back to its record`);
    }
});

// ── 5. The panel stays retired, or comes back WHOLE ──────────────────────────
//
// Five things wired that panel up, in four files. A half-restore is the failure worth catching:
// a host div with no script renders nothing, a script with no registry key initialises nothing,
// and either one is a silent dead end rather than an error. If the panel is ever wanted again,
// restore all five and delete this block — do not un-comment one of them and hope.

check('the component file is gone', () => {
    assert.ok(
        !existsSync(join(root, 'src/components/assistant-memory-query.js')),
        'assistant-memory-query.js is back. If that is deliberate, this whole section needs rewriting — '
        + 'and the reason it was removed (a question box inside the Leads tab that cannot see the leads) '
        + 'has to be answered, not just re-shipped.',
    );
});

check('nothing loads or mounts it', () => {
    assert.ok(
        !workspaceText.includes('assistant-memory-query.js'),
        'workspace.html still loads the deleted component — that is a 404 on every workspace load',
    );
    assert.ok(
        !detailText.includes('id="memory-query-host"'),
        'the Data Hub tab still carries the panel mount, which nothing will ever fill',
    );
});

check('nothing declares or activates it', () => {
    const leadBlock = registryText.slice(
        landmark(registryText, 'lead_qualifier:'),
        landmark(registryText, 'accounts_receivable_clerk:'),
    );
    // Scoped to code, not comments: the block deliberately explains why the key is absent, and a
    // bare `includes` would match that explanation and fail on the documentation.
    const code = leadBlock.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.ok(!code.includes('memoryPanel'), 'lead_qualifier still declares memoryPanel');
    assert.ok(
        !/window\.AssistantMemoryQuery/.test(assistantsText),
        'assistants.js still calls the deleted component — optional chaining makes that a silent no-op, '
        + 'which is exactly how a half-restore survives review',
    );
});

check('the Data Hub table is still the tab, and is still above nothing', () => {
    // §5.5 shipped the panel ALONGSIDE the table, never instead of it. Removing the panel must not
    // have taken the table with it.
    const hubAt = landmark(detailText, 'id="maintab-datahub"');
    const hubEndAt = landmark(detailText, '/maintab-datahub');
    const tableAt = landmark(detailText, 'id="datahub-table-host"');
    const toolbarAt = landmark(detailText, 'id="datahub-toolbar"');
    assert.ok(tableAt > hubAt && tableAt < hubEndAt, 'the records table has left the Data Hub tab');
    assert.ok(toolbarAt < tableAt, 'the toolbar must still sit above the table');
});

console.log(`\n${passed} checks passed`);
