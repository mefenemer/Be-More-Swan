// src/utils/brief-from-chat.ts — the Brand Designer's questions go straight to the design (owner 2026-11-05: answering
// them and then being asked again to save a brief was "wrong"). A proposal marked "go" is saved and started here, and
// the user lands in the studio.
//
// This is the one place a chat turn can spend, and the owner chose it knowingly. So the spend is tied to the user's
// own answer, not to anything the model wrote: an AI picture is only kept when the user's own recent message picked
// AI_PICTURE_ANSWER, whose words state the cost. Anything else starts on free sources, and startRound still makes its
// own checks on the plan and the balance. tests/design-studio.test.ts.

import { visualBriefs } from '../../db/schema';
import type { getDb } from '../../db/client';
import { FLYER_PURPOSE, normaliseBrief } from '../config/visual-brief-vocab';
import { normaliseFlyerContent } from '../config/flyer-vocab';
import { contactDefaults, offerLine } from './flyer-words';
import { loadIntroOffer } from './intro-offer';
import { endRound, startRound } from './visual-briefs';
import { triggerBriefRound } from './trigger-brief-round';
import { enforcePromptModeration } from './moderation';

type Db = ReturnType<typeof getDb>;

export const AI_PICTURE_ANSWER = 'An AI-made picture (1 task)';
export const DESIGN_STARTED_TYPE = 'design_started';

export interface DesignStartedCard { type: typeof DESIGN_STARTED_TYPE; briefId: number; title: string; note: string | null }

/**
 * Whether this user's own answers picked the AI picture. Only their words count, never the model's, and only their
 * latest set of answers: an AI picture chosen for an earlier design never pays for a later one they made free.
 */
export function userChoseAiPicture(history: Array<{ role: string; content: string | null }>, latest: string): boolean {
    const mine = [...history.filter((m) => m.role === 'user').slice(-5).map((m) => m.content ?? ''), latest];
    if (latest.includes(AI_PICTURE_ANSWER)) return true;
    const answers = mine.filter((t) => t.startsWith('My answers:'));
    const last = answers[answers.length - 1];
    return !!last && last.includes(AI_PICTURE_ANSWER) && !mine.slice(mine.lastIndexOf(last) + 1).some((t) => t.startsWith('Skip the questions'));
}

/** The sources a started design may use. Stripped of anything that costs unless the user's answer chose it. */
export function startableSources(raw: unknown, aiChosen: boolean): unknown {
    if (!Array.isArray(raw)) return raw;
    const free = raw.filter((s) => s !== 'ai_image' && s !== 'ai_video');
    return aiChosen ? raw.filter((s) => s !== 'ai_video') : free;
}

/**
 * Save and start. Null means it could not start for a plain reason (a bad proposal), and the caller keeps the card it
 * has. Once the brief is saved a card is always returned, with a note if its round did not start.
 */
export async function startDesignFromChat(db: Db, args: {
    orgId: number; userId: number; assistantId: number; proposal: Record<string, unknown>; aiChosen: boolean;
}): Promise<DesignStartedCard | null> {
    const n = normaliseBrief({ ...args.proposal, sources: startableSources(args.proposal.sources, args.aiChosen) });
    if (!n.ok) return null;
    // A flyer is always drawn from words, so one sent with none (they answered "No words") gets its title as the
    // headline rather than a round that refuses to start. Changeable in the editor, and costs nothing.
    if (n.brief.purpose === FLYER_PURPOSE && !n.brief.flyerContent) {
        const w = normaliseFlyerContent({ headline: n.brief.title });
        if (w.ok) n.brief.flyerContent = w.content;
    }
    // Contact details, the QR link and the offer only ever come from what the business recorded.
    if (n.brief.flyerContent && !Object.values(n.brief.flyerContent.contact).some(Boolean) && !n.brief.flyerContent.qr) {
        const intro = await loadIntroOffer(db, args.orgId).catch(() => null);
        const d = await contactDefaults(db, args.orgId, intro);
        n.brief.flyerContent = { ...n.brief.flyerContent, contact: d.contact, qr: d.qr, offer: n.brief.flyerContent.offer ?? offerLine(intro) };
    }
    const [brief] = await db.insert(visualBriefs).values({
        organisationId: args.orgId, aiAssistantId: args.assistantId, createdBy: args.userId, ...n.brief, origin: 'chat',
    }).returning();
    const card = (note: string | null): DesignStartedCard => ({ type: DESIGN_STARTED_TYPE, briefId: brief.id, title: brief.title, note });
    // The same check as the button on a brief.
    const f = n.brief.flyerContent;
    const blocked = await enforcePromptModeration({ text: [brief.title, brief.message, brief.mood, f?.headline, f?.subheading].filter(Boolean).join('\n'), userId: args.userId, organisationId: args.orgId, source: 'brand-briefs' });
    if (blocked) return card('It was not started, because the wording could not be used. Please change it on the brief.');
    const started = await startRound(db, { orgId: args.orgId, brief });
    if (!started.ok) return card(started.error);
    if (!(await triggerBriefRound(brief.id, args.userId))) {
        await endRound(db, brief.id, { chargeAi: false, note: 'Could not start making options. Nothing was charged — try again.' });
        return card('It could not start just now, and nothing was charged. Please try again on the brief.');
    }
    return card(null);
}
