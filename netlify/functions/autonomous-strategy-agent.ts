// netlify/functions/autonomous-strategy-agent.ts
// Phase 5a slice 2 — the weekly Strategy Agent run: the edit-pattern proposer plus the expiry
// sweep. Design: docs/lead-generator-revenue-engine-plan.md §7, docs/strategy-agent-plan.md §4.
//
//   for each (org, assistant) with ≥ MIN_EDIT_SAMPLE unbanked template_feedback rows in the window
//     → GROUP BY edit_reason, take the modal reason; skip unless IT alone clears the threshold
//     → skip if a pending proposal already exists for the target field (§3.2)
//     → LLM rewrites the playbook; output is parsed to {targetField, proposedValue} and NOTHING else
//     → validate against the frozen change envelope
//     → persist status='pending' — an INERT row
//   then one notification per org, and the expiry sweep.
//
// ── Clone the optimizer's structure, not its ending ──────────────────────────
// autonomous-goal-optimizer.ts writes the field, then audits, then notifies. THIS DOES NOT WRITE
// THE FIELD. It stops at persisting a pending proposal, and a human applies it from the Strategy
// tab having read the diff. §7.1 and §2.4 both turn on that distinction and it is the whole point
// of the phase: a content-tone change affects the org's own output; an outreach playbook change
// changes what real strangers receive.
//
// ── Why the model's output is safe to store ──────────────────────────────────
// Untrusted text is adjacent to this prompt (§5.2) and, unlike memory-query, this function writes.
// The mitigation is the SHAPE of what it can write, not the prompt:
//   1. The output is parsed to {targetField, proposedValue} and nothing else is read from it.
//      Evidence is computed in SQL and attached by the persist path — a model that invents
//      "sampleSize: 400" must not be able to launder it into the UI.
//   2. targetField is validated against a frozen map, and additionally must equal the field we
//      asked about. Reject, never clamp.
//   3. The row is INERT. status='pending' changes no behaviour anywhere.
//   4. No sends, no tools, no writes outside strategy_proposals. tests/strategy-agent.test.ts
//      asserts that against the source.
//
// Message BODIES are deliberately not in the prompt — only `diff_summary`, which is computed
// (§3.3), never LLM-written, and never carries prospect prose. The reasoning that would justify
// including bodies ("more context, better rewrite") is exactly how prospect-authored text reaches
// a model whose output gets stored.

import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, discoveryCampaigns, strategyProposals } from '../../db/schema';
import { createNotification } from '../../src/utils/notify';
import { hasFeatureByOrg } from '../../src/utils/plan-features';
import { CONFIG_KEYS, isGlobalAiDisabled, setPlatformConfig } from '../../src/utils/platform-config';
import { triggerStrategyAgentRun } from '../../src/utils/trigger-strategy-agent';
import { gatewayGenerate } from '../../src/lib/ai-gateway';
import { parseModelJson } from '../../src/utils/model-json';
import { withLambda } from '@netlify/aws-lambda-compat';
import { EDIT_REASON_LABELS, MIN_EDIT_SAMPLE, isEditReason } from '../../src/config/template-feedback';
import {
    LEAD_REJECT_REASONS_FOR_TARGETING, LEAD_REJECT_REASON_LABELS, MIN_REJECT_CAMPAIGNS,
    MIN_REJECT_SAMPLE, MIN_REJECT_SPREAD_DAYS, isLeadRejectReason, type LeadRejectReason,
} from '../../src/config/lead-reject-reasons';
import {
    REJECT_REASONS_FED_TO_MODEL, STRATEGY_AGENT_FEATURE, isValidValueFor, tunableField,
} from '../../src/config/strategy-proposals';
import { expirePendingProposals, proposeChange } from '../../src/utils/strategy-proposals';

/** Assistants considered per run. One proposal each at most, so this is a generous ceiling. */
const BATCH = 50;

/**
 * Wall-clock budget for the whole run.
 *
 * ⚠️ ONE ORG COSTS ~50 SECONDS — almost all of it the model rewriting the playbook. Measured on
 * staging 2026-08-03: cold start 17:40:50, proposal written 17:41:39. That is why this function is
 * driven by a `-background` worker rather than run inline: a synchronous Netlify function gets 10s
 * by default and 26s at the absolute maximum, so the scheduled run was being killed every time. It
 * only ever produced a proposal because the staging workflow's `curl --retry` handed it a second
 * attempt and the killed invocation's write had already committed — luck, not design.
 *
 * Background functions get 15 minutes. This stops well short of that and leaves the remaining
 * clusters for next week, because a run killed by the platform reports nothing at all, whereas one
 * that stops on its own terms records what it did and why (`truncated: true`).
 */
const RUN_BUDGET_MS = 11 * 60_000;

/** Stop starting new clusters once a single one could no longer finish inside the budget. */
const PER_CLUSTER_RESERVE_MS = 90_000;

/**
 * How far back edits count.
 *
 * 90 days, not all time: a playbook change six months ago makes the edits before it evidence about
 * a template that no longer exists. Long enough that a low-volume org still accumulates a sample.
 */
const WINDOW_DAYS = 90;

/**
 * Which field an edit-pattern proposal targets.
 *
 * Every EDIT_REASON is a statement about the opening email — its tone, its claim, its length, its
 * subject line — so they all point at one field. Declared as a map rather than a constant so that
 * adding a reason forces a decision about where it lands, instead of silently inheriting this one.
 * (`objection_playbook` is NOT a target here: these are edits to opening drafts, not to replies.)
 */
const TARGET_FIELD_FOR_REASON: Record<string, string> = {
    too_formal: 'outreach_playbook',
    too_casual: 'outreach_playbook',
    wrong_value_prop: 'outreach_playbook',
    wrong_pain_point: 'outreach_playbook',
    too_long: 'outreach_playbook',
    factually_wrong: 'outreach_playbook',
    bad_subject: 'outreach_playbook',
    personalisation_missing: 'outreach_playbook',
    // `other` never reaches here — it is filtered out of the aggregate, being a bucket rather than
    // a signal (src/config/template-feedback.ts).
};

interface Cluster {
    organisationId: number;
    aiAssistantId: number;
    editReason: string;
    n: number;
    feedbackIds: number[];
    diffs: string[];
}

/**
 * A run of rejections sharing one reason — the targeting counterpart of `Cluster`.
 *
 * Kept as its own type rather than widened into `Cluster` with nullable members: the two carry
 * genuinely different evidence (diff summaries vs rejected company names), fund different fields,
 * and bank into different tables. A union with six optional properties would make every use site
 * re-derive which half it is holding.
 */
interface RejectionCluster {
    organisationId: number;
    aiAssistantId: number;
    reason: LeadRejectReason;
    n: number;
    rejectionIds: number[];
    /** Distinct campaigns the rejections came from — half of the burst guard. */
    campaigns: number;
    /** Days between the first and last rejection in the cluster — the other half. */
    spreadDays: number;
    /** Company names, for the model to see what it kept surfacing. */
    examples: string[];
}

/**
 * Edits grouped by (org, assistant, reason), strongest cluster first.
 *
 * One query across every org rather than a query per org: the run is weekly and the whole table is
 * small, and iterating orgs first would issue one round trip per tenant to discover that almost all
 * of them have nothing.
 *
 * `applied_to_template = false` is what stops spent evidence funding a second proposal, and
 * `edit_reason <> 'other'` drops the bucket that cannot be clustered.
 *
 * ⚠️ The assistant comes from `tf.ai_assistant_id` FIRST, with the message→thread path only as a
 * fallback — and the LEFT joins matter. The ⭐ review-time path writes `lead_message_id = NULL` by
 * design (the edit precedes the send), and it is the only writer today, so inner-joining through
 * lead_messages would silently match zero rows and the proposer would find no clusters, forever.
 */
async function loadClusters(db: ReturnType<typeof getDb>): Promise<Cluster[]> {
    const rows = await db.execute<{
        organisation_id: number; ai_assistant_id: number; edit_reason: string;
        n: number; feedback_ids: number[]; diffs: (string | null)[];
    }>(sql`
        SELECT tf.organisation_id,
               COALESCE(tf.ai_assistant_id, lt.ai_assistant_id) AS ai_assistant_id,
               tf.edit_reason,
               count(*)::int              AS n,
               array_agg(tf.id)           AS feedback_ids,
               array_agg(tf.diff_summary) AS diffs
          FROM template_feedback tf
          LEFT JOIN lead_messages lm ON lm.id = tf.lead_message_id
          LEFT JOIN lead_threads  lt ON lt.id = lm.lead_thread_id
         WHERE tf.applied_to_template = false
           AND tf.edit_reason IS NOT NULL
           AND tf.edit_reason <> 'other'
           AND COALESCE(tf.ai_assistant_id, lt.ai_assistant_id) IS NOT NULL
           AND tf.created_at > now() - (${WINDOW_DAYS} * interval '1 day')
         GROUP BY 1, 2, 3
        HAVING count(*) >= ${MIN_EDIT_SAMPLE}
         ORDER BY 1, 2, count(*) DESC`);

    return rows.map((r) => ({
        organisationId: r.organisation_id,
        aiAssistantId: r.ai_assistant_id,
        editReason: r.edit_reason,
        n: r.n,
        feedbackIds: (r.feedback_ids ?? []).filter((x): x is number => Number.isInteger(x)),
        diffs: (r.diffs ?? []).filter((d): d is string => typeof d === 'string' && d.trim().length > 0),
    }));
}

/**
 * Rejection runs, strongest first — the evidence behind a `lead_rejection` proposal.
 *
 * ⚠️ THREE GATES, NOT ONE. `count(*) >= MIN_REJECT_SAMPLE` alone is nearly worthless here: a
 * reviewer clearing one bad run rejects twenty leads in an afternoon and clears any threshold from
 * a single misconfigured search. So the HAVING also demands spread — more than one campaign, or
 * more than one day — because "the same complaint twice, independently" is the actual signal.
 *
 * `applied_to_target = false` stops spent evidence funding a second retarget, and the reason filter
 * drops `other` plus the three reasons that are facts about a lead rather than faults in the
 * targeting (see LEAD_REJECT_REASONS_FOR_TARGETING).
 *
 * The company names are joined in for context only. They are the org's OWN discovery output rather
 * than prospect-authored prose, which is why they may go in the prompt at all — the same line the
 * edit proposer draws when it sends diff summaries and never message bodies.
 */
/*
 * ⚠️ The reason list is built with sql.join into an explicit ARRAY[...]::text[] — do NOT "simplify"
 * it back to = ANY(<array>). Interpolating a JS array into a drizzle sql template expands it into a
 * parenthesised PARAMETER LIST, ($1, $2, ...), which is a row constructor rather than an array;
 * = ANY(row) is invalid and Postgres rejects it with 42809 (make_scalar_array_op). It threw on
 * EVERY run, and because this loader sits before recordLastRun the exception killed the whole run
 * and left strategy_agent.last_run frozen at the previous week — indistinguishable, from the UI,
 * from a cron that never fired. Typecheck and the unit tests both pass either way; only a real
 * Postgres round trip catches it.
 */
async function loadRejectionClusters(db: ReturnType<typeof getDb>): Promise<RejectionCluster[]> {
    const rows = await db.execute<{
        organisation_id: number; ai_assistant_id: number; reason: string; n: number;
        rejection_ids: number[]; campaigns: number; spread_days: number; examples: (string | null)[];
    }>(sql`
        SELECT lrf.organisation_id,
               lrf.ai_assistant_id,
               lrf.reason,
               count(*)::int                                    AS n,
               array_agg(lrf.id)                                AS rejection_ids,
               count(DISTINCT lrf.campaign_id)::int             AS campaigns,
               EXTRACT(DAY FROM (max(lrf.created_at) - min(lrf.created_at)))::int AS spread_days,
               array_agg(DISTINCT ar.title)                     AS examples
          FROM lead_reject_feedback lrf
          LEFT JOIN assistant_records ar ON ar.id = lrf.assistant_record_id
         WHERE lrf.applied_to_target = false
           AND lrf.reason = ANY(ARRAY[${sql.join(
               LEAD_REJECT_REASONS_FOR_TARGETING.map((r) => sql`${r}`), sql`, `,
           )}]::text[])
           AND lrf.created_at > now() - (${WINDOW_DAYS} * interval '1 day')
         GROUP BY 1, 2, 3
        HAVING count(*) >= ${MIN_REJECT_SAMPLE}
           AND (count(DISTINCT lrf.campaign_id) >= ${MIN_REJECT_CAMPAIGNS}
                OR EXTRACT(DAY FROM (max(lrf.created_at) - min(lrf.created_at))) >= ${MIN_REJECT_SPREAD_DAYS})
         ORDER BY 1, 2, count(*) DESC`);

    return rows.flatMap((r) => {
        // A value the vocabulary no longer contains — the row survives in the table, but it can no
        // longer be reasoned about, so it must not reach the prompt as a bare string.
        if (!isLeadRejectReason(r.reason)) return [];
        return [{
            organisationId: r.organisation_id,
            aiAssistantId: r.ai_assistant_id,
            reason: r.reason,
            n: r.n,
            rejectionIds: (r.rejection_ids ?? []).filter((x): x is number => Number.isInteger(x)),
            campaigns: r.campaigns ?? 0,
            spreadDays: r.spread_days ?? 0,
            examples: (r.examples ?? []).filter((x): x is string => typeof x === 'string' && !!x.trim()).slice(0, 15),
        }];
    });
}

/** One rejection cluster per assistant — the modal reason, same rule as the edit proposer. */
function modalRejectionPerAssistant(clusters: RejectionCluster[]): RejectionCluster[] {
    const seen = new Set<string>();
    const out: RejectionCluster[] = [];
    for (const c of clusters) {
        const key = `${c.organisationId}:${c.aiAssistantId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(c);
    }
    return out;
}

/**
 * The modal cluster per assistant.
 *
 * §4.1: "take the modal reason; skip if it does not clear the threshold on its own." Summing
 * across reasons would let five unrelated complaints look like one pattern, which is precisely the
 * noise MIN_EDIT_SAMPLE exists to exclude — the ORDER BY above already puts the strongest first.
 */
function modalPerAssistant(clusters: Cluster[]): Cluster[] {
    const seen = new Set<string>();
    const out: Cluster[] = [];
    for (const c of clusters) {
        const key = `${c.organisationId}:${c.aiAssistantId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!isEditReason(c.editReason)) continue;      // a value the vocabulary no longer contains
        if (c.n < MIN_EDIT_SAMPLE) continue;            // belt and braces against the HAVING clause
        out.push(c);
    }
    return out;
}

/** Prior rejections for this field, so declining teaches the loop rather than being a dead end. */
async function priorRejections(
    db: ReturnType<typeof getDb>, organisationId: number, targetField: string,
): Promise<string[]> {
    const rows = await db
        .select({ reason: strategyProposals.rejectReason, value: strategyProposals.proposedValue })
        .from(strategyProposals)
        .where(and(
            eq(strategyProposals.organisationId, organisationId),
            eq(strategyProposals.targetField, targetField),
            eq(strategyProposals.status, 'rejected'),
            isNotNull(strategyProposals.rejectReason),
            // `other` carries only a free-text note, and one org's idiosyncratic phrasing in a
            // prompt is poison rather than signal (§7.1). The note stays visible to humans.
            inArray(strategyProposals.rejectReason, [...REJECT_REASONS_FED_TO_MODEL]),
        ))
        .orderBy(desc(strategyProposals.decidedAt))
        .limit(5);

    return rows.map((r) => {
        const text = typeof r.value === 'string' ? r.value : JSON.stringify(r.value);
        return `- Rejected as "${r.reason}": ${String(text).slice(0, 400)}`;
    });
}

/** The assistant's current value for a text-valued tunable field. */
function currentText(ctx: unknown, key: string): string {
    const o = (ctx && typeof ctx === 'object' && !Array.isArray(ctx) ? ctx : {}) as Record<string, unknown>;
    const v = o[key];
    return typeof v === 'string' ? v : '';
}

export interface StrategyAgentResult {
    clusters: number;
    proposed: number;
    skipped: number;
    expired: number;
    notified: number;
    /**
     * Why each cluster was skipped, in order — returned, not just logged.
     *
     * ⚠️ This exists because `skipped: 1` is otherwise unfalsifiable. There are six ways to skip
     * and they are indistinguishable in the summary, so "the agent proposed nothing" cannot be told
     * apart from "the agent is broken". The console lines are the natural place for that, EXCEPT
     * this function is invoked over HTTP by a GitHub workflow that prints the response body, and
     * the platform's function logs do not reliably surface a scheduled invocation's stdout. So the
     * answer travels back with the response, where the caller definitely sees it.
     *
     * Carries no tenant data — a reason string, an org id and a field name.
     */
    skipReasons: string[];
    /** True when the run stopped on its own budget with clusters left. They wait for next week. */
    truncated: boolean;
}

/**
 * One full run. Exported so run-strategy-agent.ts can drive it over HTTP on staging, where Netlify
 * never fires scheduled functions on a branch deploy.
 */
export async function runStrategyAgent(): Promise<StrategyAgentResult> {
    const db = getDb();
    const startedAt = Date.now();
    const result: StrategyAgentResult = {
        clusters: 0, proposed: 0, skipped: 0, expired: 0, notified: 0, skipReasons: [], truncated: false,
    };

    // The expiry sweep runs FIRST and unconditionally — it is one statement, it costs nothing, and
    // it must not be skippable by an early return further down. Global (no org filter): this run is
    // already the only thing that lapses proposals, and a proposal in a workspace whose feature was
    // switched off should still stop being actionable. Computing expiry on read instead would need
    // the same predicate in the UI, the notification and the aggregate — and one would forget it.
    result.expired = await expirePendingProposals(db);

    // A global AI kill-switch must stop the model call, not the housekeeping above.
    if (await isGlobalAiDisabled()) return result;

    const clusters = modalPerAssistant(await loadClusters(db));
    result.clusters = clusters.length;

    const featureByOrg = new Map<number, boolean>();
    // One notification per ORG per RUN, not per proposal (§9.4). Two proposers firing for one org
    // in a single run is two proposals and would otherwise be two alerts about the same visit.
    const proposedByOrg = new Map<number, { count: number; summary: string; assistantName: string }>();

    // Every skip records WHY. Six paths reach `skipped`, and without this the summary cannot
    // distinguish "correctly proposed nothing" from "silently broken" — the difference that
    // matters most for a job that is expected to do nothing for months.
    const skip = (why: string, extra?: Record<string, unknown>) => {
        result.skipped++;
        const detail = extra ? ` ${JSON.stringify(extra)}` : '';
        result.skipReasons.push(`${why}${detail}`);
    };

    for (const c of clusters.slice(0, BATCH)) {
        // Stop cleanly rather than being killed mid-cluster. A platform kill reports nothing; this
        // records what was done and that more is waiting.
        if (Date.now() - startedAt > RUN_BUDGET_MS - PER_CLUSTER_RESERVE_MS) {
            result.truncated = true;
            console.warn('[strategy-agent] run budget reached; remaining clusters wait for the next run', {
                done: result.proposed + result.skipped, total: clusters.length,
            });
            break;
        }

        const where = { org: c.organisationId, assistant: c.aiAssistantId, reason: c.editReason };

        // Eligibility can lapse — a workspace can lose the feature between runs. Re-check per run,
        // cached per org, exactly as the optimizer re-checks the tier.
        let enabled = featureByOrg.get(c.organisationId);
        if (enabled === undefined) {
            enabled = await hasFeatureByOrg(db, c.organisationId, STRATEGY_AGENT_FEATURE);
            featureByOrg.set(c.organisationId, enabled);
        }
        // The expected state for almost every org: the feature is default-off.
        if (!enabled) { skip('feature not enabled for this org', where); continue; }

        const targetField = TARGET_FIELD_FOR_REASON[c.editReason];
        const field = tunableField(targetField);
        if (!field) { skip('edit reason maps to no tunable field', { ...where, targetField }); continue; }

        // Skip early if a pending proposal already holds this field's one slot. proposeChange()
        // would catch the conflict anyway, but paying for a model call to discover that is waste.
        const [existing] = await db
            .select({ id: strategyProposals.id })
            .from(strategyProposals)
            .where(and(
                eq(strategyProposals.organisationId, c.organisationId),
                eq(strategyProposals.targetField, targetField),
                eq(strategyProposals.status, 'pending'),
            ))
            .limit(1);
        if (existing) { skip('a pending proposal already holds this field', { ...where, targetField }); continue; }

        const [assistant] = await db
            .select({ id: aiAssistants.id, name: aiAssistants.name, onboardingContext: aiAssistants.onboardingContext })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, c.aiAssistantId), eq(aiAssistants.organisationId, c.organisationId)))
            .limit(1);
        if (!assistant) { skip('assistant not found in this org', where); continue; }

        const current = currentText(assistant.onboardingContext, field.key);
        const rejections = await priorRejections(db, c.organisationId, targetField);
        const reasonLabel = EDIT_REASON_LABELS[c.editReason as keyof typeof EDIT_REASON_LABELS] ?? c.editReason;

        let proposedValue = '';
        let claimedField = '';
        try {
            const { text, stopReason } = await gatewayGenerate({
                system:
                    `You improve the outreach playbook a sales assistant writes cold emails from.\n\n`
                    + `A human reviewer edited ${c.n} drafted emails before sending them, and gave the SAME reason `
                    + `every time: "${reasonLabel}". Rewrite the playbook so the next draft does not need that edit.\n\n`
                    + `Rules:\n`
                    + `- Keep everything that is working. You are correcting one recurring fault, not starting over.\n`
                    + `- Write instructions for how to WRITE the email, not an email.\n`
                    + `- Be concrete enough that two different drafts written from it would both avoid the fault.\n`
                    + (rejections.length
                        ? `- These earlier suggestions for this same field were DECLINED. Do not repeat them:\n${rejections.join('\n')}\n`
                        : '')
                    + `\nRespond ONLY with JSON: {"targetField":"${targetField}","proposedValue":"<the rewritten playbook>"}`,
                messages: [{
                    role: 'user',
                    content:
                        `Current ${field.label}:\n${current || '(unset)'}\n\n`
                        // Diff summaries only — computed strings like "kept 12% of the wording".
                        // Message bodies would carry prospect-influenced prose into the prompt.
                        + `How much of each draft survived the edit:\n`
                        + (c.diffs.length ? c.diffs.slice(0, 20).map((d) => `- ${d}`).join('\n') : '- (not recorded)'),
                }],
                // A playbook rewrite is prose with several concrete rules in it, and the whole
                // response has to fit inside a JSON string. 700 truncated it mid-object, which
                // fails `parseModelJson` and lands as an indistinguishable "skipped".
                maxTokens: 2000,
            });
            // A truncated response is unparseable JSON, so it would otherwise surface as a generic
            // skip. Name it: this is the one failure whose fix is a number in this file.
            if (stopReason === 'max_tokens') {
                console.error('[strategy-agent] response hit the token ceiling and cannot be parsed', {
                    org: c.organisationId, assistant: c.aiAssistantId, targetField,
                });
            }
            // Nothing but these two keys is read. Evidence is computed below, in SQL, never here.
            const parsed = parseModelJson<{ targetField?: string; proposedValue?: string }>(text);
            if (!parsed) {
                console.error('[strategy-agent] model output was not parseable JSON', {
                    org: c.organisationId, assistant: c.aiAssistantId, stopReason,
                    sample: String(text).slice(0, 300),
                });
            }
            if (parsed) {
                claimedField = String(parsed.targetField ?? '');
                proposedValue = String(parsed.proposedValue ?? '').trim();
            }
        } catch (err) {
            // One org's model failure must not stop the run for every other org.
            console.error('[strategy-agent] generation failed', { org: c.organisationId, assistant: c.aiAssistantId }, err);
            skip('generation threw', { ...where, error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' });
            continue;
        }

        // THE ENVELOPE. Reject, never clamp — and require the model to have answered about the
        // field we asked about, not merely one that happens to be tunable.
        //
        // ⚠️ Each rejection is LOGGED with its reason. These four paths are all "skipped: 1" in the
        // run summary and are otherwise indistinguishable from "the model said nothing useful" —
        // and from each other. A silent no-op is a real outcome here (the lesson revenue-ledger.ts
        // records), so the run has to leave behind enough to tell which one happened.
        const reject = (why: string, extra?: Record<string, unknown>) => {
            console.error(`[strategy-agent] proposal rejected: ${why}`, {
                org: c.organisationId, assistant: c.aiAssistantId, targetField, ...extra,
            });
            skip(why, extra);
        };

        if (claimedField !== targetField) {
            reject('model answered about a different field', { claimedField });
            continue;
        }
        if (!isValidValueFor(field, proposedValue)) {
            reject('value does not match the field shape', {
                valueType: field.valueType, length: proposedValue.length,
            });
            continue;
        }
        if (proposedValue === current) {
            reject('proposal is identical to the current value');
            continue;
        }

        const id = await proposeChange(db, {
            organisationId: c.organisationId,
            aiAssistantId: c.aiAssistantId,
            source: 'edit_pattern',
            targetField,
            proposedValue,
            // Computed here, from the SQL aggregate. The model contributes nothing to this object.
            evidence: {
                sampleSize: c.n,
                editReason: c.editReason,
                feedbackIds: c.feedbackIds,
                windowDays: WINDOW_DAYS,
                metrics: { edits: c.n, reason: reasonLabel },
            },
        });

        if (!id) {
            // proposeChange never throws; a null is a refusal or a lost conflict race, and it logs
            // its own reason. Say that the run saw it, so the two logs line up.
            reject('the writer refused the proposal (see its log line above)');
            continue;
        }
        result.proposed++;

        const prev = proposedByOrg.get(c.organisationId);
        proposedByOrg.set(c.organisationId, {
            count: (prev?.count ?? 0) + 1,
            summary: prev?.summary ?? `a new ${field.label} based on ${c.n} of your edits`,
            assistantName: prev?.assistantName ?? (assistant.name || 'Your assistant'),
        });
    }

    // ── Pass 2: rejection clusters → the target persona ──────────────────────
    // Deliberately a SECOND pass over its own clusters rather than a widened first pass. The two
    // proposers share an envelope, a budget and a notification, and nothing else: different
    // evidence, a different field, a different value type (json, not text). Interleaving them would
    // mean every line in the loop above testing which kind it was holding.
    //
    // An assistant can legitimately receive one of each in a run — they target different fields, so
    // the partial unique index does not collide, and the notification already speaks in counts.
    const rejectionClusters = modalRejectionPerAssistant(await loadRejectionClusters(db));
    result.clusters += rejectionClusters.length;

    for (const c of rejectionClusters.slice(0, BATCH)) {
        if (Date.now() - startedAt > RUN_BUDGET_MS - PER_CLUSTER_RESERVE_MS) {
            result.truncated = true;
            console.warn('[strategy-agent] run budget reached during rejection pass; the rest wait', {
                done: result.proposed + result.skipped, total: rejectionClusters.length,
            });
            break;
        }

        const where = { org: c.organisationId, assistant: c.aiAssistantId, reason: c.reason };

        let enabled = featureByOrg.get(c.organisationId);
        if (enabled === undefined) {
            enabled = await hasFeatureByOrg(db, c.organisationId, STRATEGY_AGENT_FEATURE);
            featureByOrg.set(c.organisationId, enabled);
        }
        if (!enabled) { skip('feature not enabled for this org', where); continue; }

        // ⚠️ ALWAYS target_persona. `discovery_query_themes` is the intuitive home for "your queries
        // keep surfacing directories", and it is a trap: nothing reads that field, so the proposal
        // would be reviewed, applied and change nothing while telling the user they had retargeted.
        // targetPersona is JSON-stringified straight into generateQueries' prompt, so it is live.
        const targetField = 'target_persona';
        const field = tunableField(targetField);
        if (!field) { skip('target_persona is no longer tunable', { ...where, targetField }); continue; }

        const [existing] = await db
            .select({ id: strategyProposals.id })
            .from(strategyProposals)
            .where(and(
                eq(strategyProposals.organisationId, c.organisationId),
                eq(strategyProposals.targetField, targetField),
                eq(strategyProposals.status, 'pending'),
            ))
            .limit(1);
        if (existing) { skip('a pending proposal already holds this field', { ...where, targetField }); continue; }

        const [assistant] = await db
            .select({ id: aiAssistants.id, name: aiAssistants.name })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, c.aiAssistantId), eq(aiAssistants.organisationId, c.organisationId)))
            .limit(1);
        if (!assistant) { skip('assistant not found in this org', where); continue; }

        // The personas the rejections were actually produced under. An apply writes ONE persona to
        // every active campaign (that blast radius is documented on writeFieldValue), so the model
        // is shown all of them and asked for a single replacement rather than a per-campaign patch.
        const campaigns = await db
            .select({ id: discoveryCampaigns.id, idea: discoveryCampaigns.idea, targetPersona: discoveryCampaigns.targetPersona })
            .from(discoveryCampaigns)
            .where(and(
                eq(discoveryCampaigns.aiAssistantId, c.aiAssistantId),
                eq(discoveryCampaigns.status, 'active'),
            ));
        // No active campaign means nothing to write to, and proposeChange would refuse anyway
        // (readFieldValue returns undefined). Skip before paying for a model call.
        if (campaigns.length === 0) { skip('assistant has no active campaign to retarget', where); continue; }

        const rejections = await priorRejections(db, c.organisationId, targetField);
        const reasonLabel = LEAD_REJECT_REASON_LABELS[c.reason];

        let proposedValue: unknown = null;
        let claimedField = '';
        try {
            const { text, stopReason } = await gatewayGenerate({
                system:
                    `You refine the target persona a B2B lead-discovery engine searches with. The persona is `
                    + `JSON, and it is fed verbatim into the prompt that writes the search queries.\n\n`
                    + `A human reviewer rejected ${c.n} of the leads this persona found, giving the SAME reason `
                    + `every time: "${reasonLabel}". Rewrite the persona so the next run stops surfacing them.\n\n`
                    + `Rules:\n`
                    + `- Keep every criterion that is working. You are correcting one recurring fault.\n`
                    + `- Describe WHO to find and who to avoid — never name specific companies.\n`
                    + `- Be concrete enough that a query writer reading it would exclude the rejected kind.\n`
                    + `- The value must be a JSON OBJECT, not a string and not an array.\n`
                    + (rejections.length
                        ? `- These earlier suggestions for this same field were DECLINED. Do not repeat them:\n${rejections.join('\n')}\n`
                        : '')
                    + `\nRespond ONLY with JSON: {"targetField":"${targetField}","proposedValue":{ ...the rewritten persona... }}`,
                messages: [{
                    role: 'user',
                    content:
                        `Current persona${campaigns.length > 1 ? 's' : ''} in use:\n`
                        + campaigns.map((cam) => `- ${cam.idea}\n  ${JSON.stringify(cam.targetPersona ?? {})}`).join('\n')
                        + `\n\nRejected as "${reasonLabel}" (${c.n} leads across ${c.campaigns} search${c.campaigns === 1 ? '' : 'es'}):\n`
                        + (c.examples.length ? c.examples.map((e) => `- ${e}`).join('\n') : '- (names not recorded)'),
                }],
                maxTokens: 2000,
            });
            if (stopReason === 'max_tokens') {
                console.error('[strategy-agent] rejection response hit the token ceiling and cannot be parsed', {
                    org: c.organisationId, assistant: c.aiAssistantId, targetField,
                });
            }
            const parsed = parseModelJson<{ targetField?: string; proposedValue?: unknown }>(text);
            if (!parsed) {
                console.error('[strategy-agent] rejection model output was not parseable JSON', {
                    org: c.organisationId, assistant: c.aiAssistantId, stopReason,
                    sample: String(text).slice(0, 300),
                });
            }
            if (parsed) {
                claimedField = String(parsed.targetField ?? '');
                proposedValue = parsed.proposedValue ?? null;
            }
        } catch (err) {
            console.error('[strategy-agent] rejection generation failed', { org: c.organisationId, assistant: c.aiAssistantId }, err);
            skip('generation threw', { ...where, error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' });
            continue;
        }

        const reject = (why: string, extra?: Record<string, unknown>) => {
            console.error(`[strategy-agent] rejection proposal rejected: ${why}`, {
                org: c.organisationId, assistant: c.aiAssistantId, targetField, ...extra,
            });
            skip(why, extra);
        };

        // The same envelope as the edit proposer, and for the same reason: this prompt sits next to
        // the org's own discovery output, and the guarantee comes from the SHAPE of what can be
        // written, never from the prompt.
        if (claimedField !== targetField) {
            reject('model answered about a different field', { claimedField });
            continue;
        }
        // A json field rejects a string or an array — an array of personas written to every campaign
        // would be read back as one persona object by generateQueries and silently mean nothing.
        if (!isValidValueFor(field, proposedValue) || Array.isArray(proposedValue)) {
            reject('value does not match the field shape', {
                valueType: field.valueType, got: Array.isArray(proposedValue) ? 'array' : typeof proposedValue,
            });
            continue;
        }

        const id = await proposeChange(db, {
            organisationId: c.organisationId,
            aiAssistantId: c.aiAssistantId,
            source: 'lead_rejection',
            targetField,
            proposedValue,
            // Computed from the SQL aggregate. `rejectionIds`, NOT `feedbackIds` — the two bank into
            // different tables and both are bare integer arrays, so the wrong key would silently
            // mark unrelated template_feedback rows as spent.
            evidence: {
                sampleSize: c.n,
                rejectReason: c.reason,
                rejectionIds: c.rejectionIds,
                windowDays: WINDOW_DAYS,
                metrics: {
                    rejections: c.n,
                    reason: reasonLabel,
                    campaigns: c.campaigns,
                    spreadDays: c.spreadDays,
                },
            },
        });

        if (!id) {
            reject('the writer refused the proposal (see its log line above)');
            continue;
        }
        result.proposed++;

        const prev = proposedByOrg.get(c.organisationId);
        proposedByOrg.set(c.organisationId, {
            count: (prev?.count ?? 0) + 1,
            summary: prev?.summary ?? `a new ${field.label} based on ${c.n} leads you rejected`,
            assistantName: prev?.assistantName ?? (assistant.name || 'Your assistant'),
        });
    }

    // ── Notify, once per org ─────────────────────────────────────────────────
    for (const [organisationId, info] of proposedByOrg) {
        const [owner] = await db
            .select({ userId: aiAssistants.userId })
            .from(aiAssistants)
            .where(eq(aiAssistants.organisationId, organisationId))
            .limit(1);
        if (!owner?.userId) continue;
        // The merge engine has no plural rules, so the call site passes a resolved noun phrase.
        const ok = await createNotification(db, 'strategy_proposal_pending', {
            userId: owner.userId,
            context: {
                assistant: { name: info.assistantName },
                proposal: {
                    count: info.count === 1 ? '1 suggested change' : `${info.count} suggested changes`,
                    summary: info.summary,
                },
            },
        });
        if (ok) result.notified++;
    }

    await recordLastRun(result, startedAt);
    return result;
}

/**
 * Persist the run's outcome where a human can read it.
 *
 * §7 asks the empty state to show "the last run's timestamp and skip reason, so 'is this thing even
 * running?' is answerable without the logs" — and that became load-bearing rather than nice-to-have
 * once the work moved to a background function, because the HTTP response is now just an ack and
 * the platform's function logs did not reliably surface a scheduled invocation's stdout.
 *
 * Best-effort: the proposals are already written, and losing the summary must not fail the run.
 */
async function recordLastRun(result: StrategyAgentResult, startedAt: number): Promise<void> {
    try {
        await setPlatformConfig(CONFIG_KEYS.STRATEGY_AGENT_LAST_RUN, {
            at: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
            clusters: result.clusters,
            proposed: result.proposed,
            skipped: result.skipped,
            expired: result.expired,
            notified: result.notified,
            truncated: result.truncated,
            // Capped: this is a diagnostic line in a UI, not an audit log.
            skipReasons: result.skipReasons.slice(0, 10),
        });
    } catch (err) {
        console.error('[strategy-agent] could not record the run summary', err);
    }
}

/**
 * The scheduled entry point — a DISPATCHER, not the worker.
 *
 * ⚠️ The run takes ~50s for a single org, almost all of it the model call. A synchronous Netlify
 * function gets 10s by default and 26s at most, so doing the work here meant being killed every
 * time. This hands off to the `-background` worker (15-minute budget) and returns immediately.
 *
 * The fetch IS awaited: an un-awaited background invoke can be frozen with the lambda before the
 * request leaves the sandbox, so the worker would simply never run. Awaiting a `-background` invoke
 * is cheap — the platform answers 202 as soon as it accepts the work.
 */
export default withLambda(async () => {
    const dispatched = await triggerStrategyAgentRun('weekly-cron');
    return {
        statusCode: dispatched ? 202 : 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dispatched }),
    };
});
