// src/utils/held-work.ts
// What happens when a free plan's workspace starts paying again: shared by the beta ending
// (beta-ending.ts) and the free trial (trial.ts), which both pause on the end date and hold
// anything scheduled — never delete it.

import { and, eq, lte } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, blogPosts, newsletterIssues, scheduledPosts } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

/**
 * Switch back on the assistants the free plan's end paused — only those stamped `pauseStamp`, never
 * one the user paused themselves — and send anything that fell due while paused to Review, so weeks
 * of held posts do not all go out in one tick.
 */
export async function releaseHeldWork(db: Db, organisationId: number, pauseStamp: string, now = new Date()): Promise<void> {
    await db.update(aiAssistants).set({ isActive: true, provisioningStatus: 'complete', updatedAt: now })
        .where(and(eq(aiAssistants.organisationId, organisationId), eq(aiAssistants.provisioningStatus, pauseStamp)));
    await db.update(scheduledPosts).set({ status: 'pending_approval', updatedAt: now })
        .where(and(eq(scheduledPosts.organisationId, organisationId), eq(scheduledPosts.status, 'scheduled'), lte(scheduledPosts.publishDate, now)));
    await db.update(blogPosts).set({ status: 'draft', updatedAt: now })
        .where(and(eq(blogPosts.organisationId, organisationId), eq(blogPosts.status, 'scheduled'), lte(blogPosts.publishDate, now)));
    await db.update(newsletterIssues).set({ status: 'approved', scheduledFor: null, updatedAt: now })
        .where(and(eq(newsletterIssues.organisationId, organisationId), eq(newsletterIssues.status, 'scheduled'), lte(newsletterIssues.scheduledFor, now)));
}
