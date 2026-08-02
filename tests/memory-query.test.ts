// tests/memory-query.test.ts
// Phase 3 §5.5 — the conversational query surface over the account graph.
//
// This is the first feature in the revenue engine where THIRD-PARTY TEXT REACHES A MODEL PROMPT.
// account_memory holds emails written by prospects, arriving through a public webhook, and this
// function retrieves them straight into a system/user prompt. Four properties follow from that,
// and each is asserted below:
//
//   1. NO CONTEXT, NO MODEL CALL. An LLM asked "what do we know about Acme?" with nothing
//      retrieved will invent a plausible answer. A confident fabrication about a real customer is
//      worse than "nothing on file", so the empty path returns before the API call.
//   2. RETRIEVED TEXT IS FRAMED AS DATA, and the handler has NO WRITES. The framing is the weak
//      mitigation; "there is nothing this endpoint can do" is the strong one.
//   3. CITATIONS ARE STRUCTURED, and a marker pointing at a source that does not exist must not
//      render as a working control.
//   4. EVERYTHING IS ESCAPED, and no model output or prospect text is ever interpolated into an
//      inline handler.
//
// No database and no network: the assertions are over the handler and component source, the same
// technique the other Phase 2/3 suites use.
// Run:  npx tsx tests/memory-query.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fnText = readFileSync(join(root, 'netlify/functions/memory-query.ts'), 'utf8');
const uiText = readFileSync(join(root, 'src/components/assistant-memory-query.js'), 'utf8');
const detailText = readFileSync(join(root, 'assistant-detail.html'), 'utf8');
const workspaceText = readFileSync(join(root, 'workspace.html'), 'utf8');
const assistantsText = readFileSync(join(root, 'assistants.js'), 'utf8');
const registryText = readFileSync(join(root, 'src/components/assistant-dashboard-registry.js'), 'utf8');
const cssText = readFileSync(join(root, 'style.css'), 'utf8');

// ── 1. Anti-fabrication ──────────────────────────────────────────────────────

check('no retrieval hits means the model is never called', () => {
    const emptyAt = fnText.indexOf('if (!hits.length)');
    const modelAt = fnText.indexOf('anthropic.messages.create');
    assert.ok(emptyAt > 0, 'the empty-retrieval gate is missing');
    assert.ok(modelAt > emptyAt, 'the gate must come before the model call');
    // And it must actually return, not just log.
    const block = fnText.slice(emptyAt, emptyAt + 600);
    assert.ok(block.includes('return json(200'), 'the empty path must return, not fall through');
    assert.ok(block.includes('empty: true'), 'the client needs to distinguish "no memory" from "no answer"');
});

check('the grounding rules forbid answering beyond the supplied sources', () => {
    const sys = fnText.slice(fnText.indexOf('const system ='), fnText.indexOf('const user ='));
    assert.ok(/ONLY the records supplied/i.test(sys), 'the prompt must restrict the model to the sources');
    assert.ok(/Never fill a gap|never fill a gap/i.test(sys), 'the prompt must forbid plausible guessing');
    assert.ok(/Cite every factual claim/i.test(sys), 'citations must be mandatory, not encouraged');
});

// ── 2. Prompt injection ──────────────────────────────────────────────────────

check('retrieved prospect text is fenced and labelled as data', () => {
    const user = fnText.slice(fnText.indexOf('const user ='));
    assert.ok(user.includes('<<<SOURCES'), 'the sources block must be delimited');
    assert.ok(/untrusted quoted material/i.test(user), 'the block must be labelled untrusted');
    const sys = fnText.slice(fnText.indexOf('const system ='), fnText.indexOf('const user ='));
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
    const guard = fnText.slice(fnText.indexOf("if (action !== 'ask')"), fnText.indexOf("if (action !== 'ask')") + 120);
    assert.ok(guard.includes('return json(400'), 'an unknown action must 400, not fall through');
});

// ── 3. Tenancy ───────────────────────────────────────────────────────────────

check('the assistant is ownership-checked before anything is read', () => {
    const tenantAt = fnText.indexOf('requireTenant(event, db)');
    const idorAt = fnText.indexOf('eq(aiAssistants.organisationId, orgId)');
    const searchAt = fnText.indexOf('searchMemory(db, orgId');
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
    const iface = fnText.slice(fnText.indexOf('export interface Citation'), fnText.indexOf('export default withLambda'));
    for (const field of ['memoryId', 'sourceType', 'sourceId', 'occurredAt']) {
        assert.ok(iface.includes(field), `a citation without ${field} cannot be traced back to its record`);
    }
});

check('a citation marker beyond the source count stays inert text', () => {
    // The model can emit [7] with six sources. That must not render as a control that scrolls
    // nowhere — a broken affordance reads as a broken product.
    const fn = uiText.slice(uiText.indexOf('function withCitationChips'));
    assert.ok(fn.includes('num > maxN'), 'out-of-range citation numbers must be detected');
    assert.ok(/return whole/.test(fn), 'an out-of-range marker must be returned unchanged as plain text');
});

check('the citation regex can only ever capture digits', () => {
    const fn = uiText.slice(uiText.indexOf('function withCitationChips'));
    const m = fn.match(/replace\((\/[^/]+\/g)/);
    assert.ok(m, 'could not locate the citation regex');
    assert.equal(m![1], '/\\[(\\d{1,2})\\]/g', 'the pattern must match digits only — it writes into an attribute');
});

// ── 5. XSS / untrusted rendering ─────────────────────────────────────────────

check('escaping happens BEFORE citation chips are injected', () => {
    // withCitationChips writes raw HTML. Running it before esc() would let an answer containing
    // markup inject it; running it after means the only HTML added is our own.
    assert.ok(
        uiText.includes('withCitationChips(esc(r.answer || \'\'), cites.length)'),
        'the answer must be escaped first, then chipped',
    );
});

check('no model output or prospect text reaches an inline handler', () => {
    // The trap this avoids: a snippet containing a quote character breaking out of an onclick.
    assert.ok(!/onclick="[^"]*\$\{/.test(uiText), 'a template value is being interpolated into an onclick');
    assert.ok(uiText.includes('data-cite='), 'citation chips must use a data attribute');
    assert.ok(uiText.includes('data-expand='), 'expand buttons must use a data attribute');
    assert.ok(
        uiText.includes("el.addEventListener('click'"),
        'actions must be bound by a delegated listener, not inline handlers',
    );
});

check('every server-supplied field is escaped on render', () => {
    for (const field of ['c.snippet', 'c.accountLabel', 'n.label', 'r.reason', 'a.label']) {
        const re = new RegExp(`esc\\(${field.replace('.', '\\.')}`);
        assert.ok(re.test(uiText), `${field} is rendered without esc()`);
    }
    // The one numeric field written into an attribute must be coerced, not escaped.
    assert.ok(uiText.includes('value="${Number(a.id)}"'), 'the account id must be coerced to a number');
});

// ── 6. Placement and wiring ──────────────────────────────────────────────────

check('the panel sits ALONGSIDE the Data Hub table, not instead of it', () => {
    // §5.5 is explicit: users keep the table they know.
    const hostAt = detailText.indexOf('id="memory-query-host"');
    const tableAt = detailText.indexOf('id="datahub-table-host"');
    const hubAt = detailText.indexOf('id="maintab-datahub"');
    const hubEndAt = detailText.indexOf('/maintab-datahub');
    assert.ok(hostAt > 0, 'the host div is missing');
    assert.ok(hostAt > hubAt && hostAt < hubEndAt, 'the panel must live inside the Data Hub tab');
    assert.ok(tableAt > hostAt, 'the records table must still be present, below the panel');
});

check('the panel self-hides with both the class and the inline style', () => {
    // `hidden` loses to any class that sets display, so the style must be pinned too.
    const fn = uiText.slice(uiText.indexOf('function render()'));
    assert.ok(fn.includes("classList.add('hidden')"), 'the hidden class is not applied');
    assert.ok(fn.includes("style.display = 'none'"), 'display must be pinned — `hidden` loses to inline-flex');
    assert.ok(detailText.includes('id="memory-query-host" class="hidden"'), 'the host must start hidden');
});

check('the script is loaded and the registry enables it for lead roles', () => {
    assert.ok(
        workspaceText.includes('/src/components/assistant-memory-query.js'),
        'the component script tag is missing from workspace.html',
    );
    const leadBlock = registryText.slice(registryText.indexOf('lead_qualifier:'), registryText.indexOf('accounts_receivable_clerk:'));
    assert.ok(leadBlock.includes('memoryPanel'), 'lead_qualifier must enable the memory panel');
});

check('the panel activates on an ordinary load, not only after a tab switch', () => {
    // _activateDefaultMainTab early-returns when Data Hub is already the active markup default,
    // so relying on _activateMainTab('datahub') alone means the panel never appears until the
    // user visits another tab and comes back.
    assert.ok(
        assistantsText.includes("if (name === 'datahub') window.AssistantMemoryQuery?.activate()"),
        'the tab-switch activation is missing',
    );
    const initAt = assistantsText.indexOf('window.AssistantMemoryQuery?.init(');
    assert.ok(initAt > 0, 'the panel is never initialised');
    const block = assistantsText.slice(initAt, initAt + 700);
    assert.ok(
        block.includes("getElementById('maintab-datahub')") && block.includes('activate()'),
        'the initial-load activation path is missing',
    );
});

check('init does not fetch — the context query is lazy', () => {
    // Otherwise every workspace load queries account_memory for roles that never open Data Hub.
    const api = uiText.slice(uiText.indexOf('window.AssistantMemoryQuery = {'));
    const initBlock = api.slice(api.indexOf('init('), api.indexOf('activate()'));
    assert.ok(!initBlock.includes('loadContext()'), 'init() must not fetch; activate() does');
    assert.ok(api.includes('loadContext()'), 'activate() must load the context');
});

// ── 7. Honesty about degraded retrieval ──────────────────────────────────────

check('unembedded rows are surfaced rather than silently degrading', () => {
    // Without VOYAGE_API_KEY rows store unembedded and retrieval falls back to keyword matching.
    // A system that works but answers worse should say so.
    assert.ok(fnText.includes('unembedded'), 'the context action must report unembedded coverage');
    assert.ok(uiText.includes('state.counts.unembedded'), 'the panel must surface it');
    assert.ok(/not indexed for meaning/i.test(uiText), 'the warning must be in plain language');
});

// ── 8. Styling must not force a Tailwind rebuild ─────────────────────────────

check('every utility class used is already compiled into style.css', () => {
    // A rebuild churns unrelated selectors across the whole app. Tailwind escapes ':' '[' ']' '.'
    // in compiled selectors, so the lookup has to use the escaped form.
    const classAttrs = [...uiText.matchAll(/class="([^"]*)"/g)].map((m) => m[1]);
    const tokens = new Set<string>();
    for (const attr of classAttrs) {
        for (const raw of attr.split(/\s+/)) {
            // Skip template interpolations and empties — those are conditional strings, not tokens.
            if (!raw || raw.includes('${')) continue;
            tokens.add(raw);
        }
    }
    assert.ok(tokens.size > 20, `expected a real class list, parsed ${tokens.size}`);

    const escapeSel = (t: string) => t.replace(/([:[\].])/g, '\\$1');
    const missing = [...tokens].filter((t) => !cssText.includes(escapeSel(t)));
    assert.deepEqual(missing, [], `not compiled into style.css: ${missing.join(', ')}`);
});

console.log(`\n${passed} checks passed`);
