// src/utils/special-category-clause.ts — which special-category rule goes on a master assistant's prompt.
//
// US-GDPR-1.2.1 SC3: admin-api.ts appends a refusal clause (get-dpa-content.ts SPECIAL_CATEGORY_CLAUSE)
// to every master assistant prompt, so it is there whatever the admin writes above it.
//
// The Email Assistant gets its OWN clause instead (docs/email-assistant-phase0.md §3.2, owner
// 2026-11-12). The general one tells the assistant to answer "I cannot process sensitive personal
// information. Please remove it and resend" — but the Email Assistant's "message" is a stranger's
// email the user didn't write and can't resend, so ordinary mail ("I use a wheelchair — is the cottage
// step-free?") would be refused. tests/email-assistant.test.ts holds this.

import { EMAIL_SPECIAL_CATEGORY_CLAUSE } from './email-sort';

export const SPECIAL_CATEGORY_MARKER = '<!-- special-category-clause -->';

/** The clause for a role. Pure. */
export function specialCategoryClauseFor(roleKey: string | null | undefined, generalClause: string): string {
    return roleKey === 'email_assistant' ? EMAIL_SPECIAL_CATEGORY_CLAUSE : generalClause;
}

/**
 * The prompt with the right clause once, after the marker. A prompt that already carries the marker
 * keeps what follows it — unless it is the Email Assistant's and still holds the GENERAL clause (saved
 * before its own existed), which is swapped. Pure.
 */
export function withSpecialCategoryClause(prompt: string | null, roleKey: string | null | undefined, generalClause: string): string {
    const clause = specialCategoryClauseFor(roleKey, generalClause);
    if (!prompt) return `${SPECIAL_CATEGORY_MARKER}\n${clause}`;
    if (prompt.includes(SPECIAL_CATEGORY_MARKER)) {
        if (roleKey === 'email_assistant' && prompt.includes(generalClause)) return prompt.replace(generalClause, clause);
        return prompt;
    }
    return `${prompt}\n\n${SPECIAL_CATEGORY_MARKER}\n${clause}`;
}
