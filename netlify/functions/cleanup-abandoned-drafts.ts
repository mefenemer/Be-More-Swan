// netlify/functions/cleanup-abandoned-drafts.ts
// Epic: Platform Data Management & Hygiene — Automated Abandoned Draft Cleanup.
// Scheduled daily at 00:00 UTC (see netlify.toml). Two jobs in one pass:
//
//   US2 (AC2.1–2.3): re-engagement nudge — drafts inactive 23+ days (but not yet
//        past the 30-day deletion line, and not already nudged) get one email with
//        a deep link back to their Setup Checklist.
//   US1 (AC1.1–1.4): expiry — drafts inactive 30+ days are deleted, logged to audit_logs.
//
// Drafts ARE the partial configuration (everything lives in onboarding_drafts.draft_data),
// so a single-row delete satisfies the "cascading deletion" requirement (AC1.3) — there are
// no orphaned child rows, because a draft has not yet created an ai_assistants row.

import { Handler } from '@netlify/functions';
import { and, eq, gte, isNull, lt } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { auditLogs, onboardingDrafts, users } from '../../db/schema';
import { sendEmail } from '../../src/utils/email';

const BASE_URL = process.env.BASE_URL || 'https://bemoreswan.com';
const NUDGE_DAYS = 23;
const DELETE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const handler: Handler = async () => {
    const db = getDb();
    const now = Date.now();
    const nudgeCutoff = new Date(now - NUDGE_DAYS * DAY_MS);   // updatedAt older than this → due a nudge
    const deleteCutoff = new Date(now - DELETE_DAYS * DAY_MS); // updatedAt older than this → delete

    let nudged = 0;

    try {
        // ── US2: 23-day re-engagement nudge ──────────────────────────────
        // Inactive 23–30 days, not yet reminded.
        const toNudge = await db.select({
            id: onboardingDrafts.id,
            userId: onboardingDrafts.userId,
            roleKey: onboardingDrafts.roleKey,
            displayName: onboardingDrafts.displayName,
        }).from(onboardingDrafts)
            .where(and(
                lt(onboardingDrafts.updatedAt, nudgeCutoff),
                gte(onboardingDrafts.updatedAt, deleteCutoff),
                isNull(onboardingDrafts.reminderSentAt),
            ));

        for (const draft of toNudge) {
            const [user] = await db.select({ email: users.email, firstName: users.firstName })
                .from(users).where(eq(users.id, draft.userId)).limit(1);
            if (!user?.email) continue;

            // AC2.3: deep link straight to this draft's Setup Checklist.
            const resumeUrl = `${BASE_URL}/workspace.html?view=assistant-setup&draftId=${draft.id}`;
            const label = draft.displayName || 'Digital Assistant';

            await sendEmail({
                to: user.email,
                // AC2.2: action-required subject. (Brand kept as Be More Swan to match every other
                // transactional email; the ticket's "Be More Swan" reads as a placeholder brand.)
                subject: `Action required: Finish setting up your Be More Swan Assistant`,
                html: `
                    <p>Hi ${user.firstName || 'there'},</p>
                    <p>You started setting up <strong>${label}</strong> but haven't finished yet. Your
                       progress is saved — but incomplete setups are automatically cleared after 30 days
                       of inactivity, so there's <strong>about a week left</strong> to pick up where you left off.</p>
                    <p style="margin-top:24px;">
                      <a href="${resumeUrl}" style="background:#059669;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
                        Finish setting up your assistant →
                      </a>
                    </p>
                    <p style="margin-top:16px;font-size:0.875rem;color:#6b7280;">
                      If you no longer want this assistant, you can safely ignore this email and the draft will be removed automatically.
                    </p>
                    <p>The Be More Swan Team</p>`,
            }).catch((e) => console.warn('[cleanup-abandoned-drafts] nudge email failed (non-blocking):', e));

            await db.update(onboardingDrafts)
                .set({ reminderSentAt: new Date() })
                .where(eq(onboardingDrafts.id, draft.id));
            nudged++;
        }

        // ── US1: delete drafts inactive 30+ days ─────────────────────────
        const deleted = await db.delete(onboardingDrafts)
            .where(lt(onboardingDrafts.updatedAt, deleteCutoff))
            .returning({ id: onboardingDrafts.id });

        // ── AC1.4: audit-log the run (system event — userId null) ────────
        if (deleted.length > 0 || nudged > 0) {
            await db.insert(auditLogs).values({
                userId: null,
                actionType: 'DELETE',
                resourceType: 'onboarding_drafts',
                resourceId: 'batch',
                newState: {
                    message: `Deleted ${deleted.length} abandoned draft${deleted.length === 1 ? '' : 's'}`,
                    deletedCount: deleted.length,
                    nudgedCount: nudged,
                    deletedIds: deleted.map(d => d.id),
                },
            }).catch((e) => console.warn('[cleanup-abandoned-drafts] audit insert failed (non-blocking):', e));
        }

        console.log(`[cleanup-abandoned-drafts] nudged=${nudged} deleted=${deleted.length}`);
        return { statusCode: 200, body: JSON.stringify({ nudged, deleted: deleted.length }) };
    } catch (e) {
        console.error('[cleanup-abandoned-drafts] error:', e);
        return { statusCode: 500, body: JSON.stringify({ error: 'Cleanup failed' }) };
    }
};
