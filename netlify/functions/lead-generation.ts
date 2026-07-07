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

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5-20251001';

// Assistants that a next-best-action can be handed off to, keyed by roleKey. `lead_qualifier`
// itself means "the Lead Generator handles this" (no handoff). Names match db/seed-catalog.ts.
const HANDOFF_TARGETS: Record<string, string> = {
    lead_qualifier: 'The Lead Generator',
    crm_enricher: 'The CRM Enricher',
    accounts_receivable_clerk: 'The Accounts Receivable Clerk',
    social_media_manager: 'The Social Media Manager',
    tier1_support_agent: 'The Support Agent',
};

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

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId, userId } = ctx;

    let body: { action?: string; assistantId?: number; ideaId?: number; lead?: Record<string, unknown> };
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

        // ── Approve an idea → find, score & file example leads ───────────────────
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

            const ownerList = Object.entries(HANDOFF_TARGETS).map(([k, v]) => `"${k}" (${v})`).join(', ');
            const system =
`You find and score lead opportunities for "${assistant.name}", a business using Be More Swan, based on an approved lead-generation idea. Produce 3-4 realistic example companies that fit the idea and the ideal customer profile. Score each against the profile and set a concrete next best action.

For each lead also pick who should own the next action: "lead_qualifier" means the Lead Generator handles it itself; otherwise hand off to the assistant best suited to it. Owner must be one of: ${ownerList}. Aim for a realistic mix — most owned by lead_qualifier, one or two handed off (e.g. missing firmographics → crm_enricher).

Ideal customer profile (from setup):
${icp}

Approved idea:
${JSON.stringify(idea.data)}

${SCORING_BANDS}

Return STRICT JSON only (no markdown), an array of 3-4 objects:
[
  {
    "leadName": "<company or contact>",
    "score": <0-100>,
    "rating": "hot" | "warm" | "cold",
    "reasons": ["<reason tied to a profile criterion>", ...],
    "suggestedNextStep": "<one concrete action>",
    "outreachDraft": { "to": null, "subject": "<subject>", "body": "<personalised outreach>" } | null,
    "nextActionOwner": "<one of the roleKeys above>",
    "nextActionOwnerName": "<the matching display name>"
  }
]`;

            const resp = await anthropic.messages.create({
                model: MODEL,
                max_tokens: 2048,
                system,
                messages: [{ role: 'user', content: `Find and score leads for this idea: ${idea.title}` }],
            });
            logUsage(resp, 'approve_idea');
            const raw = resp.content[0]?.type === 'text' ? resp.content[0].text : '';
            const parsed = parseJson<unknown[]>(raw);
            const list = Array.isArray(parsed) ? parsed : [];

            const leads: { id: number; owner: string; ownerName: string; data: Record<string, unknown> }[] = [];
            for (const item of list.slice(0, 4)) {
                if (!item || typeof item !== 'object') continue;
                const it = item as Record<string, unknown>;
                const card = normaliseLeadCard(it, 'Lead opportunity');
                const owner = HANDOFF_TARGETS[String(it.nextActionOwner)] ? String(it.nextActionOwner) : 'lead_qualifier';
                const ownerName = HANDOFF_TARGETS[owner];
                // Keep the owner on the stored card so the Data Hub row carries the handoff context too.
                card.nextActionOwner = owner;
                card.nextActionOwnerName = ownerName;
                const id = await upsertRecord('lead', String(card.leadName), String(card.rating), card, 'agent');
                leads.push({ id, owner, ownerName, data: card });
            }

            const status = leads.length ? `approved · ${leads.length} lead${leads.length === 1 ? '' : 's'}` : 'approved';
            await db.update(assistantRecords)
                .set({ status, updatedAt: new Date() })
                .where(eq(assistantRecords.id, idea.id));

            if (leads.length === 0) return json(502, { error: 'Approved, but no leads came back — try approving again.' });
            return json(200, {
                ideaId: idea.id,
                status,
                leads,
                handledHere: leads.filter((l) => l.owner === 'lead_qualifier'),
                handoffs: leads.filter((l) => l.owner !== 'lead_qualifier'),
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
};
