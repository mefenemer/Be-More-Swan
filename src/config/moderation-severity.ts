// src/config/moderation-severity.ts
// Which OpenAI moderation categories count as SEVERE — in one place, for both gates.
//
// ── Why this file exists ───────────────────────────────────────────────────────────────────────
// There were two hand-written lists: one in src/utils/moderation.ts (the product-wide prompt gate,
// which hard-blocks) and one in src/utils/swan-index/safety.ts (the editorial screen, which
// advises). They had drifted, and nobody could have noticed by reading either file: `violence` was
// severe to the product gate and not to the editorial screen, so the same sentence blocked a
// customer's prompt and showed an amber "worth a look" to an editor. Exactly the failure the
// SOCIAL_PLATFORMS comment in src/config/platform-formats.ts describes — two copies of one list,
// updated once.
//
// Dependency-free on purpose, same reasoning as src/utils/blog-ai-assisted.ts: the editorial screen
// must not pull the database client into its module graph just to learn which words are serious.

/**
 * The product-wide bar. A prompt flagged for any of these is REFUSED — see moderation.ts, where
 * the consequence is a hard block and a security_audits row.
 *
 * Softer flags (plain `harassment`, plain `sexual`) are left to the in-prompt Refusal & Pivot
 * Protocol rather than a hard block: blocking a customer mid-sentence is expensive, and the model
 * already declines in the cases that matter.
 */
export const SEVERE_CATEGORIES: readonly string[] = [
    'violence', 'violence/graphic',
    'self-harm', 'self-harm/intent', 'self-harm/instructions',
    'sexual/minors',
    'hate/threatening',
    'harassment/threatening',
    'illicit', 'illicit/violent',
];

/**
 * What the PUBLICATION additionally refuses, on top of the product bar.
 *
 * A masthead is a stricter surface than a chat prompt. Refusing to draft something affects one
 * person's afternoon; running it on theswanindex.com puts it beside other people's bylines on a
 * domain we own and ask search engines to index. `sexual` and `hate` are not severe enough to
 * block a prompt, and are absolutely enough to stop an editorial all-clear.
 *
 * ⚠️ ADDITIONS only. The publication set is a strict superset of the product set — a category the
 * product blocks can never be less serious here, and a test enforces that.
 */
export const PUBLICATION_EXTRA_SEVERE: readonly string[] = ['sexual', 'hate'];

/** Everything the editorial screen treats as a hard fail. */
export const PUBLICATION_SEVERE_CATEGORIES: readonly string[] = [
    ...SEVERE_CATEGORIES,
    ...PUBLICATION_EXTRA_SEVERE,
];
