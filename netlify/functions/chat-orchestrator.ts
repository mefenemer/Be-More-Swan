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
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, assistantRecords, chatMessages, chatSessions, kbArticles, kbChunks, masterAssistants, masterPlans, plans } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { logAiUsage } from '../../src/utils/ai-usage';
import { atomicCapCheck } from '../../src/utils/atomic-cap-check';
import { embedTexts } from '../../src/utils/kb-embeddings';
import { withLambda } from '@netlify/aws-lambda-compat';

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

// ── Billing enforcement ───────────────────────────────────────────────────────
// Every chat turn consumes one task credit from the org plan's monthly allowance
// (masterPlans.monthlyTaskLimit; null = unlimited), and an approved handoff's shadow
// call consumes a second one — background work must not run for an out-of-credit org.
// atomicCapCheck checks-and-increments in a single UPDATE, so concurrent turns cannot
// race past the cap. The credit is spent up-front; a later provider failure does not
// refund it (same semantics as task_runs).

const UPGRADE_REQUIRED_REASON = 'You have reached your monthly AI task limit.';

/** 403 paywall response — chat-session.js renders uiElementJson as an UpgradeRequiredCard. */
function upgradeRequired(reason: string | undefined, extra: Record<string, unknown> = {}) {
    return json(403, {
        ...extra,
        uiElementJson: { type: 'upgrade_required', reason: reason || UPGRADE_REQUIRED_REASON },
    });
}

/**
 * Resolve the org's monthly task limit from its plan (active preferred, then past_due —
 * a lapsed plan keeps its limits through the grace window, mirroring check-capacity.ts)
 * and atomically consume one credit. No plan row / no master plan = uncapped.
 */
async function consumeTaskCredit(db: ReturnType<typeof getDb>, organisationId: number) {
    const [plan] = await db
        .select({ monthlyTaskLimit: masterPlans.monthlyTaskLimit })
        .from(plans)
        .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
        .where(and(eq(plans.organisationId, organisationId), inArray(plans.status, ['active', 'past_due'])))
        // 'active' sorts before 'past_due', so an active plan always wins.
        .orderBy(asc(plans.status), asc(plans.startedAt))
        .limit(1);

    return atomicCapCheck({
        organisationId,
        counterKey: 'taskCount',
        limit: plan?.monthlyTaskLimit ?? null,
    });
}

// ── Router factory ────────────────────────────────────────────────────────────
// One AssistantRoute per masterAssistants.roleKey. Each route owns its system prompt and
// how the raw LLM text becomes { content, uiElement } — uiElement is the serialised
// "Disruptive UI" block (Lead Scoring Card, Action Item table, …) persisted to
// chatMessages.uiElementJson so transcripts re-hydrate exactly as first rendered.

/** Per-turn Knowledge Base retrieval result (retrieveKnowledgeBase). */
interface KnowledgeBaseContext {
    /** How many KB articles this assistant has — 0 = the KB hasn't been set up yet. */
    articleCount: number;
    /** Formatted top-matching excerpts for this turn; null when nothing matched. */
    excerpts: string | null;
}

interface RouteContext {
    assistantName: string;
    jobRole: string | null;
    /** The per-org instance's own system prompt (aiAssistants.systemPrompt), if set. */
    baseSystemPrompt: string | null;
    /** Role-specific onboarding answers captured at hire time (aiAssistants.onboardingContext). */
    onboardingContext: unknown;
    /** KB retrieval for this turn — only populated for routes with usesKnowledgeBase.
     *  null/undefined (e.g. shadow handoff calls) renders the "no KB yet" prompt path. */
    knowledgeBase?: KnowledgeBaseContext | null;
}

interface AssistantRoute {
    model: string;
    maxTokens: number;
    /** When true the handler runs KB retrieval on the user's message and passes the
     *  result into buildRolePrompt via rc.knowledgeBase (kb_articles / kb_chunks). */
    usesKnowledgeBase?: boolean;
    /** Role-specific prompt body. buildSystemPrompt() appends the hardened
     *  <strict_configuration> block to this before every API call. */
    buildRolePrompt(rc: RouteContext): string;
    /** Turn the raw LLM text into displayable content + an optional Disruptive UI element. */
    parseResponse(raw: string): { content: string; uiElement: unknown | null };
}

function sharedContextBlock(rc: RouteContext): string {
    return [
        rc.baseSystemPrompt ? rc.baseSystemPrompt.trim() : '',
        `You are "${rc.assistantName}"${rc.jobRole ? `, the ${rc.jobRole}` : ''} for a small business using Be More Swan.`,
        rc.onboardingContext
            ? 'The <strict_configuration> block at the end of these instructions holds the answers this business gave during setup — never ask for information already answered there.'
            : 'No onboarding context has been captured for this assistant yet.',
    ].filter(Boolean).join('\n\n');
}

// ── System prompt hardening ───────────────────────────────────────────────────
// Every API call gets the user's onboarding answers restated in a <strict_configuration>
// XML block appended AFTER the role prompt, with an explicit priority override. The role
// prompts still weave individual values (tone, thresholds, overwrite rules) into their
// task instructions; this block is the authoritative restatement that stops drift when
// those instructions and the model's own judgement disagree.

/** "minInvoiceValue" / "support_tone" → "Min invoice value" / "Support tone". */
function humanizeConfigKey(key: string): string {
    const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1).toLowerCase() : key;
}

function formatConfigValue(value: unknown): string {
    if (Array.isArray(value)) return value.map(formatConfigValue).join(', ');
    if (value !== null && typeof value === 'object') return JSON.stringify(value);
    return String(value).trim();
}

/**
 * Compose the final system string sent to Anthropic: the base prompt (the route's full
 * role prompt, which already folds in the instance's own aiAssistants.systemPrompt via
 * sharedContextBlock) followed by the onboardingContext rendered as human-readable
 * key/value rules inside <strict_configuration> tags.
 */
function buildSystemPrompt(baseSystemPrompt: string, onboardingContext: unknown): string {
    // onboardingContext is a JSON column, but tolerate a serialised string from older rows.
    let context = onboardingContext;
    if (typeof context === 'string') {
        try { context = JSON.parse(context); } catch { context = null; }
    }
    const entries = context && typeof context === 'object' && !Array.isArray(context)
        ? Object.entries(context as Record<string, unknown>)
            .filter(([, v]) => v !== null && v !== undefined && v !== '')
        : [];
    if (entries.length === 0) return baseSystemPrompt;

    const parameters = entries
        .map(([key, value]) => `- ${humanizeConfigKey(key)}: ${formatConfigValue(value)}`)
        .join('\n');

    return `${baseSystemPrompt}

<strict_configuration>
The user has configured your specific behavior with the following parameters. You MUST obey these rules at all times. If these rules conflict with your base instructions, these rules take priority:

${parameters}
</strict_configuration>`;
}

// Plain conversational reply, no structured UI.
const defaultRoute: AssistantRoute = {
    model: DEFAULT_MODEL,
    maxTokens: 1024,
    buildRolePrompt: (rc) => [
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

// Display labels for the meeting-note-taker's taskDestination onboarding values
// (src/config/assistant-onboarding-schemas.js) — shown verbatim in the card's sync button.
const TASK_DESTINATION_LABELS: Record<string, string> = {
    notion: 'Notion',
    jira: 'Jira',
    asana: 'Asana',
    monday: 'Monday.com',
};

/** Pull one onboarding answer out of the (untyped) onboardingContext JSON blob. */
function onboardingValue(rc: RouteContext, key: string): unknown {
    if (rc.onboardingContext && typeof rc.onboardingContext === 'object') {
        return (rc.onboardingContext as Record<string, unknown>)[key];
    }
    return undefined;
}

// ── Spreadsheet Fallback (Golden Rule 1) ──────────────────────────────────────
// Appended to every Tier 1 role prompt: the assistant must never treat an external
// system (CRM/helpdesk/accounting/…) as a prerequisite. Users without one work via
// CSV upload/export in the role's Data Hub tab on the assistant's dashboard page.
function spreadsheetFallback(platform: unknown, tabLabel: string, subject: string): string {
    const platformLabel = platform ? String(platform) : 'an external system';
    return `SPREADSHEET FALLBACK — do not assume this business uses ${platformLabel}, and NEVER tell the user an external system is required. They can equally: paste ${subject} directly into this chat; upload a CSV of ${subject} in the "${tabLabel}" tab of your dashboard (Excel and Google Sheets users export via File → Download → CSV); and export everything you produce back out as CSV from that same tab. Every structured result you emit here is saved to the "${tabLabel}" tab automatically, so nothing is lost when the conversation ends. When the user asks how to get data in or out and has no integration connected, point them to the "${tabLabel}" tab.`;
}

// ── Internal Data Hub persistence (Golden Rule 2) ─────────────────────────────
// Structured chat output flows into assistant_records automatically so the Data Hub
// tab (assistant-detail.html) lists it. Each hub-type uiElement maps to one or more
// records whose `data` is a renderable uiElement wire shape; upsert on
// (assistant, recordType, title) so re-processing a record refreshes it.

type HubRecord = { recordType: string; title: string; status: string | null; data: unknown };

function hubRecordsFromUiElement(uiElement: unknown): HubRecord[] {
    if (!uiElement || typeof uiElement !== 'object') return [];
    const ui = uiElement as Record<string, unknown>;
    const str = (v: unknown, max = 300) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

    switch (ui.type) {
        case 'lead_scoring_card': {
            const title = str(ui.leadName);
            return title ? [{ recordType: 'lead', title, status: str(ui.rating, 60) ?? 'scored', data: ui }] : [];
        }
        case 'data_diff_view': {
            const title = str(ui.recordName);
            return title ? [{ recordType: 'enrichment', title, status: 'proposed', data: ui }] : [];
        }
        case 'action_item_assignment': {
            const title = str(ui.meetingTitle) ?? `Meeting notes — ${new Date().toISOString().slice(0, 10)}`;
            const open = Array.isArray(ui.tasks) ? ui.tasks.length : 0;
            return [{ recordType: 'meeting', title, status: open ? 'open' : 'no actions', data: ui }];
        }
        case 'aging_invoices_table': {
            // One hub record per invoice row so "last chased" / pause state can be
            // tracked per client; data stays a renderable one-row aging table.
            const invoices = Array.isArray(ui.invoices) ? ui.invoices : [];
            return invoices.flatMap((inv) => {
                if (!inv || typeof inv !== 'object') return [];
                const title = str((inv as Record<string, unknown>).clientName);
                if (!title) return [];
                return [{
                    recordType: 'invoice',
                    title,
                    status: str((inv as Record<string, unknown>).status, 60) ?? 'overdue',
                    data: { type: 'aging_invoices_table', title: ui.title ?? null, accountingProvider: ui.accountingProvider ?? null, invoices: [inv] },
                }];
            });
        }
        case 'ticket_triage_view': {
            const title = str(ui.summary) ?? (ui.ticketId ? `Ticket #${str(ui.ticketId, 40)}` : null);
            return title ? [{ recordType: 'ticket', title, status: str(ui.status, 60), data: ui }] : [];
        }
        default:
            return [];
    }
}

// Issue #180: the chat transcript had no link back to where a completed task actually
// landed. Every hub record starts 'pending_approval' (assistant_records default), which
// is what surfaces it in the assistant-detail Review Queue tab — so whenever a turn
// produces hub records, tell the user in-line and point them at that tab.
const HUB_RECORD_LABELS: Record<string, string> = {
    lead: 'lead',
    enrichment: 'enrichment record',
    meeting: 'meeting summary',
    invoice: 'invoice',
    ticket: 'ticket',
};

function hubLinkFromRecords(records: HubRecord[]): { tab: string; label: string } | null {
    if (records.length === 0) return null;
    if (records.length === 1) {
        const kind = HUB_RECORD_LABELS[records[0].recordType] ?? 'record';
        return { tab: 'review-queue', label: `Added this ${kind} to your Review Queue` };
    }
    return { tab: 'review-queue', label: `Added ${records.length} items to your Review Queue` };
}

/** Best-effort upsert of a reply's hub records — a persistence failure never fails the turn. */
async function persistHubRecords(
    db: ReturnType<typeof getDb>,
    orgId: number,
    aiAssistantId: number,
    records: HubRecord[],
): Promise<void> {
    if (records.length === 0) return;
    try {
        for (const rec of records) {
            const [existing] = await db
                .select({ id: assistantRecords.id })
                .from(assistantRecords)
                .where(and(
                    eq(assistantRecords.organisationId, orgId),
                    eq(assistantRecords.aiAssistantId, aiAssistantId),
                    eq(assistantRecords.recordType, rec.recordType),
                    eq(assistantRecords.title, rec.title),
                ))
                .limit(1);
            if (existing) {
                await db.update(assistantRecords)
                    .set({ status: rec.status, data: rec.data, source: 'chat', updatedAt: new Date() })
                    .where(eq(assistantRecords.id, existing.id));
            } else {
                await db.insert(assistantRecords).values({
                    organisationId: orgId,
                    aiAssistantId,
                    recordType: rec.recordType,
                    title: rec.title,
                    status: rec.status,
                    source: 'chat',
                    data: rec.data,
                });
            }
        }
    } catch (err) {
        console.error('[chat-orchestrator] hub record persistence failed:', err);
    }
}

// ── Knowledge Base retrieval (tier1_support_agent) ────────────────────────────
// Grounds "Resolved" answers in the business's own KB articles (kb_articles /
// kb_chunks, managed via the Knowledge Base tab → netlify/functions/kb-articles.ts).
// Vector search first (Voyage query embedding + pgvector cosine over kb_chunks);
// falls back to Postgres full-text search when no embedding provider is configured,
// the query embedding fails, or nothing lands within the distance ceiling. Any
// retrieval failure degrades to "no KB" — the turn must never 500 because of RAG.

const KB_TOP_K = 5;
// Cosine distance ceiling — beyond this a chunk is noise, not support. Voyage
// cosine similarities for on-topic support matches typically sit well above 0.45.
const KB_MAX_DISTANCE = 0.55;
// Cap on chars per injected excerpt and on the query text sent for embedding.
const KB_EXCERPT_MAX_CHARS = 1600;
const KB_QUERY_MAX_CHARS = 2000;

async function retrieveKnowledgeBase(
    db: ReturnType<typeof getDb>,
    orgId: number,
    aiAssistantId: number,
    query: string,
): Promise<KnowledgeBaseContext> {
    try {
        const scope = and(eq(kbChunks.organisationId, orgId), eq(kbChunks.aiAssistantId, aiAssistantId));

        const [counted] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(kbArticles)
            .where(and(eq(kbArticles.organisationId, orgId), eq(kbArticles.aiAssistantId, aiAssistantId)));
        const articleCount = counted?.count ?? 0;
        if (articleCount === 0) return { articleCount: 0, excerpts: null };

        const q = query.slice(0, KB_QUERY_MAX_CHARS);
        let rows: { title: string; content: string }[] = [];

        // Semantic pass — embed the query and rank chunks by cosine distance.
        const vectors = await embedTexts([q], 'query').catch((err) => {
            console.error('[chat-orchestrator] KB query embedding failed:', err);
            return null;
        });
        if (vectors && vectors[0]) {
            const queryVector = `[${vectors[0].join(',')}]`;
            rows = await db
                .select({ title: kbArticles.title, content: kbChunks.content })
                .from(kbChunks)
                .innerJoin(kbArticles, eq(kbChunks.kbArticleId, kbArticles.id))
                .where(and(
                    scope,
                    sql`${kbChunks.embedding} IS NOT NULL`,
                    sql`${kbChunks.embedding} <=> ${queryVector}::vector < ${KB_MAX_DISTANCE}`,
                ))
                .orderBy(sql`${kbChunks.embedding} <=> ${queryVector}::vector`)
                .limit(KB_TOP_K);
        }

        // Keyword pass — full-text fallback over content_tsv (db/kb-articles.sql).
        if (rows.length === 0) {
            rows = await db
                .select({ title: kbArticles.title, content: kbChunks.content })
                .from(kbChunks)
                .innerJoin(kbArticles, eq(kbChunks.kbArticleId, kbArticles.id))
                .where(and(scope, sql`content_tsv @@ websearch_to_tsquery('english', ${q})`))
                .orderBy(sql`ts_rank(content_tsv, websearch_to_tsquery('english', ${q})) DESC`)
                .limit(KB_TOP_K);
        }

        if (rows.length === 0) return { articleCount, excerpts: null };
        const excerpts = rows
            .map((r, i) => `[KB ${i + 1}] From article "${r.title}":\n${r.content.slice(0, KB_EXCERPT_MAX_CHARS)}`)
            .join('\n\n');
        return { articleCount, excerpts };
    } catch (err) {
        // Missing tables (migration not applied) or any other retrieval failure:
        // behave as if no KB exists rather than failing the chat turn.
        console.error('[chat-orchestrator] KB retrieval failed:', err);
        return { articleCount: 0, excerpts: null };
    }
}

const ROUTES: Record<string, AssistantRoute> = {
    // Tier 1, Batch 1 — Lead Generator. Scores inbound leads against the ideal-customer
    // profile captured at hire time (targetIndustries / minHeadcount / salesTone, see
    // src/config/assistant-onboarding-schemas.js). Wire shape: reply + lead_scoring_card
    // uiElement, matching the LeadScoringCard renderer in disruptive-ui-registry.js.
    lead_qualifier: {
        model: DEFAULT_MODEL,
        maxTokens: 1024,
        buildRolePrompt: (rc) => {
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

A user turn may also open with "[Imported records]" followed by rows from the user's Leads tab (CSV upload) — treat each row as an inbound lead to score. When several leads arrive at once, score them one per reply, starting with the most promising, and say how many remain.

${spreadsheetFallback('a CRM like HubSpot', 'Leads', 'inbound leads')}

Return STRICT JSON (no markdown, no prose outside the JSON). uiElement is EXACTLY ONE of the two shapes below, or null:
{
  "reply": "your conversational message to the user",
  "uiElement": {                      // shape 1 — enough data to score
    "type": "lead_scoring_card",
    "leadName": "<name or company>",
    "score": <0-100>,
    "rating": "hot" | "warm" | "cold",
    "reasons": ["<short reason tied to the profile criteria>", ...],
    "suggestedNextStep": "<one concrete action>",
    "outreachDraft": {                // a ready-to-review outreach email for hot/warm leads; null for cold leads
      "to": "<the lead's email address, only when the conversation gives one>" | null,
      "subject": "<outreach email subject line>",
      "body": "<the full outreach email body, personalised to the lead and written in the sales tone>"
    } | null
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
        buildRolePrompt: (rc) => {
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

When the conversation contains overdue-invoice details (from the user pasting a report, uploading a CSV to the Ledger tab, listing debtors, or asking you to review their aged receivables), include the aging table; otherwise set uiElement to null and ask for the aged-receivables detail you need. Sort invoices most-overdue first. status is your recommended chasing stage: "reminder" (gentle nudge), "overdue" (firm chase), "final_notice" (last warning before escalation), or "escalated" (recommend humans/legal take over).

For every invoice you recommend chasing (status other than "escalated"), write the actual chasing email in emailDraft. Match the tone to the age of the debt: ~7 days overdue = friendly nudge that assumes good faith; ~30 days = firm and specific about the amount and original due date; 60+ days / final_notice = formal, states the consequence of continued non-payment. Always reference the amount and how overdue it is. Set emailDraft to null only for "escalated" invoices (a human takes over) and for invoices below the minimum-value threshold.

A user turn may open with "[Imported records]" followed by rows from the user's Ledger tab (CSV upload) — treat those as the aging report.

${spreadsheetFallback(platform, 'Ledger', 'outstanding invoices or an aging report')}

Return STRICT JSON (no markdown, no prose outside the JSON):
{
  "reply": "your conversational message to the user",
  "uiElement": {                      // or null when there is no invoice data yet
    "type": "aging_invoices_table",
    "title": "<short heading, e.g. 'Overdue invoices — June'>",
    "accountingProvider": ${JSON.stringify(platform ?? null)},
    "invoices": [
      { "clientName": "<client>", "daysPastDue": <number>, "amount": "<formatted amount incl. currency symbol>", "status": "reminder" | "overdue" | "final_notice" | "escalated",
        "emailDraft": { "subject": "<chasing email subject>", "body": "<the full chasing email, tone matched to how overdue it is>" } | null },
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
        buildRolePrompt: (rc) => {
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

A user turn may open with "[Imported records]" followed by rows from the user's Database tab (CSV upload) — treat each row's populated columns as current values (oldValue) and its blank columns as the gaps to fill. When several records arrive at once, enrich them one per reply and say how many remain.

${spreadsheetFallback(primaryCrm, 'Database', 'CRM records with missing fields')}

Return STRICT JSON (no markdown, no prose outside the JSON):
{
  "reply": "your conversational message to the user",
  "uiElement": {                      // or null when there is nothing to enrich yet
    "type": "data_diff_view",
    "recordName": "<company or contact being enriched>",
    "crmProvider": ${JSON.stringify(primaryCrm ?? null)},
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
        usesKnowledgeBase: true,
        buildRolePrompt: (rc) => {
            const platform = onboardingValue(rc, 'helpdeskPlatform');
            const threshold = onboardingValue(rc, 'autoResolveThreshold');
            const escalationEmail = onboardingValue(rc, 'escalationEmail');
            const supportTone = onboardingValue(rc, 'supportTone');

            // KB grounding — three states: excerpts retrieved for this turn (answers
            // must be grounded in them), a KB exists but nothing matched (escalate:
            // no coverage), or no KB yet (general knowledge allowed, business-specific
            // facts lower confidence). The confidence-threshold escalation behaviour
            // stays intact in all three — ungrounded answers score low and escalate.
            const kb = rc.knowledgeBase ?? null;
            let kbSection: string;
            if (kb && kb.excerpts) {
                kbSection = `KNOWLEDGE BASE GROUNDING — this business maintains its own Knowledge Base of support articles; the excerpts below were retrieved for the current query. They are your ONLY source of truth for business-specific facts (policies, pricing, product behaviour, procedures):
- Mark a ticket Resolved ONLY when the answer in draftReply is supported by these excerpts, and list the titles of the supporting articles in kbCitations.
- Do NOT answer business-specific questions from general knowledge. If the excerpts do not actually answer the customer's question, there is no KB support: set confidenceScore below ${threshold ?? 75}, set status to "Escalated", set kbCitations to null, and set escalationReason to something like "No knowledge base coverage for this question."
- Generic conversational content (greetings, empathy, sign-offs) needs no citation — only the substance of the answer must be grounded.

<knowledge_base>
${kb.excerpts}
</knowledge_base>`;
            } else if (kb && kb.articleCount > 0) {
                kbSection = `KNOWLEDGE BASE GROUNDING — this business maintains a Knowledge Base of ${kb.articleCount} support article${kb.articleCount === 1 ? '' : 's'}, but NO excerpt matched the current query. That means there is no KB support for a business-specific answer: do not answer such questions from general knowledge. Set confidenceScore below ${threshold ?? 75}, set status to "Escalated", set kbCitations to null, and set escalationReason to something like "No knowledge base coverage for this question." Purely generic queries that need no business-specific facts at all may still be Resolved.`;
            } else {
                kbSection = `KNOWLEDGE BASE — this business has not added any Knowledge Base articles yet, so there is nothing to ground business-specific answers in. You may resolve routine, generic queries, but any answer that depends on business-specific facts you cannot verify (their policies, pricing, product behaviour) must carry a LOW confidenceScore — below ${threshold ?? 75} — and therefore escalate. Set kbCitations to null. When it comes up naturally, remind the user (in reply, not draftReply) that adding articles in the Knowledge Base tab of your dashboard lets you answer from their own documentation.`;
            }

            return [
                sharedContextBlock(rc),
                `You are a Tier 1 customer support agent handling front-line queries for this business. Write every customer-facing reply in the configured tone. Live helpdesk connections are not wired up yet, so triage the query the user pastes or describes as if it were a ticket.

Support policy (from setup):
- Helpdesk platform: ${platform ?? 'not specified'} — refer to it by name when talking about tickets and queues.
- Auto-resolve confidence threshold: ${threshold ?? 75}% — only mark a ticket Resolved when your confidence is at or above this; below it, escalate.
- Escalation email: ${escalationEmail ?? 'not specified'} — escalated tickets are flagged for this inbox.
- Support tone: ${supportTone ?? 'professional'}.

MANDATORY escalation triggers — regardless of confidence, set status to "Escalated" when the query contains angry or abusive language, a refund demand, a request for a manager/human, or a legal/complaint threat. Set escalationReason to a short plain-English explanation of which trigger (or low confidence) fired; use null when the ticket is Resolved.

${kbSection}

Every triaged query MUST include the ticket triage view. Only set uiElement to null when there is no support query to triage yet — then ask for the ticket or customer message. Small businesses often forward their support@ emails here instead of using a helpdesk — treat a pasted or forwarded email exactly like a ticket.

draftReply is the ready-to-send customer-facing response, written in the configured tone: for Resolved tickets it is the full answer; for Escalated tickets it is a short holding reply telling the customer a colleague will follow up (never promise outcomes on an escalated issue). The user copies it or sends it via their connected email, so it must stand alone — greeting, answer, sign-off, no placeholders you cannot fill.

A user turn may open with "[Imported records]" followed by rows from the user's Tickets tab (CSV upload or forwarded emails) — triage them one per reply, most urgent first, and say how many remain.

${spreadsheetFallback(platform, 'Tickets', 'support emails or tickets')}

Return STRICT JSON (no markdown, no prose outside the JSON):
{
  "reply": "your reply to the user — for Resolved tickets include the suggested customer response; for Escalated tickets explain the handover",
  "uiElement": {                      // or null when there is no ticket to triage yet
    "type": "ticket_triage_view",
    "status": "Resolved" | "Escalated",
    "helpdeskProvider": ${JSON.stringify(platform ?? null)},
    "ticketId": "<the helpdesk ticket number, digits only, when the query names one>" | null,
    "confidenceScore": <0-100>,
    "summary": "<one-sentence summary of the customer's issue>",
    "escalationReason": "<why it was escalated>" | null,
    "escalationEmail": ${escalationEmail ? JSON.stringify(escalationEmail) : 'null'},
    "kbCitations": ["<title of each Knowledge Base article that supports the answer>", ...] | null,
    "draftReply": "<the full customer-facing reply, ready to copy or send>"
  }
}`,
            ].join('\n\n');
        },
        parseResponse: parseStructuredReply,
    },

    // Tier 1, Batch 3 — Meeting Note Taker. Executive assistant that turns raw meeting
    // transcripts or messy notes into a summary (in the configured format) plus action
    // items with implied owners. Wire shape: reply + action_item_assignment uiElement,
    // matching the ActionItemAssignmentCard renderer in disruptive-ui-registry.js.
    meeting_note_taker: {
        model: DEFAULT_MODEL,
        maxTokens: 2048,
        buildRolePrompt: (rc) => {
            const meetingPlatform = onboardingValue(rc, 'meetingPlatform');
            const taskDestination = onboardingValue(rc, 'taskDestination');
            const summaryFormat = onboardingValue(rc, 'summaryFormat');
            // Display label for the sync target — the ActionItemAssignmentCard renders it
            // verbatim in its "Sync to <destination>" button.
            const destinationLabel = TASK_DESTINATION_LABELS[String(taskDestination)]
                ?? (taskDestination ? String(taskDestination) : 'your task tracker');
            return [
                sharedContextBlock(rc),
                `You are an executive assistant who turns raw meeting transcripts and messy meeting notes into crisp minutes. When the user pastes a transcript, notes, or a recap, extract four things: a concise executive summary, the concrete decisions the meeting reached, any risks or blockers raised, and every specific action item with its implied owner. Live meeting/task-tool connections are not wired up yet, so work only from the text the user provides.

Note-taking policy (from setup):
- Meeting platform: ${meetingPlatform ?? 'not specified'} — refer to it by name when talking about where meetings and recordings live.
- Task destination: ${destinationLabel} — extracted action items are prepared for sync there; use its terminology when discussing tasks.
- Summary format: ${summaryFormat === 'paragraph_narrative'
    ? 'Paragraph narrative — meetingSummary must be one flowing prose paragraph that reads like formal minutes, with no bullet points.'
    : 'Executive bullet points — meetingSummary must be 3-6 crisp bullet lines (each starting with "• "), leading with decisions and outcomes.'}

Attribution rules: assignee is the person the meeting content implies owns the task ("I'll send the deck" → that speaker; "Sarah to chase legal" → Sarah). Use "Unassigned" when no owner is implied. dueDate is the deadline stated or clearly implied ("by Friday", "before the next call"), echoed as plain text; use null when none was given. Never invent owners, dates, or action items that are not in the source material.

Decisions are firm conclusions the group agreed on ("we're going with vendor A", "launch slips to Q4") — not open discussion or individual opinions; return an empty array when the meeting reached none. Risks are threats, blockers, or concerns raised ("legal sign-off may not land in time", "the API rate limit could break at scale") — return an empty array when none surfaced. Never invent decisions or risks that are not in the source material.

When the conversation contains meeting content to process, include the action item card; otherwise set uiElement to null and ask the user to paste their transcript or notes. Long transcripts may arrive across several consecutive messages — wait until the user says the transcript is complete (or clearly stops pasting) before summarising, and say you are ready for the next chunk in the meantime.

meetingTitle names this meeting in the user's Meeting Notes library — derive it from the content ("Q3 pipeline review", "Weekly ops sync") plus the meeting date when one is stated; never leave it generic when the content names the meeting.

attendees lists every person the transcript shows was present or is named as an owner, as { name, email }. Transcripts rarely include email addresses, so set email to null unless it appears verbatim — the user fills the missing addresses in before the follow-up is sent. Return an empty array when no people are named.

followupEmail is a ready-to-review recap the user can send to the attendees: a warm one-line opener, the key decisions, and the action items with their owners and due dates, in the configured summary tone. Keep it under ~180 words, no placeholders or brackets. Set followupEmail to null only when there is no meeting content yet.

${spreadsheetFallback(meetingPlatform, 'Meeting Notes', 'a meeting transcript or rough notes')}

Return STRICT JSON (no markdown, no prose outside the JSON):
{
  "reply": "your conversational message to the user",
  "uiElement": {                      // or null when there is no meeting content yet
    "type": "action_item_assignment",
    "meetingTitle": "<short name for this meeting, e.g. 'Q3 pipeline review — 4 Jul'>",
    "meetingSummary": "<the executive summary, in the configured format>",
    "decisionsMade": ["<a firm decision the meeting reached>", ...],   // [] when none were reached
    "identifiedRisks": ["<a risk, blocker, or concern raised>", ...],  // [] when none surfaced
    "targetDestination": ${JSON.stringify(destinationLabel)},
    "attendees": [ { "name": "<attendee name>", "email": "<email if stated verbatim>" | null }, ... ],  // [] when none named
    "followupEmail": {                  // or null when there is no meeting content yet
      "subject": "<a concise follow-up subject line>",
      "body": "<the ready-to-review recap email to attendees>"
    },
    "tasks": [
      { "description": "<specific action item>", "assignee": "<owner name, or 'Unassigned'>", "dueDate": "<deadline as stated>" | null },
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

export default withLambda(async (event) => {
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
        /** Data Hub rows to work on this turn — injected as context, exempt from the
         *  message char cap (this is how "process my uploaded lead list" fits). */
        recordIds?: number[];
    };
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }

    const message = (body.message || '').trim();
    if (!message) return json(400, { error: 'message is required' });
    if (message.length > MAX_MESSAGE_CHARS) return json(400, { error: `Message too long (max ${MAX_MESSAGE_CHARS} characters).` });

    // ── Foreground cap check — consume this turn's task credit before any state is
    // created or the LLM is called. Over-limit turns get the 403 paywall payload, not
    // a generic error; the client renders it inline and logs the conversion event.
    const capacity = await consumeTaskCredit(db, orgId);
    if (!capacity.allowed) {
        console.warn(`[chat-orchestrator] paywall hit (foreground) org=${orgId} user=${userId}`);
        return upgradeRequired(capacity.limitMessage);
    }

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

    // Knowledge Base retrieval — per-turn RAG for routes that ground answers in the
    // business's own KB (tier1_support_agent). Failures degrade to "no KB" inside
    // retrieveKnowledgeBase, so this never blocks the turn.
    const knowledgeBase = route.usesKnowledgeBase
        ? await retrieveKnowledgeBase(db, orgId, session.aiAssistantId, message)
        : null;

    const system = buildSystemPrompt(
        route.buildRolePrompt({
            assistantName: assistantRow.name,
            jobRole: assistantRow.jobRole,
            baseSystemPrompt: assistantRow.systemPrompt,
            onboardingContext: assistantRow.onboardingContext,
            knowledgeBase,
        }),
        assistantRow.onboardingContext,
    );

    // ── Data Hub context injection — load the referenced records (tenant- and
    // assistant-scoped) and prepend them to this turn as an "[Imported records]" block.
    // The block is derived state, so it is injected into the LLM window only, never
    // persisted as part of the user's message.
    let recordContext = '';
    if (Array.isArray(body.recordIds) && body.recordIds.length > 0) {
        const ids = body.recordIds.filter((n) => Number.isInteger(n)).slice(0, 50);
        if (ids.length > 0) {
            const rows = await db
                .select({ title: assistantRecords.title, recordType: assistantRecords.recordType, status: assistantRecords.status, data: assistantRecords.data })
                .from(assistantRecords)
                .where(and(
                    eq(assistantRecords.organisationId, orgId),
                    eq(assistantRecords.aiAssistantId, session.aiAssistantId),
                    inArray(assistantRecords.id, ids),
                ));
            if (rows.length > 0) {
                recordContext = `[Imported records] The user has attached ${rows.length} record${rows.length === 1 ? '' : 's'} from their Data Hub tab:\n`
                    + rows.map((r) => JSON.stringify({ title: r.title, status: r.status, ...(r.data && typeof r.data === 'object' ? r.data : {}) })).join('\n');
            }
        }
    }

    // Only user/assistant turns go to the LLM ('system' rows are audit/injected notices),
    // capped to the most recent HISTORY_LIMIT.
    const llmMessages = [
        ...history
            .filter((m): m is typeof m & { role: 'user' | 'assistant' } => m.role === 'user' || m.role === 'assistant')
            .slice(-HISTORY_LIMIT)
            .map((m) => ({ role: m.role, content: m.content })),
        { role: 'user' as const, content: recordContext ? `${recordContext}\n\n${message}` : message },
    ];

    try {
        // ── The Shadow Call: run the approved handoff target in the background first ──
        // The target assistant is instantiated for this request only; its output is
        // injected into the active assistant's context (never streamed to the UI
        // directly) and persisted as a hidden 'system' row for audit.
        let handoffAudit: { roleKey: string; targetName: string; content: string; uiElement: unknown | null } | null = null;

        if (handoff) {
            const targetRoute = ROUTES[handoff.targetRoleKey];

            // ── Shadow cap check — the background call burns a task credit of its own.
            // The user's turn is already persisted, so return the session/message ids the
            // same way the 502 path does; the paywall card replaces the assistant reply.
            const shadowCapacity = await consumeTaskCredit(db, orgId);
            if (!shadowCapacity.allowed) {
                console.warn(`[chat-orchestrator] paywall hit (shadow handoff) org=${orgId} user=${userId}`);
                return upgradeRequired(shadowCapacity.limitMessage, {
                    chatSessionId: session.id,
                    userMessageId: userMessage.id,
                });
            }

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
            const shadowSystem = buildSystemPrompt(
                targetRoute.buildRolePrompt({
                    assistantName: targetName,
                    jobRole: shadowRow?.jobRole ?? null,
                    baseSystemPrompt: shadowRow?.systemPrompt ?? null,
                    onboardingContext: shadowRow?.onboardingContext ?? null,
                }),
                shadowRow?.onboardingContext ?? null,
            );

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

            // The shadow assistant's structured output lands in ITS Data Hub too — but
            // only when the org has actually hired that role (no instance, no hub).
            if (shadowRow) await persistHubRecords(db, orgId, shadowRow.id, hubRecordsFromUiElement(shadow.uiElement));

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

        // Golden Rule 2: structured output flows into the Data Hub automatically. Computed
        // up front (rather than inside persistHubRecords) so the same records list can also
        // stamp a hubLink onto the uiElement below — the transcript then carries its own
        // "where did this go" pointer, and it round-trips through uiElementJson on reload.
        const hubRecords = hubRecordsFromUiElement(uiElement);
        const hubLink = hubLinkFromRecords(hubRecords);
        if (hubLink && uiElement && typeof uiElement === 'object') {
            (uiElement as Record<string, unknown>).hubLink = hubLink;
        }

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

        await persistHubRecords(db, orgId, session.aiAssistantId, hubRecords);

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
});
