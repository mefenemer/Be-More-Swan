// src/utils/post-disclosure.ts
// Resolving a POST's disclosure footer from the database, in one place.
//
// disclosure-footer.ts owns the rules and stays pure (it is imported by caption assembly). This is
// the thin db-aware layer on top: which org, which assistant, therefore which string. It exists
// because two callers need the identical answer — the per-post opt-out toggle, and the caption
// write path that has to put the footer back after an edit replaced the caption wholesale — and a
// second copy of "org setting wins when enabled, else the per-assistant disclosure" is exactly the
// kind of duplication that drifts into a post going out with no disclosure on it.

import { eq } from 'drizzle-orm';
import { organisations, aiAssistants } from '../../db/schema';
import { resolveDisclosureFooter, appendFooter } from './disclosure-footer';

/**
 * The footer string this post should carry, or null when none applies.
 *
 * Resolved exactly as generation resolved it: the workspace (org) footer wins when enabled,
 * otherwise the assistant's own disclosure, with `{assistant}` filled from the post's assistant.
 */
export async function resolvePostFooter(
    db: any,
    organisationId: number,
    assistantId: number | null | undefined,
): Promise<string | null> {
    const [org] = await db
        .select({ enabled: organisations.aiDisclosureFooterEnabled, text: organisations.aiDisclosureFooterText })
        .from(organisations).where(eq(organisations.id, organisationId)).limit(1);

    let assistantName: string | null = null;
    let perAssistantText: string | null = null;
    if (assistantId) {
        const [asst] = await db
            .select({ name: aiAssistants.name, disclosureText: aiAssistants.disclosureText })
            .from(aiAssistants).where(eq(aiAssistants.id, assistantId)).limit(1);
        assistantName = asst?.name ?? null;
        perAssistantText = asst?.disclosureText ?? null;
    }

    return resolveDisclosureFooter({
        orgEnabled: org?.enabled ?? false,
        orgText: org?.text ?? null,
        perAssistantText,
        assistantName,
    });
}

/**
 * Keep the disclosure on a caption that has just been REPLACED.
 *
 * The footer is stored inside the caption (deterministically appended at generation), so anything
 * that overwrites the caption wholesale takes the disclosure with it — while
 * `disclosure_footer_disabled` still reads false, so the editor's checkbox goes on claiming the
 * post carries one. That is the state this exists to prevent: ticked box, no disclosure.
 *
 * The reported route was chat — "talk it through", accept the suggested caption, and the assistant's
 * text replaces the caption footer and all — but it is not special. Ask-the-assistant rewrites,
 * applied quality suggestions and a person deleting the line by hand all do the same thing, which is
 * why this belongs on the write rather than on any one caller.
 *
 * Honours the opt-out: an explicitly disabled post is left exactly as the caller wrote it. Idempotent
 * via appendFooter, so a caption that still ends with its footer is returned untouched.
 */
export async function keepDisclosureOnCaption(
    db: any,
    caption: string | null | undefined,
    post: { organisationId: number | null; assistantId: number | null; disclosureFooterDisabled: boolean | null },
): Promise<string | null | undefined> {
    if (caption === undefined || caption === null) return caption;
    if (post.disclosureFooterDisabled) return caption;
    if (!post.organisationId) return caption;
    try {
        const footer = await resolvePostFooter(db, post.organisationId, post.assistantId);
        return appendFooter(caption, footer);
    } catch {
        // Best effort: a lookup failure must not block the user's edit. The footer is re-asserted on
        // the next save, and publish-time assembly appends it too.
        return caption;
    }
}
