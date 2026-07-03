// netlify/functions/relationship-checklist.ts
// AC6 (SMM): Daily Relationship-Building Checklist.
//
// GET  ?assistantId=<id>          — today's checklist; generated lazily (LLM) if none exists.
// POST { taskId, completed }      — tick / untick a single item.
// POST { assistantId, regenerate } — discard today's list and generate a fresh one.
//
// Per-assistant, per-day actions persisted in relationship_building_tasks so completion
// survives reload. Gated to social-capable assistants (same sandbox as the bio generator).

import { Handler } from '@netlify/functions';
import Anthropic from '@anthropic-ai/sdk';
import { eq, and, asc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, organisations, systemConnections, relationshipBuildingTasks } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';
import { isServiceAllowedForAssistant } from '../../src/utils/connection-map';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-haiku-4-5-20251001';
const VALID_CATEGORIES = new Set(['engagement', 'outreach', 'community', 'follow_up']);

/** UTC calendar day as YYYY-MM-DD — the checklist's "today". */
function todayUtc(): string {
    return new Date().toISOString().slice(0, 10);
}

interface ChecklistRow {
    id: number; title: string; description: string | null; category: string | null;
    sortOrder: number; completed: boolean;
}

export const handler: Handler = async (event) => {
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId } = ctx;

    // ── POST: toggle completion, or regenerate today's list. ────────────────────
    if (event.httpMethod === 'POST') {
        let body: { taskId?: number; completed?: boolean; assistantId?: number; regenerate?: boolean };
        try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

        // Toggle a single item (tenant-scoped — the org_id predicate prevents cross-tenant writes).
        if (typeof body.taskId === 'number') {
            const completed = body.completed === true;
            const [updated] = await db.update(relationshipBuildingTasks)
                .set({ completed, completedAt: completed ? new Date() : null, completedBy: completed ? userId : null })
                .where(and(
                    eq(relationshipBuildingTasks.id, body.taskId),
                    eq(relationshipBuildingTasks.organisationId, organisationId),
                ))
                .returning({ id: relationshipBuildingTasks.id });
            if (!updated) return { statusCode: 404, body: JSON.stringify({ error: 'Checklist item not found' }) };
            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
        }

        // Regenerate today's checklist for an assistant.
        if (body.regenerate && typeof body.assistantId === 'number') {
            const gate = await loadAssistant(db, organisationId, body.assistantId);
            if ('error' in gate) return gate.error;
            await db.delete(relationshipBuildingTasks).where(and(
                eq(relationshipBuildingTasks.assistantId, body.assistantId),
                eq(relationshipBuildingTasks.organisationId, organisationId),
                eq(relationshipBuildingTasks.taskDate, todayUtc()),
            ));
            const items = await generateAndStore(db, gate.assistant, organisationId);
            return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, items, date: todayUtc() }) };
        }

        return { statusCode: 400, body: JSON.stringify({ error: 'taskId or { assistantId, regenerate } required' }) };
    }

    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    // ── GET: today's checklist (lazily generated if absent). ─────────────────────
    const assistantId = Number(event.queryStringParameters?.assistantId);
    if (!assistantId) return { statusCode: 400, body: JSON.stringify({ error: 'assistantId is required' }) };

    const gate = await loadAssistant(db, organisationId, assistantId);
    if ('error' in gate) return gate.error;

    let items = await fetchToday(db, organisationId, assistantId);
    if (items.length === 0) {
        items = await generateAndStore(db, gate.assistant, organisationId);
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, items, date: todayUtc() }),
    };
};

type LoadedAssistant = {
    id: number; name: string; systemPrompt: string | null;
    configuration: unknown; onboardingContext: unknown;
};

// Load the active assistant scoped to the tenant and enforce the social sandbox.
async function loadAssistant(
    db: ReturnType<typeof getDb>, organisationId: number, assistantId: number,
): Promise<{ assistant: LoadedAssistant } | { error: { statusCode: number; body: string } }> {
    const [assistant] = await db
        .select({
            id: aiAssistants.id, name: aiAssistants.name, systemPrompt: aiAssistants.systemPrompt,
            configuration: aiAssistants.configuration, onboardingContext: aiAssistants.onboardingContext,
        })
        .from(aiAssistants)
        .where(and(
            eq(aiAssistants.id, assistantId),
            eq(aiAssistants.organisationId, organisationId),
            eq(aiAssistants.isActive, true),
        ))
        .limit(1);

    if (!assistant) return { error: { statusCode: 404, body: JSON.stringify({ error: 'Assistant not found' }) } };

    const roleKey = (assistant.configuration as { type?: string } | null)?.type;
    // Relationship building checklist is reserved for a future assistant type; explicitly not
    // supported by the Social Media Manager.
    if (roleKey === 'social_media_manager') {
        return { error: { statusCode: 403, body: JSON.stringify({ error: 'Relationship building checklist is not available for this assistant type.', code: 'FEATURE_NOT_SUPPORTED' }) } };
    }
    const roleArg = { roleKey, role: assistant.name };
    if (!isServiceAllowedForAssistant('instagram', roleArg) && !isServiceAllowedForAssistant('linkedin', roleArg)) {
        return { error: { statusCode: 403, body: JSON.stringify({ error: 'This assistant does not manage social engagement.', code: 'CONNECTION_NOT_RELEVANT' }) } };
    }
    return { assistant };
}

async function fetchToday(
    db: ReturnType<typeof getDb>, organisationId: number, assistantId: number,
): Promise<ChecklistRow[]> {
    return db
        .select({
            id: relationshipBuildingTasks.id, title: relationshipBuildingTasks.title,
            description: relationshipBuildingTasks.description, category: relationshipBuildingTasks.category,
            sortOrder: relationshipBuildingTasks.sortOrder, completed: relationshipBuildingTasks.completed,
        })
        .from(relationshipBuildingTasks)
        .where(and(
            eq(relationshipBuildingTasks.assistantId, assistantId),
            eq(relationshipBuildingTasks.organisationId, organisationId),
            eq(relationshipBuildingTasks.taskDate, todayUtc()),
        ))
        .orderBy(asc(relationshipBuildingTasks.sortOrder), asc(relationshipBuildingTasks.id));
}

// Generate today's checklist via the LLM and persist it; returns the stored rows.
async function generateAndStore(
    db: ReturnType<typeof getDb>, assistant: LoadedAssistant, organisationId: number,
): Promise<ChecklistRow[]> {
    const onboarding = (assistant.onboardingContext as Record<string, unknown>) ?? {};
    const [org] = await db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, organisationId)).limit(1);
    const businessName = org?.name ?? 'the business';

    const toneOfVoice = (onboarding.tone_of_voice as string) ?? 'friendly and professional';
    const targetAudience = (onboarding.target_audience as string) ?? 'customers';
    const contentPillars = Array.isArray(onboarding.content_pillars)
        ? (onboarding.content_pillars as string[]).join(', ')
        : (onboarding.content_pillars as string) ?? '';

    // Which platforms are actually connected — tailor the actions to them.
    const conns = await db.select({ serviceName: systemConnections.serviceName })
        .from(systemConnections)
        .where(and(eq(systemConnections.organisationId, organisationId), eq(systemConnections.isActive, true)));
    const platforms = [...new Set(conns.map(c => c.serviceName))];
    const platformLine = platforms.length ? `Connected platforms: ${platforms.join(', ')}.` : 'No platforms connected yet — keep actions platform-agnostic.';

    const prompt = `You are a social media manager for ${businessName}. Tone: ${toneOfVoice}. Audience: ${targetAudience}.${contentPillars ? ` Content pillars: ${contentPillars}.` : ''}
${platformLine}

Create TODAY's relationship-building checklist: 5-6 concrete, finishable engagement actions that grow genuine relationships with the audience (NOT content creation — these are manual community actions the user does themselves). Each must be specific and measurable (include a number where it helps).

Return ONLY valid JSON: an array of objects with these exact keys:
[{ "title": "short imperative action, max 80 chars", "description": "one sentence on how/why, max 160 chars", "category": "engagement" | "outreach" | "community" | "follow_up" }]

Rules:
- Mix categories: engagement (reply/like), outreach (proactive new connections), community (groups/conversations), follow_up (nurture warm leads).
- Tailor to the connected platforms above.
- Realistic for one day. No content-writing tasks. No placeholders.`;

    let parsed: Array<{ title?: string; description?: string; category?: string }> | null = null;
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await anthropic.messages.create({
                model: MODEL, max_tokens: 700,
                messages: [{ role: 'user', content: prompt }],
            });
            const raw = (response.content[0] as { text: string }).text.trim();
            const jsonMatch = raw.match(/\[[\s\S]*\]/);
            const candidate = jsonMatch ? JSON.parse(jsonMatch[0]) : null;
            if (Array.isArray(candidate) && candidate.length) { parsed = candidate; break; }
            console.warn(`[relationship-checklist] Attempt ${attempt}: invalid LLM response`);
        } catch (err) {
            console.warn(`[relationship-checklist] Attempt ${attempt} error:`, err);
            if (attempt === MAX_RETRIES) break;
            await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
        }
    }

    if (!parsed) {
        // Fall back to a sensible static checklist so the user is never left empty-handed.
        parsed = FALLBACK_CHECKLIST;
    }

    const rows = parsed
        .filter(p => p && typeof p.title === 'string' && p.title.trim())
        .slice(0, 6)
        .map((p, i) => ({
            organisationId,
            assistantId: assistant.id,
            taskDate: todayUtc(),
            title: String(p.title).slice(0, 80),
            description: typeof p.description === 'string' ? p.description.slice(0, 160) : null,
            category: p.category && VALID_CATEGORIES.has(p.category) ? p.category : null,
            sortOrder: i,
        }));

    if (rows.length === 0) return [];

    // Idempotent insert — the unique (assistant, date, title) index absorbs any race/dupe.
    await db.insert(relationshipBuildingTasks).values(rows).onConflictDoNothing();

    return fetchToday(db, organisationId, assistant.id);
}

const FALLBACK_CHECKLIST = [
    { title: 'Reply to all comments from the last 24 hours', description: 'Acknowledge every comment to keep conversations alive and signal you are listening.', category: 'engagement' },
    { title: 'Respond to any unread DMs', description: 'Answer direct messages promptly — fast replies build trust and surface warm leads.', category: 'follow_up' },
    { title: 'Engage with 10 posts from your target audience', description: 'Leave thoughtful comments on posts in your niche to get on new people\'s radar.', category: 'outreach' },
    { title: 'Comment in 2 relevant groups or conversations', description: 'Add value in communities where your audience gathers — no pitching.', category: 'community' },
    { title: 'Follow up with 3 warm leads from this week', description: 'Send a personal, no-pressure message to people who recently engaged.', category: 'follow_up' },
];
