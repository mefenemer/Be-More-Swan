// src/lib/discussion-triage.ts
// The model half of the Discussions tab: is this forum thread someone this business could genuinely
// help, and what would a good reply say? src/utils/discussions.ts gathers the threads; this judges
// them. The disclosure line is NOT the model's job — withDisclosure() adds it after, in code.
//
// ── The reply is help first ──────────────────────────────────────────────────────────────────────
// A reply that is an advert gets removed and gets the account banned, and it is the thing the DMCC
// Act and every community's rules are aimed at. So the prompt asks for the answer a knowledgeable
// person would give, with the business mentioned at most once and only where it really fits — and
// for no reply at all when the honest answer is "this isn't for us".
//
// ⚠️ Never throws. A failed call returns no verdicts; the caller keeps nothing and says so.

import Anthropic from '@anthropic-ai/sdk';
import { parseModelJson, parseModelJsonArray } from '../utils/model-json';
import { adaptForModel, replyText } from '../config/model-options';
import { withRoleModel, type RoleModelChoice } from '../utils/assistant-model';
import { logMessageUsage } from '../utils/ai-usage';
import { SPECIAL_CATEGORY_RULE } from '../constants/special-category-rule';
import type { SenderIdentity } from '../config/sender-identity';
import { sourceInfo, type DiscussionFit, type DiscussionSource } from '../config/discussion-sites';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const TRIAGE_MODEL = 'claude-haiku-4-5-20251001';
/** Threads judged per call — each verdict carries a reply of up to ~150 words. */
const GROUP_SIZE = 5;
const CALL_TIMEOUT_MS = 60_000;
/** How much of a thread's page text the model sees. */
export const THREAD_TEXT_CHARS = 4000;

export interface TriageCandidate {
    site: DiscussionSource;
    title: string;
    snippet: string;
    /** The thread page's text, when it could be read (robots.txt allowing). Empty = snippet only. */
    pageText: string;
}

export interface TriageVerdict {
    relevance: number;
    fit: DiscussionFit;
    why: string;
    /** Without the disclosure line. Null when the model judged it not worth a reply. */
    reply: string | null;
}

function businessBlock(sender: SenderIdentity): string {
    const lines: string[] = [];
    const name = (sender.businessName || '').trim();
    lines.push(name ? `The business: ${name}.` : 'The business has not been named in this workspace.');
    if (sender.businessDescription?.trim()) lines.push(`What it does: ${sender.businessDescription.trim()}`);
    if (sender.industry?.trim()) lines.push(`Industry: ${sender.industry.trim()}`);
    if (sender.websiteUrl?.trim()) lines.push(`Website: ${sender.websiteUrl.trim()}`);
    if (sender.productsBlock?.trim()) lines.push(sender.productsBlock.trim());
    return lines.join('\n');
}

const REPLY_RULES = `HOW THE REPLY IS WRITTEN — it is posted by a real person from the business, under their own name, on a public forum:
- Answer the question first, properly: the advice a knowledgeable, honest person would give, useful even to a reader who never buys anything. Name other good options where they are relevant — a reply that only points at one business reads as an advert, and forums remove adverts.
- Mention the business at most ONCE, and only where it genuinely fits what they asked. Never invent features, prices, offers, reviews or results — name a product only as it is described above.
- Plain, conversational, no marketing language, no headings, no emojis, no hashtags, no sign-off. Under 150 words.
- Do NOT add any disclosure, "I work at…" line, or link — a disclosure line is added automatically after your last sentence, and a second one would print twice.
- Never claim to be a customer, a neutral user, or anyone other than someone from this business.
- Never mention Be More Swan, this platform, AI, or an assistant.
${SPECIAL_CATEGORY_RULE}`;

function systemPrompt(sender: SenderIdentity): string {
    return `You find public forum threads where a small business could genuinely help someone, and draft the reply a person from that business would post.

${businessBlock(sender)}

For each thread, decide:
- "relevance" 0-100: how well what this business offers answers what the person is asking. 80+ = they are asking for exactly this kind of product or service; 50-79 = the business has real expertise to offer on the question; below 50 = only a keyword overlap, not a fit. Be strict: most threads that match a keyword are NOT a fit.
- "fit": "asking_for" when the person wants a product or service like this business's; "can_help" when they want advice the business is qualified to give.
- "why": one sentence for the business owner — what the person needs and why this business can help. Quote nothing private.
- "reply": the reply to post, for relevance 50 or above; null below 50, or when the thread is a complaint, a news story, a job post, already answered and closed, or not something a business should step into.

${REPLY_RULES}

Only the thread text given is known — do not assume anything else about the thread or the person.`;
}

const ARRAY_SHAPE = `Return STRICT JSON only (no markdown): an array with ONE object per thread, in the SAME ORDER as given:
[{ "relevance": <0-100>, "fit": "asking_for" | "can_help", "why": "<one sentence>", "reply": "<the reply>" | null }]`;

function clampVerdict(raw: unknown): TriageVerdict | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const n = Number(r.relevance);
    if (!Number.isFinite(n)) return null;
    const relevance = Math.max(0, Math.min(100, Math.round(n)));
    const fit: DiscussionFit = r.fit === 'asking_for' ? 'asking_for' : 'can_help';
    const why = typeof r.why === 'string' ? r.why.replace(/\s+/g, ' ').trim().slice(0, 400) : '';
    const reply = typeof r.reply === 'string' && r.reply.trim() ? r.reply.trim().slice(0, 2000) : null;
    return { relevance, fit, why, reply };
}

function threadPayload(c: TriageCandidate, index: number) {
    return {
        index,
        site: sourceInfo(c.site).label,
        title: c.title.slice(0, 300),
        // Google's two lines, then the page itself when we could read it.
        snippet: c.snippet.slice(0, 500),
        threadText: c.pageText ? c.pageText.slice(0, THREAD_TEXT_CHARS) : null,
    };
}

/** Who the call is billed to in the AI usage ledger. */
export interface TriageUsage { workspaceId: number; assistantId: number }

export interface TriageResult {
    /** Aligned with the input; null = not judged (the call failed or was cut off). */
    verdicts: Array<TriageVerdict | null>;
    inputTokens: number;
    outputTokens: number;
}

async function triageGroup(group: TriageCandidate[], offset: number, sender: SenderIdentity, modelChoice: RoleModelChoice | null, usage: TriageUsage | null): Promise<TriageResult> {
    try {
        const { resp, model: used } = await withRoleModel(modelChoice, TRIAGE_MODEL, async (model, thinking) => ({ model, resp: await anthropic.messages.create(adaptForModel({
            model,
            max_tokens: 4096,
            system: `${systemPrompt(sender)}\n\n${ARRAY_SHAPE}`,
            messages: [{ role: 'user', content: `Judge these ${group.length} threads:\n${JSON.stringify(group.map((c, i) => threadPayload(c, offset + i)))}` }],
        }, model, thinking) as Anthropic.MessageCreateParamsNonStreaming, { timeout: CALL_TIMEOUT_MS, maxRetries: 1 }) }), { requestPath: false, label: 'discussion-triage' });
        logMessageUsage(resp, used, { ...usage, sessionId: 'discussion-triage' });
        const parsed = parseModelJsonArray(replyText(resp.content));
        const list = Array.isArray(parsed) ? parsed : [];
        return {
            verdicts: group.map((_, i) => clampVerdict(list[i])),
            inputTokens: resp.usage.input_tokens,
            outputTokens: resp.usage.output_tokens,
        };
    } catch (err) {
        console.error('[discussion-triage] triage failed', err instanceof Error ? err.message : err);
        return { verdicts: group.map(() => null), inputTokens: 0, outputTokens: 0 };
    }
}

/** Judge every candidate, in small groups side by side. */
export async function triageThreads(candidates: TriageCandidate[], sender: SenderIdentity, modelChoice: RoleModelChoice | null = null, usage: TriageUsage | null = null): Promise<TriageResult> {
    if (!candidates.length) return { verdicts: [], inputTokens: 0, outputTokens: 0 };
    const groups: Array<{ items: TriageCandidate[]; offset: number }> = [];
    for (let i = 0; i < candidates.length; i += GROUP_SIZE) groups.push({ items: candidates.slice(i, i + GROUP_SIZE), offset: i });
    const parts = await Promise.all(groups.map((g) => triageGroup(g.items, g.offset, sender, modelChoice, usage)));
    return {
        verdicts: parts.flatMap((p) => p.verdicts),
        inputTokens: parts.reduce((n, p) => n + p.inputTokens, 0),
        outputTokens: parts.reduce((n, p) => n + p.outputTokens, 0),
    };
}

/**
 * Rewrite one reply — "Redraft" on a card, or the chat's redraft card. `instruction` is what the
 * user asked for, in their words. Returns the reply without the disclosure line, or null on failure.
 */
export async function redraftReply(
    c: TriageCandidate & { currentReply: string | null },
    instruction: string | null,
    sender: SenderIdentity,
    modelChoice: RoleModelChoice | null = null,
    usage: TriageUsage | null = null,
): Promise<string | null> {
    try {
        const { resp, model: used } = await withRoleModel(modelChoice, TRIAGE_MODEL, async (model, thinking) => ({ model, resp: await anthropic.messages.create(adaptForModel({
            model,
            max_tokens: 1024,
            system: `You draft the reply a person from this business would post on a public forum thread.

${businessBlock(sender)}

${REPLY_RULES}

Return STRICT JSON only (no markdown): { "reply": "<the reply>" }`,
            messages: [{
                role: 'user',
                content: `${JSON.stringify(threadPayload(c, 0))}\n\nThe current draft:\n${c.currentReply || '(none)'}\n\n${instruction ? `What the business owner wants changed: ${instruction}` : 'Write a better reply.'}`,
            }],
        }, model, thinking) as Anthropic.MessageCreateParamsNonStreaming, { timeout: 20_000, maxRetries: 0 }) }), { requestPath: true, label: 'discussion-redraft' });
        logMessageUsage(resp, used, { ...usage, sessionId: 'discussion-redraft' });
        const parsed = parseModelJson(replyText(resp.content)) as { reply?: unknown } | null;
        const reply = parsed && typeof parsed.reply === 'string' ? parsed.reply.trim().slice(0, 2000) : '';
        return reply || null;
    } catch (err) {
        console.error('[discussion-triage] redraft failed', err instanceof Error ? err.message : err);
        return null;
    }
}
