// src/utils/archived-assistant-drafts.ts
//
// Drafts an ARCHIVED assistant left waiting for review are not waiting on anyone.
//
// Archiving (manage-assistant.ts) stops the assistant and opens a 14-day reinstate window before
// purge-archived-assistants.ts deletes it — but it leaves the assistant's unapproved drafts where they
// are. The Review Queue and the Content Calendar kept listing them, so a workspace saw "Misty" in the
// calendar legend and five of Misty's drafts "needing your review" for an assistant that no longer
// appeared on My Assistants, and the Review pill counted them while the Dashboard did not (SWAN-4,
// SWAN-10, 2026-11-01). Nothing is deleted: reinstating the assistant brings its drafts back.
//
// Applied ONLY to the awaiting-review reads. Posts an archived assistant already scheduled or
// published are real history and stay where they are.

import { sql } from 'drizzle-orm';
import { scheduledPosts } from '../../db/schema';

/** A scheduled_posts predicate: the row has no assistant, or its assistant is not archived. */
export function notFromArchivedAssistant() {
    return sql`(${scheduledPosts.assistantId} IS NULL OR NOT EXISTS (
        SELECT 1 FROM ai_assistants archived_aa
        WHERE archived_aa.id = ${scheduledPosts.assistantId} AND archived_aa.lifecycle_status = 'archived'))`;
}
