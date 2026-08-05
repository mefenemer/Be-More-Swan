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
import { randomUUID } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, assistantRecords, chatMessages, chatSessions, kbArticles, kbChunks, masterAssistants, organisations, scheduledPosts, scheduledPostAssets } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { appendFooter } from '../../src/utils/disclosure-footer';
import { resolvePostFooter } from '../../src/utils/post-disclosure';
import { logAiUsage } from '../../src/utils/ai-usage';
import { consumeTaskCredit } from '../../src/utils/task-credit';
import { embedTexts } from '../../src/utils/kb-embeddings';
import { computeScheduleSlots, resolvePostingSchedule } from '../../src/config/posting-cadence';
import { normalizePlatform, platformFormat, type SocialPlatform } from '../../src/config/platform-formats';
import { normalizeMediaSources } from '../../src/utils/media-sources';
import { replyClaimsPostSaved, honestDraftReply, type DraftClaimFailure } from '../../src/utils/chat-draft-claims';
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

// consumeTaskCredit now lives in src/utils/task-credit.ts — the quality reviewer's assisted
// rewrite needed the same metering, and a second copy of the plan-resolution rules is how the two
// drift apart.

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
    /** The org's own business identity (Business Information page) — grounds every route in
     *  the business it actually serves, not the Be More Swan platform itself. */
    business: { name: string; industry: string | null; description: string | null };
    /** KB retrieval for this turn — only populated for routes with usesKnowledgeBase.
     *  null/undefined (e.g. shadow handoff calls) renders the "no KB yet" prompt path. */
    knowledgeBase?: KnowledgeBaseContext | null;
    /** aiAssistants.mediaSources — the ordered Media Source Selection list. The social route
     *  needs it to tell the model, truthfully, which visuals this assistant can produce. */
    mediaSources?: unknown;
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
    const b = rc.business;
    return [
        rc.baseSystemPrompt ? rc.baseSystemPrompt.trim() : '',
        `You are "${rc.assistantName}"${rc.jobRole ? `, the ${rc.jobRole}` : ''}, a digital assistant provided via the Be More Swan platform. `
            + `You work exclusively for ${b.name}${b.industry ? ` (industry: ${b.industry})` : ''}, not for Be More Swan itself — Be More Swan is only the platform that runs you. `
            + `Every reply must be grounded in ${b.name}'s own business, products/services, and audience.`
            + (b.description ? ` About ${b.name}: ${b.description}` : ''),
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

// Plain conversational reply, no structured UI. This is the fallback for every roleKey
// that has no AssistantRoute below — nothing this route says is ever persisted (no
// assistant_records row, no post, no email), so it must never claim otherwise.
const defaultRoute: AssistantRoute = {
    model: DEFAULT_MODEL,
    maxTokens: 1024,
    buildRolePrompt: (rc) => [
        sharedContextBlock(rc),
        'Reply conversationally in plain text. Be concise, warm, and practical. Do not use markdown headings.',
        'IMPORTANT: this chat is conversational only — you cannot actually create, save, schedule, publish, or send anything from here, and nothing you draft in this conversation is stored anywhere else in the app (not in the Review Queue, Calendar, or Data Hub). Never tell the user something has been "created", "scheduled", "added to your Review Queue", or similar — you may draft copy, ideas, or advice in the chat itself, but if they want it actually created/scheduled they must use the relevant tool elsewhere in their dashboard (e.g. the assistant\'s dashboard tools, Review Queue, or Calendar).',
    ].join('\n\n'),
    parseResponse: (raw) => ({ content: raw.trim(), uiElement: null }),
};

// Strips accidental ```json fences and parses the route's structured reply. A malformed
// reply must NEVER surface raw JSON to the user: a model that dumps its own scaffolding (or
// blows the token budget mid-string, or unescapes a quote inside a caption) produces an
// unparseable blob, and the old fallback showed that blob verbatim in chat — which also
// meant uiElement was null, so the drafted post was never persisted and no review link was
// stamped. So: try a direct parse, then a best-effort parse of the outermost {...} span, and
// only when the output was never a structured attempt at all do we pass it through as plain
// text. A JSON-shaped-but-broken reply degrades to a friendly retry line, not the payload.
const STRUCTURED_REPLY_FALLBACK =
    "Sorry — something went wrong formatting that on my end. Could you send that to me again? I'll redraft it cleanly.";

/** True when `text` was clearly meant to be the route's JSON envelope (so a parse failure
 *  should degrade to the retry line rather than being shown to the user as-is). */
function looksLikeStructuredAttempt(text: string): boolean {
    const t = text.trimStart();
    return t.startsWith('{') || t.startsWith('[') || /"reply"\s*:/.test(text) || /"uiElement"\s*:/.test(text);
}

function parseStructuredReply(raw: string): { content: string; uiElement: unknown | null } {
    const stripped = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();

    // Direct parse first, then a best-effort parse of the outermost {...} span — this
    // recovers a reply wrapped in stray prose, though not one broken *inside* the JSON.
    const candidates = [stripped];
    const first = stripped.indexOf('{');
    const last = stripped.lastIndexOf('}');
    if (first !== -1 && last > first) candidates.push(stripped.slice(first, last + 1));

    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed.reply === 'string') {
                return { content: parsed.reply.trim(), uiElement: parsed.uiElement ?? null };
            }
        } catch { /* try the next candidate */ }
    }

    // Unparseable. Never show raw JSON scaffolding to the user: if this was clearly a
    // (broken) structured attempt, degrade to a friendly retry line; only genuine
    // non-JSON prose is passed through untouched.
    if (looksLikeStructuredAttempt(stripped)) {
        console.warn('[chat-orchestrator] structured reply was unparseable — showing retry fallback');
        return { content: STRUCTURED_REPLY_FALLBACK, uiElement: null };
    }
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

// ── Lead Generator: its own dashboard surfaces ────────────────────────────────
// The lead_qualifier prompt predates outbound discovery, and nothing else in the
// system prompt tells an assistant what its dashboard contains — so when a user named
// a surface it had never heard of ("create a search in the Signal Inbox") it filed the
// platform's OWN tab alongside Apollo/Hunter and refused as "an external tool". This
// block is the truth about what the Lead Generator owns.
//
// ⚠️ Keep in sync with src/components/assistant-dashboard-registry.js (`lead_qualifier`)
// and the campaign form in src/components/assistant-discovery-campaigns.js. Only name
// fields that form actually has: there is no target-persona input, so the ICP has to be
// written INTO the idea text. Naming a field the user can't find is the same class of
// bug as naming a tool that doesn't exist.
//
// ⚠️ Tab names here are USER-FACING NAVIGATION. The tab this calls "Searches" is internally the
// signal inbox (registry key `signalInbox`, assistant-signal-inbox.js) — it was labelled "Signal
// Inbox" until the rename. If the label changes again and this string doesn't, the assistant
// confidently sends users to a tab that isn't there, which is the same class of bug as the one
// described above.
//
// Both "Find New Leads" and "Review Lead Ideas" say "in the Searches toolbar" — they moved out of
// the Leads tab action bar (see assistants.js) and those old locations are dead ends.
function leadGeneratorSurfaces(): string {
    return `YOUR OWN DASHBOARD — these are tabs and buttons on YOUR page inside this platform. They are NOT third-party products, and you must never describe them as external tools, or lump them in with LinkedIn, Apollo, Hunter, or any other outside service:
- "Searches" tab — everything that came IN before it became a lead: what your searches found, still awaiting review. This is the tab the user lands on, and its toolbar holds both the "Find New Leads" and "Review Lead Ideas" buttons.
- "Review Lead Ideas" (button in the Searches toolbar) — the lighter-weight route: you propose ideas for where this business's next customers might be found, and approving one sends you off to find, score and file matching companies. Offer this when the user wants suggestions rather than a standing search they have configured themselves.
- "Find New Leads" (button in the Searches toolbar) — this is where a search gets created. It opens a short form: a plain-English description of who to find, an optional short name for the search, how often to run (once now / daily / weekly), max leads per run, terms to exclude, and a "review found leads before any outreach" checkbox. Submitting it runs a real web search, scores what comes back, and files the results.
- "Leads" tab — every lead you have scored, with its outreach draft; also where CSV lead lists are imported and exported.
- "Conversations" tab — what happened after a lead was approved: the outreach thread and any reply.

FINDING NEW LEADS — when the user asks you to find leads, create a search, build a campaign, or go looking for customers: this is squarely your job and you must NEVER refuse it or send them to an outside lead-sourcing tool. Emit the discovery_campaign_proposal uiElement (shape 3 below). Write the "who to find" brief yourself, folding the ideal customer profile (industries, size, location, and the specific pain signals discussed) into that one description, since the form has no separate profile fields. Approving it SAVES the search — the user does not have to retype anything — but saves it as a draft that has not started: a run costs real money and reaches real strangers, so they start it themselves from "Find New Leads" in the Searches tab. Say that plainly in your reply and never claim the search is already running or that leads are already coming in. Frame it as you doing the work, because you are: the search you just wrote is what goes out and finds them.`;
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

type HubLink = { tab: string; label: string; postId?: number };

function hubLinkFromRecords(records: HubRecord[]): HubLink | null {
    if (records.length === 0) return null;
    if (records.length === 1) {
        const kind = HUB_RECORD_LABELS[records[0].recordType] ?? 'record';
        return { tab: 'review-queue', label: `Added this ${kind} to your Review Queue` };
    }
    return { tab: 'review-queue', label: `Added ${records.length} items to your Review Queue` };
}

// ── Social post drafting (social_media_manager) ───────────────────────────────
// Issue #180 follow-up: the social_media_manager route has no structured output of its
// own, so a drafted post used to live only in the chat transcript — nothing was ever
// saved, and the assistant had to tell the user to go create/schedule it themselves
// elsewhere. A drafted post is now persisted for real (one scheduled_posts row per
// platform, status 'pending_approval', same lifecycle create-manual-post.ts's manual
// "Write your own" path lands in) so the chat can instead hand the user a direct link to
// review and approve it.
// primary_platforms (onboardingContext) is stored as short codes — fb/ig/li/x/th/yt, per
// integrations.js PLATFORM_KEY_MAP — but the draft wire shape, the model's output format,
// and persistence all use full names. normalizePlatform() is the shared code→name mapping.
//
// This was a local four-entry map plus a matching four-name allow-list, both written before
// Threads and YouTube shipped. A user asking the chat for a Threads post got prose and no
// draft: the platform was filtered out, socialPostDraftFromUiElement returned null, and
// nothing was ever persisted.

/** Configured social platforms for this assistant, normalized to the supported full names. */
function configuredPlatforms(onboardingContext: unknown): string[] {
    let ctx = onboardingContext;
    if (typeof ctx === 'string') { try { ctx = JSON.parse(ctx); } catch { ctx = null; } }
    const raw = ctx && typeof ctx === 'object' && !Array.isArray(ctx)
        ? (ctx as Record<string, unknown>).primary_platforms
        : null;
    if (!Array.isArray(raw)) return [];
    return [...new Set(
        raw
            .map((p) => normalizePlatform(p))
            .filter((p): p is SocialPlatform => !!p),
    )];
}

type SocialPostDraft = {
    platforms: string[];
    caption: string;
    hashtags: string | null;
    /** Wording for a branded text card, when this assistant can produce one. See BRAND CARDS below. */
    cardHeadline: string | null;
};

/**
 * `forcePlatform` — the platform of the post the user is EDITING (see draftTarget). When set, the
 * model's own platforms array is ignored in favour of the one fact we know authoritatively: which
 * platform that row is for.
 *
 * (It used to double as the workaround for the local allow-list being narrower than the platform
 * catalogue — that gap is gone now that both paths normalise through normalizePlatform.)
 */
function socialPostDraftFromUiElement(uiElement: unknown, forcePlatform: string | null = null): SocialPostDraft | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== 'social_post_draft') return null;
    const caption = typeof ui.caption === 'string' ? ui.caption.trim() : '';
    if (!caption) return null;
    const platforms = forcePlatform ? [forcePlatform] : (Array.isArray(ui.platforms)
        ? [...new Set(ui.platforms.map(p => normalizePlatform(p)).filter((p): p is SocialPlatform => !!p))]
        : []);
    if (platforms.length === 0) return null;
    const hashtags = typeof ui.hashtags === 'string' && ui.hashtags.trim() ? ui.hashtags.trim() : null;
    // Bounded here only as untrusted-input hygiene — the real ceiling is MAX_HEADLINE_CHARS, applied
    // by the renderer, which is where it belongs (this module deliberately does not import
    // brand-card; see attachBrandCardToDrafts). An absent or blank field is not an error: the card
    // path falls back to headlineFromCaption(), exactly as the scheduled drafter does.
    const rawHeadline = typeof ui.cardHeadline === 'string' ? ui.cardHeadline.trim() : '';
    const cardHeadline = rawHeadline ? rawHeadline.slice(0, 300) : null;
    return { platforms, caption, hashtags, cardHeadline };
}

// ── Drafting INTO a post the user already has open ────────────────────────────
// "Talk it through in chat" from the post editor used to be a dead end in both directions: the
// assistant's caption could only be copied out by hand, while the orchestrator quietly saved it as
// one NEW pending_approval post per configured platform — so asking for help with the post in front
// of you forked it into others and left the original untouched.
//
// With a target, nothing is persisted and nothing is promised. The caption comes back in the
// uiElement, the client offers a button that writes it into that post, and pressing it is the
// user's decision.
const EDITABLE_POST_STATUSES = ['draft', 'pending_approval', 'in_review', 'approved', 'scheduled'];

/** Appended AFTER the role prompt, so it overrides the "saved for real" paragraph in it. */
function draftTargetPromptBlock(platform: string | null): string {
    return [
        `IMPORTANT — this conversation is about a ${platform ? `${platform} post` : 'post'} the user already has open in the post editor. This OVERRIDES anything above about drafted posts being saved automatically.`,
        `Nothing you draft in this conversation is saved anywhere. Under your reply the user is shown a button that puts your caption into the post they are editing, and only they can press it. That button carries the CAPTION only, so no branded card is made here however the instructions above read — the post already has its own picture controls in the editor the user is sitting in.`,
        `So: still return the post draft object exactly as specified whenever you have enough to write finished copy${platform ? `, with "platforms": ["${platform}"] — that is this post's platform, so never draft for another one` : ''}. But do NOT say you have saved, drafted or scheduled it, do NOT suggest a posting time, and do NOT mention a link to review or approve it — none of that happens here. Keep "reply" to one short sentence offering the caption.`,
    ].join('\n\n');
}

// ── Branded text cards on a chat draft ────────────────────────────────────────
//
// A card is the one media source a chat turn can actually produce. Reported from prod: a user asked
// their social assistant for the wording of a colour-block image, and it replied that it does not
// generate visuals and that the brand colours it had asked for during setup were of no use to it —
// while offering that "a visual asset tool or designer" might exist elsewhere in the workspace.
// Every part of that was wrong. Branded text cards ARE this platform's colour-block image: rendered
// by src/lib/brand-card.ts in the org's own brand kit, chosen in onboarding's Visual Strategy step
// and stored on aiAssistants.mediaSources, and drawn on every post the SCHEDULED drafter makes
// (process-content-jobs asks the model for a `cardHeadline` for exactly this).
//
// Chat was the only drafting path that skipped media entirely — contentAssetIds: [] with a
// mediaMissing flag for Instagram — so the assistant's own words were the closest thing to true it
// could say. This closes that gap: the same renderer, the same kit, the same headline field.
//
// Scope, deliberately: brand_card ONLY, never stock or AI. A card is free, deterministic, needs no
// external service and no AI credits, so it can be made inside an interactive turn without spending
// the user's money or betting the reply on someone else's API. A draft whose assistant prefers
// stock or AI imagery still arrives with no picture and is sourced in the Review Queue's picker,
// exactly as before.
async function attachBrandCardToDrafts(
    db: ReturnType<typeof getDb>,
    args: {
        orgId: number;
        userId: number;
        /** The rows just written — a cross-post group shares ONE image (see crosspost-media.ts). */
        posts: { id: number; platform: string }[];
        headline: string | null;
        /**
         * Fallback source for the headline when the model returned none. The RAW caption, not the
         * one written to the post: the disclosure footer belongs on the post, never set as display
         * type on the card. Named apart from the post's own caption field so the disclosure guard in
         * tests/post-disclosure-persistence.test.ts stays strict about `caption: draft.caption`.
         */
        captionForHeadline: string;
    },
): Promise<boolean> {
    const { orgId, userId, posts, captionForHeadline } = args;
    if (posts.length === 0) return false;
    const postIds = posts.map(p => p.id);

    // One card, one shape, several platforms — so the shape belongs to the platform that will be
    // judged on it. Instagram cannot publish without an image and crops to 4:5; the others take a
    // portrait image happily, while a 16:9 card (X's ratio, and first in the list often enough)
    // lands on Instagram as a letterboxed strip. So: the ratio of the first platform that REQUIRES
    // media, else the primary platform's own.
    const ratioPlatform = posts.find(p => platformFormat(p.platform).mediaMandatory)?.platform
        ?? posts[0].platform;

    // Loaded on demand, not at module scope. brand-card pulls in satori, the resvg native binding
    // and ~250KB of base64-decoded font data at import time; chat is the app's most latency-
    // sensitive endpoint and most turns never make a card, so that cost belongs on the turns that do.
    const [{ headlineFromCaption, MAX_HEADLINE_CHARS }, { renderAndPersistBrandCard }] = await Promise.all([
        import('../../src/lib/brand-card'),
        import('../../src/lib/media-persist'),
    ]);

    const headline = (args.headline || '').trim().slice(0, MAX_HEADLINE_CHARS)
        || headlineFromCaption(captionForHeadline)
        || '';
    if (!headline) return false;

    // The STORED kit, normalised — deliberately NOT the resolve-or-extract helper the scheduled
    // drafter uses. That one derives a kit from the org's website when none has been stored, which
    // means an 8s page fetch, a 5s stylesheet fetch and an LLM call to pick the accent. That is
    // correct in the background drafter and unacceptable in a turn the user is waiting on: it could
    // spend the whole function budget and lose the reply along with it. So chat renders in whatever
    // is already stored — the colours the user picked, if they picked any — and the daily drafter
    // remains the thing that fills an empty kit in. Worst case here is one neutral-monochrome card
    // for an org that has never had one, which is a publishable card and self-corrects.
    const [{ normalizeBrandKit }, [org]] = await Promise.all([
        import('../../src/utils/brand-kit'),
        db.select({ name: organisations.name, brandKit: organisations.brandKit })
            .from(organisations).where(eq(organisations.id, orgId)).limit(1),
    ]);
    const kit = normalizeBrandKit(org?.brandKit);

    const assetId = await renderAndPersistBrandCard(db, {
        orgId, userId, headline, kit,
        aspectRatio: platformFormat(ratioPlatform).aspectRatio,
        // Same seed rule as the scheduled drafter: the post id picks the light/bold polarity, so
        // consecutive cards alternate and re-rendering this post reproduces this card.
        seed: postIds[0],
        orgName: org?.name ?? null,
    });

    for (const postId of postIds) {
        await db.insert(scheduledPostAssets)
            .values({ scheduledPostId: postId, contentAssetId: assetId, position: 0 })
            .onConflictDoNothing();
    }
    // contentAssetIds is the deprecated mirror of the junction table, kept in step because the
    // editor and the publishers still read it. postFormat moves off 'text' for the same reason a
    // post with a picture is not a text post — and mediaMissing comes off, because it no longer is.
    await db.update(scheduledPosts)
        .set({
            contentAssetIds: [assetId],
            postFormat: 'image',
            mediaMissing: false,
            mediaMissingNote: null,
            updatedAt: new Date(),
        })
        .where(inArray(scheduledPosts.id, postIds));

    return true;
}

/**
 * Persist a chat-drafted post as one pending_approval scheduled_posts row per platform,
 * pre-filled with the next slot from the assistant's own posting schedule (posting_days /
 * posting_times / posting_timezone in onboardingContext — the same config the Calendar
 * and autonomous drafts use).
 *
 * Media: when this assistant's media sources include brand_card, a branded text card is rendered
 * and attached to every row (see attachBrandCardToDrafts). Otherwise there is still nothing to
 * attach here, so Instagram's row is created but flagged mediaMissing — the Review Queue already
 * prompts to source one before approving (issue #55) — rather than silently dropping the platform.
 *
 * Best-effort throughout: a persistence failure never fails the turn, and a card that cannot be
 * rendered (no R2, no usable headline) leaves the drafts exactly as they were without one.
 */
async function persistSocialPostDraft(
    db: ReturnType<typeof getDb>,
    orgId: number,
    userId: number,
    aiAssistantId: number,
    assistantName: string,
    onboardingContext: unknown,
    mediaSources: unknown,
    draft: SocialPostDraft,
): Promise<{ id: number; platform: string }[]> {
    try {
        const schedule = resolvePostingSchedule(
            onboardingContext && typeof onboardingContext === 'object' ? onboardingContext as Record<string, unknown> : null,
        );
        const [slot] = computeScheduleSlots({ schedule, horizonDays: 14 });
        const publishDate = slot ?? new Date(Date.now() + 24 * 60 * 60 * 1000);
        const now = new Date();
        // Shared id across the fanned-out platform rows so the Review Queue shows one card; a
        // single-platform draft stays standalone (null).
        const crosspostGroupId = draft.platforms.length > 1 ? randomUUID() : null;

        // The disclosure is appended to the CAPTION at generation, not at publish — so a post saved
        // straight out of chat, whose caption is whatever the model returned, carries none at all
        // while the editor's checkbox reads as enabled. Every other drafting route goes through
        // buildPlatformCaption, which appends it; this one writes the model's text directly, so it
        // has to append it here.
        const footer = await resolvePostFooter(db, orgId, aiAssistantId).catch(() => null);
        const captionWithFooter = appendFooter(draft.caption, footer);

        const created: { id: number; platform: string }[] = [];
        for (const platform of draft.platforms) {
            const isInstagram = platform === 'instagram';
            const [post] = await db.insert(scheduledPosts).values({
                userId,
                organisationId: orgId,
                assistantId: aiAssistantId,
                platform,
                postFormat: 'text',
                publishDate,
                caption: captionWithFooter,
                hashtags: draft.hashtags,
                contentAssetIds: [],
                status: 'pending_approval',
                triggerType: 'manual',
                isAutonomous: false,
                ownerId: userId,
                ownerLabel: `AI: ${assistantName}`,
                generatedAt: now,
                mediaMissing: isInstagram,
                mediaMissingNote: isInstagram ? 'Instagram needs an image — add one below before approving.' : null,
                crosspostGroupId,
            }).returning({ id: scheduledPosts.id });
            created.push({ id: post.id, platform });
        }

        // The card is attached AFTER the rows exist and inside its own guard: the draft is already
        // saved and linked at this point, so a failed render must cost the picture and nothing else.
        // Cards are for stills only — a video post's media is a different problem entirely.
        if (created.length && normalizeMediaSources(mediaSources).includes('brand_card')) {
            try {
                await attachBrandCardToDrafts(db, {
                    orgId, userId,
                    posts: created,
                    headline: draft.cardHeadline,
                    captionForHeadline: draft.caption,
                });
            } catch (cardErr) {
                console.warn('[chat-orchestrator] brand card for chat draft failed:', cardErr instanceof Error ? cardErr.message : cardErr);
            }
        }

        return created;
    } catch (err) {
        console.error('[chat-orchestrator] social post draft persistence failed:', err);
        return [];
    }
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
                `You have TWO jobs for this business: you FIND new leads (outbound discovery) and you SCORE the leads that reach you (inbound qualification). Never describe yourself as scoring-only — finding new customers is your job, not something the user has to go elsewhere for.

${leadGeneratorSurfaces()}

Score every lead against the ideal customer profile below — a lead that matches it well scores high; one that misses it scores low, and your reasons must say which criteria it met or missed.

Ideal customer profile (from setup):
- Target industries: ${industries ? JSON.stringify(industries) : 'not specified — treat industry as neutral'}
- Minimum company headcount: ${minHeadcount ?? 'not specified — treat company size as neutral'}
- Sales tone: ${salesTone ?? 'professional'} — write your reply (and the suggested next step) in this tone.

Scoring bands: 70-100 = "hot" (strong profile fit + buying intent), 40-69 = "warm" (partial fit or unclear intent), 0-39 = "cold" (poor fit or no intent).

When the conversation contains enough detail to assess a lead, include the scoring card.

HANDOFF PROTOCOL — when you lack the firmographic data to score a named lead confidently against the profile (e.g. company size/headcount, industry, or revenue is unknown), do NOT output the lead_scoring_card yet. Instead propose a handoff to "CRM Data Assistant": explain in your reply what is missing and that the enricher can fill the gaps, and emit the handoff_proposal uiElement below. Put everything the enricher needs in payloadToPass — the lead/company name, every detail already known from the conversation, and the fields you are missing. The user must approve the handoff before it runs.

A later user turn may be marked "[Approved handoff result]" and contain enriched data from CRM Data Assistant — when it does, treat that data as trusted CRM enrichment, complete your original scoring task, and emit the lead_scoring_card. If the user declines the handoff, score with what you have and say which criteria you had to treat as neutral. Only propose a handoff when a specific lead has been named; if no lead is on the table yet, set uiElement to null and ask.

A user turn may also open with "[Imported records]" followed by rows from the user's Leads tab (CSV upload) — treat each row as an inbound lead to score. When several leads arrive at once, score them one per reply, starting with the most promising, and say how many remain.

SPREADSHEET FALLBACK — do not assume this business uses a CRM like HubSpot, and NEVER tell the user an external system is required. Leads can reach you three ways, and you should name whichever fits what they asked: your own discovery searches (above — the answer whenever they want NEW leads); pasted straight into this chat; or imported as a CSV in the "Leads" tab of your dashboard (Excel and Google Sheets users export via File → Download → CSV), which is also where everything you produce exports back out. Never offer CSV import as the answer to "find me some leads" — that is asking the user to go do your job. Every structured result you emit here is saved to the "Leads" tab automatically, so nothing is lost when the conversation ends.

Return STRICT JSON (no markdown, no prose outside the JSON). uiElement is EXACTLY ONE of the three shapes below, or null:
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
    "targetAssistantName": "CRM Data Assistant",
    "targetRoleKey": "crm_enricher",
    "reason": "<one sentence naming the missing data, e.g. 'Company size and revenue are unknown, so the lead cannot be scored against the profile yet.'>",
    "payloadToPass": {
      "recordName": "<lead or company name>",
      "knownDetails": { "<field>": "<value already known from the conversation>", ... },
      "missingFields": ["<field the enricher should fill>", ...]
    }
  }
}
{
  "reply": "your conversational message to the user",
  "uiElement": {                      // shape 3 — the user wants NEW leads found; propose a search
    "type": "discovery_campaign_proposal",
    "name": "<chip-sized label, max 80 chars, e.g. 'UK creative agencies'>",
    "idea": "<the whole brief in plain English: who to find, where, and the pain signals that mark a fit. This single field IS the targeting — there are no separate profile fields — so fold the ideal customer profile into it. Max 1000 chars.>",
    "cadence": "one_off" | "daily" | "weekly",   // one_off unless the user asked for a standing search
    "rationale": "<one sentence on why this targets their ideal customer>",
    "guardrails": {                   // omit any limit the user has not expressed a view on
      "maxLeadsPerRun": <number>,
      "negativeKeywords": ["<term that would waste a run, e.g. a competitor>", ...],
      "requireHumanApproval": true    // only ever false if the user explicitly asks to skip review
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

    // Social Media Assistant — the default/legacy assistant role. Drafts real, ready-to-post
    // captions in chat; the handler below (persistSocialPostDraft) saves each as a
    // pending_approval scheduled_posts row, so the reply only needs to confirm the draft
    // exists and that a schedule was suggested — the actual "review it" link is appended
    // by the client from the hubLink the handler stamps on the reply.
    social_media_manager: {
        model: DEFAULT_MODEL,
        // 1024 was not enough headroom for a finished caption plus hashtags plus the reply, and
        // the failure mode is the worst one available: the envelope truncates mid-string, the
        // JSON never parses, and parseStructuredReply degrades to STRUCTURED_REPLY_FALLBACK —
        // so the post the model had already written is discarded and the user is told "something
        // went wrong formatting that". Seen twice in one live session on 2026-08-05. max_tokens
        // is a ceiling, not a spend: raising it costs nothing on turns that don't need it.
        maxTokens: 2048,
        buildRolePrompt: (rc) => {
            const canCard = normalizeMediaSources(rc.mediaSources).includes('brand_card');
            // What this assistant can honestly say about pictures.
            //
            // The prompt used to say nothing at all about media, so when a user asked for the
            // wording of a colour-block image the model improvised a denial: it does not make
            // visuals, the brand colours picked during setup were misleading to ask for, and some
            // other "visual asset tool or designer" might handle it. Three false statements about
            // the user's own product, from silence. State the truth instead — and, when cards are
            // off, say the one true thing about that case rather than leaving the gap open again.
            const mediaLine = canCard
                ? `BRAND CARDS — you CAN give this business a picture, and it is the thing they configured you for. A branded text card is a colour-block image: one short line of your wording set as large type in ${rc.business.name}'s own brand colours. It is drawn automatically from the "cardHeadline" you return with the draft, so the card is made and attached to the post in the same moment the draft is saved.

So when the user asks for wording for a colour block, a quote card, a text graphic or "something to attach", that is this — write the line and return it as cardHeadline. Never say you cannot make visuals, never call the brand colours unused or pointless (they are what the card is drawn in), and never suggest that some other tool, designer or assistant handles it. Always include cardHeadline alongside a post draft, whether or not a picture was asked for: one sharp standalone line, no hashtags, no emoji, no link, no quotation marks, no trailing full stop. The user can change the words and the design when they review the post.`
                : `PICTURES — you write words, not images: this assistant is set up to take its media from its picture sources rather than to draw it. Say that plainly if asked, and never invent another tool, designer or assistant that would do it instead. What you should say is that the post's picture is chosen when they review it, and that Branded Text Cards — a line of your wording set in ${rc.business.name}'s own brand colours — can be switched on for you in this assistant's media sources.`;
            const platforms = configuredPlatforms(rc.onboardingContext);
            const platformLine = platforms.length
                ? `This business has ALREADY configured its social platforms: ${platforms.join(', ')}. These are the default target for every post — put exactly these values in the draft's "platforms" array unless the user's message explicitly asks for a different or narrower set. You already know their platforms, so NEVER ask which platform(s) to use; asking wastes the user's time.`
                : `This business has not configured any social platforms yet. If the user's request doesn't make the target platform(s) clear, ask one short clarifying question (uiElement: null) before drafting.`;
            return [
                sharedContextBlock(rc),
                `You are this business's social media manager. When the user asks you to draft, write, or come up with a social media post — or gives you enough to write one (a topic, an announcement, a promotion, an update) — write the actual finished caption and hashtags, ready to post as-is: no placeholders, no brackets, no "[insert X here]".

Every post you draft here is saved for real the moment you include the post draft below, with a suggested posting slot already picked from this business's posting schedule — this chat cannot publish or schedule it further than that. Because of this: NEVER tell the user to go set it up, schedule it, or add it to their Review Queue themselves, and never describe dashboard steps, tools, or sections to visit. Once you include the post draft, your reply should just briefly confirm you've drafted the post and suggested a schedule for it — a link to review and approve it is added automatically straight after your reply, so don't mention where that link is or how to find it.

Only include the post draft once you have enough to write real, finished copy — a topic or brief is enough. Ask a short clarifying question (uiElement: null) only when you don't have a topic to write about yet.

ONE POST PER REPLY. The draft object below holds exactly one post, so one reply can only ever save one. If the user asks for several at once — three days' worth, a week's worth, one per platform-day — draft the FIRST one properly and end by offering to write the next ("That's Tuesday's saved — want Wednesday next?"). Never describe, summarise or promise posts you have not included here; if they want a whole week filled without asking each time, that is what their posting schedule already does automatically.

NEVER say a post has been drafted, written, saved, scheduled or queued for review unless THIS reply includes the post draft object. If uiElement is null then nothing has been saved, and a reply claiming otherwise sends the user to an empty Review Queue. When you have nothing to include, say plainly what you need in order to write it.`,
                platformLine,
                mediaLine,
                `Return STRICT JSON and NOTHING else — no markdown, no code fences, no prose before or after the object, and never repeat the conversation back. Keep "reply" to one or two short sentences. Every string must be valid JSON (escape any quotes or newlines inside caption/hashtags):
{
  "reply": "your conversational message to the user",
  "uiElement": {                      // or null when there is nothing to draft yet
    "type": "social_post_draft",
    "platforms": ["facebook" | "instagram" | "linkedin" | "x", ...],
    "caption": "<the finished, ready-to-post caption>",
    "hashtags": "<space-separated hashtags>" | null${canCard ? `,
    "cardHeadline": "<the branded card's single line of type — see BRAND CARDS above>"` : ''}
  }
}`,
            ].join('\n\n');
        },
        parseResponse: parseStructuredReply,
    },
};

// ── Handler ───────────────────────────────────────────────────────────────────

/**
 * Every failure answers in JSON, including the ones nobody predicted.
 *
 * The handler used to have exactly one try/catch, wrapped around the LLM call and everything after
 * it. The whole first half — resolving the tenant, creating the session, the parallel assistant/org/
 * target reads, the history query, persisting the user's turn — ran with no boundary at all, so a
 * throw anywhere in there escaped to withLambda and became a bare platform 502 with no body. The
 * chat UI can only report that as "Something went wrong (HTTP 502)": the orchestrator's own error
 * path never ran, so there was nothing to say and nothing logged from here to say it with.
 *
 * That is not a hypothetical. It is the exact symptom reported from "Talk it through in chat", whose
 * cold path (new session + immediate heavy turn) is the most likely place to hit one.
 *
 * This wrapper does NOT make failures succeed — a function KILLED at the timeout still returns a raw
 * 502, because no JavaScript runs after the kill. What it fixes is the far more common case of a
 * thrown error: the client now gets a named reason and the server logs the stack.
 */
export default withLambda(async (event) => {
    try {
        return await handleChatTurn(event);
    } catch (err) {
        console.error('[chat-orchestrator] unhandled error before the LLM boundary:', err);
        // Name the fault in the reply, not just the log.
        //
        // "Please try again — the details are in our logs" is only useful to someone who can read
        // the logs, which is nobody holding the mouse. A Postgres error carries a `code` (42703
        // undefined column, 42P01 undefined table, 23502 not-null violation, 22P02 bad input) and
        // every Error carries a `name`: both identify the fault precisely and neither contains any
        // row data or SQL text, so they are safe to show. A user can now read one line back and it
        // is immediately actionable instead of being another anonymous failure.
        const e = err as { code?: unknown; name?: unknown; message?: unknown };
        const code = typeof e?.code === 'string' && e.code.length <= 12 ? e.code
                   : typeof e?.name === 'string' && e.name.length <= 40 ? e.name
                   : 'unknown';
        // The code alone was not enough: a plain `throw new Error(...)` reports as "Error", which
        // narrows the fault to "our own code threw" and no further. The message is what identifies
        // it, so it is returned as well.
        //
        // Deliberate, and worth stating plainly: this endpoint is authenticated and tenant-scoped, so
        // the only reader is the workspace owner, and the strings involved are our own throw sites or
        // a driver naming a column — never row data. Truncated because a stack-carrying message has
        // no business being a UI string. If this app ever serves untrusted users, drop `detail` and
        // go back to reading the function logs.
        const detail = typeof e?.message === 'string' ? e.message.slice(0, 200) : '';
        return json(500, {
            code,
            detail,
            error: detail
                ? `Something went wrong starting that conversation: ${detail}`
                : `Something went wrong starting that conversation (${code}).`,
        });
    }
});

async function handleChatTurn(event: Parameters<Parameters<typeof withLambda>[0]>[0]) {
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
        /** The post the user is editing, when this conversation was opened FROM the post
         *  editor ("Talk it through in chat"). Changes what a drafted post means: the
         *  caption is offered to that post instead of being saved as a new one. See
         *  draftTarget below. */
        forPostId?: number;
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
        // A cap that could not be EVALUATED is a server fault, and answering it with the upgrade
        // card would tell the user to buy a bigger plan to fix our outage. 503 says "try again",
        // which is the true and actionable thing; the cause is in the [atomicCapCheck] log line.
        if (capacity.failed) {
            console.error(`[chat-orchestrator] cap check failed (not a limit) org=${orgId} user=${userId}`);
            return json(503, { code: 'cap_check_failed', error: capacity.limitMessage });
        }
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

    // ── Retrieve state: assistant instance + roleKey + org business identity + the post being
    //    edited (when there is one) + prior turns ──
    const forPostId = Number(body.forPostId);
    const [[assistantRow], [orgRow], [targetRow]] = await Promise.all([
        db
            .select({
                id: aiAssistants.id,
                name: aiAssistants.name,
                jobRole: aiAssistants.aiAssistantJobRole,
                systemPrompt: aiAssistants.systemPrompt,
                onboardingContext: aiAssistants.onboardingContext,
                mediaSources: aiAssistants.mediaSources,
                roleKey: masterAssistants.roleKey,
            })
            .from(aiAssistants)
            .leftJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
            .where(and(eq(aiAssistants.id, session.aiAssistantId), eq(aiAssistants.organisationId, orgId)))
            .limit(1),
        db
            .select({ name: organisations.name, industry: organisations.industry, businessDescription: organisations.businessDescription })
            .from(organisations)
            .where(eq(organisations.id, orgId))
            .limit(1),
        // Tenant-scoped by the same where clause as everything else here: a post id from the client
        // can only ever resolve to this org's own row.
        Number.isInteger(forPostId)
            ? db
                .select({ id: scheduledPosts.id, status: scheduledPosts.status, platform: scheduledPosts.platform })
                .from(scheduledPosts)
                .where(and(eq(scheduledPosts.id, forPostId), eq(scheduledPosts.organisationId, orgId)))
                .limit(1)
            : Promise.resolve([]),
    ]);
    if (!assistantRow) return json(404, { error: 'Assistant not found in this organisation.' });

    // A target that isn't ours, or has gone past editing (approved and published while the chat was
    // open), degrades to ordinary behaviour rather than failing the turn: the conversation stays
    // usable, the draft is saved as a new post, and its review link says where it went. Failing here
    // would kill the conversation over a post the user may have stopped caring about.
    const draftTarget = targetRow && EDITABLE_POST_STATUSES.includes(targetRow.status ?? '')
        ? { id: targetRow.id, platform: targetRow.platform ?? null }
        : null;

    // Every route's prompt is grounded in this — the business the assistant actually works
    // for, not the Be More Swan platform that runs it (issue #199).
    const business = {
        name: orgRow?.name || 'the user\'s business',
        industry: orgRow?.industry ?? null,
        description: orgRow?.businessDescription ?? null,
    };

    // Only user/assistant turns are ever sent to the LLM ('system' rows are audit/injected
    // notices), and only the most recent HISTORY_LIMIT of them — so both filters belong in the
    // query, not in a post-filter. Sessions are resumed now rather than recreated per open, so
    // a thread can hold thousands of rows: loading all of them to discard all but 20 would grow
    // the cost of every turn without bound. Fetched newest-first, then flipped back to
    // chronological order for the prompt.
    const history = (await db
        .select({ role: chatMessages.role, content: chatMessages.content, createdAt: chatMessages.createdAt })
        .from(chatMessages)
        .where(and(
            eq(chatMessages.chatSessionId, session.id),
            inArray(chatMessages.role, ['user', 'assistant']),
        ))
        .orderBy(desc(chatMessages.createdAt), desc(chatMessages.id))
        .limit(HISTORY_LIMIT)).reverse();

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

    const rolePrompt = route.buildRolePrompt({
        assistantName: assistantRow.name,
        jobRole: assistantRow.jobRole,
        baseSystemPrompt: assistantRow.systemPrompt,
        onboardingContext: assistantRow.onboardingContext,
        business,
        knowledgeBase,
        mediaSources: assistantRow.mediaSources,
    });
    const system = buildSystemPrompt(
        // Appended last so it wins: the SMM role prompt states that every draft is saved and linked,
        // which is exactly what must NOT happen when the user is editing a post already.
        draftTarget ? `${rolePrompt}\n\n${draftTargetPromptBlock(draftTarget.platform)}` : rolePrompt,
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

    // `history` is already role-filtered and capped by the query above.
    const llmMessages = [
        ...history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
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
                    business,
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
        // `content` is not final: the reconciliation guard below replaces it when the model
        // claims a post was saved and no row was actually written.
        const parsed = route.parseResponse(raw);
        const uiElement = parsed.uiElement;
        let content = parsed.content;

        // Golden Rule 2: structured output flows into the Data Hub automatically. Computed
        // up front (rather than inside persistHubRecords) so the same records list can also
        // stamp a hubLink onto the uiElement below — the transcript then carries its own
        // "where did this go" pointer, and it round-trips through uiElementJson on reload.
        const hubRecords = hubRecordsFromUiElement(uiElement);
        let hubLink = hubLinkFromRecords(hubRecords);

        // Social post drafts land in scheduled_posts, not assistant_records, so they get
        // their own persistence path — but the same "tell the transcript where it went"
        // treatment, pointing straight at the drafted post rather than just the tab.
        const socialDraft = socialPostDraftFromUiElement(uiElement, draftTarget?.platform ?? null);
        // What this turn actually wrote. Stays null on every path that persists nothing, which
        // is what the reconciliation guard below tests the reply against.
        let persistedPosts: { id: number; platform: string }[] | null = null;
        if (socialDraft && draftTarget) {
            // Drafting INTO an open post: persist nothing and link nowhere. The id rides on the
            // uiElement so the card knows which post the offer belongs to — and still knows after
            // the transcript is reloaded from uiElementJson, when the client's own target is gone.
            (uiElement as Record<string, unknown>).forPostId = draftTarget.id;
        } else if (socialDraft) {
            const createdPosts = await persistSocialPostDraft(
                db, orgId, userId, session.aiAssistantId, assistantRow.name, assistantRow.onboardingContext,
                assistantRow.mediaSources, socialDraft,
            );
            persistedPosts = createdPosts;
            if (createdPosts.length > 0) {
                hubLink = {
                    tab: 'review-queue',
                    label: createdPosts.length > 1 ? `Drafted ${createdPosts.length} posts — review & approve` : 'Drafted this post — review & approve',
                    postId: createdPosts[0].id,
                };
            }
        }

        // ── Reply ↔ persistence reconciliation ────────────────────────────────────
        // The reply text and the scheduled_posts row come from the same model response but by
        // independent paths, and nothing used to compare them — so "all three posts are drafted
        // and ready for your review" shipped alongside a null uiElement, and the user opened an
        // empty Review Queue. (Observed live on 2026-08-05: six such claims in 22 minutes, every
        // one with ui_element_json NULL.) A success claim now has to be backed by a row.
        //
        // Only asked on the social route, and only when this turn wrote nothing: an honest turn —
        // a clarifying question, an offer to draft, a plain chat answer — never reaches the
        // detector, and a turn that really did save is left exactly as the model wrote it.
        if (route === ROUTES.social_media_manager && replyClaimsPostSaved(content)) {
            let breach: DraftClaimFailure | null = null;
            if (draftTarget) breach = 'not_saved_here';                      // saving here is wrong by design
            else if (persistedPosts?.length === 0) breach = 'persist_failed'; // valid draft, the write threw
            else if (!persistedPosts) breach = 'no_draft';                   // claimed a post, produced none

            if (breach) {
                console.warn(
                    `[chat-orchestrator] suppressed unbacked draft claim (${breach}) — assistant ${session.aiAssistantId}, session ${session.id}`,
                );
                content = honestDraftReply(breach);
            }
        }

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
}
