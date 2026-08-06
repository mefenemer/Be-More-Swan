// tests/strategy-agent.test.ts
// Phase 5a slice 2 — the weekly Strategy Agent run (the edit-pattern proposer + expiry sweep).
// Design: docs/lead-generator-revenue-engine-plan.md §7, docs/strategy-agent-plan.md §4-§5.
//
// What is being defended here, and none of it is checkable by the type system:
//
//   1. THE PROPOSER CANNOT ACT. Untrusted third-party text is adjacent to this prompt and, unlike
//      memory-query, this function writes. The guarantee is the SHAPE of what it can do — no sends,
//      no tools, no writes outside strategy_proposals — so it is asserted against the source.
//
//   2. IT CAN ACTUALLY FIND ITS EVIDENCE. The proposer's aggregate has to reach the assistant from
//      a template_feedback row. The obvious join (through lead_messages) matches ZERO rows, because
//      the only writer of that table leaves lead_message_id NULL by design. That mistake produces a
//      cron that runs weekly, errors never, and permanently proposes nothing — the most expensive
//      kind of bug to notice.
//
//   3. THE CRON IS ACTUALLY WIRED, on both environments. Netlify fires schedules only on the
//      production deploy, so staging needs its own workflow, and the two drift silently.
//
// No database and no model: source and config consistency only, so this runs in CI with no
// connection string.
// Run:  npx tsx tests/strategy-agent.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EDIT_REASONS, MIN_EDIT_SAMPLE } from '../src/config/template-feedback';
import { STRATEGY_TUNABLE_FIELDS, PROPOSAL_SOURCES } from '../src/config/strategy-proposals';
import { categoryOf } from '../src/utils/notification-actions';
import { NOTIFICATION_DEFAULTS } from '../src/utils/notification-templates-catalog';

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

/** Blank out comments, preserving offsets — the modules NAME what they must not do, in prose. */
function stripComments(text: string): string {
    return text
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
}
const raw = (rel: string) => readFileSync(join(root, rel), 'utf8');
const sourceOf = (rel: string) => stripComments(raw(rel));

const agentSrc = sourceOf('netlify/functions/autonomous-strategy-agent.ts');
const agentRaw = raw('netlify/functions/autonomous-strategy-agent.ts');

/**
 * The body of runStrategyAgent(), for the ordering assertions below.
 *
 * Scoped deliberately: the import block names `isGlobalAiDisabled` and `createNotification` before
 * any call site, so an indexOf over the whole file compares import positions and reports an order
 * that has nothing to do with what executes.
 */
const runBody = (() => {
    const start = agentSrc.indexOf('export async function runStrategyAgent');
    assert.ok(start !== -1, 'runStrategyAgent is missing');
    const end = agentSrc.indexOf('\nexport default', start);
    return agentSrc.slice(start, end === -1 ? undefined : end);
})();

// ── 1. The proposer cannot act ───────────────────────────────────────────────

check('the proposer never sends anything and holds no tools', () => {
    for (const forbidden of [
        'sendGmailMessage', 'sendOutlookMessage', 'sendEmail', 'sendGridSend',
        'enqueueLeadHandoff', 'enrolInSequence', 'recordOutboundMessage',
    ]) {
        assert.ok(!agentSrc.includes(forbidden), `the proposer must not reference ${forbidden}`);
    }
});

check('the proposer writes NOTHING directly — every write goes through the single writer', () => {
    // §5.4 + §5.2(4). A direct db.update here would be both a second mechanism and an escape from
    // the change envelope.
    for (const verb of ['update', 'insert', 'delete']) {
        const re = new RegExp(`db\\s*\\.\\s*${verb}\\s*\\(`);
        assert.ok(!re.test(agentSrc), `the proposer calls db.${verb}() directly`);
    }
    assert.ok(agentSrc.includes('proposeChange'), 'the proposer does not use the single writer');
    assert.ok(agentSrc.includes('expirePendingProposals'), 'the expiry sweep is not wired into the run');
});

check('the proposer never applies its own proposal', () => {
    // THE distinction the phase is built on: it stops at persisting an inert pending row. A human
    // applies it having read the diff (§7.1 — "never apply-then-notify").
    assert.ok(!agentSrc.includes('applyStrategyChange'), 'the proposer must never apply a change itself');
    assert.ok(!agentSrc.includes('assembleBlueprint'), 'the proposer must not recompile a brief — nothing changed yet');
});

check('only targetField and proposedValue are read from the model', () => {
    // §5.2(1): evidence is computed in SQL and attached by the persist path. A model that invents
    // "sampleSize: 400" must not be able to launder it into the UI.
    const parsed = agentSrc.match(/parseModelJson<\{([^}]*)\}>/);
    assert.ok(parsed, 'could not find the parseModelJson type argument');
    const keys = [...parsed![1].matchAll(/(\w+)\s*\??\s*:/g)].map((m) => m[1]).sort();
    assert.deepEqual(keys, ['proposedValue', 'targetField'],
        `the model's output is destructured into ${keys.join(', ')} — evidence must never come from it`);
});

check('the evidence blob is built from the SQL aggregate, not the model', () => {
    const evidence = agentSrc.match(/evidence:\s*\{([\s\S]*?)\n\s{12}\}/);
    assert.ok(evidence, 'could not find the evidence object');
    assert.ok(/sampleSize:\s*c\.n/.test(evidence![1]), 'sampleSize must come from the SQL count');
    assert.ok(/feedbackIds:\s*c\.feedbackIds/.test(evidence![1]), 'feedbackIds must come from the SQL aggregate');
    assert.ok(!/parsed\./.test(evidence![1]), 'no evidence field may be taken from the parsed model output');
});

check('the model must answer about the field it was asked about — reject, never clamp', () => {
    assert.ok(/claimedField\s*!==\s*targetField/.test(agentSrc),
        'a model naming a different (but tunable) field must be rejected, not accepted');
    assert.ok(agentSrc.includes('tunableField('), 'the target field must be resolved through the frozen allow-list');
});

check('message bodies never reach the prompt — only computed diff summaries', () => {
    // The reasoning that would justify including bodies ("more context, better rewrite") is exactly
    // how prospect-authored text reaches a model whose output gets stored.
    for (const leak of ['generatedBody', 'leadMessages.body', '.body', 'outreachDraft']) {
        assert.ok(!agentSrc.includes(leak), `the prompt path references ${leak}`);
    }
    assert.ok(agentSrc.includes('c.diffs'), 'the prompt should carry the computed diff summaries');
});

check('`other` is excluded from clustering, in the query and in the target map', () => {
    assert.ok(agentSrc.includes("edit_reason <> 'other'"), 'the aggregate must drop the unclusterable bucket');
});

// ── 2. It can actually find its evidence ─────────────────────────────────────

check('the aggregate does NOT inner-join lead_messages', () => {
    // ⚠️ THE REGRESSION THIS FILE EXISTS FOR. `record_edit_feedback` writes lead_message_id = NULL
    // by design — a review-time edit precedes the send — and it is the only writer. An inner join
    // through lead_messages matches zero rows and the proposer silently never proposes.
    const joins = [...agentRaw.matchAll(/\n\s*(LEFT\s+|INNER\s+)?JOIN\s+(lead_messages|lead_threads)/gi)];
    assert.ok(joins.length >= 2, `expected joins onto lead_messages/lead_threads, found ${joins.length}`);
    for (const j of joins) {
        assert.equal((j[1] || '').trim().toUpperCase(), 'LEFT',
            `join onto ${j[2]} must be a LEFT join — the primary evidence source has a NULL lead_message_id`);
    }
});

check('the aggregate resolves the assistant from template_feedback first', () => {
    assert.ok(/COALESCE\(tf\.ai_assistant_id,\s*lt\.ai_assistant_id\)/.test(agentRaw),
        'the assistant must come from the column first, with the message path only as a fallback');
});

check('template_feedback.ai_assistant_id exists in schema.ts and its migration', () => {
    const schemaText = raw('db/schema.ts');
    const block = schemaText.slice(schemaText.indexOf('export const templateFeedback'));
    assert.ok(block.slice(0, 1200).includes('aiAssistantId'), 'the column is missing from db/schema.ts');
    const sqlText = raw('db/template-feedback-assistant.sql');
    assert.ok(sqlText.includes('ADD COLUMN IF NOT EXISTS ai_assistant_id'), 'the migration does not add the column');
    assert.ok(sqlText.includes('CREATE INDEX IF NOT EXISTS'), 'the index creation is not guarded');
});

check('the writer of template_feedback supplies the assistant', () => {
    // A row without it is invisible to the proposer, while still counting toward nothing useful.
    const writerSrc = sourceOf('src/utils/template-feedback.ts');
    assert.ok(/aiAssistantId:\s*input\.aiAssistantId/.test(writerSrc), 'the writer drops the assistant id');
    const callerSrc = sourceOf('netlify/functions/lead-generation.ts');
    assert.ok(/aiAssistantId:\s*assistant\.id/.test(callerSrc), 'record_edit_feedback does not pass the assistant');
});

check('every clusterable edit reason maps to a field on the allow-list', () => {
    const map = agentSrc.match(/TARGET_FIELD_FOR_REASON[^=]*=\s*\{([\s\S]*?)\n\};/);
    assert.ok(map, 'could not find TARGET_FIELD_FOR_REASON');
    const entries = [...map![1].matchAll(/(\w+):\s*'([\w_]+)'/g)].map((m) => [m[1], m[2]] as const);
    const mapped = new Map(entries);

    for (const reason of EDIT_REASONS) {
        if (reason === 'other') {
            assert.ok(!mapped.has(reason), '`other` must not have a target — it is a bucket, not a signal');
            continue;
        }
        const target = mapped.get(reason);
        assert.ok(target, `${reason} has no target field — adding a reason must force this decision`);
        assert.ok(Object.prototype.hasOwnProperty.call(STRATEGY_TUNABLE_FIELDS, target!),
            `${reason} targets "${target}", which is not on the change allow-list`);
    }
});

check('the modal reason must clear the threshold on its own', () => {
    // Summing across reasons would let five unrelated complaints look like one pattern — precisely
    // the noise MIN_EDIT_SAMPLE exists to exclude.
    assert.ok(agentSrc.includes('MIN_EDIT_SAMPLE'), 'the proposer does not gate on the sample threshold');
    assert.ok(/HAVING count\(\*\) >= \$\{MIN_EDIT_SAMPLE\}/.test(agentRaw), 'the threshold is not applied per cluster in SQL');
    assert.ok(agentSrc.includes('modalPerAssistant'), 'the proposer does not reduce to one cluster per assistant');
    assert.equal(MIN_EDIT_SAMPLE, 5, 'the edit threshold moved — the empty-state copy quotes it');
});

check('spent evidence is banked on apply, so the same edits cannot fund a repeat', () => {
    const writerSrc = sourceOf('src/utils/strategy-proposals.ts');
    assert.ok(writerSrc.includes('bankEvidence'), 'nothing marks the funding edits as spent');
    assert.ok(/appliedToTemplate:\s*true/.test(writerSrc), 'the banking does not set applied_to_template');
    // On apply, NOT on propose: a declined proposal leaves its evidence unspent, because the reject
    // reason is fed back and the next run may reach a better answer from the same material.
    assert.ok(!/bankEvidence[\s\S]{0,400}status:\s*'pending'/.test(writerSrc), 'evidence must not be banked at propose time');
});

check('prior rejections are fed back, minus the free-text bucket', () => {
    assert.ok(agentSrc.includes('priorRejections'), 'rejections are not fed back — declining would be a dead end');
    assert.ok(agentSrc.includes('REJECT_REASONS_FED_TO_MODEL'),
        '`other` carries only a free-text note and must not reach the prompt');
});

// ── 3. The run is wired on both environments ─────────────────────────────────

check('the production cron is registered and weekly', () => {
    const toml = raw('netlify.toml');
    assert.ok(toml.includes('[functions.autonomous-strategy-agent]'), 'no schedule block in netlify.toml');
    const m = toml.match(/\[functions\.autonomous-strategy-agent\]\s*\n\s*schedule\s*=\s*"([^"]+)"/);
    assert.ok(m, 'the schedule value is missing');
    const [, expr] = m!;
    const dow = expr.trim().split(/\s+/)[4];
    assert.ok(dow && dow !== '*', `"${expr}" runs daily — the sample unit is a human edit, so a daily run re-reads the same edits`);
});

check('staging has its own workflow, because Netlify crons never fire on a branch deploy', () => {
    const wf = raw('.github/workflows/staging-strategy-cron.yml');
    assert.ok(wf.includes('run-strategy-agent'), 'the workflow does not poke the wrapper endpoint');
    assert.ok(wf.includes('CRON_TRIGGER_SECRET'), 'the workflow does not send the shared secret');
    assert.ok(wf.includes('staging--bemoreswan.netlify.app'), 'the workflow must target staging, never production');
});

check('both entry points fail closed when the secret is unset', () => {
    for (const rel of [
        'netlify/functions/run-strategy-agent.ts',
        'netlify/functions/autonomous-strategy-agent-background.ts',
    ]) {
        const src = sourceOf(rel);
        assert.ok(/if\s*\(!secret\)/.test(src), `${rel} does not refuse when the secret is missing`);
        assert.ok(src.includes('503'), `${rel}: an unconfigured endpoint must be disabled, not open`);
        assert.ok(src.includes('401'), `${rel}: a wrong token must be rejected`);
    }
});

check('⚠️ the work runs in a BACKGROUND function, never inline in a scheduled one', () => {
    // THE REGRESSION THIS GUARDS. One org costs ~50s (staging 2026-08-03: cold start 17:40:50 →
    // proposal written 17:41:39). A synchronous Netlify function gets 10s by default, 26s at most,
    // so running the work inline meant being killed on every tick — and the one proposal it did
    // produce survived only because the staging workflow's `curl --retry` gave it another attempt.
    const worker = sourceOf('netlify/functions/autonomous-strategy-agent-background.ts');
    assert.ok(worker.includes('runStrategyAgent'), 'the background worker does not run the agent');

    // Neither entry point may do the work itself — both dispatch.
    for (const rel of [
        'netlify/functions/autonomous-strategy-agent.ts',
        'netlify/functions/run-strategy-agent.ts',
    ]) {
        const src = sourceOf(rel);
        const handler = src.slice(src.indexOf('export default withLambda'));
        assert.ok(!/runStrategyAgent\(/.test(handler), `${rel} runs the agent inline — it will be killed by the timeout`);
        assert.ok(/triggerStrategyAgentRun\(/.test(handler), `${rel} does not dispatch to the background worker`);
    }
});

check('the dispatch is AWAITED, or the worker is never invoked', () => {
    // An un-awaited fetch can be frozen with the lambda before the request leaves the sandbox.
    const trig = sourceOf('src/utils/trigger-strategy-agent.ts');
    assert.ok(/await fetch\(/.test(trig), 'the background invoke must be awaited');
    assert.ok(/-background/.test(trig), 'the trigger must target the -background function');
});

check('the run stops on its own budget rather than being killed', () => {
    assert.ok(agentSrc.includes('RUN_BUDGET_MS'), 'no wall-clock budget');
    assert.ok(/truncated:\s*boolean/.test(agentSrc), 'the result cannot report that work was left over');
    assert.ok(/result\.truncated = true/.test(runBody), 'the budget never sets truncated');
});

check('every skip records a reason — "skipped: N" must never be unfalsifiable', () => {
    // Six paths reach `skipped`, and in the summary they are indistinguishable. For a job expected
    // to do nothing for months, "correctly proposed nothing" and "silently broken" look identical
    // without this. The reasons are RETURNED as well as logged, because the platform's function
    // logs do not reliably surface a scheduled invocation's stdout.
    const increments = [...runBody.matchAll(/result\.skipped\s*\+\+/g)];
    assert.equal(increments.length, 1, 'skipped must be incremented in exactly one place (the skip() helper)');
    assert.ok(/const skip = \(/.test(runBody), 'no skip() helper');
    assert.ok(/skipReasons\.push/.test(runBody), 'the helper does not record the reason');

    // Every `continue` that abandons a cluster must have gone through skip()/reject() first.
    const bare = [...runBody.matchAll(/\n\s*if \([^)]*\) \{ (?!skip\(|reject\()[^}]*continue; \}/g)];
    assert.deepEqual(bare.map((m) => m[0].trim()), [], 'a cluster is abandoned without recording why');
});

check('the run persists its outcome where a human can read it', () => {
    const iface = agentSrc.match(/export interface StrategyAgentResult \{([\s\S]*?)\n\}/);
    assert.ok(iface, 'StrategyAgentResult is missing');
    assert.ok(/skipReasons:\s*string\[\]/.test(iface![1]), 'skipReasons is not part of the result');

    // Once the work moved to a background function, NOBODY reads its HTTP response — the caller
    // got a 202 and left. So the outcome has to be persisted, or "is this thing even running?"
    // becomes unanswerable again (§7).
    assert.ok(/recordLastRun\(/.test(runBody), 'the run does not persist a summary');
    assert.ok(agentSrc.includes('STRATEGY_AGENT_LAST_RUN'), 'no config key for the last run');

    // …and something has to actually read it back.
    const api = sourceOf('netlify/functions/strategy-proposals.ts');
    assert.ok(api.includes('STRATEGY_AGENT_LAST_RUN'), 'the API never reads the last-run summary');
    assert.ok(/lastRun:/.test(api), 'the API does not return lastRun to the client');
    const ui = readFileSync(join(root, 'src/components/assistant-strategy.js'), 'utf8');
    assert.ok(/lastRunLine\(\)/.test(ui), 'the empty state does not show when the agent last ran');
});

check('the expiry sweep runs before the AI kill-switch can short-circuit it', () => {
    // Lapsing a proposal is housekeeping, not AI work. If the sweep sat after the kill-switch,
    // disabling AI would leave every pending proposal actionable forever.
    const sweep = runBody.indexOf('expirePendingProposals');
    const killSwitch = runBody.indexOf('isGlobalAiDisabled');
    assert.ok(sweep !== -1 && killSwitch !== -1, 'could not locate both statements');
    assert.ok(sweep < killSwitch, 'the expiry sweep must not be skippable by the AI kill-switch');
});

// ── 4. The notification ──────────────────────────────────────────────────────

check('strategy_proposal_pending is in the catalog with every variable it uses', () => {
    const tpl = NOTIFICATION_DEFAULTS.find((t) => t.templateKey === 'strategy_proposal_pending');
    assert.ok(tpl, 'the template is missing from the catalog');
    // Every {{path}} in the copy must be declared, or the admin's variable list lies and save-time
    // validation cannot reject one the call site never supplies.
    const used = [...`${tpl!.title} ${tpl!.message}`.matchAll(/\{\{([\w.]+)\}\}/g)].map((m) => m[1]);
    const declared = new Set(tpl!.variables.map((v) => v.key));
    for (const u of used) assert.ok(declared.has(u), `{{${u}}} is used but not declared`);
});

check('the proposal alert is actionable but dismissible — never a pinned banner', () => {
    // critical_action is undismissible. Nothing here is broken: a lapsed proposal costs nothing and
    // the agent re-proposes while the evidence still supports it.
    assert.equal(categoryOf('strategy_proposal_pending'), 'suggested_action');
});

check('the notification is per org per run, not per proposal', () => {
    // §9.4 — two proposers firing for one org in a single run is two proposals and would otherwise
    // be two alerts about the same visit.
    assert.ok(runBody.includes('proposedByOrg'), 'notifications are not collapsed per org');
    const notifyIdx = runBody.indexOf('createNotification');
    const loopIdx = runBody.indexOf('for (const [organisationId, info] of proposedByOrg)');
    assert.ok(loopIdx !== -1 && notifyIdx > loopIdx, 'the notification must be sent from the per-org loop, not the per-cluster loop');
});

// ── 5. The human's own save shares the apply path (§5.4) ─────────────────────

check('saveHumanDefault routes through applyStrategyChange, not a direct write', () => {
    const writerSrc = sourceOf('src/utils/strategy-proposals.ts');
    const fnIdx = writerSrc.indexOf('export async function saveHumanDefault');
    assert.ok(fnIdx !== -1, 'saveHumanDefault is missing — the next human-save surface will write the field directly');
    const body = writerSrc.slice(fnIdx, writerSrc.indexOf('\nexport ', fnIdx + 10));
    assert.ok(body.includes('proposeChange'), 'it must create a proposal, so the save appears in history');
    assert.ok(body.includes('applyStrategyChange'), 'it must apply through the shared path');
    assert.ok(!/db\.update\(aiAssistants\)/.test(body), 'it must never write the assistant field itself');
    assert.ok(/source:\s*'human'/.test(body), "the synthetic proposal must be sourced 'human'");
});

check("'human' is a permitted source in the constraint, so no migration is needed to wire a surface", () => {
    assert.ok((PROPOSAL_SOURCES as readonly string[]).includes('human'));
    assert.ok(raw('db/strategy-proposals.sql').includes("'human'"), 'the SQL CHECK would reject a human save');
});

// ── 6. The rejection proposer (lead_rejection) ───────────────────────────────

check("'lead_rejection' is permitted by a migration, not only by the config", () => {
    assert.ok((PROPOSAL_SOURCES as readonly string[]).includes('lead_rejection'));
    // proposeChange() validates the source against the config and would hand a value the OLD CHECK
    // rejects straight to an INSERT. That failure is swallowed, so the only symptom would be a
    // weekly "the writer refused the proposal" with no other trace.
    assert.ok(
        raw('db/strategy-proposal-source-lead-rejection.sql').includes("'lead_rejection'"),
        'no migration widens the CHECK — every rejection proposal would fail silently',
    );
});

check('the rejection cluster demands spread, not just a count', () => {
    // ⚠️ The whole point. One reviewer clearing one bad run rejects twenty leads in an afternoon and
    // clears any raw threshold — from a single misconfigured search. Without this the proposer would
    // rewrite the persona for every campaign the assistant has on the strength of one sitting.
    // The loader is a module-level function, so this reads the whole file rather than runBody.
    const src = sourceOf('netlify/functions/autonomous-strategy-agent.ts');
    const fn = src.slice(src.indexOf('async function loadRejectionClusters'));
    const query = fn.slice(0, fn.indexOf('return rows'));
    assert.ok(/MIN_REJECT_SAMPLE/.test(query), 'no sample threshold');
    assert.ok(/MIN_REJECT_CAMPAIGNS/.test(query), 'a burst inside ONE campaign must not qualify');
    assert.ok(/MIN_REJECT_SPREAD_DAYS/.test(query), 'a burst inside ONE day must not qualify');
    assert.ok(/applied_to_target = false/.test(query), 'spent evidence would fund the same proposal forever');
});

check('the rejection proposer never targets the field nothing reads', () => {
    // discovery_query_themes is the intuitive home for "the queries keep finding directories", and
    // it is a trap: no reader exists, so a proposal there applies cleanly and changes nothing while
    // telling the user they have retargeted.
    const pass = runBody.slice(runBody.indexOf('const rejectionClusters'));
    assert.ok(!/discovery_query_themes/.test(pass), 'the rejection pass routes at a field nothing reads');
    assert.ok(/const targetField = 'target_persona'/.test(pass), 'it must target the live field');
});

check('rejection evidence banks under its own key, never feedbackIds', () => {
    // Both are bare integer arrays into different tenant-shared tables. The wrong key would not
    // throw — it would permanently mark unrelated template_feedback rows as spent.
    const pass = runBody.slice(runBody.indexOf('const rejectionClusters'));
    const evidence = pass.slice(pass.indexOf('evidence: {'), pass.indexOf('});', pass.indexOf('evidence: {')));
    assert.ok(/rejectionIds/.test(evidence), 'the rejection evidence must carry rejectionIds');
    assert.ok(!/feedbackIds/.test(evidence), 'rejection ids must never be written as feedbackIds');

    const writer = sourceOf('src/utils/strategy-proposals.ts');
    assert.ok(/leadRejectFeedback[\s\S]*appliedToTarget/.test(writer), 'rejections are never banked on apply');
});

check('the rejection pass enforces the same envelope as the edit pass', () => {
    const pass = runBody.slice(runBody.indexOf('const rejectionClusters'));
    assert.ok(/claimedField !== targetField/.test(pass), 'the model may answer about another field');
    assert.ok(/isValidValueFor/.test(pass), 'the value shape is unchecked');
    assert.ok(/Array\.isArray\(proposedValue\)/.test(pass),
        'an array persona would be read back as one object and silently mean nothing');
    assert.ok(/hasFeatureByOrg/.test(pass), 'the feature gate is not re-checked in this pass');
});

check('every agent source names its own evidence unit in the review card', () => {
    // ⚠️ The unit used to be a two-way ternary defaulting to "closed deals", so a lead_rejection
    // proposal (8 clicks) announced itself as 8 CLOSED DEALS. Overstating the evidence is the one
    // thing this card must never do — a human applies a real outreach change from it.
    const ui = sourceOf('src/components/assistant-strategy.js');
    const block = ui.slice(ui.indexOf('const UNITS'), ui.indexOf('const bits'));
    assert.ok(block.length > 0, 'the UNITS map is gone — the unit fell back to a generic default again');
    for (const s of PROPOSAL_SOURCES) {
        assert.ok(block.includes(`${s}:`), `${s} has no evidence unit and would borrow another source's`);
    }
    assert.ok(!/closed deals'\s*\)/.test(block), 'no source may fall back to "closed deals"');
});

check('the rejection pass skips before paying for a model call', () => {
    const pass = runBody.slice(runBody.indexOf('const rejectionClusters'));
    const beforeModel = pass.slice(0, pass.indexOf('gatewayGenerate'));
    assert.ok(/no active campaign to retarget/.test(beforeModel),
        'with no campaign there is nothing to write to — proposeChange would refuse anyway');
    assert.ok(/a pending proposal already holds this field/.test(beforeModel), 'the pending check is too late');
});

console.log(`\n${passed} checks passed.`);
