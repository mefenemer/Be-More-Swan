// src/utils/newsletter-campaign-generate.ts
// Write every email of an email campaign whose plan a person has already agreed — the Email
// Studio's campaign builder, for people who do not use the chat. The chat route plans and drafts in
// conversation; this takes the finished plan (kind, goal, audience, links, and the day + job of each
// email) and returns the same normalised NewsletterCampaignDraft the chat card holds, so both paths
// save through the same two endpoints and are checked by the same normaliser.
//
// ⚠️ ONE MODEL CALL PER EMAIL, IN PARALLEL. A synchronous Netlify function is cut off at ~26s, and
// five emails written in one reply is ~1,500 output tokens — close enough to the limit that it fails
// on a slow day, after the customer has been charged for it. Each call is ~300 tokens and they run
// side by side. Cohesion does not come from one call seeing the others' COPY; it comes from every
// call seeing the whole PLAN (every email's day and job) and the same fixed greeting and sign-off.

import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { organisations } from '../../db/schema';
import { logAiUsage } from './ai-usage';
import { currentDatePromptBlock } from './current-date-prompt';
import { parseModelJson } from './model-json';
import { loadAssistantVoice, NEWSLETTER_MODEL } from './newsletter-generate';
import { GREETING_EXAMPLE, NEWSLETTER_MERGE_VARS } from '../config/newsletter-merge-vars';
import { cadenceFor } from '../config/email-campaign-cadences';
import {
    campaignDraftFromUiElement, MAX_CAMPAIGN_EMAILS, NEWSLETTER_CAMPAIGN_DRAFT_TYPE,
    type CampaignType, type NewsletterCampaignDraft,
} from './newsletter-campaign-chat-draft';

type Db = ReturnType<typeof getDb>;

export interface CampaignPlanInput {
    organisationId: number;
    userId: number;
    assistantId: number | null;
    name: string;
    campaignType: CampaignType;
    goal: string;
    audience: string;
    /** 'subscribed' → the welcome sequence; anything else → draft emails the user sends. */
    triggerEvent: 'subscribed' | 'form' | 'custom';
    /** Links and facts the person supplied. The ONLY source a URL may come from. */
    facts: string;
    avoid: string;
    steps: { day: number; role: string }[];
}

const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

export async function draftCampaignEmails(db: Db, input: CampaignPlanInput): Promise<NewsletterCampaignDraft> {
    const steps = input.steps.slice(0, MAX_CAMPAIGN_EMAILS);
    if (!steps.length) throw new Error('Add at least one email to the plan.');

    const { tone, assistantPrompt, timezone } = await loadAssistantVoice(db, input.assistantId, input.organisationId);
    const [org] = await db.select({
        name: organisations.name, businessDescription: organisations.businessDescription,
        targetAudience: organisations.targetAudience,
    }).from(organisations).where(eq(organisations.id, input.organisationId)).limit(1);
    const business = org?.name || 'the business';
    const kind = cadenceFor(input.campaignType);

    const plan = steps.map((s, i) => `  Email ${i + 1} — Day ${s.day}: ${s.role}`).join('\n');
    const system = [
        currentDatePromptBlock({ publishDate: null, timezone }),
        `You are writing ONE email in an email campaign for ${business}, in a ${tone} tone.` +
            (assistantPrompt ? ` Voice guidance: ${assistantPrompt}` : ''),
        org?.businessDescription ? `About ${business}: ${org.businessDescription}` : '',
        `THE CAMPAIGN — "${input.name}" (${kind.label}).
Goal — what the reader has done when it worked: ${input.goal || '(not stated — infer it from the plan)'}
Who is in it: ${input.audience || org?.targetAudience || 'their subscribers'}
${input.triggerEvent === 'subscribed' ? 'They enter the moment they subscribe.' : input.triggerEvent === 'form' ? 'They enter the moment they fill in a sign-up form (and confirm their email).' : 'The business sends each email to this group by hand on its day.'}
The whole plan (you write ONE of these; the others are written separately, in the same voice):
${plan}`,
        input.facts ? `Facts and links the business gave you — the ONLY facts and URLs you may use:\n${input.facts}` : 'The business gave no links. Write no URLs at all.',
        input.avoid ? `Avoid: ${input.avoid}` : '',
        kind.note ? `For this kind of campaign: ${kind.note}` : '',
        `HOW EVERY EMAIL IN THIS CAMPAIGN IS WRITTEN — so they read as one series:
  • Open with exactly "Hi ${GREETING_EXAMPLE}," on its own line, and sign off with exactly "— The ${business} team".
  • ONE job and ONE ask — the job given for your email in the plan, and one call to action.
  • The ask gets stronger across the series, never louder: early emails give value and ask for something small; later ones ask for the goal directly. Never invent urgency, scarcity or a deadline.
  • Make sense on its own: a reader may have missed the earlier emails. You may refer back lightly ("a few days ago we sent you…"), never "as I said yesterday".
  • Still true after they've done it: the series does not stop when a reader acts, so a later email must read well to someone who already has.
  • 120–250 words. Short paragraphs, at most two ## headings, no H1 (the subject is the title).
  • Subject under 60 characters, specific to THIS email; no fake "Re:"/"Fwd:", no "Last chance" without a real deadline.
  • Never write an unsubscribe line, footer, postal address or "you are receiving this because" — they are added automatically.
  • Never invent statistics, testimonials, prices, discounts, deadlines, dates or URLs.
  • Personalisation tags, written exactly: ${NEWSLETTER_MERGE_VARS.map((v) => `{{${v.key}}}`).join(', ')} — always with a fallback on a name, like ${GREETING_EXAMPLE}.`,
        `Return ONLY a JSON object:
{ "subject": "...", "preheader": "<one sentence that adds to the subject>", "bodyMarkdown": "<the email>", "callToAction": { "label": "<button text>", "url": "<a URL from the facts above, or null>" } }`,
    ].filter(Boolean).join('\n\n');

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const written = await Promise.all(steps.map(async (s, i) => {
        const res = await anthropic.messages.create({
            model: NEWSLETTER_MODEL,
            max_tokens: 1200,
            system,
            messages: [{ role: 'user', content: `Write Email ${i + 1} of ${steps.length} — Day ${s.day}: ${s.role}.` }],
        });
        void logAiUsage({
            userId: input.userId, workspaceId: input.organisationId, model: NEWSLETTER_MODEL,
            inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0,
        });
        const raw = (res.content[0] as { text?: string })?.text ?? '';
        const out = parseModelJson<{ subject?: unknown; preheader?: unknown; bodyMarkdown?: unknown; callToAction?: unknown }>(raw) ?? {};
        return {
            sequenceOrder: i + 1, sendDay: s.day, role: clip(s.role, 80),
            subject: out.subject, preheader: out.preheader, bodyMarkdown: out.bodyMarkdown, callToAction: out.callToAction,
        };
    }));

    // Through the chat card's normaliser — the same day/delay arithmetic, link grounding, merge-tag
    // scrub and "starts by itself" derivation. Two paths to one campaign must not disagree about it.
    const draft = campaignDraftFromUiElement({
        type: NEWSLETTER_CAMPAIGN_DRAFT_TYPE,
        stage: 'draft',
        campaign: {
            name: input.name, campaignType: input.campaignType, goal: input.goal, audience: input.audience,
            trigger: { event: input.triggerEvent, description: input.audience }, tone,
            newsletters: written,
        },
    }, [input.facts, input.goal, input.audience].join('\n'));
    if (!draft) throw new Error('The emails came back in a form we could not read. Try again.');
    return draft;
}
