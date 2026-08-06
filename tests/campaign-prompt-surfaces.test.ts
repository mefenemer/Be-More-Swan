// tests/campaign-prompt-surfaces.test.ts
// The Campaign Assistant's chat prompt must know its own dashboard, its own vocabulary, and the
// three things it is not allowed to do.
//
// WHY THIS EXISTS. Cloned from tests/lead-prompt-surfaces.test.ts, which exists because a user
// asked the Lead Generator to "create a search in the Signal Inbox" and it refused, calling the
// platform's own tab an external tool alongside Apollo and Hunter. Nothing was broken: the prompt
// was written before the tab was, and no one updated it. A prompt is just a string, and a string
// describing last quarter's product still compiles and still passes every other test here.
//
// This role carries that risk plus two of its own:
//
//   1. Its whole job is describing work done on OTHER assistants' surfaces, and the orders it can
//      issue are a CLOSED vocabulary (src/config/campaign-vocab.ts). A prompt that names an action
//      the executor does not have produces a proposal the user approves and nothing acts on. That
//      is not hypothetical — the first draft of this prompt said "write_pillar_article" where the
//      vocabulary says "draft_blog_pillar", and nothing but this file would have caught it.
//
//   2. It is the only assistant that can commit the org's monthly allowance across three other
//      assistants. So the invariant from chat-creates-draft-campaigns is tightened here and pinned
//      below: approving in chat SAVES A DRAFT, and no chat turn may start a campaign, raise a
//      ceiling, or resume a paused one.
//
// Also guarded: the campaign directive actually reaching BOTH generation seams. goals-steer-
// generation shipped seven functions, three crons and a progress bar that changed no drafted word,
// and the only reason anyone found out was a manual grep.
//
// No database: source-consistency checks only, matching every other file in tests/ except
// rls-enforcement.
// Run:  npx tsx tests/campaign-prompt-surfaces.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAMPAIGN_ORDER_ACTIONS, ORDER_ACTION_SPECS, UNAVAILABLE_OUTCOME_METRICS, CAMPAIGN_OUTCOME_METRICS } from '../src/config/campaign-vocab';
import { ORCHESTRATABLE_ROLE_KEYS, CAMPAIGN_ORCHESTRATOR_ROLE_KEY } from '../src/constants/roles';

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
 * Load-bearing, not hygiene — the same trap tests/lead-prompt-surfaces.test.ts and
 * icp-snapshot.test.ts both hit. The helper this file scans carries a header comment that names
 * HubSpot and Hootsuite while explaining the bug, so a scan counting comment text would find every
 * phrase it is looking for inside the explanation of why the phrases are needed, and pass a prompt
 * that says none of it.
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
// The shared surfaces helper plus the campaign_orchestrator role prompt that calls it. Scoped to
// those two spans on purpose: a mention of "Campaigns" in some OTHER role's prompt must not satisfy
// a requirement about THIS one.

const orchestrator = stripComments(read('netlify/functions/chat-orchestrator.ts'));
const surfacesBlock = span(orchestrator, 'function campaignSurfaces', '\n}', 'the campaignSurfaces() helper');
const campaignRoute = span(orchestrator, 'campaign_orchestrator: {', 'parseResponse: parseStructuredReply', 'the campaign_orchestrator route');
const PROMPT = `${surfacesBlock}\n${campaignRoute}`;

// ── The registry, evaluated rather than regex-scraped ────────────────────────
// A plain browser IIFE with no imports and no DOM access at load, so it runs under a fake `window`
// and yields the real config object. Scraping it with regexes would drift from what ships.

interface SurfaceCfg { label?: unknown }
const fakeWindow: { AssistantDashboardRegistry?: { REGISTRY: Record<string, Record<string, SurfaceCfg>> } } = {};
new Function('window', read('src/components/assistant-dashboard-registry.js'))(fakeWindow);
const campaignCfg = fakeWindow.AssistantDashboardRegistry?.REGISTRY?.[CAMPAIGN_ORCHESTRATOR_ROLE_KEY];

/**
 * Surfaces the prompt is allowed NOT to mention, each with the reason it would be WRONG to promise.
 * This is the pressure valve that keeps the generic scan honest: a new surface fails the test until
 * someone either documents it in the prompt or lands here with a justification.
 */
const EXEMPT: Record<string, string> = {
    // The button that opens THIS chat. An assistant telling the user to click it would be telling
    // them to open the conversation they are already having.
    primaryAction: 'the button that opens this chat — naming it sends the user in a circle',
};

console.log('\n──── the prompt knows its own dashboard ────');

check('every user-facing surface the registry declares is named in the prompt', () => {
    assert.ok(campaignCfg, `${CAMPAIGN_ORCHESTRATOR_ROLE_KEY} is missing from the dashboard registry entirely. `
        + 'Without an entry the role silently inherits the social_media_manager dashboard, which is wrong in every cell.');
    const missing: string[] = [];
    for (const [key, cfg] of Object.entries(campaignCfg)) {
        if (!cfg || typeof cfg !== 'object' || typeof cfg.label !== 'string') continue;
        if (key in EXEMPT) continue;
        if (!PROMPT.includes(`"${cfg.label}"`)) missing.push(`${key} ("${cfg.label}")`);
    }
    assert.deepStrictEqual(missing, [],
        `The campaign_orchestrator chat prompt never mentions: ${missing.join(', ')}.\n`
        + '    An assistant that has not been told a surface exists will invent an explanation for it.\n'
        + '    Add it to campaignSurfaces(), or add it to EXEMPT with the reason it must not be promised.');
});

check('no stale exemptions — every EXEMPT key still exists in the registry', () => {
    const gone = Object.keys(EXEMPT).filter((k) => !(campaignCfg && k in campaignCfg));
    assert.deepStrictEqual(gone, [],
        `EXEMPT names surfaces the registry no longer has: ${gone.join(', ')}. `
        + 'A stale exemption silently excuses a future surface that happens to reuse the key.');
});

check('the landing tab the registry declares is the one the prompt sends users to', () => {
    const landing = (campaignCfg as Record<string, unknown> | undefined)?.defaultMainTab;
    assert.strictEqual(landing, 'campaigns',
        'The registry must land this role on its Campaigns tab — it is the thing the role is for.');
    const label = campaignCfg?.campaignsTab?.label;
    assert.ok(PROMPT.includes(`"${label}" tab — the tab the user lands on`),
        `The prompt must tell the assistant which tab the user lands on, naming it "${label}".`);
});

check('the prompt forbids describing its own surfaces as third-party tools', () => {
    assert.match(PROMPT, /NOT third-party/,
        'The prompt must state outright that these are not third-party products.');
    assert.match(PROMPT, /never describe them as external tools/i,
        'The prompt must ban the exact failure: calling its own tabs external tools.');
    assert.match(PROMPT, /HubSpot|Hootsuite/,
        'The prompt should name the outside services a campaign assistant is most likely to confuse '
        + 'its own tabs with, the way the lead prompt names Apollo and Hunter.');
});

check('the prompt says it writes nothing itself', () => {
    assert.match(PROMPT, /you do not write posts, articles or emails yourself/i,
        'This role commissions work; it produces none. An assistant that thinks it drafts content '
        + 'will promise drafts that no job ever creates.');
});

console.log('\n──── the prompt speaks the executor\'s vocabulary ────');

// The failure this catches is silent and total: the user approves a plan, the card renders, the
// campaign saves, and the order the model named does not exist — so nothing is ever commissioned.

check('every order action the prompt offers exists in CAMPAIGN_ORDER_ACTIONS', () => {
    const quoted = [...PROMPT.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    const known = new Set<string>(CAMPAIGN_ORDER_ACTIONS);
    // Only inspect the action union line, so unrelated quoted strings elsewhere are not candidates.
    const actionLine = span(PROMPT, '"action":', '\n', 'the action union in the wire shape');
    const offered = [...actionLine.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).filter((v) => v !== 'action');
    assert.ok(offered.length > 0, 'The wire shape no longer offers any actions — did the union move?');
    const invented = offered.filter((a) => !known.has(a));
    assert.deepStrictEqual(invented, [],
        `The prompt offers order action(s) the executor does not have: ${invented.join(', ')}.\n`
        + `    Valid actions are: ${[...known].join(', ')}.\n`
        + '    A proposal naming an unknown action is approved by the user and then acted on by nobody.');
    assert.ok(quoted.length > 0);
});

check('every order action the executor has is offered by the prompt', () => {
    const actionLine = span(PROMPT, '"action":', '\n', 'the action union in the wire shape');
    const unoffered = CAMPAIGN_ORDER_ACTIONS.filter((a) => !actionLine.includes(`"${a}"`));
    assert.deepStrictEqual(unoffered, [],
        `The executor supports order action(s) the prompt never offers: ${unoffered.join(', ')}.\n`
        + '    A capability the assistant is never told about is a capability no user can reach.');
});

check('every assignedRole the prompt offers is orchestratable, and vice versa', () => {
    const roleLine = span(PROMPT, '"assignedRole":', '\n', 'the assignedRole union in the wire shape');
    const offered = [...roleLine.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).filter((v) => v !== 'assignedRole');
    const allowed = new Set(ORCHESTRATABLE_ROLE_KEYS);
    const invented = offered.filter((r) => !allowed.has(r));
    assert.deepStrictEqual(invented, [],
        `The prompt offers role(s) the orchestrator may not command: ${invented.join(', ')}. `
        + 'ORCHESTRATABLE_ROLE_KEYS is a real boundary — a role that drifts into the prompt acquires a controller.');
    const unoffered = ORCHESTRATABLE_ROLE_KEYS.filter((r) => !roleLine.includes(`"${r}"`));
    assert.deepStrictEqual(unoffered, [],
        `Role(s) the orchestrator may command are never offered to it: ${unoffered.join(', ')}.`);
});

check('each order action is described against the assistant that actually receives it', () => {
    // ORDER_ACTION_SPECS pins one role per action. If the prompt describes the Blog Writing
    // Assistant as drafting social posts, the model will emit a mismatched pair that the executor
    // rejects — a proposal the user approved that then quietly fails.
    for (const [action, spec] of Object.entries(ORDER_ACTION_SPECS)) {
        assert.ok(ORCHESTRATABLE_ROLE_KEYS.includes(spec.roleKey),
            `ORDER_ACTION_SPECS.${action} is assigned to "${spec.roleKey}", which is not in ORCHESTRATABLE_ROLE_KEYS. `
            + 'The executor would route an order to an assistant the security boundary forbids.');
    }
});

check('the prompt offers only outcome metrics something can actually count', () => {
    const metricLine = span(PROMPT, '"outcomeMetric":', '\n', 'the outcomeMetric union in the wire shape');
    for (const m of UNAVAILABLE_OUTCOME_METRICS) {
        assert.ok(!metricLine.includes(`"${m}"`),
            `The prompt offers "${m}", which nothing counts yet (UNAVAILABLE_OUTCOME_METRICS). `
            + 'A campaign whose number always reads zero looks broken, not unbuilt.');
    }
    const selectable = CAMPAIGN_OUTCOME_METRICS.filter((m) => !UNAVAILABLE_OUTCOME_METRICS.includes(m));
    const unoffered = selectable.filter((m) => !metricLine.includes(`"${m}"`));
    assert.deepStrictEqual(unoffered, [],
        `Countable outcome metric(s) are never offered: ${unoffered.join(', ')}.`);
});

console.log('\n──── money is never mentioned, because there is none ────');

// discovery-spend-cap-is-operator-only: a pound sign on a card IS a price to whoever reads it,
// whatever we meant by it. Phase 1 campaigns spend capacity; paid channels are blocked on approvals
// we do not control, so any money talk here promises something no button in this product can do.

check('the prompt forbids quoting prices and offering ads', () => {
    assert.match(PROMPT, /budget is TASKS, not money/i,
        'The prompt must state the unit of a campaign budget outright.');
    assert.match(PROMPT, /never offer to buy ads|paid advertising is not available/i,
        'The prompt must forbid offering paid advertising — it is blocked on platform approvals.');
    assert.match(PROMPT, /nothing is ever billed on top/i,
        'The task cap is a stop, not an overage charge, and the assistant must be able to say so.');
});

check('the proposal card renders no monetary figure', () => {
    const registry = read('src/components/disruptive-ui-registry.js');
    const card = span(stripComments(registry), 'function renderCampaignStrategyProposalCard', '\n  register(', 'the proposal card');
    assert.ok(!card.includes('£'),
        'The campaign proposal card renders a £ figure. Phase 1 campaigns have no money budget, and '
        + 'a pound sign on an approval card reads as a price the user is agreeing to pay.');
    assert.match(card, /tasks from your monthly allowance/,
        'The card must state the budget in tasks, so the user knows what approving commits.');
});

console.log('\n──── approving in chat SAVES, it never STARTS ────');

check('the emitted type has a renderer registered under the same name', () => {
    const registry = read('src/components/disruptive-ui-registry.js');
    assert.match(PROMPT, /"type": "campaign_strategy_proposal"/,
        'The prompt must document the wire shape it is told to emit.');
    assert.match(registry, /register\('campaign_strategy_proposal'/,
        'Nothing renders campaign_strategy_proposal — an unknown type degrades to text silently, '
        + 'so the assistant would promise a card the user never sees.');
});

check('approving the proposal creates a DRAFT, never a running campaign', () => {
    const chat = stripComments(read('src/components/chat-session.js'));
    const handler = span(chat, 'function onCampaignCreate', '\n    }', 'the campaign create handler');
    assert.match(handler, /asDraft:\s*true/,
        'chat-session.js must send asDraft — without it a chat turn commits the org\'s monthly '
        + 'allowance across three assistants on the strength of one click.');

    const api = stripComments(read('netlify/functions/campaigns.ts'));
    const create = span(api, "action === 'create'", "action === 'edit'", 'the create action');
    assert.match(create, /status:\s*'draft'/,
        'campaigns.ts must insert campaigns as draft. A campaign created active is one the user '
        + 'never started.');
});

check('the chat cannot start, raise a ceiling, or resume a paused campaign', () => {
    const chat = stripComments(read('src/components/chat-session.js'));
    const handler = span(chat, 'function onCampaignCreate', '\n    }', 'the campaign create handler');
    for (const forbidden of ['start', 'edit', 'place_order']) {
        assert.ok(!new RegExp(`action:\\s*'${forbidden}'`).test(handler),
            `The chat campaign handler posts action '${forbidden}'. A chat turn may only create a `
            + 'draft — starting, re-budgeting and resuming are clicks on the Campaigns tab with the '
            + 'numbers visible (docs/campaign-orchestrator-plan.md §1.3).');
    }
    assert.ok(!/maxSpendGbp/.test(handler),
        'The chat create path must not send a money budget at all.');

    assert.match(PROMPT, /cannot raise a budget ceiling or resume a paused campaign/i,
        'The prompt must tell the assistant it cannot do these things, so it explains rather than '
        + 'silently failing when asked.');
});

check('starting a campaign refuses to resurrect anything but a draft or a pause the user made', () => {
    const api = stripComments(read('netlify/functions/campaigns.ts'));
    const start = span(api, "action === 'start'", "action === 'pause'", 'the start action');
    assert.match(start, /\['draft',\s*'paused'\]/,
        'start must accept only draft and paused campaigns — starting a finished or archived one '
        + 'would silently revive work the user considered done.');
    assert.match(start, /haltReason:\s*null/,
        'Resuming must clear the halt fields, or the campaign runs while still claiming to be halted. '
        + 'connection-pause-needs-a-resume: every pause needs a real, named way back.');
});

check('approving the same proposal twice does not create two campaigns', () => {
    const api = read('netlify/functions/campaigns.ts');
    assert.match(api, /deduped:\s*true/,
        'The draft create path needs a dedupe: chat transcripts re-hydrate from '
        + 'chatMessages.uiElementJson on reload, so an old proposal card comes back with live buttons.');
});

check('a chat write tells the page a campaign now exists', () => {
    const chat = read('src/components/chat-session.js');
    assert.match(chat, /CustomEvent\('campaign:created'/,
        'chat-session.js must dispatch campaign:created on `document`. The Campaigns tab sits behind '
        + 'the chat modal, already loaded, with no other way to learn about the write — users closed '
        + 'the chat onto "No campaigns yet" and concluded the assistant had done nothing '
        + '(chat-creates-draft-campaigns).');
    const dispatch = span(stripComments(chat), "CustomEvent('campaign:created'", '}));', 'the campaign:created dispatch');
    assert.match(dispatch, /assistantId/,
        'The event must carry the assistantId so only the tab it belongs to reacts.');
});

check('the card names the tab as the registry labels it', () => {
    const registry = read('src/components/disruptive-ui-registry.js');
    const card = span(registry, 'function renderCampaignStrategyProposalCard', '\n  register(', 'the proposal card');
    const tabLabel = campaignCfg?.campaignsTab?.label;
    assert.ok(card.includes(`${tabLabel} tab`),
        `The proposal card must send users to the "${tabLabel}" tab, matching the registry label. `
        + 'It is the last instruction in the flow, and copy that names the wrong tab strands the user '
        + 'holding an approved campaign they cannot find.');
    assert.ok(!card.includes('is running') && !card.includes('has started'),
        'The card must never claim the campaign started. Approving saves a draft.');
});

console.log('\n──── a decision is settled where the decision lives ────');

// assistant_records only MIRRORS campaign_decisions so the Review Queue can draw a card. The
// generic records handler PATCHes that mirror — which for this role would show the user a settled
// card while the real decision stayed pending, no orders were placed, and no reason was captured.

check('approving a campaign decision routes to campaigns.ts, not the generic records PATCH', () => {
    const detail = stripComments(read('assistants.js'));
    const handler = span(detail, 'window._detailRqRecordAct = async function', '\nconst _RQ_BLOG_STATUS', 'the generic record-action handler');
    assert.match(handler, /recordType === 'campaign_decision'[\s\S]{0,200}_rqApproveCampaignDecision/,
        'The approve branch must hand campaign decisions to _rqApproveCampaignDecision and return. '
        + 'The generic PATCH only flips the mirror\'s approval_status — it does not place the orders, '
        + 'so the user would see an approved card while no assistant was ever briefed.');
    assert.match(detail, /action: 'decide', decisionId, verdict: 'approve'/,
        'Approval must call the decide action, which is what places the orders.');
});

check('rejecting a campaign decision requires a reason and has no skip', () => {
    const detail = stripComments(read('assistants.js'));
    const strip = span(detail, 'function _rqRejectCampaignDecision', '\nfunction _rqShowRejectReasonStrip', 'the campaign reject strip');
    assert.match(strip, /verdict: 'reject'/, 'Rejection must go through campaigns.ts decide.');
    assert.ok(!/data-cd-skip|>Skip</.test(strip),
        'The campaign reject strip must NOT offer a Skip. The lead strip may skip because nothing '
        + 'reads its answer; this reason is written into the campaign\'s constraints and restated in '
        + 'the next proposal\'s prompt, so skipping would drop a steer the user was promised.');

    const api = stripComments(read('netlify/functions/campaigns.ts'));
    assert.match(api, /isCampaignRejectReason\(body\.reason\)/,
        'The server must refuse a reasonless rejection — the UI is a convenience, never the gate.');
});

check('the approval toast is built from the server\'s answer, not the click', () => {
    const detail = stripComments(read('assistants.js'));
    const fn = span(detail, 'async function _rqApproveCampaignDecision', 'function _rqRejectCampaignDecision', 'the approve handler');
    assert.match(fn, /data\.orders/,
        'The toast must count the orders the SERVER reports placing. placeOrder can refuse an '
        + 'individual order (budget, plan cap, missing assistant) while the decision still succeeds, '
        + 'so "approved" and "briefed" are different facts (chat-claims-drafts-it-never-saved).');
    // The response key is `orders`; a client reading `placed` would silently count zero and tell
    // every user no briefs went out.
    const api = read('netlify/functions/campaigns.ts');
    assert.match(api, /verdict: 'approved', orders: placed/,
        'The decide response must keep returning `orders` — the client counts that key by name.');
});

console.log('\n──── the campaign actually reaches generation ────');

// goals-steer-generation: SMART Goals shipped seven functions, three crons, a metric catalog and a
// progress bar, and `grep -i goal` over the generation path returned nothing. Every post was
// byte-identical to having no goal. These four checks are the whole reason the directive exists.

check('the campaign section is emitted verbatim, not flattened into JSON', () => {
    const prompt = read('src/utils/blueprint-prompt.ts');
    assert.match(prompt, /VERBATIM_DIRECTIVE_SECTIONS = new Set\(\[[^\]]*'13-campaign'/,
        "'13-campaign' must be in VERBATIM_DIRECTIVE_SECTIONS, or the generic flattener dumps the "
        + 'raw JSON alongside the prose and the model reads the same instruction twice in two formats.');
});

check('the SOCIAL seam gets the directive', () => {
    const prompt = read('src/utils/blueprint-prompt.ts');
    assert.match(prompt, /13-campaign/,
        'renderBlueprintPrompt() is the social seam — process-content-jobs and admin-test-generate '
        + 'both go through it.');
});

check('the BLOG seam gets the directive too', () => {
    // The blog assembles its OWN prompt and does not go through renderBlueprintPrompt(). Feeding
    // one seam and not the other is exactly how the Inspo tab shipped half-wired.
    const blog = read('src/utils/blog-generate.ts');
    const block = span(stripComments(blog), 'export async function buildBlueprintGuardrailsBlock', '\n}', 'the blog guardrails block');
    assert.match(block, /13-campaign/,
        'buildBlueprintGuardrailsBlock() must inject the campaign directive. A campaign that steers '
        + 'posts but not articles is a campaign the Blog Writer is not in.');
});

check('the directive carries no fast-moving value', () => {
    // Blueprint rows de-dupe by section CONTENT. A live spend figure or a raw count would make every
    // unrelated recompile — a profile autosave on a 1.2s debounce, a content-rule edit — emit a new
    // blueprint row because a number ticked by one.
    const directive = read('src/utils/campaign-directive.ts');
    assert.match(directive, /export type CampaignPace = 'ahead' \| 'on_track' \| 'behind' \| 'unknown'/,
        'Pace must stay a coarse bucket, never a percentage or a raw count.');
    const rendered = span(stripComments(directive), 'function renderCampaignDirective', '\n}', 'the rendered directive');

    // What matters is not whether a number is READ, but whether one is INTERPOLATED into the
    // emitted text — that is what changes the section content and forces a new blueprint row.
    // `weeksRemaining` is read here and deliberately only compared (`<= 2`) to pick between fixed
    // sentences, which is why the check targets interpolation rather than mention.
    const numericFields = ['weeksRemaining', 'targetValue', 'actual', 'expected', 'progress', 'spend', 'workItems'];
    const interpolated = numericFields.filter((f) => new RegExp(`\\$\\{[^}]*\\b${f}\\b`).test(rendered));
    assert.deepStrictEqual(interpolated, [],
        `The rendered directive interpolates ${interpolated.join(', ')} into the prompt text. Blueprint `
        + 'rows de-dupe by section CONTENT, so a value that ticks emits a new row on every unrelated '
        + 'recompile — a profile autosave on a 1.2s debounce would be enough. Branch on the value to '
        + 'choose between fixed sentences instead, the way weeksRemaining does.');

    assert.ok(!/%|percent/i.test(rendered),
        'The rendered directive states a percentage. Pace is a bucket for exactly this reason.');
});

check('the campaign never overrides the content standards', () => {
    const directive = read('src/utils/campaign-directive.ts');
    assert.match(directive, /The campaign does not relax any other rule/,
        'The directive must settle its collision with the content standards explicitly. Without it '
        + 'the model reads a campaign target as licence to optimise for engagement.');
    assert.match(directive, /Never mention the campaign/,
        'The reader must never be shown the machinery.');
});

console.log('\n──── rejection teaches something ────');

// lead-rejection-teaches-nothing: a Reject button that captured no reason and fed no consumer, so
// the user re-corrects the same mistake forever. The rule agreed for this role is that the reason
// ships WITH its consumer or the button ships disabled.

check('a rejected decision reaches the next proposal', () => {
    const reasons = read('src/config/campaign-reject-reasons.ts');
    assert.match(reasons, /export function applyRejectionToConstraints/,
        'The reject reason needs a writer.');
    assert.match(reasons, /export function renderCampaignConstraints/,
        'The reject reason needs a reader.');

    const api = stripComments(read('netlify/functions/campaigns.ts'));
    assert.match(api, /applyRejectionToConstraints/,
        'campaigns.ts must apply the rejection on the decide path, or the reason is captured and '
        + 'never used — a write-only feedback loop, which is the bug this guards.');

    const directive = read('src/utils/campaign-directive.ts');
    assert.match(directive, /renderCampaignConstraints/,
        'The constraints must reach generation. A reason stored but never restated in a prompt '
        + 'teaches the assistant nothing.');
});

console.log(`\n${passed} checks passed.`);
