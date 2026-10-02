// live-role-label.ts — the assistant's ROLE TITLE as the admin has it today.
//
// master_assistants.name is the source of truth (admin-editable in the portal's Master Data).
// ai_assistants.ai_assistant_job_role is only a snapshot taken at hire time: it goes stale on every
// admin rename, which is how the Social Media Assistant's chat kept introducing itself as the
// "Social Media Manager" long after the role was renamed. Every read that shows the role to a user
// or writes it into a prompt goes through this instead.
//
// A correlated subquery rather than a join, so it drops into any select FROM ai_assistants without
// changing the query's joins. Falls back to the snapshot for a legacy row with no master link.

import { sql } from 'drizzle-orm';
import { aiAssistants } from '../../db/schema';

export const liveRoleLabel = sql<string | null>`coalesce((select ma.name from master_assistants ma where ma.id = ${aiAssistants.masterAssistantId}), ${aiAssistants.aiAssistantJobRole})`;
