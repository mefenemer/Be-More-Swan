// src/utils/mentor-feedback.ts
// "Get feedback" on the user's own draft (docs/business-mentor-plan.md §3.6, §14) — the screen twin of
// pasting a draft into the Mentor's chat. Both judge it by the same MENTOR_FEEDBACK_CRAFT
// (src/constants/mentor-craft.ts) against the same workspace (mentor-snapshot.ts), on the Mentor's
// model from Admin ▸ Assistants ▸ Model & rules. Called by netlify/functions/mentor.ts.
//
// Metered like the editing helpers (meterInteraction 'helpers': fair use, no task, and nothing without
// a paid plan). Never writes anything but the usage log.

import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import { organisations } from '../../db/schema';
import { MENTOR_FEEDBACK_CRAFT } from '../constants/mentor-craft';
import { CHAT_DEFAULT_MODEL } from '../config/assistant-prompt-layers';
import { adaptForModel, replyText } from '../config/model-options';
import { loadRoleModel, withRoleModel } from './assistant-model';
import { loadMentorSnapshotData, type MentorSnapshotData } from './mentor-snapshot';
import { MENTOR_ROLE_KEY } from './mentor-provision';
import { meterInteraction } from './task-credit';
import { logAiUsage } from './ai-usage';
import { sanitizeForModel } from './text-safe';
import { isGlobalAiDisabled } from './platform-config';

type Db = any;

export const FEEDBACK_MIN_CHARS = 20;
export const FEEDBACK_MAX_CHARS = 12_000;

export type FeedbackResult =
    | { ok: true; feedback: string }
    | { ok: false; status: number; error: string; code?: string };

/** Pure: the text the user gave, or why it can't be judged. */
export function checkDraftText(raw: unknown): { ok: true; text: string } | { ok: false; error: string } {
    const t = typeof raw === 'string' ? raw.trim() : '';
    if (t.length < FEEDBACK_MIN_CHARS) return { ok: false, error: 'Paste a little more of your draft so there’s something to judge.' };
    if (t.length > FEEDBACK_MAX_CHARS) return { ok: false, error: `That’s too long to judge in one go — paste up to ${FEEDBACK_MAX_CHARS.toLocaleString('en-GB')} characters.` };
    return { ok: true, text: t };
}

/** Pure: what the Mentor knows about the business, for the critique. Missing is said as missing. */
export function feedbackContext(d: MentorSnapshotData, audience: string | null, businessName: string | null): string {
    const lines = ['THE BUSINESS (from their workspace):'];
    lines.push(`- Name: ${businessName?.trim() || 'not given'}`);
    lines.push(`- What it does: ${d.business.description?.trim() || 'not filled in yet'}`);
    lines.push(`- Who its customers are: ${audience?.trim() || 'not filled in yet'}`);
    if (d.business.website?.trim()) lines.push(`- Website: ${d.business.website.trim()}`);
    lines.push(d.productCount
        ? `- Products & Services: ${d.products.map((p) => `${p.name}${p.hasPrice ? '' : ' (no price)'}`).join('; ')}${d.productCount > d.products.length ? '; …' : ''}`
        : '- Products & Services: none listed — never state a product or price');
    const active = d.team.filter((t) => t.state === 'active');
    lines.push(active.length
        ? `- Active assistants (the only ones you may mention for a rewrite): ${active.map((t) => `${t.name} (${t.role})`).join(', ')}`
        : '- Active assistants: none — never suggest asking an assistant; they can make the changes themselves');
    return lines.join('\n');
}

export function feedbackSystemPrompt(context: string): string {
    return `You are this business's Business Mentor on Be More Swan, giving feedback on something the user wrote. Reply in plain text, no markdown headings.

${context}

${MENTOR_FEEDBACK_CRAFT}

- Never invent anything about the business: only what is listed above. If something the draft says isn't above, say you can't check it.
- No statistic or benchmark unless you can say where it comes from; otherwise call it your own judgement.
- This is the "Get feedback" box on your Overview tab: nothing is saved or changed, so never say you have changed anything.`;
}

/** The screen's action: judge the draft. */
export async function mentorDraftFeedback(db: Db, orgId: number, userId: number, raw: unknown): Promise<FeedbackResult> {
    const checked = checkDraftText(raw);
    if (!checked.ok) return { ok: false, status: 400, error: checked.error };
    if (await isGlobalAiDisabled()) return { ok: false, status: 503, error: 'AI services are temporarily unavailable. Please try again later.' };

    const credit = await meterInteraction(db, orgId, 'helpers');
    if (!credit.allowed) {
        // A cap that could not be EVALUATED is a server fault, not a plan limit.
        if (credit.failed) return { ok: false, status: 503, error: credit.limitMessage ?? 'Please try again.' };
        if (credit.fairUse) return { ok: false, status: 429, error: credit.limitMessage ?? 'Please try again later.', code: 'FAIR_USE_LIMIT' };
        return { ok: false, status: 403, error: credit.limitMessage ?? 'You need a plan for this.', code: 'UPGRADE_REQUIRED' };
    }

    const [data, [org]] = await Promise.all([
        loadMentorSnapshotData(db, orgId, userId),
        db.select({ audience: organisations.targetAudience, name: organisations.name }).from(organisations).where(eq(organisations.id, orgId)).limit(1),
    ]);
    const system = feedbackSystemPrompt(feedbackContext(data, org?.audience ?? null, org?.name ?? null));

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const { response, model } = await withRoleModel(
        await loadRoleModel(db, MENTOR_ROLE_KEY), CHAT_DEFAULT_MODEL,
        async (m, thinking) => ({ model: m, response: await anthropic.messages.create(adaptForModel({
            model: m,
            max_tokens: 1200,
            system: sanitizeForModel(system),
            messages: sanitizeForModel([{ role: 'user' as const, content: `Here's my draft — what do you think?\n\n"""\n${checked.text}\n"""` }]),
        }, m, thinking) as Anthropic.MessageCreateParamsNonStreaming) }),
        { requestPath: true, label: 'mentor feedback' },
    );
    void logAiUsage({
        workspaceId: orgId, userId, model,
        inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens,
        sessionId: 'mentor:feedback', dataCategories: ['business_context'],
    });
    const feedback = replyText(response.content).trim();
    if (!feedback) return { ok: false, status: 502, error: 'Your Mentor didn’t come back with anything — please try again.' };
    return { ok: true, feedback };
}
