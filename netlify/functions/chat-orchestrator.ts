// netlify/functions/chat-orchestrator.ts
// Unified orchestrator for all Digital Assistant conversations — the single entry point
// the chat UI talks to, whichever of the (eventually 18) assistants is on the other end.
//
//  POST { chatSessionId?: number, aiAssistantId?: number, message: string }
//   → { chatSessionId, message: { id, role: 'assistant', content, uiElement, createdAt } }
//
// Pass aiAssistantId (no chatSessionId) to start a new conversation; pass chatSessionId
// to continue one. Per-role behaviour is injected via the ROUTES factory below, keyed by
// masterAssistants.roleKey — add a route per assistant as each Tier 1 role lands.
//
// Netlify Functions buffer responses (no true streaming), so this returns one JSON
// payload; the client should show its own loading state between send and response.
// Auth: aura_session + active org via requireTenant (tenant isolation on every read).

import { Handler } from '@netlify/functions';
import Anthropic from '@anthropic-ai/sdk';
import { and, asc, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, chatMessages, chatSessions, masterAssistants } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { logAiUsage } from '../../src/utils/ai-usage';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

const MAX_MESSAGE_CHARS = 4000;
// Cap on the serialised payloadToPass a HandoffProposalCard approval may carry — the
// payload is LLM-authored and client-echoed, so treat it as untrusted input.
const HANDOFF_PAYLOAD_MAX_CHARS = 4000;
// LLM context window: the most recent turns only — older history stays in the DB and can
// be summarised into the window later without changing the client contract.
const HISTORY_LIMIT = 20;

// Light per-instance rate limit (matches assistant-command.ts style).
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 20;
const rate = new Map<number, { count: number; start: number }>();
function allow(userId: number): boolean {
    const now = Date.now();
    const e = rate.get(userId);
    if (!e || now - e.start > RATE_WINDOW_MS) { rate.set(userId, { count: 1, start: now }); return true; }
    if (e.count >= RATE_MAX) return false;
    e.count++; return true;
}

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

// ── Router factory ────────────────────────────────────────────────────────────
// One AssistantRoute per masterAssistants.roleKey. Each route owns its system prompt and
// how the raw LLM text becomes { content, uiElement } — uiElement is the serialised
// "Disruptive UI" block (Lead Scoring Card, Action Item table, …) persisted to
// chatMessages.uiElementJson so transcripts re-hydrate exactly as first rendered.

interface RouteContext {
    assistantName: string;
    jobRole: string | null;
    /** The per-org instance's own system prompt (aiAssistants.systemPrompt), if set. */
    baseSystemPrompt: string | null;
    /** Role-specific onboarding answers captured at hire time (aiAssistants.onboardingContext). */
    onboardingContext: unknown;
}

interface AssistantRoute {
    model: string;
    maxTokens: number;
    buildSystemPrompt(rc: RouteContext): string;
    /** Turn the raw LLM text into displayable content + an optional Disruptive UI element. */
    parseResponse(raw: string): { content: string; uiElement: unknown | null };
}

function sharedContextBlock(rc: RouteContext): string {
    return [
        rc.baseSystemPrompt ? rc.baseSystemPrompt.trim() : '',
        `You are "${rc.assistantName}"${rc.jobRole ? `, the ${rc.jobRole}` : ''} for a small business using Be More Swan.`,
        rc.onboardingContext
            ? `Business context gathered during setup (use it — never ask for information already answered here):\n${JSON.stringify(rc.onboardingContext)}`
            : 'No onboarding context has been captured for this assistant yet.',
    ].filter(Boolean).join('\n\n');
}

// Plain conversational reply, no structured UI.
const defaultRoute: AssistantRoute = {
    model: DEFAULT_MODEL,
    maxTokens: 1024,
    buildSystemPrompt: (rc) => [
        sharedContextBlock(rc),
        'Reply conversationally in plain text. Be concise, warm, and practical. Do not use markdown headings.',
    ].join('\n\n'),
    parseResponse: (raw) => ({ content: raw.trim(), uiElement: null }),
};

// Strips accidental ```json fences and parses the route's structured reply. Falls back to
// treating the whole response as plain text so a malformed reply never 500s the chat.
function parseStructuredReply(raw: string): { content: string; uiElement: unknown | null } {
    const jsonText = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    try {
        const parsed = JSON.parse(jsonText);
        if (parsed && typeof parsed.reply === 'string') {
            return { content: parsed.reply.trim(), uiElement: parsed.uiElement ?? null };
        }
    } catch { /* fall through to plain text */ }
    return { content: raw.trim(), uiElement: null };
}

/** Pull one onboarding answer out of the (untyped) onboardingContext JSON blob. */
function onboardingValue(rc: RouteContext, key: string): unknown {
    if (rc.onboardingContext && typeof rc.onboardingContext === 'object') {
        return (rc.onboardingContext as Record<string, unknown>)[key];
    }
    return undefined;
}

const ROUTES: Record<string, AssistantRoute> = {
    // Tier 1, Batch 1 — Lead Qualifier. Scores inbound leads against the ideal-customer
    // profile captured at hire time (targetIndustries / minHeadcount / salesTone, see
    // src/config/assistant-onboarding-schemas.js). Wire shape: reply + lead_scoring_card
    // uiElement, matching the LeadScoringCard renderer in disruptive-ui-registry.js.
    lead_qualifier: {
        model: DEFAULT_MODEL,
        maxTokens: 1024,
        buildSystemPrompt: (rc) => {
            const industries = onboardingValue(rc, 'targetIndustries');
            const minHeadcount = onboardingValue(rc, 'minHeadcount');
            const salesTone = onboardingValue(rc, 'salesTone');
            return [
                sharedContextBlock(rc),
                `You qualify inbound leads for this business. Score every lead against the ideal customer profile below — a lead that matches it well scores high; one that misses it scores low, and your reasons must say which criteria it met or missed.

Ideal customer profile (from setup):
- Target industries: ${industries ? JSON.stringify(industries) : 'not specified — treat industry as neutral'}
- Minimum company headcount: ${minHeadcount ?? 'not specified — treat company size as neutral'}
- Sales tone: ${salesTone ?? 'professional'} — write your reply (and the suggested next step) in this tone.

Scoring bands: 70-100 = "hot" (strong profile fit + buying intent), 40-69 = "warm" (partial fit or unclear intent), 0-39 = "cold" (poor fit or no intent).

When the conversation contains enough detail to assess a lead, include the scoring card.

HANDOFF PROTOCOL — when you lack the firmographic data to score a named lead confidently against the profile (e.g. company size/headcount, industry, or revenue is unknown), do NOT output the lead_scoring_card yet. Instead propose a handoff to "The CRM Enricher": explain in your reply what is missing and that the enricher can fill the gaps, and emit the handoff_proposal uiElement below. Put everything the enricher needs in payloadToPass — the lead/company name, every detail already known from the conversation, and the fields you are missing. The user must approve the handoff before it runs.

A later user turn may be marked "[Approved handoff result]" and contain enriched data from The CRM Enricher — when it does, treat that data as trusted CRM enrichment, complete your original scoring task, and emit the lead_scoring_card. If the user declines the handoff, score with what you have and say which criteria you had to treat as neutral. Only propose a handoff when a specific lead has been named; if no lead is on the table yet, set uiElement to null and ask.

Return STRICT JSON (no markdown, no prose outside the JSON). uiElement is EXACTLY ONE of the two shapes below, or null:
{
  "reply": "your conversational message to the user",
  "uiElement": {                      // shape 1 — enough data to score
    "type": "lead_scoring_card",
    "leadName": "<name or company>",
    "score": <0-100>,
    "rating": "hot" | "warm" | "cold",
    "reasons": ["<short reason tied to the profile criteria>", ...],
    "suggestedNextStep": "<one concrete action>"
  }
}
{
  "reply": "your conversational message to the user",
  "uiElement": {                      // shape 2 — missing data, propose enrichment
    "type": "handoff_proposal",
    "targetAssistantName": "The CRM Enricher",
    "targetRoleKey": "crm_enricher",
    "reason": "<one sentence naming the missing data, e.g. 'Company size and revenue are unknown, so the lead cannot be scored against the profile yet.'>",
    "payloadToPass": {
      "recordName": "<lead or company name>",
      "knownDetails": { "<field>": "<value already known from the conversation>", ... },
      "missingFields": ["<field the enricher should fill>", ...]
    }
  }
}`,
            ].join('\n\n');
        },
        parseResponse: parseStructuredReply,
    },

    // Tier 1, Batch 1 — Accounts Receivable Clerk. Polite-but-firm collections agent;
    // chases overdue invoices above the configured threshold on the configured cadence.
    // Wire shape: reply + aging_invoices_table uiElement, matching the
    // AgingInvoicesTableCard renderer in disruptive-ui-registry.js.
    accounts_receivable_clerk: {
        model: DEFAULT_MODEL,
        maxTokens: 1536,
        buildSystemPrompt: (rc) => {
            const platform = onboardingValue(rc, 'accountingPlatform');
            const cadence = onboardingValue(rc, 'followUpCadence');
            const minInvoiceValue = onboardingValue(rc, 'minInvoiceValue');
            return [
                sharedContextBlock(rc),
                `You are a collections agent chasing overdue invoices for this business. Your voice is polite but firm: always courteous and professional, never apologetic about asking for money that is owed, and escalating in firmness the longer an invoice is past due.

Collections policy (from setup):
- Accounting platform: ${platform ?? 'not specified'} — refer to it by name when talking about where invoice data lives.
- Follow-up cadence: ${cadence ?? 'weekly'} — recommend chasing on this rhythm.
- Minimum invoice value to chase: ${minInvoiceValue ?? 'no threshold'} — do not recommend chasing invoices below this value; mention you are leaving them alone.

When the conversation contains overdue-invoice details (from the user pasting a report, listing debtors, or asking you to review their aged receivables), include the aging table; otherwise set uiElement to null and ask for the aged-receivables detail you need. Sort invoices most-overdue first. status is your recommended chasing stage: "reminder" (gentle nudge), "overdue" (firm chase), "final_notice" (last warning before escalation), or "escalated" (recommend humans/legal take over).

Return STRICT JSON (no markdown, no prose outside the JSON):
{
  "reply": "your conversational message to the user",
  "uiElement": {                      // or null when there is no invoice data yet
    "type": "aging_invoices_table",
    "title": "<short heading, e.g. 'Overdue invoices — June'>",
    "invoices": [
      { "clientName": "<client>", "daysPastDue": <number>, "amount": "<formatted amount incl. currency symbol>", "status": "reminder" | "overdue" | "final_notice" | "escalated" },
      ...
    ]
  }
}`,
            ].join('\n\n');
        },
        parseResponse: parseStructuredReply,
    },

    // Tier 1, Batch 2 — CRM Enricher. Data enrichment engine: given a company or contact,
    // generates (mock) enriched values for the fields chosen at hire time and shows them as
    // a before/after diff. Wire shape: reply + data_diff_view uiElement, matching the
    // DataDiffViewCard renderer in disruptive-ui-registry.js.
    crm_enricher: {
        model: DEFAULT_MODEL,
        maxTokens: 1536,
        buildSystemPrompt: (rc) => {
            const primaryCrm = onboardingValue(rc, 'primaryCrm');
            const targetData = onboardingValue(rc, 'targetEnrichmentData');
            const overwriteLogic = onboardingValue(rc, 'overwriteLogic');
            return [
                sharedContextBlock(rc),
                `You are a CRM data enrichment engine. When the user gives you a company or contact (a name, a pasted CRM record, or a list), research and propose enriched values for the target fields below. Live data connections are not wired up yet, so generate plausible, clearly-illustrative mock data — say in your reply that these are simulated values pending the CRM integration.

Enrichment policy (from setup):
- Primary CRM: ${primaryCrm ?? 'not specified'} — use its terminology (properties/fields/records) when talking about where data lands.
- Target enrichment data: ${targetData ? JSON.stringify(targetData) : 'not specified — default to LinkedIn URL, company size, and industry'} — propose one diff row per target field.
- Overwrite logic: ${overwriteLogic === 'overwrite_existing'
    ? 'Overwrite existing fields — you may propose a newValue that replaces a populated oldValue when your data is better.'
    : 'Only fill blank fields — NEVER propose changing a populated oldValue; only include rows where oldValue is null/blank, and mention any populated fields you left alone.'}

Use any current values the user shares as oldValue; when a field's current value is unknown or blank, set oldValue to null. When the conversation names a record to enrich, include the diff view; otherwise set uiElement to null and ask which company or contact to enrich (and for their current field values if relevant).

Return STRICT JSON (no markdown, no prose outside the JSON):
{
  "reply": "your conversational message to the user",
  "uiElement": {                      // or null when there is nothing to enrich yet
    "type": "data_diff_view",
    "recordName": "<company or contact being enriched>",
    "fields": [
      { "fieldName": "<CRM field>", "oldValue": "<current value>" | null, "newValue": "<proposed value>" },
      ...
    ]
  }
}`,
            ].join('\n\n');
        },
        parseResponse: parseStructuredReply,
    },

    // Tier 1, Batch 2 — Tier 1 Support Agent. Front-line support triage: resolves routine
    // queries within its confidence threshold and simulates escalation for angry customers,
    // refund demands, or manager requests. Wire shape: reply + ticket_triage_view uiElement,
    // matching the TicketTriageViewCard renderer in disruptive-ui-registry.js.
    // NOTE: roleKey tier1_support_agent matches masterAssistants.roleKey (db/seed-catalog.ts).
    tier1_support_agent: {
        model: DEFAULT_MODEL,
        maxTokens: 1024,
        buildSystemPrompt: (rc) => {
            const platform = onboardingValue(rc, 'helpdeskPlatform');
            const threshold = onboardingValue(rc, 'autoResolveThreshold');
            const escalationEmail = onboardingValue(rc, 'escalationEmail');
            const supportTone = onboardingValue(rc, 'supportTone');
            return [
                sharedContextBlock(rc),
                `You are a Tier 1 customer support agent handling front-line queries for this business. Write every customer-facing reply in the configured tone. Live helpdesk connections are not wired up yet, so triage the query the user pastes or describes as if it were a ticket.

Support policy (from setup):
- Helpdesk platform: ${platform ?? 'not specified'} — refer to it by name when talking about tickets and queues.
- Auto-resolve confidence threshold: ${threshold ?? 75}% — only mark a ticket Resolved when your confidence is at or above this; below it, escalate.
- Escalation email: ${escalationEmail ?? 'not specified'} — escalated tickets are flagged for this inbox.
- Support tone: ${supportTone ?? 'professional'}.

MANDATORY escalation triggers — regardless of confidence, set status to "Escalated" when the query contains angry or abusive language, a refund demand, a request for a manager/human, or a legal/complaint threat. Set escalationReason to a short plain-English explanation of which trigger (or low confidence) fired; use null when the ticket is Resolved.

Every triaged query MUST include the ticket triage view. Only set uiElement to null when there is no support query to triage yet — then ask for the ticket or customer message.

Return STRICT JSON (no markdown, no prose outside the JSON):
{
  "reply": "your reply to the user — for Resolved tickets include the suggested customer response; for Escalated tickets explain the handover",
  "uiElement": {                      // or null when there is no ticket to triage yet
    "type": "ticket_triage_view",
    "status": "Resolved" | "Escalated",
    "confidenceScore": <0-100>,
    "summary": "<one-sentence summary of the customer's issue>",
    "escalationReason": "<why it was escalated>" | null,
    "escalationEmail": ${escalationEmail ? JSON.stringify(escalationEmail) : 'null'}
  }
}`,
            ].join('\n\n');
        },
        parseResponse: parseStructuredReply,
    },
};

// ── Handler ───────────────────────────────────────────────────────────────────

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId: orgId } = ctx;

    if (!allow(userId)) {
        return json(429, { error: 'You are sending messages very quickly — give me a moment and try again.' });
    }

    let body: {
        chatSessionId?: number;
        aiAssistantId?: number;
        message?: string;
        approvedHandoff?: { targetRoleKey?: string; targetAssistantName?: string; payloadToPass?: unknown };
    };
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

    const message = (body.message || '').trim();
    if (!message) return json(400, { error: 'message is required' });
    if (message.length > MAX_MESSAGE_CHARS) return json(400, { error: `Message too long (max ${MAX_MESSAGE_CHARS} characters).` });

    // ── HITL handoff approval — the hidden flag sent by chat-session.js when the user
    // clicks "Approve Handoff" on a HandoffProposalCard. Validated up front: the target
    // must be a routed assistant, and the payload (LLM-authored) is size-capped.
    let handoff: { targetRoleKey: string; targetAssistantName: string; payloadJson: string } | null = null;
    if (body.approvedHandoff !== undefined) {
        const h = body.approvedHandoff;
        const targetRoleKey = typeof h?.targetRoleKey === 'string' ? h.targetRoleKey : '';
        if (!ROUTES[targetRoleKey]) return json(400, { error: 'Unknown handoff target.' });
        let payloadJson: string;
        try { payloadJson = JSON.stringify(h.payloadToPass ?? {}); } catch { return json(400, { error: 'Invalid handoff payload.' }); }
        if (payloadJson.length > HANDOFF_PAYLOAD_MAX_CHARS) return json(400, { error: 'Handoff payload too large.' });
        handoff = {
            targetRoleKey,
            targetAssistantName: typeof h.targetAssistantName === 'string' && h.targetAssistantName.trim()
                ? h.targetAssistantName.trim().slice(0, 100)
                : targetRoleKey,
            payloadJson,
        };
    }

    // ── Resolve the session (continue or create) — always scoped to the caller's org ──
    let session: { id: number; aiAssistantId: number };

    if (body.chatSessionId !== undefined) {
        const [existing] = await db
            .select({ id: chatSessions.id, aiAssistantId: chatSessions.aiAssistantId, status: chatSessions.status })
            .from(chatSessions)
            .where(and(eq(chatSessions.id, Number(body.chatSessionId)), eq(chatSessions.organisationId, orgId)))
            .limit(1);
        if (!existing) return json(404, { error: 'Chat session not found.' });
        if (existing.status !== 'active') return json(409, { error: 'This conversation is archived — start a new one.' });
        session = existing;
    } else {
        const assistantId = Number(body.aiAssistantId);
        if (!Number.isInteger(assistantId)) return json(400, { error: 'aiAssistantId is required to start a new conversation.' });
        const [assistant] = await db
            .select({ id: aiAssistants.id, lifecycleStatus: aiAssistants.lifecycleStatus })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId)))
            .limit(1);
        if (!assistant) return json(404, { error: 'Assistant not found in this organisation.' });
        if (assistant.lifecycleStatus === 'archived') return json(409, { error: 'This assistant has been archived.' });

        const [created] = await db
            .insert(chatSessions)
            .values({ organisationId: orgId, userId, aiAssistantId: assistant.id })
            .returning({ id: chatSessions.id, aiAssistantId: chatSessions.aiAssistantId });
        session = created;
    }

    // ── Retrieve state: assistant instance + roleKey + prior turns ──
    const [assistantRow] = await db
        .select({
            id: aiAssistants.id,
            name: aiAssistants.name,
            jobRole: aiAssistants.aiAssistantJobRole,
            systemPrompt: aiAssistants.systemPrompt,
            onboardingContext: aiAssistants.onboardingContext,
            roleKey: masterAssistants.roleKey,
        })
        .from(aiAssistants)
        .leftJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
        .where(and(eq(aiAssistants.id, session.aiAssistantId), eq(aiAssistants.organisationId, orgId)))
        .limit(1);
    if (!assistantRow) return json(404, { error: 'Assistant not found in this organisation.' });

    const history = await db
        .select({ role: chatMessages.role, content: chatMessages.content, createdAt: chatMessages.createdAt })
        .from(chatMessages)
        .where(eq(chatMessages.chatSessionId, session.id))
        .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));

    // Persist the user's turn before calling the LLM so it survives a provider failure.
    const [userMessage] = await db
        .insert(chatMessages)
        .values({ chatSessionId: session.id, role: 'user', content: message })
        .returning({ id: chatMessages.id, createdAt: chatMessages.createdAt });

    const route = (assistantRow.roleKey && ROUTES[assistantRow.roleKey]) || defaultRoute;
    const system = route.buildSystemPrompt({
        assistantName: assistantRow.name,
        jobRole: assistantRow.jobRole,
        baseSystemPrompt: assistantRow.systemPrompt,
        onboardingContext: assistantRow.onboardingContext,
    });

    // Only user/assistant turns go to the LLM ('system' rows are audit/injected notices),
    // capped to the most recent HISTORY_LIMIT.
    const llmMessages = [
        ...history
            .filter((m): m is typeof m & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant')
            .slice(-HISTORY_LIMIT)
            .map((m) => ({ role: m.role, content: m.content })),
        { role: 'user' as const, content: message },
    ];

    try {
        // ── The Shadow Call: run the approved handoff target in the background first ──
        // The target assistant is instantiated for this request only; its output is
        // injected into the active assistant's context (never streamed to the UI
        // directly) and persisted as a hidden 'system' row for audit.
        let handoffAudit: { roleKey: string; targetName: string; content: string; uiElement: unknown | null } | null = null;

        if (handoff) {
            const targetRoute = ROUTES[handoff.targetRoleKey];

            // Prefer the org's own hired instance of the target role (its name, custom
            // prompt and onboarding answers); fall back to a synthetic context so the
            // handoff still works when the target hasn't been hired yet.
            const [shadowRow] = await db
                .select({
                    id: aiAssistants.id,
                    name: aiAssistants.name,
                    jobRole: aiAssistants.aiAssistantJobRole,
                    systemPrompt: aiAssistants.systemPrompt,
                    onboardingContext: aiAssistants.onboardingContext,
                })
                .from(aiAssistants)
                .innerJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
                .where(and(
                    eq(masterAssistants.roleKey, handoff.targetRoleKey),
                    eq(aiAssistants.organisationId, orgId),
                ))
                .limit(1);

            const targetName = shadowRow?.name ?? handoff.targetAssistantName;
            const shadowSystem = targetRoute.buildSystemPrompt({
                assistantName: targetName,
                jobRole: shadowRow?.jobRole ?? null,
                baseSystemPrompt: shadowRow?.systemPrompt ?? null,
                onboardingContext: shadowRow?.onboardingContext ?? null,
            });

            const shadowResponse = await anthropic.messages.create({
                model: targetRoute.model,
                max_tokens: targetRoute.maxTokens,
                system: shadowSystem,
                messages: [{
                    role: 'user' as const,
                    content: `Background handoff (automated — the user approved this handoff; they are not addressing you directly). "${assistantRow.name}" needs your output to finish its own task. Work the payload below and respond in your usual format; keep the reply brief.\n\nHandoff payload:\n${handoff.payloadJson}`,
                }],
            });

            // Shadow calls burn real tokens — same telemetry as a foreground turn, with a
            // :handoff session suffix so COGS reporting can split background work out.
            void logAiUsage({
                workspaceId: orgId,
                userId,
                assistantId: shadowRow?.id ?? assistantRow.id,
                model: targetRoute.model,
                inputTokens: shadowResponse.usage.input_tokens,
                outputTokens: shadowResponse.usage.output_tokens,
                sessionId: `chat:${session.id}:handoff`,
                dataCategories: ['business_context'],
            });

            const shadowRaw = shadowResponse.content[0]?.type === 'text' ? shadowResponse.content[0].text : '';
            const shadow = targetRoute.parseResponse(shadowRaw);
            handoffAudit = { roleKey: handoff.targetRoleKey, targetName, content: shadow.content, uiElement: shadow.uiElement };

            // The Context Injection + Resumption: append the shadow output as an extra
            // user turn so the active assistant completes its original task with it.
            // (Consecutive user turns are combined into one by the API.)
            llmMessages.push({
                role: 'user' as const,
                content: [
                    `[Approved handoff result] Here is the enriched data from ${targetName}:`,
                    shadow.content,
                    shadow.uiElement ? `Structured data:\n${JSON.stringify(shadow.uiElement)}` : '',
                    'Please complete your original task using this data.',
                ].filter(Boolean).join('\n\n'),
            });
        }

        const response = await anthropic.messages.create({
            model: route.model,
            max_tokens: route.maxTokens,
            system,
            messages: llmMessages,
        });

        void logAiUsage({
            workspaceId: orgId,
            userId,
            assistantId: assistantRow.id,
            model: route.model,
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            sessionId: `chat:${session.id}`,
            dataCategories: ['business_context'],
        });

        const raw = response.content[0]?.type === 'text' ? response.content[0].text : '';
        const { content, uiElement } = route.parseResponse(raw);

        // One transaction: the shadow call's audit row (role 'system' — hidden from the
        // transcript and excluded from the LLM window, kept so the handoff's work is
        // auditable) commits together with the final assistant reply, or not at all.
        const [assistantMessage] = await db.transaction(async (tx) => {
            if (handoffAudit) {
                await tx.insert(chatMessages).values({
                    chatSessionId: session.id,
                    role: 'system',
                    content: `[handoff:${handoffAudit.roleKey}] ${handoffAudit.targetName}: ${handoffAudit.content}`,
                    uiElementJson: handoffAudit.uiElement,
                });
            }
            return tx
                .insert(chatMessages)
                .values({ chatSessionId: session.id, role: 'assistant', content, uiElementJson: uiElement })
                .returning({ id: chatMessages.id, createdAt: chatMessages.createdAt });
        });

        await db.update(chatSessions).set({ updatedAt: new Date() }).where(eq(chatSessions.id, session.id));

        return json(200, {
            chatSessionId: session.id,
            userMessageId: userMessage.id,
            message: {
                id: assistantMessage.id,
                role: 'assistant',
                content,
                uiElement,
                createdAt: assistantMessage.createdAt,
            },
        });
    } catch (err) {
        console.error('[chat-orchestrator] LLM error:', err);
        // The user's turn is already persisted; the client can retry into the same session.
        return json(502, { chatSessionId: session.id, userMessageId: userMessage.id, error: "I'm having trouble right now — please try again in a moment." });
    }
};
