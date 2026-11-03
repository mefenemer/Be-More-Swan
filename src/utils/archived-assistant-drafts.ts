// src/utils/archived-assistant-drafts.ts
//
// Work an ARCHIVED assistant left waiting is not waiting on anyone.
//
// Archiving (manage-assistant.ts) stops the assistant and opens a 14-day reinstate window before
// purge-archived-assistants.ts deletes it — but it leaves the assistant's unapproved drafts where they
// are. The Review Queue and the Content Calendar kept listing them, so a workspace saw "Misty" in the
// calendar legend and five of Misty's drafts "needing your review" for an assistant that no longer
// appeared on My Assistants, and the Review pill counted them while the Dashboard did not (SWAN-4,
// SWAN-10, 2026-11-01). Nothing is deleted: reinstating the assistant brings its drafts back.
//
// The same holds for its actions held for approval (pending_actions) and, for a Website Assistant, the
// enquiries and booking requests its site took: their only home is that assistant's Website tab, which
// is hidden once it is archived. The Mentor's morning summary still read "1 website enquiry to answer
// (Website ▸ Enquiries)" for an archived Website Assistant (2026-11-03).
//
// Applied ONLY to "waiting for you" reads. Posts an archived assistant already scheduled or published,
// sales its site took and confirmed bookings are real history and stay where they are.

import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { pendingActions, scheduledPosts } from '../../db/schema';

/** Predicate: the assistant id column is empty, or that assistant is not archived. */
export function notArchivedAssistant(assistantIdCol: AnyPgColumn): SQL {
    return sql`(${assistantIdCol} IS NULL OR NOT EXISTS (
        SELECT 1 FROM ai_assistants archived_aa
        WHERE archived_aa.id = ${assistantIdCol} AND archived_aa.lifecycle_status = 'archived'))`;
}

/** A scheduled_posts predicate: the row has no assistant, or its assistant is not archived. */
export function notFromArchivedAssistant() {
    return notArchivedAssistant(scheduledPosts.assistantId);
}

/** A pending_actions predicate: the action has no assistant, or its assistant is not archived. */
export function actionNotFromArchivedAssistant() {
    return notArchivedAssistant(pendingActions.assistantId);
}

/** Predicate on a site id column (site_enquiries, bookings, …): no site, or its Website Assistant is not archived. */
export function notFromArchivedSite(siteIdCol: AnyPgColumn): SQL {
    return sql`(${siteIdCol} IS NULL OR NOT EXISTS (
        SELECT 1 FROM sites archived_s JOIN ai_assistants archived_sa ON archived_sa.id = archived_s.ai_assistant_id
        WHERE archived_s.id = ${siteIdCol} AND archived_sa.lifecycle_status = 'archived'))`;
}
