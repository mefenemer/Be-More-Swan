// tests/lead-prompt-surfaces.test.ts
// The Lead Generator's chat prompt must know what the Lead Generator's dashboard contains.
//
// WHY THIS EXISTS. A user asked the assistant to "create a search for me in the Signal Inbox" and
// it refused, calling Signal Inbox an "external tool" and listing it alongside Apollo and Hunter.
// Nothing was broken: ROUTES.lead_qualifier was written when the role only scored INBOUND leads,
// outbound discovery shipped later, and no one updated the prompt. The assistant had never been
// told its own product exists, so it confabulated a third party and sent the user elsewhere.
//
// That failure is invisible to types, to the compiler, and to every other test in this directory —
// a prompt is just a string, and a string that describes last quarter's product still compiles.
// The only thing that can catch it is a scan asserting the prompt and the registry still agree.
//
// Three drift directions are guarded:
//   1. A new surface appears in the registry and the prompt never learns about it (the original bug).
//   2. The discovery campaign form gains or renames a field, so the prompt describes a form the user
//      cannot find — the same class of lie as naming a tool that doesn't exist.
//   3. "Find New Leads" moves again. It has already moved once, out of the Overview action bar and
//      into the Signal Inbox toolbar, and the prompt sends users to a specific place to click it.
//
// No database: source-consistency checks only, matching every other file in tests/ except
// rls-enforcement.
// Run:  npx tsx tests/lead-prompt-surfaces.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
function check(name: string, fn: () => void): void {
    try {
        fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

/**
 * Blank out comments, preserving length and newlines so line numbers stay exact.
 *
 * Load-bearing here, not hygiene: the helper's own header comment names Apollo, Hunter and the
 * Signal Inbox while EXPLAINING the bug. A scan that counts comment text would find every phrase
 * it is looking for in the explanation of why the phrases are needed, and pass a prompt that says
 * none of it. icp-snapshot.test.ts learned the same lesson.
 */
function stripComments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}

/** The source span between `start` and `end`, or a failure naming what moved. */
function span(text: string, start: string, end: string, what: string): string {
    const a = text.indexOf(start);
    assert.notStrictEqual(a, -1, `Could not find ${what} — the anchor ${JSON.stringify(start)} is gone. Update this test's anchors.`);
    const b = text.indexOf(end, a);
    assert.notStrictEqual(b, -1, `Could not find the end of ${what} — the anchor ${JSON.stringify(end)} is gone. Update this test's anchors.`);
    return text.slice(a, b);
}

// ── The text the model actually receives ─────────────────────────────────────
// The shared surfaces helper plus the lead_qualifier role prompt that calls it. Scoped to those two
// spans on purpose: a mention of "Signal Inbox" in some OTHER role's prompt must not satisfy a
// requirement about THIS one.

const orchestrator = stripComments(read('netlify/functions/chat-orchestrator.ts'));
const surfacesBlock = span(orchestrator, 'function leadGeneratorSurfaces', '\n}', 'the leadGeneratorSurfaces() helper');
const leadRoute = span(orchestrator, 'lead_qualifier: {', 'parseResponse: parseStructuredReply', 'the lead_qualifier route');
const PROMPT = `${surfacesBlock}\n${leadRoute}`;

// ── The registry, evaluated rather than regex-scraped ────────────────────────
// A plain browser IIFE with no imports and no DOM access at load, so it runs under a fake `window`
// and yields the real config object. Scraping it with regexes would drift from what ships.

interface SurfaceCfg { label?: unknown }
const fakeWindow: { AssistantDashboardRegistry?: { REGISTRY: Record<string, Record<string, SurfaceCfg>> } } = {};
new Function('window', read('src/components/assistant-dashboard-registry.js'))(fakeWindow);
const leadCfg = fakeWindow.AssistantDashboardRegistry?.REGISTRY?.lead_qualifier;

/**
 * Surfaces the prompt is allowed NOT to mention, each with the reason it would be WRONG to promise.
 * This is the pressure valve that keeps the generic scan honest: a new surface fails the test until
 * someone either documents it in the prompt or lands here with a justification.
 */
const EXEMPT: Record<string, string> = {
    // Gated on the `strategy_agent` plan feature, DEFAULT OFF, and the component hides its own
    // button until the server confirms it. Most tenants have no Strategy tab, so an assistant that
    // described one would be sending them to a tab that isn't on their screen.
    strategyTab: 'feature-gated (strategy_agent, default off) — not present for most tenants',
    // `memoryPanel` was exempted here as "self-hides until the org has account memory". The panel
    // is now deleted outright (see tests/memory-query.test.ts §5) rather than conditionally
    // hidden, so there is no surface left to exempt. Removed rather than kept "just in case": the
    // stale-exemption check below exists precisely to stop a dead entry silently excusing some
    // future surface that reuses the key.
    // `primaryAction` was exempted here as "the button that opens this chat" — it was labelled
    // "Score New Leads" but only redirected to this page. The role no longer declares one at all
    // (scoring is automatic: discovery runs and CSV imports score on arrival, and the one manual
    // path is the Leads tab's own "Add Lead"), so there is nothing left to exempt. Removed rather
    // than kept "just in case": the stale-exemption check below exists precisely to stop a dead
    // entry silently excusing some future surface that reuses the key.
};

console.log('\n──── the prompt knows its own dashboard ────');

check('every user-facing surface the registry declares is named in the prompt', () => {
    assert.ok(leadCfg, 'lead_qualifier is missing from the dashboard registry entirely.');
    const missing: string[] = [];
    for (const [key, cfg] of Object.entries(leadCfg)) {
        if (!cfg || typeof cfg !== 'object' || typeof cfg.label !== 'string') continue;
        if (key in EXEMPT) continue;
        // The prompt quotes every surface it names, which also stops the bare label "Leads" from
        // being satisfied by the "Find New Leads" / "Review Lead Ideas" that contain it.
        if (!PROMPT.includes(`"${cfg.label}"`)) missing.push(`${key} ("${cfg.label}")`);
    }
    assert.deepStrictEqual(missing, [],
        `The lead_qualifier chat prompt never mentions: ${missing.join(', ')}.\n`
        + '    An assistant that has not been told a surface exists will invent an explanation for it —\n'
        + '    the Signal Inbox was called "an external tool like Apollo" for exactly this reason.\n'
        + '    Add it to leadGeneratorSurfaces(), or add it to EXEMPT with the reason it must not be promised.');
});

check('no stale exemptions — every EXEMPT key still exists in the registry', () => {
    const gone = Object.keys(EXEMPT).filter((k) => !(leadCfg && k in leadCfg));
    assert.deepStrictEqual(gone, [],
        `EXEMPT names surfaces the registry no longer has: ${gone.join(', ')}. `
        + 'A stale exemption silently excuses a future surface that happens to reuse the key.');
});

check('the prompt forbids describing its own surfaces as third-party tools', () => {
    assert.match(PROMPT, /NOT third-party/,
        'The prompt must state outright that these are not third-party products.');
    assert.match(PROMPT, /never describe them as external tools/i,
        'The prompt must ban the exact failure: calling its own tabs external tools.');
    assert.match(PROMPT, /Apollo/,
        'The prompt should name the outside services it previously confused its own tabs with — '
        + 'the refusal listed LinkedIn, Apollo and Hunter by name.');
});

check('the prompt claims finding leads as its own job, not only scoring', () => {
    assert.match(PROMPT, /TWO jobs/,
        'The role opening must establish that this assistant both finds and scores leads.');
    assert.match(PROMPT, /never REFUSE it|NEVER refuse it/i,
        'The prompt must explicitly forbid refusing a request to find leads — that was the bug.');
    assert.match(PROMPT, /Never offer CSV import as the answer to "find me some leads"/,
        'The spreadsheet fallback must not be allowed to answer "find me leads" — it is the '
        + 'paragraph that produced "paste the results here or upload them as CSV".');
});

console.log('\n──── the prompt describes a form that exists ────');

// Every input control in the campaign form, mapped to the phrasing the prompt must use for it. The
// map is deliberately manual: adding a field to the form should FAIL here until someone decides how
// the assistant will describe it, rather than silently teaching users an incomplete form.
const FIELD_CLAIMS: Record<string, RegExp> = {
    idea: /plain-English description of who to find/,
    name: /optional short name for the search/,
    cadence: /how often to run \(once now \/ daily \/ weekly\)/,
    maxleads: /max leads per run/,
    // The two limits that actually end a run. Added to the form once measurement showed the token
    // budget bound at ~63 searches — before the search cap and long before the cost cap — while
    // being invisible everywhere the user could look.
    maxsearches: /max searches per run/,
    maxtokens: /a token budget per run/,
    negatives: /terms to exclude/,
    approval: /"review found leads before any outreach" checkbox/,
};

// Attributes inside form() that are not inputs: the submit button, the inline error span, and the
// "Ask your assistant in chat" link.
//
// ⚠️ `ask` is deliberately NOT in FIELD_CLAIMS. It is a route BACK to chat, and describing it in
// leadGeneratorSurfaces() would have the assistant telling a user who is already talking to it
// where to find a link to talk to it. The fields below are things the user fills in; this is not
// one. (It exists because a customer used a different AI product to fill in the idea box — see the
// comment on the element itself.)
const NON_FIELD = new Set(['create', 'error', 'ask']);

check('the prompt describes every field of the discovery campaign form, and no others', () => {
    const component = read('src/components/assistant-discovery-campaigns.js');
    // Scoped to form() — campaignCard() carries its own data-dc-* attributes (run, view, edit,
    // archive, and the -val mirrors) which are not fields the user fills in.
    const formBody = span(component, 'function form()', '\n  function campaignCard', 'the campaign form');
    const fields = [...new Set([...formBody.matchAll(/data-dc-([a-z]+)\b/g)].map((m) => m[1]))]
        .filter((f) => !NON_FIELD.has(f));

    const undocumented = fields.filter((f) => !(f in FIELD_CLAIMS));
    assert.deepStrictEqual(undocumented, [],
        `The campaign form has field(s) the prompt never mentions: ${undocumented.join(', ')}.\n`
        + '    Describe them in leadGeneratorSurfaces() and add them to FIELD_CLAIMS.');

    const removed = Object.keys(FIELD_CLAIMS).filter((f) => !fields.includes(f));
    assert.deepStrictEqual(removed, [],
        `The prompt describes form field(s) that no longer exist: ${removed.join(', ')}.\n`
        + '    Telling a user to fill in a field that is not on screen is the same bug as naming a tool that is not there.');

    const wrong = fields.filter((f) => !FIELD_CLAIMS[f].test(PROMPT));
    assert.deepStrictEqual(wrong, [],
        `The prompt does not describe form field(s): ${wrong.join(', ')} (see FIELD_CLAIMS).`);
});

check('the prompt does not invent a target-persona field the form lacks', () => {
    const component = read('src/components/assistant-discovery-campaigns.js');
    const formBody = span(component, 'function form()', '\n  function campaignCard', 'the campaign form');
    // discovery-campaigns.ts `create` accepts targetPersona, but the UI has no input for it, so the
    // ICP has to be written INTO the idea text. If the form ever grows one, the prompt should stop
    // telling the assistant to fold the profile into a single description.
    if (/targetPersona|data-dc-persona/.test(formBody)) {
        assert.fail('The campaign form now has a persona field — update leadGeneratorSurfaces(), '
            + 'which currently instructs the assistant to fold the ICP into the "who to find" text.');
    }
    assert.match(PROMPT, /the form has no separate profile fields/,
        'The prompt must tell the assistant to fold the ICP into the one description field.');
});

console.log('\n──── the prompt points at where the button actually is ────');

check('"Find New Leads" lives in that tab\'s toolbar, where the prompt sends users', () => {
    const inbox = read('src/components/assistant-signal-inbox.js');
    assert.match(inbox, /Find New Leads/,
        'The prompt tells users the button is in that tab\'s toolbar, but assistant-signal-inbox.js '
        + 'no longer renders it. It has moved once already (out of the Overview action bar); if it has '
        + 'moved again, update leadGeneratorSurfaces() to name the new location.');

    // Derived from the registry, never hardcoded. The tab has already been renamed once
    // ("Signal Inbox" → "Searches") and a literal here would have gone stale silently — pinning
    // the OLD name while the prompt correctly used the new one, which is the test lying rather
    // than the code. The label is the single source of truth for what the user sees on the tab.
    const tabLabel = leadCfg?.signalInbox?.label;
    assert.strictEqual(typeof tabLabel, 'string', 'The registry no longer gives the inbox tab a label.');
    assert.ok(PROMPT.includes(`button in the ${tabLabel} toolbar`),
        `The prompt must say WHERE the button is, naming the tab as the user sees it ("${tabLabel}"). `
        + 'The Overview location is a dead end.');
});

console.log('\n──── the campaign proposal card ────');

// The chat can now CREATE a campaign (discovery_campaign_proposal → chat-session.js →
// discovery-campaigns.ts). Everything below defends the one property that makes that safe: an
// approved proposal saves a DRAFT and spends nothing. A search costs real money per run and
// reaches real strangers, so "the model proposed it and the user clicked once" must never be
// enough to start it.

check('the emitted type has a renderer registered under the same name', () => {
    const registry = read('src/components/disruptive-ui-registry.js');
    assert.match(PROMPT, /"type": "discovery_campaign_proposal"/,
        'The prompt must document the wire shape it is told to emit.');
    assert.match(registry, /register\('discovery_campaign_proposal'/,
        'Nothing renders discovery_campaign_proposal — an unknown type degrades to text silently, '
        + 'so the assistant would promise a card the user never sees.');
});

check('approving the proposal creates a DRAFT, never a running campaign', () => {
    const chat = read('src/components/chat-session.js');
    assert.match(chat, /asDraft:\s*true/,
        'chat-session.js must send asDraft — without it the create path starts (and bills) a run '
        + 'on the strength of one click in a chat window.');

    const api = read('netlify/functions/discovery-campaigns.ts');
    assert.match(api, /status:\s*asDraft\s*\?\s*'draft'\s*:\s*'active'/,
        'discovery-campaigns.ts must map asDraft onto the draft status.');

    const helper = read('src/utils/discovery.ts');
    assert.match(helper, /if\s*\(isDraft\)\s*return/,
        'createDiscoveryRun must return before enqueueing a job for a draft — a draft that '
        + 'enqueues is just an active campaign with a misleading label.');
});

check('nothing dispatches a draft', () => {
    const dispatcher = read('netlify/functions/dispatch-discovery-runs.ts');
    assert.match(dispatcher, /eq\(discoveryCampaigns\.status,\s*'active'\)/,
        'The dispatcher must fire only active campaigns. If this filter widens, every chat-proposed '
        + 'draft starts spending on the next cron tick without anyone approving the run.');
});

check('starting a draft activates it, so a recurring cadence is not a dead campaign', () => {
    const api = read('netlify/functions/discovery-campaigns.ts');
    const runNow = span(stripComments(api), "action === 'run_now'", "action === 'list_leads'", 'the run_now action');
    assert.match(runNow, /status === 'draft'/,
        'run_now must promote a draft to active. Without it a chat-proposed DAILY search runs once '
        + 'and never again — status stays draft, the dispatcher skips it, and the recurrence the '
        + 'user agreed to silently never happens.');
    assert.ok(!/status === 'paused'/.test(runNow),
        'run_now must NOT resurrect a paused campaign — that would undo a human decision.');
});

check('approving the same proposal twice does not buy two campaigns', () => {
    const api = read('netlify/functions/discovery-campaigns.ts');
    assert.match(api, /deduped:\s*true/,
        'The draft create path needs the idea-level dedupe: chat transcripts re-hydrate from '
        + 'chatMessages.uiElementJson on reload, so an old proposal card comes back with live buttons.');
});

check('the card names the tab as the registry labels it', () => {
    const registry = read('src/components/disruptive-ui-registry.js');
    const card = span(registry, 'function renderDiscoveryCampaignProposalCard', '\n  register(', 'the proposal card');
    const tabLabel = leadCfg?.signalInbox?.label;
    // The card tells the user where to go and start the search they just approved. It is the last
    // instruction in the flow, and it is plain copy with nothing to keep it honest but this check.
    assert.ok(card.includes(`${tabLabel} tab`),
        `The proposal card must send users to the "${tabLabel}" tab, matching the registry label. `
        + 'The tab has been renamed once already; copy that still names the old one strands the user '
        + 'at the final step, holding an approved search they cannot find.');
});

console.log('\n──── the prompt can COUNT the tab it describes ────');

// The prompt has always been able to describe the Leads tab and never able to read it. Asked "how
// many hot leads do I have", the product answered "I don't have information about 'hot leads' in a
// structured leads database" — true of the surface that answered (the account-graph memory panel,
// now removed) and useless to someone staring at the tab. buildLeadsSnapshot() closes it, and
// everything below defends the two properties that make the fix worth having: the numbers are the
// CALLER'S, and a missing snapshot produces an admission rather than a guess.

// Bounded by the next declaration, not by the comment above it — `orchestrator` has been
// comment-stripped, so a comment anchor is an anchor that is not there.
const snapshotFn = span(orchestrator, 'async function buildLeadsSnapshot', 'function campaignSurfaces', 'buildLeadsSnapshot()');

check('the snapshot is scoped to the caller\'s organisation AND assistant', () => {
    // Both, on both queries. The complaint that produced this feature was an answer naming an
    // entity the user did not recognise, so a widened scope here is the exact regression.
    const aggregate = span(snapshotFn, 'db.execute<LeadCounts>', 'const c =', 'the count aggregate');
    assert.match(aggregate, /organisation_id = \$\{organisationId\}/,
        'the aggregate is not organisation-scoped — it would count every tenant\'s leads');
    assert.match(aggregate, /ai_assistant_id = \$\{aiAssistantId\}/,
        'the aggregate is not assistant-scoped — one org\'s two lead assistants would report each other\'s rows');
    assert.match(aggregate, /record_type = 'lead'/,
        'the aggregate counts every record type, so meetings and invoices would be reported as leads');

    const names = span(snapshotFn, 'const names = await db', '.limit(', 'the sample list query');
    for (const scope of ['assistantRecords.organisationId, organisationId', 'assistantRecords.aiAssistantId, aiAssistantId']) {
        assert.ok(names.includes(scope), `the name list is missing its scope: ${scope}`);
    }
});

check('the block tells the model these are the ONLY leads it knows about', () => {
    assert.match(snapshotFn, /ONLY leads you know anything about/,
        'without this the model treats the counts as one source among several and blends them with '
        + 'whatever else is in context — which is how another entity got named in the first place');
    assert.match(snapshotFn, /do not describe, name or count any other organisation/i,
        'the cross-tenant prohibition must be stated outright, not implied by the scoping');
    assert.match(snapshotFn, /never say you cannot see their leads, and never estimate/,
        'the model must be told the counts are authoritative — otherwise it hedges over real numbers');
});

check('the name list is capped, and says so', () => {
    assert.match(snapshotFn, /LEAD_SNAPSHOT_NAMES/, 'the sample is unbounded — a big tab would blow the prompt');
    assert.match(snapshotFn, /this list does not/,
        'a truncated list presented as complete is worse than no list: "these are all your leads" '
        + 'about 20 of 4,000 is a confident lie');
});

check('a failed snapshot degrades to an admission, never to a guess', () => {
    assert.match(snapshotFn, /catch \(err\)/, 'the snapshot must not be able to fail the turn');
    assert.match(snapshotFn, /return null/, 'a failure must return null rather than throwing');
    // And the prompt has to do something honest with that null.
    assert.match(leadRoute, /rc\.leadsSnapshot/, 'the role prompt never reads the snapshot');
    assert.match(leadRoute, /Do NOT estimate/,
        'the no-snapshot fallback must forbid estimating — "roughly a dozen" about someone\'s real '
        + 'pipeline is the failure this whole block exists to prevent');
});

check('the snapshot is rebuilt every turn, and only for the role that owns the records', () => {
    assert.match(leadRoute, /usesLeadSnapshot: true/, 'the lead route no longer opts in');
    const handler = span(orchestrator, 'const leadsSnapshot = route.usesLeadSnapshot', 'const rolePrompt', 'the snapshot call site');
    assert.match(handler, /buildLeadsSnapshot\(db, orgId, session\.aiAssistantId\)/,
        'the call site must pass the SESSION\'s assistant and the resolved tenant — anything else '
        + 'is a scope decided by the request body');
    // Not cached on the session: approving leads in another tab and then asking "how many are
    // left?" must reflect the approvals.
    assert.ok(!/leadsSnapshot\s*=\s*session\./.test(orchestrator),
        'the snapshot must not be read off the session — it would go stale the moment the user acts');
});

console.log(`\n${passed} checks passed.`);
