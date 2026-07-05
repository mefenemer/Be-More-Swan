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
    'lead-qualifier': {
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

When the conversation contains enough detail to assess a lead, include the scoring card; otherwise set uiElement to null and ask for what's missing (industry, company size, budget/intent).

Return STRICT JSON (no markdown, no prose outside the JSON):
{
  "reply": "your conversational message to the user",
  "uiElement": {                      // or null when no card is warranted yet
    "type": "lead_scoring_card",
    "leadName": "<name or company>",
    "score": <0-100>,
    "rating": "hot" | "warm" | "cold",
    "reasons": ["<short reason tied to the profile criteria>", ...],
    "suggestedNextStep": "<one concrete action>"
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
    'accounts-receivable-clerk': {
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

    let body: { chatSessionId?: number; aiAssistantId?: number; message?: string };
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

    const message = (body.message || '').trim();
    if (!message) return json(400, { error: 'message is required' });
    if (message.length > MAX_MESSAGE_CHARS) return json(400, { error: `Message too long (max ${MAX_MESSAGE_CHARS} characters).` });

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

        const [assistantMessage] = await db
            .insert(chatMessages)
            .values({ chatSessionId: session.id, role: 'assistant', content, uiElementJson: uiElement })
            .returning({ id: chatMessages.id, createdAt: chatMessages.createdAt });

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
