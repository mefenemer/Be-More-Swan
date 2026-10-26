// src/utils/mentor-draft-request.ts
// The Mentor asks an ACTIVE Social Media assistant for one post (docs/business-mentor-plan.md §2.2, §5.3):
// the `mentor_draft_request` card. The Mentor never drafts or orders work itself — the card's click calls
// the SAME endpoint as "Create a Post" on that assistant's Posts tab (generate-post.ts, on demand) with the
// brief as its context. generate-post.ts then links the job to the accepted suggestion
// (mentor-outcomes.ts linkOutcomeJob), and the post carries "Requested by <Mentor>" (requested-by.ts).
//
// The model names { assistantId, brief, why }; the server rebuilds the card from the row: a target that
// isn't an active Social Media assistant in this workspace is refused.

import { and, eq } from 'drizzle-orm';
import { aiAssistants, masterAssistants } from '../../db/schema';
import { teamState } from './mentor-snapshot';

type Db = any;

export const DRAFT_REQUEST_TYPE = 'mentor_draft_request';
/** The roles a draft request may go to: the ones "Create a Post" (generate-post.ts) drafts for. */
export const DRAFT_REQUEST_ROLES = ['social_media_manager'] as const;
/** generate-post.ts refuses a longer context prompt. */
export const BRIEF_MAX = 500;

export interface DraftRequestCard {
    type: typeof DRAFT_REQUEST_TYPE;
    summary: string;
    why: string;
    asked: boolean;
    assistantId: number;
    assistantName: string;
    brief: string;
}

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Build the card from the database, or say why not. */
export async function resolveDraftRequest(db: Db, orgId: number, ui: unknown): Promise<DraftRequestCard | { error: string } | null> {
    if (!ui || typeof ui !== 'object' || (ui as { type?: unknown }).type !== DRAFT_REQUEST_TYPE) return null;
    const u = ui as Record<string, unknown>;
    const id = Number(u.assistantId);
    const brief = text(u.brief, BRIEF_MAX);
    const why = text(u.why, 400);
    if (!Number.isInteger(id) || id <= 0) return { error: 'It didn’t say which assistant should write it.' };
    if (brief.length < 15) return { error: 'The brief was too short for an assistant to write from.' };
    if (!why) return { error: 'A suggestion needs to say why.' };
    const [row] = await db.select({
        id: aiAssistants.id, name: aiAssistants.name, roleKey: masterAssistants.roleKey,
        life: aiAssistants.lifecycleStatus, prov: aiAssistants.provisioningStatus,
    }).from(aiAssistants).leftJoin(masterAssistants, eq(aiAssistants.masterAssistantId, masterAssistants.id))
        .where(and(eq(aiAssistants.id, id), eq(aiAssistants.organisationId, orgId))).limit(1);
    if (!row) return { error: 'That assistant isn’t in this workspace.' };
    if (!(DRAFT_REQUEST_ROLES as readonly string[]).includes(row.roleKey ?? '')) return { error: 'Only a Social Media assistant can be asked for a post this way.' };
    if (teamState(row.life, row.prov) !== 'active') return { error: `${row.name || 'That assistant'} isn’t active, so it can’t be asked for a post.` };
    return {
        type: DRAFT_REQUEST_TYPE, summary: text(u.summary, 300) || `Ask ${row.name} for a post`, why, asked: u.asked === true,
        assistantId: row.id, assistantName: row.name || 'Your Social Media assistant', brief,
    };
}

export function draftRequestPromptLine(): string {
    return `Ask an ACTIVE Social Media assistant (listed under YOUR TEAM) for one post, when a post would clearly help — for example to back a goal that's behind or answer a theme from their reviews. The brief is what the post should say, from facts above only (under ${BRIEF_MAX} characters). Their click asks that assistant exactly as "Create a Post" does; the draft lands in its "Posts" tab for review, marked "Requested by" you:
{"type":"${DRAFT_REQUEST_TYPE}","summary":"<one sentence>","why":"<the figures it's based on>","asked":false,"assistantId":<its assistantId>,"brief":"<what the post should say>"}`;
}
