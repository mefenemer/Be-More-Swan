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
import Anthropic from '@anthropic-ai/sdk';
import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, assistantRecords, masterAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { logAiUsage } from '../../src/utils/ai-usage';
import { createDiscoveryRun } from '../../src/utils/discovery';
import { isSearchConfigured } from '../../src/lib/discovery-search';
import { sendGmailMessage } from '../../src/utils/gmail';
import { IntegrationError } from '../../src/utils/workspace-integrations';
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

/** The ideal-customer-profile block, built from the same onboarding answers the chat route uses. */
function icpBlock(onboarding: Record<string, unknown>): string {
    const industries = onboarding.targetIndustries;
    const minHeadcount = onboarding.minHeadcount;
    const salesTone = onboarding.salesTone;
    return [
        `- Target industries: ${industries ? JSON.stringify(industries) : 'not specified — treat industry as neutral'}`,
        `- Minimum company headcount: ${minHeadcount ?? 'not specified — treat company size as neutral'}`,
        `- Sales tone: ${salesTone ?? 'professional'} — write outreach and next steps in this tone.`,
    ].join('\n');
}

const SCORING_BANDS =
    'Scoring bands: 70-100 = "hot" (strong profile fit + buying intent), 40-69 = "warm" (partial fit or unclear intent), 0-39 = "cold" (poor fit or no intent).';

/** Coerce whatever the LLM returned into a safe lead_scoring_card wire shape. */
function normaliseLeadCard(raw: unknown, fallbackName: string): Record<string, unknown> {
    const ui = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
    const score = Math.max(0, Math.min(100, Math.round(Number(ui.score)) || 0));
    const rating = ['hot', 'warm', 'cold'].includes(String(ui.rating)) ? String(ui.rating)
        : score >= 70 ? 'hot' : score >= 40 ? 'warm' : 'cold';
    const reasons = Array.isArray(ui.reasons)
        ? ui.reasons.filter((r) => typeof r === 'string').slice(0, 6).map((r) => String(r).slice(0, 300))
        : [];
    let outreachDraft: unknown = null;
    if (ui.outreachDraft && typeof ui.outreachDraft === 'object') {
        const d = ui.outreachDraft as Record<string, unknown>;
        if (str(d.body)) outreachDraft = { to: str(d.to, 200), subject: str(d.subject, 300) ?? '', body: String(d.body).slice(0, 4000) };
    }
    return {
        type: 'lead_scoring_card',
        leadName: str(ui.leadName, 300) ?? fallbackName,
        score,
        rating,
        reasons,
        suggestedNextStep: str(ui.suggestedNextStep, 500) ?? '',
        outreachDraft,
    };
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

    let body: { action?: string; assistantId?: number; ideaId?: number; recordId?: number; lead?: Record<string, unknown> };
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

${SCORING_BANDS}

Return STRICT JSON only (no markdown, no prose outside the JSON):
{
  "leadName": "<the lead or company name>",
  "score": <0-100>,
  "rating": "hot" | "warm" | "cold",
  "reasons": ["<short reason tied to a profile criterion>", ...],
  "suggestedNextStep": "<one concrete next action>",
  "outreachDraft": { "to": "<email or null>", "subject": "<subject>", "body": "<personalised outreach email in the sales tone>" } | null
}
Write an outreachDraft for hot/warm leads; use null for cold leads.`;

            const resp = await anthropic.messages.create({
                model: MODEL,
                max_tokens: 1024,
                system,
                messages: [{ role: 'user', content: `Score this lead:\n${JSON.stringify(lead)}` }],
            });
            logUsage(resp, 'score_lead');
            const raw = resp.content[0]?.type === 'text' ? resp.content[0].text : '';
            const card = normaliseLeadCard(parseJson(raw), title);
            const id = await upsertRecord('lead', title, String(card.rating), card, 'manual');
            return json(200, { record: { id, title, status: card.rating, data: card } });
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

            const provider = str(onboarding.outreachEmailProvider, 40);
            if (provider === 'microsoft') return json(200, { sent: false, reason: 'microsoft_coming_soon' });
            if (provider !== 'google') return json(200, { sent: false, reason: 'no_provider' });

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

            // Use the stored draft if present; otherwise generate one from the lead's details.
            let subject = str(draft?.subject as string, 300);
            let bodyText = str(draft?.body as string, 4000);
            if (!bodyText) {
                const tone = str(onboarding.salesTone, 40) ?? 'professional';
                const system =
`You write a short, personalised cold outreach email for "${assistant.name}" (a business using Be More Swan) to the lead below, in a ${tone} tone. Under 150 words, no placeholders or brackets, no subject-line clichés. Return STRICT JSON only: { "subject": "<subject>", "body": "<email body>" }`;
                const resp = await anthropic.messages.create({
                    model: MODEL, max_tokens: 512, system,
                    messages: [{ role: 'user', content: `Lead: ${JSON.stringify({ title: rec.title, ...data })}` }],
                });
                logUsage(resp, 'send_outreach_gen');
                const gen = parseJson<{ subject?: string; body?: string }>(resp.content[0]?.type === 'text' ? resp.content[0].text : '') || {};
                subject = str(gen.subject, 300) || subject;
                bodyText = str(gen.body, 4000);
                if (!bodyText) return json(502, { error: 'Could not draft an outreach email for this lead.' });
            }
            if (!subject) subject = `Quick note for ${rec.title}`;

            try {
                await sendGmailMessage(db, orgId, { to: recipient, subject, body: bodyText });
            } catch (e) {
                if (e instanceof IntegrationError) return json(200, { sent: false, reason: 'not_connected' });
                throw e;
            }

            const chase = chaseDate();
            const nextData = { ...data, outreachDraft: { to: recipient, subject, body: bodyText }, outreachSentAt: new Date().toISOString() };
            await db.update(assistantRecords)
                .set({ approvalStatus: 'scheduled', scheduledFor: chase, data: nextData, updatedAt: new Date() })
                .where(eq(assistantRecords.id, recordId));

            return json(200, { sent: true, to: recipient, chaseDate: chase.toISOString() });
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
        console.error('[lead-generation]', action, err);
        return json(502, { error: 'The Lead Generator is having trouble right now — please try again in a moment.' });
    }
});
