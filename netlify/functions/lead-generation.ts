// netlify/functions/lead-generation.ts
// Lead Generator (roleKey `lead_qualifier`) proactive tools — the LLM-backed engine
// behind the Data Hub "Add Lead" button and the Overview "Review Lead Ideas" flow on
// assistant-detail.html. All actions are tenant-scoped and ownership-checked (IDOR guard),
// and every produced lead lands in assistant_records as a `lead_scoring_card` so it renders
// identically to a chat-produced lead (disruptive-ui-registry.js → renderLeadScoringCard).
//
//   POST { action: 'score_lead',    assistantId, lead: { name, company?, email?, website?, industry?, headcount?, notes? } }
//        → LLM scores the lead against the ICP; upserts a recordType:'lead' record; returns it.
//   POST { action: 'generate_ideas', assistantId }
//        → LLM proposes ~3 lead-generation ideas from the ICP; stores each as recordType:'lead_idea'; returns them.
//   POST { action: 'list_ideas',     assistantId }
//        → returns this assistant's lead_idea records (proposed | approved | declined).
//   POST { action: 'approve_idea',   assistantId, ideaId }
//        → LLM finds ~3-4 example leads matching the idea, scores each, tags a next-best-action
//          owner (this assistant vs a handoff to another), stores them as recordType:'lead',
//          marks the idea 'approved', and returns the leads grouped by owner.
//   POST { action: 'decline_idea',   assistantId, ideaId }
//        → marks the idea 'declined'.
//
// LLM plumbing mirrors chat-orchestrator.ts (Anthropic SDK, ICP from onboardingContext,
// direct assistant_records inserts) — so it is not bound by the RECORD_TYPES/SOURCES sets in
// assistant-records.ts. Every value returned to the client is stored LLM output: the front-end
// treats it as untrusted and escapes on render.

import { Handler } from '@netlify/functions';
import { randomUUID } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, assistantRecords, discoveredLeads, leadRejectFeedback, masterAssistants, revenueEvents } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { logAiUsage } from '../../src/utils/ai-usage';
import { createDiscoveryRun } from '../../src/utils/discovery';
import { triggerDiscoveryDrain } from '../../src/utils/trigger-drain';
import { isSearchConfigured } from '../../src/lib/discovery-search';
import { sendGmailMessage } from '../../src/utils/gmail';
import { sendOutlookMessage } from '../../src/utils/outlook';
import { IntegrationError } from '../../src/utils/workspace-integrations';
import { recordEvent, cycleDaysBetween } from '../../src/utils/revenue-ledger';
import { getBlueprintVersion } from '../../src/utils/blueprint-version';
import { makeIcpSnapshotCache } from '../../src/utils/icp-snapshot';
import {
    OUTCOMES, LOSS_REASONS, EVENT_FOR_OUTCOME, OUTCOMES_REQUIRING_LOSS_REASON,
    isOutcome, isLossReason, type LossReason,
} from '../../src/config/revenue-events';
import { EDIT_REASONS, isEditReason } from '../../src/config/template-feedback';
import { needsPersonalInboxConfirmation } from '../../src/config/lead-email-kind';
import { EXCLUDE_PROFILE_DNC_RULE, EXCLUDE_PROFILE_RULE, SCORING_BANDS, icpBlock } from '../../src/config/icp-profile';
import { recordTemplateEdit } from '../../src/utils/template-feedback';
import {
    DOMAIN_EXCLUSION_REASONS, LEAD_REJECT_REASONS, isLeadRejectReason,
} from '../../src/config/lead-reject-reasons';
import { recordLeadRejection } from '../../src/utils/lead-reject-feedback';
import { openLeadThread, recordOutboundMessage } from '../../src/utils/lead-threads';
import { replyAddress } from '../../src/utils/reply-address';
import { checkSuppression } from '../../src/utils/suppression';
import { enrolInSequence, haltEnrolmentsForRecord } from '../../src/utils/outreach-sequences';
import { OUTREACH_SUBJECT_RULES } from '../../src/constants/outreach-subject';
import { evaluateDoNotContact } from '../../src/config/do-not-contact';
// One normaliser for the lead_scoring_card wire shape, shared with discovery scoring — the
// do-not-contact gate reads the card this produces, so the two paths must not drift apart.
import { normaliseLeadCard, type LeadScoringCard } from '../../src/lib/discovery-scoring';
import { classifyEmailKind } from '../../src/config/lead-email-kind';
import { withLambda } from '@netlify/aws-lambda-compat';

/** Chase reminder for an approved+contacted lead: 3 days out at 09:00, nudged off weekends. */
function chaseDate(): Date {
    const d = new Date();
    d.setDate(d.getDate() + 3);
    d.setHours(9, 0, 0, 0);
    if (d.getDay() === 6) d.setDate(d.getDate() + 2);
    else if (d.getDay() === 0) d.setDate(d.getDate() + 1);
    return d;
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5-20251001';

/**
 * When this lead was FIRST contacted — the start of the sales cycle (Phase 4.5).
 *
 * The ledger is authoritative: `outreach_sent` is written on a confirmed send only, so its earliest
 * row is the real first touch. `data.outreachSentAt` is the fallback for leads contacted before the
 * ledger existed, and it is only ever the LAST send, so it over-reports cycle time on a lead that
 * received a sequence — hence second place, not first.
 *
 * Returns null when nothing was ever sent. The caller leaves `cycleDays` NULL in that case rather
 * than measuring from the record's creation, which would report how long a lead sat in a list.
 */
async function firstOutreachAt(
    db: ReturnType<typeof getDb>,
    assistantRecordId: number,
    data: Record<string, unknown>,
): Promise<Date | null> {
    try {
        const [row] = await db
            .select({ occurredAt: revenueEvents.occurredAt })
            .from(revenueEvents)
            .where(and(
                eq(revenueEvents.assistantRecordId, assistantRecordId),
                eq(revenueEvents.eventType, 'outreach_sent'),
            ))
            .orderBy(asc(revenueEvents.occurredAt))
            .limit(1);
        if (row?.occurredAt) return row.occurredAt;
    } catch {
        // An un-migrated environment has no revenue_events table. Fall through — a missing cycle
        // time is a gap in analytics, never a reason to refuse to record the outcome.
    }
    const stamped = typeof data.outreachSentAt === 'string' ? new Date(data.outreachSentAt) : null;
    return stamped && !Number.isNaN(stamped.getTime()) ? stamped : null;
}

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

function str(v: unknown, max = 300): string | null {
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

/** Strip accidental ```json fences and parse; return null instead of throwing on bad JSON. */
function parseJson<T = unknown>(raw: string): T | null {
    const text = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    try { return JSON.parse(text) as T; } catch { return null; }
}


export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

    // confirmPersonal: the caller has explicitly OK'd sending to a scraped personal inbox.
    // confirmChange: the caller has explicitly OK'd overwriting a deal outcome already recorded.
    let body: {
        action?: string; assistantId?: number; ideaId?: number; recordId?: number;
        lead?: Record<string, unknown>; confirmPersonal?: boolean; reason?: string;
        outcome?: string; lossReason?: string; valueGbp?: number | string | null; confirmChange?: boolean;
        editReason?: string; provider?: string;
    };
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

    const action = String(body.action || '');
    const assistantId = Number(body.assistantId);

    // Load the assistant instance (IDOR guard) plus the ICP context the LLM needs.
    const [assistant] = await db
        .select({
            id: aiAssistants.id,
            name: aiAssistants.name,
            onboardingContext: aiAssistants.onboardingContext,
            roleKey: masterAssistants.roleKey,
        })
        .from(aiAssistants)
        .leftJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
        .limit(1);
    if (!assistant) return json(404, { error: 'Assistant not found.' });

    let onboarding: Record<string, unknown> = {};
    if (assistant.onboardingContext && typeof assistant.onboardingContext === 'object' && !Array.isArray(assistant.onboardingContext)) {
        onboarding = assistant.onboardingContext as Record<string, unknown>;
    } else if (typeof assistant.onboardingContext === 'string') {
        const parsed = parseJson<Record<string, unknown>>(assistant.onboardingContext);
        if (parsed && typeof parsed === 'object') onboarding = parsed;
    }
    const icp = icpBlock(onboarding);

    /**
     * The blueprint version live for this assistant — half of the ledger's attribution key (§7.2).
     * Resolved lazily and memoised for the request: one request is one assistant, and most actions
     * here emit nothing, so an eager lookup would be a query on every idea-listing call.
     */
    let _blueprintVersion: string | null | undefined;
    async function blueprintVersion(): Promise<string | null> {
        if (_blueprintVersion === undefined) _blueprintVersion = await getBlueprintVersion(db, assistant.id);
        return _blueprintVersion;
    }

    /**
     * The other half of the attribution key (§7.2), memoised for the request on the same reasoning.
     *
     * Pass the record id whenever one is in scope: the resolver walks record → discovered lead →
     * campaign and returns the ICP that was live when the lead was FOUND. That matters most on the
     * terminal outcome events — attributing a deal won today to today's onboarding would credit the
     * current targeting for a lead the previous targeting found, which is exactly the correlating
     * noise §7.2 exists to prevent. Omit it only where the lead is known to be manually added.
     */
    const _icpFor = makeIcpSnapshotCache(db);
    function icpSnapshot(assistantRecordId?: number | null): Promise<Record<string, unknown> | null> {
        return _icpFor({ assistantRecordId: assistantRecordId ?? null, aiAssistantId: assistant.id });
    }

    /** Log token usage the same way the chat route does, so COGS reporting stays complete. */
    function logUsage(resp: Anthropic.Message, suffix: string) {
        void logAiUsage({
            workspaceId: orgId,
            userId,
            assistantId: assistant.id,
            model: MODEL,
            inputTokens: resp.usage.input_tokens,
            outputTokens: resp.usage.output_tokens,
            sessionId: `lead-generation:${assistant.id}:${suffix}`,
            dataCategories: ['business_context'],
        });
    }

    /** Upsert a produced record on (org, assistant, type, title) — same rule as the chat route. */
    async function upsertRecord(recordType: string, title: string, status: string | null, data: unknown, source: string) {
        const [existing] = await db
            .select({ id: assistantRecords.id })
            .from(assistantRecords)
            .where(and(
                eq(assistantRecords.organisationId, orgId),
                eq(assistantRecords.aiAssistantId, assistant.id),
                eq(assistantRecords.recordType, recordType),
                eq(assistantRecords.title, title),
            ))
            .limit(1);
        if (existing) {
            await db.update(assistantRecords)
                .set({ status, data, source, updatedAt: new Date() })
                .where(eq(assistantRecords.id, existing.id));
            return existing.id;
        }
        const [created] = await db.insert(assistantRecords)
            .values({ organisationId: orgId, aiAssistantId: assistant.id, recordType, title, status, source, data })
            .returning({ id: assistantRecords.id });
        return created.id;
    }

    try {
        // ── Score a single, manually-entered lead ────────────────────────────────
        if (action === 'score_lead') {
            const lead = (body.lead && typeof body.lead === 'object') ? body.lead : {};
            const name = str(lead.name, 200);
            const company = str(lead.company, 200);
            if (!name && !company) return json(400, { error: 'A lead needs at least a name or a company.' });
            const title = company || name!;

            const system =
`You qualify inbound leads for "${assistant.name}", a business using Be More Swan. Score the lead below against the ideal customer profile — a lead that matches it well scores high; one that misses it scores low, and your reasons must name which criteria it met or missed.

Ideal customer profile (from setup):
${icp}

${EXCLUDE_PROFILE_RULE} ${EXCLUDE_PROFILE_DNC_RULE}

${SCORING_BANDS}

Return STRICT JSON only (no markdown, no prose outside the JSON):
{
  "leadName": "<the lead or company name>",
  "score": <0-100>,
  "rating": "hot" | "warm" | "cold",
  "reasons": ["<short reason tied to a profile criterion>", ...],
  "suggestedNextStep": "<one concrete next action>",
  "outreachDraft": { "to": "<email or null>", "subject": "<subject>", "body": "<personalised outreach email in the sales tone>" } | null,
  "doNotContact": <true|false>,
  "doNotContactReason": "<short reason, or null>"
}
Write an outreachDraft for hot/warm leads; use null for cold leads.

Set "doNotContact": true when this lead must not be emailed AT ALL — an internal or test account, our
own staff or domain, a competitor, an existing customer, or anyone who has asked not to be contacted.
This is stronger than a low score: a cold lead is a poor prospect we may still contact, whereas
doNotContact means sending would be wrong. When it is true, set outreachDraft to null.

${OUTREACH_SUBJECT_RULES}`;

            const resp = await anthropic.messages.create({
                model: MODEL,
                max_tokens: 1024,
                system,
                messages: [{ role: 'user', content: `Score this lead:\n${JSON.stringify(lead)}` }],
            });
            logUsage(resp, 'score_lead');
            const raw = resp.content[0]?.type === 'text' ? resp.content[0].text : '';
            // Widened on purpose: the card is stored as the record's `data` blob and this path
            // stamps extra fields onto it below.
            const card: LeadScoringCard & Record<string, unknown> = { ...normaliseLeadCard(parseJson(raw), title) };

            // Persist the address the user actually typed. Without this the only recipient
            // source for a manual lead is whatever the model chose to echo into
            // outreachDraft.to, so send_outreach could return 'no_recipient' for a lead whose
            // email was filled in — see the resolution order at send_outreach below. Stored as
            // contactEmail so that order (draft.to → contactEmail → lead.email) finds it, and
            // so the Review Queue recipient line reads from the same field.
            // emailSource 'manual' (not 'scrape') deliberately keeps the personal-inbox gate
            // off: a hand-entered address is user-supplied, not harvested.
            //
            // ⚠️ `emailKind` is NOT optional alongside it. The Leads tab reads
            // `emailKind === 'personal' ? 'personal' : 'role'`, so an address stored without one
            // renders as "Role inbox" — a named individual mislabelled as a generic company inbox,
            // which is the LESS cautious of the two labels on the weakest GDPR footing the product
            // has. Same classifier the scraper uses, so the two writers cannot disagree.
            const submittedEmail = str(lead.email, 200);
            if (submittedEmail) {
                card.contactEmail = submittedEmail;
                card.emailSource = 'manual';
                card.emailKind = classifyEmailKind(submittedEmail) ?? 'personal';
            }

            const id = await upsertRecord('lead', title, String(card.rating), card, 'manual');

            // Revenue ledger (Phase 0). A manually-added lead has no discovered_leads row, so
            // discoveredLeadId stays null and the record id is the only subject link — that is the
            // expected shape here, not a missing field. actor 'agent': the SCORE is the model's
            // judgement, even though a human typed the lead in.
            await recordEvent(db, 'lead_scored', {
                organisationId: orgId,
                aiAssistantId: assistant.id,
                assistantRecordId: id,
                actor: 'agent',
                actorUserId: userId,
                // No record id passed on purpose: this lead was hand-entered, so there is no
                // campaign to attribute it to and the walk would be a guaranteed miss. The
                // onboarding-derived snapshot is the honest answer here.
                icpSnapshot: await icpSnapshot(),
                blueprintVersion: await blueprintVersion(),
                payload: { score: card.score, rating: card.rating, source: 'manual' },
            });

            return json(200, { record: { id, title, status: card.rating, data: card } });
        }

        // ── Overrule a do-not-contact verdict for ONE lead ────────────────────────
        // For a mis-scored lead: qualification decided it must never be emailed and was wrong. The
        // override is PERSISTED on the record rather than passed as a per-send flag, because two
        // separate paths enforce the gate — send_outreach here and processEnrolment in the sequence
        // worker. A per-send bypass would send the opener, enrol a cadence, and then halt it at
        // step 2 when the worker re-checked and still saw the block.
        //
        // Deliberately NOT sticky: upsertRecord replaces `data` wholesale, so re-scoring the lead
        // drops the override along with the verdict it overrode. The human overruled one judgement,
        // not every future one.
        if (action === 'override_do_not_contact') {
            const recordId = Number(body.recordId);
            if (!Number.isInteger(recordId)) return json(400, { error: 'recordId is required.' });

            // A reason is mandatory, and short ones are rejected. This is the audit trail for
            // bypassing a compliance gate — "ok" is not a justification, and readOverride() ignores
            // an override with no reason anyway, which would fail silently at send time instead.
            const reason = str(body.reason, 500);
            if (!reason || reason.length < 10) {
                return json(400, { error: 'A reason of at least 10 characters is required to override a do-not-contact verdict.' });
            }

            const [rec] = await db
                .select({ id: assistantRecords.id, data: assistantRecords.data })
                .from(assistantRecords)
                .where(and(
                    eq(assistantRecords.id, recordId),
                    eq(assistantRecords.organisationId, orgId),
                    eq(assistantRecords.aiAssistantId, assistant.id),
                    eq(assistantRecords.recordType, 'lead'),
                ))
                .limit(1);
            if (!rec) return json(404, { error: 'Lead not found.' });

            const data = (rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)) ? rec.data as Record<string, unknown> : {};

            // Refuse to override a lead that is not actually blocked. Otherwise the record acquires
            // a standing pre-authorisation that would release a verdict a LATER scoring pass makes —
            // which is exactly the sticky behaviour this design avoids.
            const current = evaluateDoNotContact(data);
            if (!current.blocked && !current.overridden) {
                return json(400, { error: 'This lead is not flagged do-not-contact, so there is nothing to override.' });
            }

            const override = { at: new Date().toISOString(), by: userId ? String(userId) : 'user', reason };
            await db.update(assistantRecords)
                .set({ data: { ...data, doNotContactOverride: override }, updatedAt: new Date() })
                .where(eq(assistantRecords.id, recordId));

            // actor 'user': this is a human decision, and the ONLY thing that can produce this event.
            await recordEvent(db, 'do_not_contact_overridden', {
                organisationId: orgId,
                aiAssistantId: assistant.id,
                assistantRecordId: recordId,
                actor: 'user',
                actorUserId: userId,
                blueprintVersion: await blueprintVersion(),
                icpSnapshot: await icpSnapshot(recordId),
                payload: { reason, overrodeSource: current.source, overrodeReason: current.reason },
            });

            return json(200, { overridden: true, recordId, reason });
        }

        // ── Look again for a contact address (Phase 2 item 10) ────────────────────
        //
        // `signals->>'enrichAttemptedAt'` is what stops the scraper revisiting a lead forever: it is
        // the stamp that makes "None found" mean "we looked", and `enrichBatch` filters on
        // `IS NULL`. That is right for one run and wrong over months — a company that publishes a
        // contact page in September is never looked at again. Clearing the stamp for ONE lead puts
        // it back in the queue.
        //
        // ⚠️ Per-lead only, never a bulk re-scrape. A "re-check everything" button is a spend
        // problem (every lead costs up to four fetches) and a politeness problem (we would be
        // re-crawling strangers' sites on a timer they never agreed to).
        //
        // ⚠️ This does NOT itself scrape anything. Enrichment only ever runs inside a live discovery
        // job on the lead's own campaign, so all this does is restore eligibility for the next run.
        // Every refusal below exists so the button cannot claim otherwise: a lead the worker would
        // skip anyway must be told why, not handed a cleared stamp and a false promise.
        if (action === 'look_again') {
            const recordId = Number(body.recordId);
            if (!Number.isInteger(recordId)) return json(400, { error: 'recordId is required.' });

            const [rec] = await db
                .select({ id: assistantRecords.id, data: assistantRecords.data, status: assistantRecords.status })
                .from(assistantRecords)
                .where(and(
                    eq(assistantRecords.id, recordId),
                    eq(assistantRecords.organisationId, orgId),
                    eq(assistantRecords.aiAssistantId, assistant.id),
                    eq(assistantRecords.recordType, 'lead'),
                ))
                .limit(1);
            if (!rec) return json(404, { error: 'Lead not found.' });

            const data = (rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)) ? rec.data as Record<string, unknown> : {};
            if (str(data.contactEmail as string, 200)) {
                return json(400, { error: 'This lead already has an address — there is nothing to look for.' });
            }

            // The stamp that matters lives on `discovered_leads`, NOT on the record the UI edits:
            // `enrichBatch` selects from discovered_leads, so clearing only the mirrored copy would
            // change the chip and re-queue precisely nothing.
            const [lead] = await db
                .select({ id: discoveredLeads.id, domain: discoveredLeads.domain, rating: discoveredLeads.rating, status: discoveredLeads.status })
                .from(discoveredLeads)
                .where(and(
                    eq(discoveredLeads.assistantRecordId, recordId),
                    eq(discoveredLeads.organisationId, orgId),
                ))
                .limit(1);
            // A hand-added or imported lead has no discovered_leads row at all. There is no site the
            // scraper was ever pointed at, so "look again" is meaningless — say so rather than
            // reporting success for a no-op.
            if (!lead) {
                return json(400, { error: 'This lead was added by hand rather than found by a search, so there is no website on file to check. Add an address instead.' });
            }
            if (!lead.domain) {
                return json(400, { error: 'No website is recorded for this company, so there is nothing to read. Add an address by hand instead.' });
            }
            // Mirrors enrichBatch's own predicate. Clearing the stamp on a cold lead would leave it
            // eligible-looking and never visited, which is the "Checking… forever" lie in a new coat.
            if (lead.rating !== 'hot' && lead.rating !== 'warm') {
                return json(400, { error: 'Only hot and warm leads are looked up, and this one scored cold. Re-scoring or better targeting is the fix, not another lookup.' });
            }
            if (lead.status !== 'promoted') {
                return json(400, { error: 'This lead is not in the active set for its search, so a lookup would skip it.' });
            }

            // `-` removes the key outright. Setting it to null would NOT work: the filter is
            // `signals ->> 'enrichAttemptedAt' IS NULL`, and a JSON null renders as SQL NULL there,
            // but a later merge would then carry an explicit null around forever.
            await db.update(discoveredLeads)
                .set({ signals: sql`COALESCE(${discoveredLeads.signals}, '{}'::jsonb) - 'enrichAttemptedAt'`, updatedAt: new Date() })
                .where(eq(discoveredLeads.id, lead.id));

            // Clear the mirror too, or the Contact column keeps reading "None found" over a lead
            // that is genuinely queued again — and the Searches aggregate (which reads
            // discovered_leads) would disagree with the table (which reads this record). Those two
            // are held in step deliberately; see src/config/lead-contact-state.ts.
            //
            // The same `-` operator rather than writing back the object read above: this record is
            // also written by the Review Queue, the Edit form and the worker's mirror, and a
            // read-modify-write here would silently discard anything one of them committed since
            // the SELECT. Removing one key in the database touches only that key.
            await db.update(assistantRecords)
                .set({ data: sql`COALESCE(${assistantRecords.data}, '{}'::jsonb) - 'enrichAttemptedAt'`, updatedAt: new Date() })
                .where(eq(assistantRecords.id, recordId));

            return json(200, { requeued: true, recordId });
        }

        // ── Record the deal outcome for a lead (Phase 4.5) ────────────────────────
        // The keystone the Strategy Agent is built on: until this action existed, NOTHING in the
        // codebase could emit a terminal event, so `revenue_events.outcome` was NULL on every row
        // that would ever be written and win rate had no numerator. See docs/strategy-agent-plan.md
        // §0.1.
        //
        // Outcome is a SEPARATE axis from approval_status (plan §3.2) — five other assistant roles
        // read that column, and 'won' is not an approval state. It lives on the record's `data` and
        // is denormalised into the ledger, which is the only thing Phase 5 aggregates.
        if (action === 'set_outcome') {
            const recordId = Number(body.recordId);
            if (!Number.isInteger(recordId)) return json(400, { error: 'recordId is required.' });

            const outcome = String(body.outcome || '');
            if (!isOutcome(outcome)) {
                return json(400, { error: `outcome must be one of: ${OUTCOMES.join(', ')}.` });
            }

            // A loss reason is REQUIRED on lost/disqualified and refused on won. recordEvent()
            // stores lossReason on any terminal event, so a won deal carrying one would be counted
            // by every "why are we losing?" aggregate — silently, since nothing downstream
            // re-checks the pairing.
            const rawReason = str(body.lossReason, 40);
            const needsReason = OUTCOMES_REQUIRING_LOSS_REASON.includes(outcome);
            let lossReason: LossReason | null = null;
            if (needsReason) {
                if (!rawReason) {
                    return json(400, { error: `A reason is required when marking a lead ${outcome}.` });
                }
                if (!isLossReason(rawReason)) {
                    return json(400, { error: `lossReason must be one of: ${LOSS_REASONS.join(', ')}.` });
                }
                lossReason = rawReason;
            } else if (rawReason) {
                return json(400, { error: 'A won deal has no loss reason.' });
            }

            // Value belongs to a win only. Accepting it on a loss would quietly change what "mean
            // deal value" means in the per-segment aggregate — mixing revenue earned with revenue
            // missed into one number.
            let valueGbp: number | null = null;
            if (body.valueGbp !== undefined && body.valueGbp !== null && body.valueGbp !== '') {
                if (outcome !== 'won') {
                    return json(400, { error: 'A deal value can only be recorded on a won deal.' });
                }
                const n = Number(body.valueGbp);
                if (!Number.isFinite(n) || n < 0) {
                    return json(400, { error: 'A deal value must be a positive number.' });
                }
                valueGbp = n;
            }

            const [rec] = await db
                .select({ id: assistantRecords.id, title: assistantRecords.title, data: assistantRecords.data })
                .from(assistantRecords)
                .where(and(
                    eq(assistantRecords.id, recordId),
                    eq(assistantRecords.organisationId, orgId),
                    eq(assistantRecords.aiAssistantId, assistant.id),
                    eq(assistantRecords.recordType, 'lead'),
                ))
                .limit(1);
            if (!rec) return json(404, { error: 'Lead not found.' });

            const data = (rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data))
                ? rec.data as Record<string, unknown> : {};
            const prior = (data.dealOutcome && typeof data.dealOutcome === 'object')
                ? data.dealOutcome as Record<string, unknown> : null;

            // ⚠️ The ledger is append-only, so CORRECTING an outcome appends a second terminal row
            // rather than replacing the first. That means a naive `count(*) WHERE outcome='won'`
            // would count one lead twice, and a lead marked won-then-lost would appear in both
            // aggregates. Two things keep that safe:
            //   1. this gate — a mis-click cannot produce a correction, only a deliberate confirm;
            //   2. `payload.supersedes` on the corrective row, so the analyser can identify it.
            // The rule for any reader: take the LATEST terminal event per assistant_record_id.
            if (prior?.outcome && body.confirmChange !== true) {
                return json(409, {
                    error: `This lead is already marked ${String(prior.outcome)}.`,
                    currentOutcome: prior.outcome,
                    needsConfirmation: true,
                });
            }

            const firstTouch = await firstOutreachAt(db, recordId, data);
            const cycleDays = firstTouch ? cycleDaysBetween(firstTouch) : null;

            const decidedAt = new Date();
            const dealOutcome = {
                outcome,
                lossReason: lossReason ?? null,
                valueGbp,
                cycleDays,
                at: decidedAt.toISOString(),
                by: userId ? String(userId) : 'user',
                ...(prior?.outcome ? { supersedes: prior.outcome } : {}),
            };
            await db.update(assistantRecords)
                .set({ data: { ...data, dealOutcome }, updatedAt: decidedAt })
                .where(eq(assistantRecords.id, recordId));

            // A decided deal must stop receiving follow-ups. Nothing else in the pipeline learns
            // this: the sequence worker's guards key off thread state and approval status, and a
            // won deal changes neither. Best-effort — a cadence that cannot be halted is worth a
            // log line, not a failed outcome capture.
            const sequencesHalted = await haltEnrolmentsForRecord(db, recordId);

            // actor 'user': a human decided this. Until the Closing Agent (Phase 4) exists, that is
            // the only actor that can — and the baseline any future autonomous close is measured
            // against.
            await recordEvent(db, EVENT_FOR_OUTCOME[outcome], {
                organisationId: orgId,
                aiAssistantId: assistant.id,
                assistantRecordId: recordId,
                actor: 'user',
                actorUserId: userId,
                lossReason,
                valueGbp,
                cycleDays,
                icpSnapshot: await icpSnapshot(recordId),
                blueprintVersion: await blueprintVersion(),
                payload: {
                    title: rec.title,
                    sequencesHalted,
                    firstTouchAt: firstTouch ? firstTouch.toISOString() : null,
                    ...(prior?.outcome ? { supersedes: prior.outcome, isCorrection: true } : {}),
                },
            });

            return json(200, { recordId, dealOutcome, sequencesHalted });
        }

        // ── Flag WHY a drafted message was edited (plan §2.6, the ⭐ option) ──────
        // The edit itself has already been saved by the time this runs — that ordering is the whole
        // design. §2.6 splits "this wording is wrong for this prospect" (class A, ships now) from
        // "this wording is wrong for everyone" (class C, governs every future message), and the ⭐
        // option resolves the tension: the edit ships immediately, and the REASON is banked as
        // evidence. After MIN_EDIT_SAMPLE similar edits the Strategy Agent proposes the template
        // change through the normal proposal flow — with a sample size behind it, unlike a "save as
        // default" click, which generalises from n = 1.
        //
        // Leads only. The Review Queue's edit surface also serves meetings and tickets, but the
        // Strategy Agent tunes the OUTREACH playbook; a meeting follow-up is not part of the
        // revenue loop, and clustering its edits in would propose changes to the wrong template.
        if (action === 'record_edit_feedback') {
            const recordId = Number(body.recordId);
            if (!Number.isInteger(recordId)) return json(400, { error: 'recordId is required.' });

            const editReason = str(body.editReason, 40);
            if (!isEditReason(editReason)) {
                return json(400, { error: `editReason must be one of: ${EDIT_REASONS.join(', ')}.` });
            }

            const [rec] = await db
                .select({ id: assistantRecords.id, data: assistantRecords.data })
                .from(assistantRecords)
                .where(and(
                    eq(assistantRecords.id, recordId),
                    eq(assistantRecords.organisationId, orgId),
                    eq(assistantRecords.aiAssistantId, assistant.id),
                    eq(assistantRecords.recordType, 'lead'),
                ))
                .limit(1);
            if (!rec) return json(404, { error: 'Lead not found.' });

            const data = (rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data))
                ? rec.data as Record<string, unknown> : {};
            const original = (data.draftOriginal && typeof data.draftOriginal === 'object')
                ? data.draftOriginal as Record<string, unknown> : null;
            const current = (data.outreachDraft && typeof data.outreachDraft === 'object')
                ? data.outreachDraft as Record<string, unknown> : null;

            // No stashed original means nothing was ever edited, so there is no before/after and
            // nothing to learn from. A 400 rather than an empty row: a feedback row with no diff
            // would inflate the sample count the proposer gates on.
            if (typeof original?.body !== 'string' || typeof current?.body !== 'string') {
                return json(400, { error: 'This draft has not been edited, so there is no change to explain.' });
            }

            const feedbackId = await recordTemplateEdit(db, {
                organisationId: orgId,
                // NULL by design — a review-time edit precedes the send, so no lead_messages row
                // exists yet. The sent message keeps its own copy via generated_body.
                leadMessageId: null,
                // ...which is exactly why the assistant has to be stated outright: with no message
                // row there is nothing to join through, and the edit-pattern proposer groups on this.
                aiAssistantId: assistant.id,
                templateVersion: await blueprintVersion(),
                editReason,
                before: { subject: (original.subject as string) ?? null, body: original.body },
                after: { subject: (current.subject as string) ?? null, body: current.body },
            });

            // recordTemplateEdit never throws and returns null on failure. Report that honestly
            // rather than claiming a save — but still 200: the user's EDIT succeeded, and this
            // request was only ever about the annotation.
            return json(200, { recorded: feedbackId !== null, feedbackId, recordId });
        }

        // ── Why a lead was REJECTED (Review Queue, after the reject commits) ──────
        // The mirror of record_edit_feedback above: that one captures what was wrong with the
        // message, this one what was wrong with the targeting that surfaced the lead at all.
        //
        // Runs AFTER the rejection, never as a gate in front of it — a reviewer with nineteen more
        // leads waiting must never be blocked from clearing one because they could not be bothered
        // to categorise it.
        //
        // Returns the lead's domain and campaign when discovery found them, so the caller can offer
        // the one thing that acts on this today: excluding that domain from the search.
        if (action === 'record_reject_feedback') {
            const recordId = Number(body.recordId);
            if (!Number.isInteger(recordId)) return json(400, { error: 'recordId is required.' });

            const reason = str(body.reason, 40);
            if (!isLeadRejectReason(reason)) {
                return json(400, { error: `reason must be one of: ${LEAD_REJECT_REASONS.join(', ')}.` });
            }

            // Tenant + assistant + type check before writing anything keyed to this record. Leads
            // only: assistant_records is shared by six roles, and a rejected invoice says nothing
            // about who a discovery search should look for.
            const [rec] = await db
                .select({ id: assistantRecords.id })
                .from(assistantRecords)
                .where(and(
                    eq(assistantRecords.id, recordId),
                    eq(assistantRecords.organisationId, orgId),
                    eq(assistantRecords.aiAssistantId, assistant.id),
                    eq(assistantRecords.recordType, 'lead'),
                ))
                .limit(1);
            if (!rec) return json(404, { error: 'Lead not found.' });

            const result = await recordLeadRejection(db, {
                organisationId: orgId,
                aiAssistantId: assistant.id,
                assistantRecordId: recordId,
                reason,
            });

            // 200 with recorded:false when the write failed — the user's REJECTION succeeded, and
            // this request was only ever about the annotation. `canExcludeDomain` is the server's
            // call, not the browser's: it needs the vocabulary AND the discovery provenance, and
            // only one of those is known client-side.
            return json(200, {
                recorded: result.id !== null,
                recordId,
                domain: result.domain,
                campaignId: result.campaignId,
                canExcludeDomain: result.id !== null
                    && !!result.domain
                    && !!result.campaignId
                    && DOMAIN_EXCLUSION_REASONS.includes(reason),
            });
        }

        // ── What the reviewer has taught the search by rejecting (Profile ▸ Rules) ────
        // The read side of record_reject_feedback above. Learned Directives is otherwise fed
        // entirely by content_rules, which only ever steers social and blog GENERATION — so a
        // reviewer who had spent an afternoon categorising rejected leads opened that panel and
        // found it empty, with no way to tell "captured but shown nowhere" from "never saved".
        //
        // Aggregated, not row-per-rejection: the reason is a GROUP BY key by design (see
        // lead-reject-reasons.ts), and forty individual rows say less than six counts.
        //
        // `appliedCount` is the honesty column. A rejection only stops being inert evidence when
        // the Strategy Agent banks it into a targeting proposal, which happens for orgs with the
        // `strategy_agent` feature and nowhere else — reporting the raw total alone would let the
        // panel imply the assistant had learned from every click.
        if (action === 'list_reject_feedback') {
            const rows = await db
                .select({
                    reason: leadRejectFeedback.reason,
                    total: count(),
                    applied: sql<number>`count(*) filter (where ${leadRejectFeedback.appliedToTarget})`.mapWith(Number),
                    lastAt: sql<string | null>`max(${leadRejectFeedback.createdAt})`,
                })
                .from(leadRejectFeedback)
                .where(and(
                    eq(leadRejectFeedback.organisationId, orgId),
                    eq(leadRejectFeedback.aiAssistantId, assistant.id),
                ))
                .groupBy(leadRejectFeedback.reason)
                .orderBy(desc(count()));

            return json(200, {
                reasons: rows.map(r => ({
                    reason: r.reason,
                    count: Number(r.total),
                    appliedCount: Number(r.applied),
                    lastAt: r.lastAt,
                })),
                total: rows.reduce((n, r) => n + Number(r.total), 0),
                appliedTotal: rows.reduce((n, r) => n + Number(r.applied), 0),
            });
        }

        // ── Send the outreach email for an approved lead (auto-send on approval) ──
        // Reads the assistant's outreachEmailProvider setup answer. For 'google', sends the
        // lead's outreach email from the connected Gmail account, then sets a chase reminder
        // (approvalStatus='scheduled' + scheduledFor) so it lands on the Calendar. Returns a
        // { sent:false, reason } for every non-send outcome so the caller can explain it — never
        // an error the user has to act on. Design: [[outreach-email-connect]].
        if (action === 'send_outreach') {
            const recordId = Number(body.recordId);
            if (!Number.isInteger(recordId)) return json(400, { error: 'recordId is required.' });

            // The onboarding answer says 'microsoft'; the OAuth provider key is 'outlook'
            // (the env vars derive from the provider key, so they're OUTLOOK_CLIENT_*).
            // Map here rather than renaming the stored answer, which would strand every
            // assistant already onboarded.
            const provider = str(onboarding.outreachEmailProvider, 40);
            if (provider !== 'google' && provider !== 'microsoft') return json(200, { sent: false, reason: 'no_provider' });

            const [rec] = await db
                .select({ id: assistantRecords.id, title: assistantRecords.title, data: assistantRecords.data })
                .from(assistantRecords)
                .where(and(
                    eq(assistantRecords.id, recordId),
                    eq(assistantRecords.organisationId, orgId),
                    eq(assistantRecords.aiAssistantId, assistant.id),
                    eq(assistantRecords.recordType, 'lead'),
                ))
                .limit(1);
            if (!rec) return json(404, { error: 'Lead not found.' });

            const data = (rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)) ? rec.data as Record<string, unknown> : {};
            const draft = (data.outreachDraft && typeof data.outreachDraft === 'object') ? data.outreachDraft as Record<string, unknown> : null;
            const leadObj = (data.lead && typeof data.lead === 'object') ? data.lead as Record<string, unknown> : {};
            const recipient = str(draft?.to as string, 200) || str(data.contactEmail as string, 200) || str(leadObj.email as string, 200);
            if (!recipient) return json(200, { sent: false, reason: 'no_recipient' });

            // Do-not-contact gate. Checked FIRST — before suppression, the personal-inbox gate and
            // any generation — because it is the cheapest check and the only one that says this
            // lead should never have reached a send path at all. The qualification pass can decide
            // a lead is an internal/test account, a competitor or an existing customer; until now
            // that verdict lived in prose nothing read, and a lead whose own record said "Do not
            // contact" was emailed anyway. Hard block: there is no confirm-and-send override here,
            // unlike the personal-inbox gate, because the answer is not "are you sure who" but
            // "this must not be sent". See src/config/do-not-contact.ts.
            const dnc = evaluateDoNotContact(data);
            if (dnc.blocked) {
                return json(200, { sent: false, reason: 'do_not_contact', detail: dnc.reason, source: dnc.source, to: recipient });
            }
            if (dnc.overridden) {
                // Proceeding past a raised gate is not the same as a gate that never fired. Logged
                // so the bypass is visible in the function logs as well as the ledger.
                console.log(`[lead-generation] do-not-contact overridden for record ${recordId} by ${dnc.override?.by}: ${dnc.override?.reason}`);
            }

            // Suppression gate. suppression_list has been populated from tenants' CRMs since the
            // Integration Scenario Library shipped, but until Phase 2b NOTHING READ IT — so this
            // path could cold-email an org's own existing customers despite the tenant having
            // connected a CRM specifically to prevent that. Checked before the personal-inbox gate
            // because "we must not email this company at all" outranks "who at this company".
            const suppression = await checkSuppression(db, orgId, recipient);
            if (suppression.suppressed) {
                return json(200, {
                    sent: false,
                    reason: suppression.unknown ? 'suppression_check_failed' : 'suppressed',
                    to: recipient,
                    suppressionReason: suppression.reason ?? null,
                });
            }

            // Personal-inbox gate. A SCRAPED address belonging to a named individual (rather
            // than a generic info@/enquiries@ desk) is the weakest footing for cold B2B
            // outreach under UK GDPR/PECR, and approval otherwise auto-sends with no further
            // prompt. Require an explicit per-lead confirmation. Enforced HERE, not just in
            // the UI, so the gate holds for any caller. See [[lead-generator-discovery-plan]].
            const emailKind = str(data.emailKind as string, 20);
            const emailSource = str(data.emailSource as string, 20);
            // ⚠️ Keyed on "the user did not type it", NOT on 'scrape'. A PURCHASED address is a
            // named individual whose details we paid a broker for — a stronger reason to confirm
            // than a scraped one, not a weaker one — and it carries emailSource 'provider', which
            // a literal 'scrape' test would wave straight through. See needsPersonalInboxConfirmation.
            if (needsPersonalInboxConfirmation(emailKind, emailSource) && body.confirmPersonal !== true) {
                return json(200, { sent: false, reason: 'personal_inbox_unconfirmed', to: recipient });
            }

            // Use the stored draft if present; otherwise generate one from the lead's details.
            let subject = str(draft?.subject as string, 300);
            let bodyText = str(draft?.body as string, 4000);
            if (!bodyText) {
                const tone = str(onboarding.salesTone, 40) ?? 'professional';
                const system =
`You write a short, personalised cold outreach email for "${assistant.name}" (a business using Be More Swan) to the lead below, in a ${tone} tone. Under 150 words, no placeholders or brackets.

${OUTREACH_SUBJECT_RULES}

If this email should NOT be written at all — the lead details below say this is not a genuine prospect,
that it must not be contacted, or the only honest email would break the rules above — do NOT write one
anyway and do NOT put your reasoning in the subject or body. Return exactly:
{ "decline": "<one short line saying why>" }

Otherwise return STRICT JSON only: { "subject": "<subject>", "body": "<email body>" }`;
                const resp = await anthropic.messages.create({
                    model: MODEL, max_tokens: 512, system,
                    messages: [{ role: 'user', content: `Lead: ${JSON.stringify({ title: rec.title, ...data })}` }],
                });
                logUsage(resp, 'send_outreach_gen');
                const gen = parseJson<{ subject?: string; body?: string; decline?: string }>(resp.content[0]?.type === 'text' ? resp.content[0].text : '') || {};

                // An explicit refusal — e.g. the scoring pass wrote "do not contact" or "internal test
                // account" into this record and the only honest email would contradict it. Without this
                // channel the model has nowhere to put that except the subject and body, which then get
                // emailed verbatim ("Not sending this email"). 200 + sent:false, not 502: nothing is
                // broken, we are declining on purpose, and the caller should show the reason.
                const declined = str(gen.decline, 300);
                if (declined && !str(gen.body, 4000)) {
                    return json(200, { sent: false, reason: 'generator_declined', detail: declined, to: recipient });
                }

                subject = str(gen.subject, 300) || subject;
                bodyText = str(gen.body, 4000);
                if (!bodyText) return json(502, { error: 'Could not draft an outreach email for this lead.' });
            }
            if (!subject) subject = `Quick note for ${rec.title}`;

            // Mint the thread + its inbound alias BEFORE sending, so the Reply-To we advertise is
            // one we can actually resolve. If the thread write fails we send without a Reply-To
            // rather than not sending — losing reply tracking is recoverable, a lead who never
            // hears from us is not.
            const thread = await openLeadThread(db, {
                organisationId: orgId,
                aiAssistantId: assistant.id,
                assistantRecordId: recordId,
                contactEmail: recipient,
            });

            try {
                const outgoing = { to: recipient, subject, body: bodyText, ...(thread ? { replyTo: replyAddress(thread.replyToken) } : {}) };
                if (provider === 'microsoft') await sendOutlookMessage(db, orgId, outgoing);
                else await sendGmailMessage(db, orgId, outgoing);
            } catch (e) {
                if (e instanceof IntegrationError) return json(200, { sent: false, reason: 'not_connected' });
                throw e;
            }

            // Record what actually went out. Best-effort by contract — the email has already been
            // delivered by this point, so a bookkeeping failure must not surface as a send failure.
            if (thread) {
                // `generatedBody` is the AGENT's text, which is not always what we are sending: a
                // reviewer can rewrite the draft in the Review Queue before approving, and that
                // edit overwrites `outreachDraft` in place. `draftOriginal` is stashed on the first
                // such edit (plan §2.6), so prefer it — it is the only thing that makes an edited
                // message distinguishable from an unedited one, which is what the template-feedback
                // loop reads. Absent it, nothing was edited and the two are genuinely equal.
                const original = (data.draftOriginal && typeof data.draftOriginal === 'object')
                    ? data.draftOriginal as Record<string, unknown> : null;
                const generatedBody = typeof original?.body === 'string' && original.body.trim()
                    ? original.body : bodyText;
                await recordOutboundMessage(db, thread.id, {
                    organisationId: orgId,
                    fromEmail: null,
                    subject,
                    body: bodyText,
                    generatedBody,
                });

                // Enrol in the follow-up cadence (Phase 2b). A consequence of having ACTUALLY
                // emailed someone, never a separate UI action — so it cannot run for a lead that
                // was never contacted, and the approval click that authorised this send is the
                // consent for the cadence that follows. Best-effort: an enrolment that fails to
                // write means no follow-ups, not a failed send.
                await enrolInSequence(db, {
                    organisationId: orgId,
                    aiAssistantId: assistant.id,
                    leadThreadId: thread.id,
                    assistantRecordId: recordId,
                    contactEmail: recipient,
                });
            }

            const chase = chaseDate();
            // ⚠️ `outreachDraftedAt` is DROPPED here, not merged through. It is the "you have no
            // inbox connected, here is the draft to send yourself" stamp, and a lead can carry it
            // legitimately — declined the connect prompt on Monday, connected an inbox and sent on
            // Tuesday. Left in place, the card would read "Email Drafted" beside an email that has
            // demonstrably gone out. `leadOutreachState` already prefers the send, so this is the
            // second of two guards, not the only one.
            const { outreachDraftedAt: _wasDrafted, ...rest } = data;
            const nextData = { ...rest, outreachDraft: { to: recipient, subject, body: bodyText }, outreachSentAt: new Date().toISOString() };
            await db.update(assistantRecords)
                .set({ approvalStatus: 'scheduled', scheduledFor: chase, data: nextData, updatedAt: new Date() })
                .where(eq(assistantRecords.id, recordId));

            // Revenue ledger (Phase 0). Emitted only on a CONFIRMED send — every non-send path above
            // returns early with a `reason`, so this line is never reached for them. That is what
            // keeps "outreach sent" an actual send count rather than an attempt count.
            // The recipient address is deliberately NOT stored in the payload: emailKind carries the
            // analytically useful part (role vs personal) without putting a third party's address in
            // an append-only table that no erasure path currently walks.
            await recordEvent(db, 'outreach_sent', {
                organisationId: orgId,
                aiAssistantId: assistant.id,
                assistantRecordId: recordId,
                actor: 'agent',
                actorUserId: userId,
                blueprintVersion: await blueprintVersion(),
                icpSnapshot: await icpSnapshot(recordId),
                payload: {
                    provider,
                    emailKind: emailKind ?? null,
                    emailSource: emailSource ?? null,
                    usedStoredDraft: !!str(draft?.body as string, 4000),
                },
            });

            return json(200, { sent: true, to: recipient, chaseDate: chase.toISOString() });
        }

        // ── Record which inbox this assistant sends outreach from ────────────────
        // The counterpart to the "connect your email?" prompt the Review tab now shows when an
        // approval could not send. Connecting the OAuth account is only half of it: send_outreach
        // gates on the ONBOARDING ANSWER (`outreachEmailProvider`), so a user who onboarded with
        // "no — I'll send outreach myself" and then connects Gmail would still never auto-send,
        // and nothing on this screen would explain why.
        //
        // Deliberately NOT the generic update-assistant-context route, which REPLACES
        // onboarding_context wholesale — a partial write from this screen would blank every other
        // setup answer the assistant has. This merges one key.
        //
        // 'none' is accepted as well: a user turning auto-send back off should not have to find
        // the Operational Setup form to do it.
        if (action === 'set_outreach_provider') {
            const wanted = str(body.provider, 20);
            if (wanted !== 'google' && wanted !== 'microsoft' && wanted !== 'none') {
                return json(400, { error: 'provider must be google, microsoft or none.' });
            }
            await db.update(aiAssistants)
                .set({ onboardingContext: { ...onboarding, outreachEmailProvider: wanted }, updatedAt: new Date() })
                .where(and(eq(aiAssistants.id, assistant.id), eq(aiAssistants.organisationId, orgId)));
            return json(200, { provider: wanted });
        }

        // ── List this assistant's lead ideas ─────────────────────────────────────
        if (action === 'list_ideas') {
            const ideas = await db
                .select({ id: assistantRecords.id, title: assistantRecords.title, status: assistantRecords.status, data: assistantRecords.data, updatedAt: assistantRecords.updatedAt })
                .from(assistantRecords)
                .where(and(
                    eq(assistantRecords.organisationId, orgId),
                    eq(assistantRecords.aiAssistantId, assistant.id),
                    eq(assistantRecords.recordType, 'lead_idea'),
                ))
                .orderBy(desc(assistantRecords.updatedAt));
            return json(200, { ideas });
        }

        // ── Propose new lead-generation ideas from the ICP ───────────────────────
        if (action === 'generate_ideas') {
            const system =
`You are a lead-generation strategist for "${assistant.name}", a business using Be More Swan. Propose 3 distinct, actionable lead-generation ideas: each names a target demographic, an industry sector, and a company-size band, and gives a one-sentence rationale grounded in the ideal customer profile below. Prefer small-to-mid-sized companies unless the profile says otherwise. Make the ideas genuinely different from one another.

Ideal customer profile (from setup):
${icp}

Return STRICT JSON only (no markdown), an array of exactly 3 objects:
[
  { "title": "<short punchy label>", "demographic": "<who>", "industrySector": "<sector>", "companySizeBand": "<e.g. 11-200 staff>", "rationale": "<one sentence>" }
]`;

            const resp = await anthropic.messages.create({
                model: MODEL,
                max_tokens: 1024,
                system,
                messages: [{ role: 'user', content: 'Propose 3 lead-generation ideas.' }],
            });
            logUsage(resp, 'generate_ideas');
            const raw = resp.content[0]?.type === 'text' ? resp.content[0].text : '';
            const parsed = parseJson<unknown[]>(raw);
            const list = Array.isArray(parsed) ? parsed : [];
            const saved: { id: number; title: string; status: string; data: unknown }[] = [];
            for (const item of list.slice(0, 3)) {
                if (!item || typeof item !== 'object') continue;
                const it = item as Record<string, unknown>;
                const title = str(it.title, 200);
                if (!title) continue;
                const data = {
                    type: 'lead_idea',
                    title,
                    demographic: str(it.demographic, 300) ?? '',
                    industrySector: str(it.industrySector, 200) ?? '',
                    companySizeBand: str(it.companySizeBand, 100) ?? '',
                    rationale: str(it.rationale, 500) ?? '',
                };
                const id = await upsertRecord('lead_idea', title, 'proposed', data, 'agent');
                saved.push({ id, title, status: 'proposed', data });
            }
            if (saved.length === 0) return json(502, { error: 'Could not generate ideas right now — please try again.' });
            return json(200, { ideas: saved });
        }

        // ── Approve an idea → launch a REAL outbound discovery run ───────────────
        // Previously this asked the LLM to "produce 3-4 realistic example companies" — i.e.
        // it fabricated leads. It now promotes the idea into a discovery_campaign and enqueues
        // a background run that searches the public web, dedupes, scores, and files genuine
        // leads into the Leads tab (pending approval). Design: docs/lead-generator-discovery-plan.md.
        if (action === 'approve_idea') {
            const ideaId = Number(body.ideaId);
            const [idea] = await db
                .select({ id: assistantRecords.id, title: assistantRecords.title, data: assistantRecords.data })
                .from(assistantRecords)
                .where(and(
                    eq(assistantRecords.id, ideaId),
                    eq(assistantRecords.organisationId, orgId),
                    eq(assistantRecords.aiAssistantId, assistant.id),
                    eq(assistantRecords.recordType, 'lead_idea'),
                ))
                .limit(1);
            if (!idea) return json(404, { error: 'Idea not found.' });

            // Compose the search hypothesis from the stored idea fields.
            const d = (idea.data && typeof idea.data === 'object' ? idea.data : {}) as Record<string, unknown>;
            const parts = [d.title, d.demographic, d.industrySector, d.companySizeBand, d.rationale]
                .map((v) => (typeof v === 'string' ? v.trim() : '')).filter(Boolean);
            const ideaText = parts.join(' — ') || String(idea.title);

            const { campaignId, jobId } = await createDiscoveryRun({
                db, organisationId: orgId, userId, aiAssistantId: assistant.id,
                idea: ideaText,
                targetPersona: {
                    demographic: d.demographic ?? null,
                    industrySector: d.industrySector ?? null,
                    companySizeBand: d.companySizeBand ?? null,
                },
                cadence: 'one_off',
            });

            // The status below claims "discovery running", so make that true. Without the poke the
            // job sat queued for up to a cron cycle while the record already said it was running.
            // Awaited deliberately — see trigger-drain.ts.
            if (jobId) {
                await triggerDiscoveryDrain(event.headers as Record<string, string | undefined>, jobId, 'lead-generation:approve_idea');
            }

            await db.update(assistantRecords)
                .set({ status: 'approved · discovery running', updatedAt: new Date() })
                .where(eq(assistantRecords.id, idea.id));

            return json(200, {
                ideaId: idea.id,
                runStarted: true,
                campaignId,
                jobId,
                searchConfigured: isSearchConfigured(),
                message: isSearchConfigured()
                    ? 'Discovery run started — found leads will appear in your Leads tab for approval shortly.'
                    : 'Idea approved, but no web search provider is connected yet — connect one to start discovering real leads.',
            });
        }

        // ── Decline an idea ──────────────────────────────────────────────────────
        if (action === 'decline_idea') {
            const ideaId = Number(body.ideaId);
            const [row] = await db.update(assistantRecords)
                .set({ status: 'declined', updatedAt: new Date() })
                .where(and(
                    eq(assistantRecords.id, ideaId),
                    eq(assistantRecords.organisationId, orgId),
                    eq(assistantRecords.aiAssistantId, assistant.id),
                    eq(assistantRecords.recordType, 'lead_idea'),
                ))
                .returning({ id: assistantRecords.id });
            if (!row) return json(404, { error: 'Idea not found.' });
            return json(200, { ideaId: row.id, status: 'declined' });
        }

        return json(400, { error: `Unknown action "${action}".` });
    } catch (err) {
        // Keep the friendly copy for the user, but make the failure traceable: the same
        // errorId goes to the client and to the log line, so a screenshot is enough to
        // find the real cause. Postgres detail (code + constraint) is logged explicitly —
        // a bare `err` dump is how the assistant_records_source_check violation behind the
        // dead "Add Lead" button stayed invisible (see db/assistant-records-lead-idea.sql).
        const errorId = randomUUID().slice(0, 8);
        const pg = err as { code?: string; constraint_name?: string; constraint?: string };
        console.error('[lead-generation]', {
            errorId,
            action,
            orgId,
            assistantId,
            pgCode: pg?.code,
            pgConstraint: pg?.constraint_name ?? pg?.constraint,
        }, err);
        return json(502, {
            errorId,
            error: `The Lead Generation Assistant is having trouble right now — please try again in a moment. (ref ${errorId})`,
        });
    }
});
