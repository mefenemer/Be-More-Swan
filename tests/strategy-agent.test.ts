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
import { categoryForType, PREF_CATEGORIES } from '../src/utils/notification-prefs';
import { NOTIFICATION_DEFAULTS } from '../src/utils/notification-templates-catalog';
import { landmark } from './landmark';

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
    const block = schemaText.slice(landmark(schemaText, 'export const templateFeedback'));
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

check("the reviewer's note reaches the model, not just the reason label", () => {
    // ⚠️ The regression this exists for: rejectNote was written, stored, shown to humans, and never
    // SELECTED. Measured on staging 2026-08-07 — a proposal declined `too_narrow` with a note naming
    // two specific over-constraints was replaced by one that kept both verbatim. A reason label says
    // a change was wrong; only the note says how.
    const fn = agentSrc.slice(landmark(agentSrc, 'async function priorRejections'));
    const body = fn.slice(0, landmark(fn, '\n}'));
    assert.ok(/note:\s*strategyProposals\.rejectNote/.test(body),
        'priorRejections does not select rejectNote — the note cannot steer what it never reads');
    assert.ok(/r\.note/.test(body), 'the note is selected but never used in the formatted entry');
    // Bounded, not trusted: it is first-party text but it still goes in a prompt.
    assert.ok(/\.slice\(0,\s*\d+\)/.test(body.slice(landmark(body, 'r.note'))),
        'the note is fed unbounded — rejectNote allows 2000 chars, five of them is a prompt of its own');
    // A multi-line note must not read as several separate rejections.
    assert.ok(/replace\(\/\\s\+\/g, ' '\)/.test(body),
        'newlines in a note are not collapsed — one comment would look like several list items');
});

check('the reject form does not promise privacy it no longer provides', () => {
    // ⚠️ The note field used to read "kept for you, never sent to the model". Feeding rejectNote to
    // the prompt made that a lie, and a lie of the worst shape: someone writes something believing
    // it stays between them and their team, and it lands in a model prompt. Copy and behaviour have
    // to move together here.
    const ui = raw('src/components/assistant-strategy.js');
    const form = ui.slice(landmark(ui, 'function rejectForm'), landmark(ui, 'function conflictBlock'));
    const markup = form.replace(/<!--[\s\S]*?-->/g, ' ');
    assert.ok(/data-sa-note/.test(markup), 'the note field is gone — this check tests nothing');
    assert.ok(!/never sent to the model/i.test(markup),
        'the note field still claims it is never sent, but priorRejections now feeds it');
    assert.ok(!/kept for you/i.test(markup), 'the note field still implies the note stays private');
});

check('both prompts tell the model to ACT on the explanation, not just avoid the wording', () => {
    // Feeding the note is half the fix. "Do not repeat them" alone invites a reworded duplicate,
    // which is exactly what staging produced: same geography, same business model, new adjectives.
    const sites = [...agentSrc.matchAll(/These earlier suggestions for this same field were DECLINED[\s\S]{0,400}?rejections\.join/g)];
    assert.equal(sites.length, 2, `the rejection feedback block should appear in both passes, found ${sites.length}`);
    for (const [block] of sites) {
        assert.ok(/instruction/i.test(block), 'the prompt does not frame the explanation as an instruction');
        assert.ok(/correct for it/i.test(block), 'the prompt never asks the model to correct for the stated reason');
    }
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
    // One consolidated workflow drives every staging cron (issue #258).
    const wf = raw('.github/workflows/staging-crons.yml');
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
        const handler = src.slice(landmark(src, 'export default withLambda'));
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

check('the alert is governed by Approvals, not the General fallback', () => {
    // Moved off the product_updates fallback 2026-08-07. Unmapped types land there, so a user who
    // muted product announcements silently stopped receiving strategy approval requests, and the
    // only toggle that could bring them back was labelled "Product, Milestones & Support".
    assert.equal(categoryForType('strategy_proposal_pending').key, 'approvals');
});

check('the alert is attributed to an assistant, or the Approvals toggle is unreachable', () => {
    // 'approvals' is scope:'assistant'. Account Settings filters assistant-scope rows out
    // (workspace.html), so the ONLY surface for this toggle is the Assistant Profile drawer, and
    // the drawer writes a per-assistant override resolved from notifications.assistant_id. Drop the
    // attribution and the row resolves to the workspace-wide value, which no UI can set — the alert
    // would be permanently on, which is worse than sitting in the wrong bucket.
    assert.equal(PREF_CATEGORIES.find((c) => c.key === 'approvals')!.scope, 'assistant');
    const callIdx = runBody.indexOf("createNotification(db, 'strategy_proposal_pending'");
    assert.ok(callIdx !== -1, 'the notification is never sent');
    const callBody = runBody.slice(callIdx, callIdx + 900);
    assert.match(callBody, /assistantId: info\.assistantId/, 'no denormalised assistant link — the preference override cannot bind');
    assert.match(callBody, /metadata: \{ assistantId: info\.assistantId \}/, 'no metadata.assistantId (deep link)');
    // The per-org fan-in has to carry the id for the call site to have one at all.
    assert.match(runBody, /assistantId: prev\?\.assistantId \?\? c\.aiAssistantId/,
        'the per-org collapse drops the assistant id');
});

check('the notification is per org per run, not per proposal', () => {
    // §9.4 — two proposers firing for one org in a single run is two proposals and would otherwise
    // be two alerts about the same visit.
    assert.ok(runBody.includes('proposedByOrg'), 'notifications are not collapsed per org');
    const notifyIdx = landmark(runBody, 'createNotification');
    const loopIdx = runBody.indexOf('for (const [organisationId, info] of proposedByOrg)');
    assert.ok(loopIdx !== -1 && notifyIdx > loopIdx, 'the notification must be sent from the per-org loop, not the per-cluster loop');
});

// ── 5. The human's own save shares the apply path (§5.4) ─────────────────────

check('saveHumanDefault routes through applyStrategyChange, not a direct write', () => {
    const writerSrc = sourceOf('src/utils/strategy-proposals.ts');
    const fnIdx = writerSrc.indexOf('export async function saveHumanDefault');
    assert.ok(fnIdx !== -1, 'saveHumanDefault is missing — the next human-save surface will write the field directly');
    const body = writerSrc.slice(fnIdx, landmark(writerSrc, '\nexport ', fnIdx + 10));
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
    const fn = src.slice(landmark(src, 'async function loadRejectionClusters'));
    const query = fn.slice(0, landmark(fn, 'return rows'));
    assert.ok(/MIN_REJECT_SAMPLE/.test(query), 'no sample threshold');
    assert.ok(/MIN_REJECT_CAMPAIGNS/.test(query), 'a burst inside ONE campaign must not qualify');
    assert.ok(/MIN_REJECT_SPREAD_DAYS/.test(query), 'a burst inside ONE day must not qualify');
    assert.ok(/applied_to_target = false/.test(query), 'spent evidence would fund the same proposal forever');
});

check('every exit path records the run summary', () => {
    // The summary is the ONLY artefact that answers "is this thing even running?" — the run is a
    // background job whose HTTP response is just an ack. It used to be written at the end of the
    // body, so the kill-switch return and any throw left last_run holding the PREVIOUS week's
    // record: identical, in the UI, to a cron that never fired. That is how a 42809 went unnoticed
    // on 2026-08-06. recordLastRun must live in the wrapper's finally, and nowhere else.
    const src = sourceOf('netlify/functions/autonomous-strategy-agent.ts');
    const wrapper = src.slice(
        landmark(src, 'export async function runStrategyAgent'),
        landmark(src, 'async function executeRun'),
    );
    assert.ok(/finally\s*\{[^}]*recordLastRun/.test(wrapper),
        'recordLastRun must be in a finally so a throw still records');
    assert.ok(/catch[\s\S]*haltReason[\s\S]*throw/.test(wrapper),
        'a thrown error must be named in haltReason AND re-thrown, not swallowed');

    const body = src.slice(landmark(src, 'async function executeRun'), landmark(src, 'async function recordLastRun'));
    assert.ok(!/recordLastRun\(/.test(body),
        'the body must not record its own summary — the finally owns it, or exits diverge again');
    assert.ok(/isGlobalAiDisabled\(\)\)\s*\{[\s\S]{0,200}?haltReason/.test(body),
        'the kill-switch must name itself, or a deliberate stop reads as "nothing to learn from"');
});

check('a halted run is never dressed up as a run that found nothing', () => {
    // Both are zeroes. If the strip renders them identically, it asserts the very thing it exists
    // to disprove. And the reason string must NOT cross the API: it carries a thrown error message.
    const api = sourceOf('netlify/functions/strategy-proposals.ts');
    const projection = api.slice(landmark(api, 'async function lastStrategyRun'));
    assert.ok(/halted:\s*typeof r\.haltReason === 'string'/.test(projection),
        'the API must expose halted as a derived BOOLEAN');
    assert.ok(!/haltReason:\s*(String\(|r\.haltReason)/.test(projection),
        'the raw haltReason must never be sent to a tenant — it can quote SQL and table names');

    const ui = readFileSync(join(root, 'src/components/assistant-strategy.js'), 'utf8');
    const line = ui.slice(landmark(ui, 'function lastRunLine'), landmark(ui, 'function emptyState'));
    assert.ok(/if \(lr\.halted\)/.test(line), 'the strip must branch on halted');
    // ⚠️ Anchor on code-only text. The prose above the branch quotes the found-nothing wording, so
    // an indexOf for that phrase matches the COMMENT and measures nothing — the same positional
    // -anchor trap that silently re-pointed two checks in tests/lead-reject-reasons.test.ts.
    assert.ok(landmark(line, 'if (lr.halted)') < landmark(line, 'const outcome'),
        'the halted branch must return before the outcome wording is computed');
});

check('the rejection query never hands a bare JS array to = ANY()', () => {
    // Shipped broken 2026-08-06 and threw on EVERY run. Interpolating a JS array into a drizzle
    // sql template expands it to a parenthesised PARAMETER LIST, ($1, $2, ...) — a row constructor,
    // not an array — and = ANY(row) is rejected by Postgres with 42809. Typecheck passes, every
    // unit check passes, and the only symptom is that the run dies before recordLastRun, leaving
    // strategy_agent.last_run frozen at the previous week: identical, in the UI, to a cron that
    // never fired. An explicit ARRAY[...]::text[] built with sql.join is the only correct form.
    const src = sourceOf('netlify/functions/autonomous-strategy-agent.ts');
    const fn = src.slice(landmark(src, 'async function loadRejectionClusters'));
    const query = fn.slice(0, landmark(fn, 'return rows'));
    assert.ok(
        !/=\s*ANY\(\$\{(?!\s*sql)/.test(query),
        '= ANY() must not receive an interpolated JS array — use ARRAY[...]::text[] via sql.join',
    );
    assert.ok(/ANY\(ARRAY\[/.test(query), 'the reason list must be an explicit ARRAY[...] literal');
    assert.ok(/::text\[\]/.test(query), 'the ARRAY literal must be cast to text[]');
});

check('the rejection proposer never targets the field nothing reads', () => {
    // discovery_query_themes is the intuitive home for "the queries keep finding directories", and
    // it is a trap: no reader exists, so a proposal there applies cleanly and changes nothing while
    // telling the user they have retargeted.
    const pass = runBody.slice(landmark(runBody, 'const rejectionClusters'));
    assert.ok(!/discovery_query_themes/.test(pass), 'the rejection pass routes at a field nothing reads');
    assert.ok(/const targetField = 'target_persona'/.test(pass), 'it must target the live field');
});

check('rejection evidence banks under its own key, never feedbackIds', () => {
    // Both are bare integer arrays into different tenant-shared tables. The wrong key would not
    // throw — it would permanently mark unrelated template_feedback rows as spent.
    const pass = runBody.slice(landmark(runBody, 'const rejectionClusters'));
    const evidence = pass.slice(landmark(pass, 'evidence: {'), landmark(pass, '});', landmark(pass, 'evidence: {')));
    assert.ok(/rejectionIds/.test(evidence), 'the rejection evidence must carry rejectionIds');
    assert.ok(!/feedbackIds/.test(evidence), 'rejection ids must never be written as feedbackIds');

    const writer = sourceOf('src/utils/strategy-proposals.ts');
    assert.ok(/leadRejectFeedback[\s\S]*appliedToTarget/.test(writer), 'rejections are never banked on apply');
});

check('the banking call is REACHABLE for every source, not just edit_pattern', () => {
    // ⚠️ This is the check the one above could not make, and the gap was real: the assertion that
    // `leadRejectFeedback … appliedToTarget` EXISTS passed happily while the call site read
    // `if (p.source === 'edit_pattern') await bankEvidence(...)`. Only lead_rejection proposals
    // carry rejectionIds, so that guard excluded the single source the branch was written for, and
    // the whole half was dead. Measured on staging 2026-08-07: proposal #6 applied cleanly and left
    // all 8 lead_reject_feedback rows applied_to_target = false, which would have re-proposed a
    // retarget of the persona just applied, every week, forever.
    //
    // A source scan cannot see a guard UPSTREAM of a call, so assert on the call site itself.
    const writer = sourceOf('src/utils/strategy-proposals.ts');
    const apply = writer.slice(landmark(writer, 'export async function applyStrategyChange'));
    const body = apply.slice(0, landmark(apply, '\n}'));

    const callLine = body.split('\n').find((l) => l.includes('bankEvidence('));
    assert.ok(callLine, 'applyStrategyChange no longer banks its evidence at all');
    assert.equal(callLine.trim(), 'await bankEvidence(db, p.evidence);',
        `the banking call is not a bare statement — "${callLine.trim()}" can hide a source guard`);
    assert.ok(!/p\.source/.test(body),
        'applyStrategyChange branches on p.source; banking must stay source-agnostic');

    // The guard belongs INSIDE bankEvidence, keyed by what the blob contains — that is what makes
    // an unconditional call safe for both sources and for the next one added.
    const bank = writer.slice(landmark(writer, 'async function bankEvidence'));
    const bankBody = bank.slice(0, landmark(bank, '\n}\n'));
    assert.ok(/if \(feedbackIds\.length\)/.test(bankBody), 'bankEvidence must no-op on a missing feedbackIds');
    assert.ok(/if \(rejectionIds\.length\)/.test(bankBody), 'bankEvidence must no-op on a missing rejectionIds');
});

check('every proposal source can spend its evidence', () => {
    // Whole point of the fix: a source whose ids nothing banks proposes from the same rows forever.
    // PROPOSAL_SOURCES is the closed list, so a new source added without a banking key fails here
    // rather than silently looping in production.
    const KEY_FOR_SOURCE: Record<string, string> = {
        edit_pattern: 'feedbackIds',
        lead_rejection: 'rejectionIds',
        human: '',     // hand-made, funded by no evidence rows — nothing to spend.
        win_loss: '',  // declared in the vocabulary but NOT produced by anything yet, so nothing to
                       // bank. The assertion below is what stops that staying true silently.
    };
    const bank = sourceOf('src/utils/strategy-proposals.ts');
    for (const source of PROPOSAL_SOURCES) {
        const key = KEY_FOR_SOURCE[source];
        assert.notEqual(key, undefined,
            `PROPOSAL_SOURCES gained "${source}" — say which evidence key banks it, or "" if none`);
        if (key) {
            assert.ok(bank.includes(`blob.${key}`),
                `"${source}" evidence is keyed by ${key}, which bankEvidence never reads`);
        }
    }

    // If a proposer starts writing win_loss, its evidence needs a banking key decided WITH it —
    // otherwise it inherits exactly the bug this block exists for.
    const written = [...agentSrc.matchAll(/source: '([a-z_]+)'/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(written)].sort(), ['edit_pattern', 'lead_rejection'],
        'a new proposal source is being written — give it an evidence key in KEY_FOR_SOURCE first');
});

check('the rejection pass enforces the same envelope as the edit pass', () => {
    const pass = runBody.slice(landmark(runBody, 'const rejectionClusters'));
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
    const block = ui.slice(landmark(ui, 'const UNITS'), landmark(ui, 'const bits'));
    assert.ok(block.length > 0, 'the UNITS map is gone — the unit fell back to a generic default again');
    for (const s of PROPOSAL_SOURCES) {
        assert.ok(block.includes(`${s}:`), `${s} has no evidence unit and would borrow another source's`);
    }
    assert.ok(!/closed deals'\s*\)/.test(block), 'no source may fall back to "closed deals"');
});

check('the rejection pass skips before paying for a model call', () => {
    const pass = runBody.slice(landmark(runBody, 'const rejectionClusters'));
    const beforeModel = pass.slice(0, landmark(pass, 'gatewayGenerate'));
    assert.ok(/no active campaign to retarget/.test(beforeModel),
        'with no campaign there is nothing to write to — proposeChange would refuse anyway');
    assert.ok(/a pending proposal already holds this field/.test(beforeModel), 'the pending check is too late');
});

// ── The per-assistant consent switch ─────────────────────────────────────────
//
// The plan feature entitles a WORKSPACE. Without a second gate, granting it opts in every eligible
// assistant in that workspace at once, with no way to pilot the agent on one — which matters here
// because the rejection pass rewrites target_persona, and that redirects cold outreach at real
// strangers. Semantics of the flag itself live in tests/strategy-proposals.test.ts; this file
// asserts that both passes actually consult it, and that nothing pays a model call first.

check('both passes gate on per-assistant consent, not only on the plan feature', () => {
    const editPass = runBody.slice(landmark(runBody, 'for (const c of clusters'), landmark(runBody, 'const rejectionClusters'));
    const rejectionPass = runBody.slice(landmark(runBody, 'const rejectionClusters'));
    for (const [label, pass] of [['edit', editPass], ['rejection', rejectionPass]] as const) {
        assert.ok(pass.length > 0, `the ${label} pass could not be located — this check tests nothing`);
        assert.ok(/isStrategyAgentEnabledForAssistant/.test(pass),
            `the ${label} pass proposes for assistants that were explicitly switched off`);
        // ⚠️ Consent must be read BEFORE the model call, not just before the write. A skip that
        // happens after generation still spends the money and still reads the evidence.
        const beforeModel = pass.slice(0, landmark(pass, 'gatewayGenerate'));
        assert.ok(/isStrategyAgentEnabledForAssistant/.test(beforeModel),
            `the ${label} pass checks consent after paying for the model call`);
    }
});

check('the rejection pass loads the context it needs to check consent', () => {
    // ⚠️ This pass reads its current value from discovery_campaigns, so onboardingContext is
    // selected ONLY for the consent gate. Drop the column from the select and the gate silently
    // reads undefined — which, because the default is ON, means it never skips anything.
    const rejectionPass = runBody.slice(landmark(runBody, 'const rejectionClusters'));
    const select = rejectionPass.slice(landmark(rejectionPass, 'const [assistant]'));
    assert.ok(/onboardingContext:\s*aiAssistants\.onboardingContext/.test(select.slice(0, 400)),
        'the rejection pass no longer selects onboardingContext — its consent gate always passes');
});

check('the consent switch is on the assistant profile, defaulting ON', () => {
    const html = raw('assistant-detail.html');
    assert.ok(html.includes('id="module-strategy-agent"'), 'the Operational Setup card is gone');
    assert.ok(html.includes('id="edit_strategy_agent"'), 'the consent switch input is gone');
    // The `edit_` prefix is not cosmetic: attachAutoSave() binds on [id^="edit_"], so a renamed
    // input keeps rendering and silently stops saving.
    assert.ok(/id="edit_strategy_agent"/.test(html), 'the input must keep the edit_ prefix to autosave');

    const js = sourceOf('assistants.js');
    // Default ON in BOTH directions. `?.checked === true` would write false whenever the card is
    // not on the page, opting out every role that does not render it.
    assert.ok(/strategyAgentEnabled:\s*document\.getElementById\('edit_strategy_agent'\)\?\.checked !== false/.test(js),
        'the collector does not default a missing switch to ON');
    assert.ok(/strategyAgentEl\.checked = ctx\.strategyAgentEnabled !== false/.test(js),
        'the hydrator does not default an absent stored value to ON');
});

check('the locked switch uses a utility the compiled CSS actually has', () => {
    // ⚠️ style.css is a BUILT artifact and rebuilding it churns unrelated classes across the whole
    // file, so a card may only use variants that are already compiled. `peer-disabled:opacity-50`
    // is not one of them: the switch would look identical enabled and disabled, and the only
    // signal that a plan gate is in force would be that clicking does nothing.
    const html = raw('assistant-detail.html');
    const cardStart = html.indexOf('id="module-strategy-agent"');
    assert.ok(cardStart !== -1, 'the card is gone — this check tests nothing');
    // HTML comments stripped first: this card's comment NAMES the variants it must not use, and a
    // scan that reads prose as markup fails on the explanation rather than on the code.
    const card = html.slice(cardStart, landmark(html, 'TAB: Creative Strategy', cardStart))
        .replace(/<!--[\s\S]*?-->/g, ' ');
    const variants = [...card.matchAll(/\bpeer-disabled:[\w-]+/g)].map((m) => m[0]);
    assert.ok(variants.length > 0, 'the disabled switch has no visual treatment at all');
    const css = raw('style.css');
    for (const v of variants) {
        assert.ok(css.includes(v.replace(':', '\\:')), `${v} is not in the compiled style.css — the disabled switch renders identically to the enabled one`);
    }
});

check('the consent card is gated by the registry, never by a roleKey', () => {
    // The point of the pair: a future role that inherits strategyTab inherits the switch with it.
    // A roleKey test here would give that role a Strategy tab and no way to opt out of it.
    const js = sourceOf('assistants.js');
    const block = js.slice(landmark(js, 'const strategy = cfg.strategyTab'));
    const gate = block.slice(0, landmark(block, 'if (strategy)'));
    assert.ok(/toggle\('module-strategy-agent',\s*!!strategy\)/.test(gate),
        'the card is not toggled from the same registry declaration as the tab');
    assert.ok(!/lead_qualifier/.test(gate), 'the card is gated on a roleKey — future roles will not inherit it');
});

check('the entitlement reaches the card, which cannot resolve it alone', () => {
    // There is no client-side feature map. assistant-strategy.js is the only place that learns
    // whether the workspace has the plan feature, so it has to hand the answer over or the 🔒 chip
    // never appears.
    const ui = sourceOf('src/components/assistant-strategy.js');
    assert.ok(/_setStrategyAgentEntitled/.test(ui), 'the component never reports the plan gate to the profile card');
    const js = sourceOf('assistants.js');
    assert.ok(/window\._setStrategyAgentEntitled\s*=/.test(js), 'nothing on the profile page receives it');
    // Unresolved must read as entitled: a chip that appears late is a cosmetic delay, a switch
    // disabled by a failed fetch is a setting the user cannot reach.
    assert.ok(/let _strategyAgentEntitled = true/.test(js), 'the card defaults to locked before the gate resolves');
});

console.log(`\n${passed} checks passed.`);
