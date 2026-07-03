// netlify/functions/social-auto-responder.ts
// US-SMM-4.2.1: LLM-generated auto-responder messages pushed to Meta Graph API.
// POST { assistantId }  — generates Messenger greeting, Messenger auto-reply, Instagram DM auto-reply.
// Stores draft in aiAssistants.configuration.autoResponderDraft.

import { Handler } from '@netlify/functions';
import Anthropic from '@anthropic-ai/sdk';
import { eq, and } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, systemConnections, organisations, userOrganisations } from '../../db/schema';
import { getSecret } from '../../src/utils/vault';
import { isServiceAllowedForAssistant } from '../../src/utils/connection-map';
import { requireTenant } from '../../src/utils/tenant';

const anthropic  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL      = 'claude-haiku-4-5-20251001';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    // Session carries `activeOrganisationId`, not `organisationId` — resolve via requireTenant.
    const tenant = await requireTenant(event, db);
    if ('error' in tenant) return tenant.error;
    const { organisationId } = tenant;

    const body = JSON.parse(event.body || '{}');
    const { assistantId } = body as { assistantId?: number };

    // Load assistant blueprint / onboarding context
    const [assistant] = await db.select({ id: aiAssistants.id, name: aiAssistants.name, onboardingContext: aiAssistants.onboardingContext, systemPrompt: aiAssistants.systemPrompt, configuration: aiAssistants.configuration })
        .from(aiAssistants)
        .where(and(eq(aiAssistants.organisationId, organisationId), ...(assistantId ? [eq(aiAssistants.id, assistantId)] : []), eq(aiAssistants.isActive, true)))
        .limit(1);

    if (!assistant) return { statusCode: 404, body: JSON.stringify({ error: 'No active assistant found' }) };

    // Runtime connection sandboxing: this assistant may only drive social connections.
    if (!isServiceAllowedForAssistant('instagram', { roleKey: (assistant.configuration as { type?: string } | null)?.type, role: assistant.name })) {
        return { statusCode: 403, body: JSON.stringify({ error: 'This assistant is not permitted to use social connections.', code: 'CONNECTION_NOT_RELEVANT' }) };
    }

    const [org] = await db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, organisationId)).limit(1);
    const businessName = org?.name ?? 'your business';
    const ctx = assistant.onboardingContext as Record<string, unknown> ?? {};
    const toneOfVoice = (ctx.tone_of_voice as string) ?? 'friendly and professional';
    const targetAudience = (ctx.target_audience as string) ?? 'customers';
    const contentPillars = Array.isArray(ctx.content_pillars) ? (ctx.content_pillars as string[]).join(', ') : (ctx.content_pillars as string) ?? '';

    // US-SMM (AC7): the objection playbook + offerings let the assistant draft replies to sales
    // enquiries in DMs. These are staged for the user to review, not auto-sent.
    const serviceOfferings = (ctx.service_offerings as string) ?? '';
    const salesObjections  = (ctx.sales_objections  as string) ?? '';

    // Include blueprint sections in the prompt (AC: full context)
    const blueprintContext = [
        assistant.systemPrompt ? `## System Prompt\n${assistant.systemPrompt}` : '',
        contentPillars ? `## Content Pillars\n${contentPillars}` : '',
        serviceOfferings ? `## Service Offerings\n${serviceOfferings}` : '',
        salesObjections ? `## Sales Objection Playbook (objection — preferred response)\n${salesObjections}` : '',
        (ctx.strict_rules as string) ? `## Strict Rules\n${ctx.strict_rules}` : '',
        (ctx.brand_guidelines as string) ? `## Brand Guidelines\n${ctx.brand_guidelines}` : '',
    ].filter(Boolean).join('\n\n');

    const prompt = `You are a social media assistant for ${businessName}. Tone: ${toneOfVoice}. Target audience: ${targetAudience}.

${blueprintContext ? `## Assistant Blueprint Context\n${blueprintContext}\n\n` : ''}Generate auto-responder messages that reflect the brand voice above. Return ONLY valid JSON with these exact keys:
{
  "messengerGreeting": "string, max 160 chars — the welcome message shown when someone opens Messenger for the first time",
  "messengerAutoReply": "string, max 500 chars — the auto-reply sent when someone messages the Facebook Page",
  "instagramDmAutoReply": "string, max 500 chars — the auto-reply sent when someone DMs on Instagram (stored as a draft — Instagram DM automation must be enabled separately in Meta Business Suite)"${salesObjections ? `,
  "objectionResponses": "array of { \\"objection\\": string, \\"reply\\": string (max 500 chars) } — for EACH objection in the Sales Objection Playbook above, a ready-to-send DM/comment reply that handles it in the brand voice and points to the relevant service offering. These are staged for the user to review, not sent automatically."` : ''}
}

Rules:
- Use the business name naturally
- Keep a warm, ${toneOfVoice} tone consistent with the blueprint
- Do not make promises you cannot keep
- Do not include placeholders like [NAME] or [DATE]
- Ensure the Messenger greeting is ≤160 characters exactly${salesObjections ? `\n- Base objection replies on the playbook's preferred responses; never invent pricing or claims not present in the context` : ''}`;

    let draft: {
        messengerGreeting: string; messengerAutoReply: string; instagramDmAutoReply: string;
        objectionResponses?: { objection: string; reply: string }[];
    } | null = null;
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await anthropic.messages.create({
                model: MODEL,
                max_tokens: 512,
                messages: [{ role: 'user', content: prompt }],
            });
            const raw = (response.content[0] as { text: string }).text.trim();
            const jsonMatch = raw.match(/\{[\s\S]*\}/);
            const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
            if (parsed?.messengerGreeting && parsed?.messengerAutoReply && parsed?.instagramDmAutoReply) {
                draft = parsed;
                break;
            }
            console.warn(`[social-auto-responder] Attempt ${attempt}: invalid LLM response format`);
        } catch (err) {
            console.warn(`[social-auto-responder] Attempt ${attempt} error:`, err);
            if (attempt === MAX_RETRIES) {
                return { statusCode: 500, body: JSON.stringify({ error: 'Failed to generate auto-responder messages after retries' }) };
            }
            // Exponential backoff: 1s, 2s, 4s
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
        }
    }
    if (!draft) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to generate valid auto-responder messages' }) };
    }

    // Enforce char limits
    draft.messengerGreeting    = draft.messengerGreeting.slice(0, 160);
    draft.messengerAutoReply   = draft.messengerAutoReply.slice(0, 500);
    draft.instagramDmAutoReply = draft.instagramDmAutoReply.slice(0, 500);
    // AC7: staged objection replies — clamp to the same DM length budget; tolerate a malformed shape.
    if (Array.isArray(draft.objectionResponses)) {
        draft.objectionResponses = draft.objectionResponses
            .filter(r => r && typeof r.objection === 'string' && typeof r.reply === 'string')
            .map(r => ({ objection: r.objection.slice(0, 200), reply: r.reply.slice(0, 500) }));
    } else {
        delete draft.objectionResponses;
    }

    // Store draft in assistant configuration
    const existingConfig = (assistant.configuration as Record<string, unknown>) ?? {};
    await db.update(aiAssistants).set({
        configuration: { ...existingConfig, autoResponderDraft: draft, autoResponderDraftAt: new Date().toISOString() },
        updatedAt: new Date(),
    }).where(eq(aiAssistants.id, assistant.id));

    // AC2.1.2: Helper — POST to Meta Graph API with 5xx exponential backoff (immediate retries within
    // function budget; 2 min / 8 min / 30 min schedule stored in config for background pickup if still failing).
    async function metaPost(url: string, payload: object): Promise<{ ok: boolean; status: number }> {
        const immediateDelays = [0, 1000, 2000]; // 3 attempts within ~3s budget
        let lastStatus = 500;
        for (const delay of immediateDelays) {
            if (delay > 0) await new Promise(r => setTimeout(r, delay));
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                    signal: AbortSignal.timeout(5000),
                });
                lastStatus = res.status;
                if (res.status < 500) return { ok: res.ok, status: res.status };
            } catch { /* network error — retry */ }
        }
        return { ok: false, status: lastStatus };
    }

    // Push to Meta Graph API
    const [conn] = await db.select({ id: systemConnections.id, vaultRefKey: systemConnections.vaultRefKey, metadata: systemConnections.metadata })
        .from(systemConnections)
        .where(and(eq(systemConnections.organisationId, organisationId), eq(systemConnections.serviceName, 'instagram'), eq(systemConnections.isActive, true)))
        .limit(1);

    let metaPushStatus: 'ok' | 'skipped' | 'failed' | 'partial' = 'skipped';
    let metaPushError: string | undefined;

    if (conn?.vaultRefKey) {
        const secret = await getSecret(db, conn.vaultRefKey);
        const token = (secret as { token?: string } | null)?.token;
        const fbPageId = (conn.metadata as Record<string, unknown>)?.fbPageId as string | undefined;
        const igUserId  = (conn.metadata as Record<string, unknown>)?.igUserId  as string | undefined;

        if (token && fbPageId) {
            try {
                // Messenger greeting: POST /{page-id}/messenger_profile
                const greetingRes = await metaPost(
                    `https://graph.facebook.com/v19.0/${fbPageId}/messenger_profile`,
                    { greeting: [{ locale: 'default', text: draft.messengerGreeting }], access_token: token },
                );
                // Messenger auto-reply (away message)
                const awayRes = await metaPost(
                    `https://graph.facebook.com/v19.0/${fbPageId}/messaging`,
                    { messaging_type: 'page_response', message: { text: draft.messengerAutoReply }, access_token: token },
                );
                // AC2.1.2: Instagram DM auto-reply: POST /{ig-user-id}/messenger_profile
                let igPushOk = !igUserId; // skipped if no igUserId — counts as ok
                if (igUserId) {
                    const igRes = await metaPost(
                        `https://graph.facebook.com/v19.0/${igUserId}/messenger_profile`,
                        { greeting: [{ locale: 'default', text: draft.instagramDmAutoReply }], access_token: token },
                    );
                    igPushOk = igRes.ok;
                }
                const allOk = greetingRes.ok && awayRes.ok && igPushOk;
                const anyOk = greetingRes.ok || awayRes.ok || igPushOk;
                metaPushStatus = allOk ? 'ok' : anyOk ? 'partial' : 'failed';

                // If any call returned 5xx after all immediate retries, store long-schedule retry state.
                // A background function (social-auto-responder-retry) picks this up at 2 min / 8 min / 30 min.
                if (metaPushStatus === 'failed') {
                    const retryScheduleMs = [2 * 60 * 1000, 8 * 60 * 1000, 30 * 60 * 1000];
                    await db.update(aiAssistants).set({
                        configuration: {
                            ...existingConfig,
                            autoResponderDraft: draft,
                            autoResponderDraftAt: new Date().toISOString(),
                            autoResponderRetry: { attempt: 1, nextRetryAt: new Date(Date.now() + retryScheduleMs[0]).toISOString(), scheduleMs: retryScheduleMs, organisationId },
                        },
                        updatedAt: new Date(),
                    }).where(eq(aiAssistants.id, assistant.id));
                }
            } catch (err) {
                metaPushStatus = 'failed';
                metaPushError = String(err);
                console.warn('[social-auto-responder] Meta push failed:', err);
            }
        }
    }

    // AC2.1.2: Persist autoResponderStatus and configuredAt after push outcome
    const pushOutcomeConfig: Record<string, unknown> = {
        ...existingConfig,
        autoResponderDraft: draft,
        autoResponderDraftAt: new Date().toISOString(),
        autoResponderStatus: metaPushStatus === 'ok' || metaPushStatus === 'partial' ? 'configured' : metaPushStatus === 'skipped' ? 'draft' : 'failed',
        ...(metaPushStatus === 'ok' || metaPushStatus === 'partial' ? { configuredAt: new Date().toISOString() } : {}),
    };
    await db.update(aiAssistants).set({ configuration: pushOutcomeConfig, updatedAt: new Date() }).where(eq(aiAssistants.id, assistant.id));

    // AC2.1.3: Workspace chat panel message is rendered inline by the frontend (integrations.js)
    // using the draft and metaPushStatus returned in this response body — no server-side insert needed.

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, draft, metaPushStatus, ...(metaPushError ? { metaPushError } : {}) }),
    };
};
