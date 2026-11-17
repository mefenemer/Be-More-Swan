// Meeting Note Taker: "New meeting" — write up a meeting without the chat (docs/meeting-note-taker-finish-plan.md
// step 5, the GUI half of the GUI-and-chat rule). The Inbox tab's form posts pasted notes and/or one
// transcript file here; the reply is the same minutes card the chat makes, filed as the same meeting
// record, waiting in the Inbox for approval. Nothing is sent from here.
//
//   POST { assistantId, text?, attachment?: { name, type, data (base64) } }
//     → 200 { recordId, title, card }   the meeting is in the Inbox
//     → 422 { error }                   the model found no meeting in the text (nothing saved)
//
// Same rules as a chat turn: the shared prompt (src/utils/meeting-minutes.ts), the assistant's own and
// workspace-wide rules, moderation, and the daily fair-use count — pasted text costs no task, as chat.

import Anthropic from '@anthropic-ai/sdk';
import { withLambda } from '@netlify/aws-lambda-compat';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, masterAssistants, organisations } from '../../db/schema';
import { adaptForModel, replyText } from '../../src/config/model-options';
import { logAiUsage } from '../../src/utils/ai-usage';
import { loadRoleModel, withRoleModel } from '../../src/utils/assistant-model';
import { loadAssistantRulesBlock } from '../../src/utils/assistant-rules-prompt';
import { readAttachments } from '../../src/utils/chat-attachments';
import { persistHubRecordsWithTitles } from '../../src/utils/hub-records';
import {
    FORM_CHANNEL_BLOCK, MEETING_MINUTES_MAX_TOKENS, MEETING_MINUTES_MODEL, buildMeetingMinutesPrompt,
    meetingHubRecord, normaliseMinutesCard,
} from '../../src/utils/meeting-minutes';
import { TRANSCRIPT_MAX_CHARS } from '../../src/utils/meeting-transcript';
import { parseModelJson } from '../../src/utils/model-json';
import { enforcePromptModeration } from '../../src/utils/moderation';
import { meterInteraction } from '../../src/utils/task-credit';
import { requireTenant } from '../../src/utils/tenant';
import { sanitizeForModel } from '../../src/utils/text-safe';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export interface MeetingFormInput { text: string; fileText: string | null; fileName: string | null }

/** The one user message the model gets: the typed notes, then the file, labelled. Pure. */
export function meetingFormMessage(i: MeetingFormInput): string {
    const parts: string[] = [];
    if (i.text) parts.push(i.fileText ? `Notes from the user:\n${i.text}` : i.text);
    if (i.fileText) parts.push(`Transcript${i.fileName ? ` from "${i.fileName}"` : ''}:\n<<<TRANSCRIPT\n${i.fileText}\nTRANSCRIPT>>>`);
    return parts.join('\n\n');
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed.' });
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId: orgId } = ctx;

    let body: { assistantId?: unknown; text?: unknown; attachment?: unknown };
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

    const assistantId = Number(body.assistantId);
    if (!Number.isInteger(assistantId)) return json(400, { error: 'assistantId is required.' });
    const [assistant] = await db.select({
        id: aiAssistants.id, name: aiAssistants.name, onboardingContext: aiAssistants.onboardingContext,
        lifecycleStatus: aiAssistants.lifecycleStatus, roleKey: masterAssistants.roleKey,
    }).from(aiAssistants)
        .leftJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
        .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, orgId))).limit(1);
    if (!assistant || assistant.roleKey !== 'meeting_note_taker') return json(404, { error: 'Meeting assistant not found in this workspace.' });
    if (assistant.lifecycleStatus === 'archived') return json(409, { error: 'This assistant has been archived.' });

    // The notes and the file, read with the same limits as a transcript attached in chat.
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (text.length > TRANSCRIPT_MAX_CHARS) return json(400, { error: 'That is longer than about 2 hours of talk. Split it, and write up one part at a time.' });
    let fileText: string | null = null;
    let fileName: string | null = null;
    if (body.attachment) {
        try {
            const [doc] = await readAttachments(db, orgId, [{ ...(body.attachment as object), kind: 'document' }], { transcripts: true });
            fileText = doc?.text ?? null;
            fileName = doc?.name ?? null;
        } catch (err) {
            return json(400, { error: err instanceof Error ? err.message : 'That file couldn\'t be read.' });
        }
    }
    if (!text && !fileText) return json(400, { error: 'Paste the meeting notes or attach the transcript first.' });
    const message = meetingFormMessage({ text, fileText, fileName });
    if (message.length > TRANSCRIPT_MAX_CHARS + 2000) return json(400, { error: 'The notes and the file together are longer than about 2 hours of talk. Send them separately.' });

    const blocked = await enforcePromptModeration({ text: message.slice(0, 20000), userId, organisationId: orgId, source: 'meeting_minutes_form' });
    if (blocked) return blocked;

    // Counted like a chat message: no task, a daily fair-use limit (or a task credit with the flag off).
    const capacity = await meterInteraction(db, orgId, 'chat');
    if (!capacity.allowed) {
        if (capacity.fairUse) return json(429, { code: 'FAIR_USE_LIMIT', error: capacity.limitMessage });
        if (capacity.failed) return json(503, { code: 'cap_check_failed', error: capacity.limitMessage });
        return json(403, { code: 'UPGRADE_REQUIRED', error: capacity.limitMessage || 'Your plan has no tasks left this month.' });
    }

    const [org] = await db.select({ name: organisations.name, industry: organisations.industry, businessDescription: organisations.businessDescription })
        .from(organisations).where(eq(organisations.id, orgId)).limit(1);
    const setup = (assistant.onboardingContext && typeof assistant.onboardingContext === 'object') ? assistant.onboardingContext as Record<string, unknown> : {};
    const rulesBlock = await loadAssistantRulesBlock(db, { assistantId: assistant.id, organisationId: orgId });
    const businessName = org?.name || 'this business';
    const system = [
        `You are "${assistant.name}", a digital assistant provided via the Be More Swan platform. You work exclusively for ${businessName}${org?.industry ? ` (industry: ${org.industry})` : ''}, not for Be More Swan itself.${org?.businessDescription ? ` About ${businessName}: ${org.businessDescription}` : ''}`,
        buildMeetingMinutesPrompt({
            meetingPlatform: setup.meetingPlatform,
            taskDestination: setup.taskDestination,
            summaryFormat: setup.summaryFormat,
            channelBlock: FORM_CHANNEL_BLOCK,
        }),
        rulesBlock,
    ].filter(Boolean).join('\n\n');

    let raw: string;
    try {
        const { response, model } = await withRoleModel(
            await loadRoleModel(db, 'meeting_note_taker'), MEETING_MINUTES_MODEL,
            async (m, thinking) => ({ model: m, response: await anthropic.messages.create(adaptForModel({
                model: m,
                max_tokens: MEETING_MINUTES_MAX_TOKENS,
                system: sanitizeForModel(system),
                messages: sanitizeForModel([{ role: 'user' as const, content: message }]),
            }, m, thinking) as Anthropic.MessageCreateParamsNonStreaming) }),
            { requestPath: true, label: 'meeting-minutes' },
        );
        await logAiUsage({
            workspaceId: orgId, userId, assistantId: assistant.id, model,
            inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens,
            sessionId: `meeting-minutes:${assistant.id}`, dataCategories: ['business_context'],
        });
        raw = replyText(response.content);
    } catch (err) {
        console.error('[meeting-minutes] model call failed', err);
        return json(502, { error: 'The write-up didn\'t finish. Nothing was saved — try again in a moment.' });
    }

    const parsed = parseModelJson<{ reply?: unknown; uiElement?: unknown }>(raw);
    const card = normaliseMinutesCard(parsed?.uiElement);
    if (!card) {
        const reply = typeof parsed?.reply === 'string' && parsed.reply.trim() ? parsed.reply.trim().slice(0, 500) : 'No meeting could be found in that text.';
        return json(422, { error: reply });
    }
    const record = meetingHubRecord(card as unknown as Record<string, unknown>);
    // Every pasted set of notes is its own meeting (the form never revises). The title returned is the one SAVED,
    // which has the date and time added when another meeting already has it — so it matches the Inbox.
    const [saved] = await persistHubRecordsWithTitles(db, orgId, assistant.id, [record]);
    if (!saved) return json(500, { error: 'The minutes were written but couldn\'t be saved. Try again.' });
    return json(200, { recordId: saved.id, title: saved.title, card });
});
