// src/utils/onboarding-guardrails.ts
// The onboarding "Guardrails & Rules" step collects the user's strict rules, but the client
// (onboarding-social-media.html) folds them into a single rawInputs.strictRules array *together
// with* KNOWLEDGE BASE context entries, tagging only the genuine rules with a '- NON-NEGOTIABLE: '
// prefix. This isolates those rules — stripped of the prefix — so onboarding.ts can persist them as
// content_rules, the store both the generation blueprint (src/utils/blueprint.ts, section 4) and the
// setup-wizard readiness check (get-assistant-readiness.ts → hasRule) actually read. Without this,
// the rules only reached the compiled system prompt, which post generation never consults.
//
// Kept pure + dependency-free so it can be unit-tested without importing the onboarding function,
// which opens a Postgres connection at module load.

/** How the client tags a user's own guardrail, as opposed to a KNOWLEDGE BASE entry, in the same
 *  strictRules array. Must stay in step with onboarding-social-media.html's `- NON-NEGOTIABLE: ` prefix. */
export const NON_NEGOTIABLE_PREFIX = /^-\s*NON-NEGOTIABLE:\s*/i;

/**
 * Pull the user's guardrails out of the raw onboarding strictRules array: the NON-NEGOTIABLE-tagged
 * entries only, with the tag stripped and blanks dropped. KNOWLEDGE BASE (TEXT/LINKS) entries are
 * context, not rules, and are deliberately excluded. Returns [] for any non-array input.
 */
export function extractOnboardingGuardrails(strictRules: unknown): string[] {
    if (!Array.isArray(strictRules)) return [];
    return strictRules
        .filter((r): r is string => typeof r === 'string' && NON_NEGOTIABLE_PREFIX.test(r))
        .map((r) => r.replace(NON_NEGOTIABLE_PREFIX, '').trim())
        .filter((r) => r.length > 0);
}
