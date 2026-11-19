// The one model call that turns a meeting's text into minutes — shared by the "New meeting" form
// (netlify/functions/meeting-minutes.ts) and automatic pick-up from Google Meet, Teams and Zoom
// (src/utils/meeting-pickup.ts), so a meeting written up either way comes out the same.
//
// It builds the system prompt (business, the shared meeting prompt, the assistant's own and workspace-wide
// rules), calls the role's model, logs the usage, and cleans the card. It does NOT meter, moderate or save:
// each caller does those its own way (the form counts like chat; pick-up spends a task after it is filed).

import Anthropic from '@anthropic-ai/sdk';
import { eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { organisations } from '../../db/schema';
import { adaptForModel, replyText } from '../config/model-options';
import { logAiUsage } from './ai-usage';
import { loadRoleModel, withRoleModel } from './assistant-model';
import { loadAssistantRulesBlock } from './assistant-rules-prompt';
import { MEETING_MINUTES_MAX_TOKENS, MEETING_MINUTES_MODEL, buildMeetingMinutesPrompt, normaliseMinutesCard, type MinutesCard } from './meeting-minutes';
import { parseModelJson } from './model-json';
import { sanitizeForModel } from './text-safe';

type Db = ReturnType<typeof getDb>;

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));

export interface MinutesAssistant { id: number; name: string; onboardingContext: unknown }

export interface WriteMinutesInput {
    organisationId: number;
    /** The person who asked, or null for background pick-up. */
    userId: number | null;
    assistant: MinutesAssistant;
    /** The whole meeting as one user message. */
    message: string;
    /** How the text reached us (FORM_CHANNEL_BLOCK, PICKUP_CHANNEL_BLOCK). */
    channelBlock: string;
    /** For the usage log. */
    sessionId: string;
    /** true on a synchronous request (keeps the model's thinking short enough for 26 s). */
    requestPath: boolean;
}

export type WriteMinutesResult =
    | { ok: true; card: MinutesCard; model: string }
    | { ok: false; reason: 'model_failed' }
    | { ok: false; reason: 'no_meeting'; reply: string };

export async function writeMeetingMinutes(db: Db, i: WriteMinutesInput): Promise<WriteMinutesResult> {
    const [org] = await db.select({ name: organisations.name, industry: organisations.industry, businessDescription: organisations.businessDescription })
        .from(organisations).where(eq(organisations.id, i.organisationId)).limit(1);
    const setup = (i.assistant.onboardingContext && typeof i.assistant.onboardingContext === 'object') ? i.assistant.onboardingContext as Record<string, unknown> : {};
    const rulesBlock = await loadAssistantRulesBlock(db, { assistantId: i.assistant.id, organisationId: i.organisationId });
    const businessName = org?.name || 'this business';
    const system = [
        `You are "${i.assistant.name}", a digital assistant provided via the Be More Swan platform. You work exclusively for ${businessName}${org?.industry ? ` (industry: ${org.industry})` : ''}, not for Be More Swan itself.${org?.businessDescription ? ` About ${businessName}: ${org.businessDescription}` : ''}`,
        buildMeetingMinutesPrompt({
            meetingPlatform: setup.meetingPlatform,
            taskDestination: setup.taskDestination,
            summaryFormat: setup.summaryFormat,
            channelBlock: i.channelBlock,
        }),
        rulesBlock,
    ].filter(Boolean).join('\n\n');

    let raw: string;
    let usedModel: string;
    try {
        const { response, model } = await withRoleModel(
            await loadRoleModel(db, 'meeting_note_taker'), MEETING_MINUTES_MODEL,
            async (m, thinking) => ({ model: m, response: await anthropic().messages.create(adaptForModel({
                model: m,
                max_tokens: MEETING_MINUTES_MAX_TOKENS,
                system: sanitizeForModel(system),
                messages: sanitizeForModel([{ role: 'user' as const, content: i.message }]),
            }, m, thinking) as Anthropic.MessageCreateParamsNonStreaming) }),
            { requestPath: i.requestPath, label: 'meeting-minutes' },
        );
        await logAiUsage({
            workspaceId: i.organisationId, userId: i.userId, assistantId: i.assistant.id, model,
            inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens,
            sessionId: i.sessionId, dataCategories: ['business_context'],
        });
        raw = replyText(response.content);
        usedModel = model;
    } catch (err) {
        console.error('[meeting-minutes] model call failed', err instanceof Error ? err.message : err);
        return { ok: false, reason: 'model_failed' };
    }

    const parsed = parseModelJson<{ reply?: unknown; uiElement?: unknown }>(raw);
    const card = normaliseMinutesCard(parsed?.uiElement);
    if (!card) {
        const reply = typeof parsed?.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim().slice(0, 500) : 'No meeting could be found in that text.';
        return { ok: false, reason: 'no_meeting', reply };
    }
    return { ok: true, card, model: usedModel };
}
