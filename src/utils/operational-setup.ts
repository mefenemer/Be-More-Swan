// src/utils/operational-setup.ts
// The onboarding wizard's Operational Setup answers (step 3), turned into generation directives.
//
// Two questions are captured at onboarding and stay editable in the Assistant Profile:
//   trigger_type    — 'on_demand' | 'reactive' | 'scheduled'
//   content_source  — 'client_provided' | 'assistant_generated' | 'hybrid'
//
// Both land in ai_assistants.onboarding_context and are lifted into blueprint section 6 under
// 'operational'. Section 6 is dumped into the system prompt verbatim, but a dump reads as
// background rather than instruction — which is why content_source, the answer that genuinely
// bounds what the model may claim, had no effect on output until these directives existed.

/** Anti-fabrication clause shared by all three content-source modes. */
const NO_FABRICATION =
    'Never invent concrete specifics — statistics, named customers, testimonials, events, prices or offers — '
    + 'that are not in the context you were given. Where a specific is missing, write around it rather than '
    + 'filling the gap with something plausible.';

const CONTENT_SOURCE_DIRECTIVE: Record<string, string> = {
    client_provided:
        'CONTENT SOURCE — the user supplies the raw material for these posts, and this post must be built '
        + `from the brief and context above. ${NO_FABRICATION}`,
    hybrid:
        'CONTENT SOURCE — the user provides the direction and you fill the gaps. Expand on the brief and '
        + `context above in your own words. ${NO_FABRICATION}`,
    assistant_generated:
        'CONTENT SOURCE — you develop these posts independently from the strategy above. '
        + NO_FABRICATION,
};

// The trigger tells the model only how the post came to be drafted, which matters for one thing:
// a scheduled post is one slot in an ongoing calendar and must not read like a reply to a request
// nobody made. On-demand and reactive drafts are genuine responses, so they need no such warning.
const SCHEDULED_DIRECTIVE =
    'This post was drafted automatically to fill a slot in the posting schedule — the user did not ask '
    + 'for it just now. Write it as a standalone post in an ongoing series, never as a response to a request.';

export interface OperationalSetupSource {
    trigger_type?: unknown;
    content_source?: unknown;
}

/**
 * Prompt lines for this assistant's Operational Setup, most-constraining first. Empty entries are
 * omitted, so an assistant that never answered (or answered with something unrecognised) yields an
 * empty array and the prompt is exactly what it was before — these answers are optional, and a
 * missing one must never block a draft.
 *
 * Pass the LIVE onboarding_context first so a profile edit applies without a blueprint recompile;
 * `fallback` is the recompiled copy from blueprint section 6.
 *
 * NOTE: content_source_detail ("a Notion board", "these feeds to monitor") is deliberately not
 * surfaced here. It names a location the generation worker cannot read, and telling the model about
 * a source it has no access to invites it to write as though it had consulted one. It stays in the
 * blueprint for the human reading it.
 */
export function operationalSetupLines(
    live: OperationalSetupSource | null | undefined,
    fallback: OperationalSetupSource | null | undefined = null,
): string[] {
    const pick = (key: keyof OperationalSetupSource): string | null => {
        const v = live?.[key] ?? fallback?.[key];
        return typeof v === 'string' && v ? v : null;
    };
    const contentSource = pick('content_source');
    const triggerType = pick('trigger_type');
    return [
        (contentSource && CONTENT_SOURCE_DIRECTIVE[contentSource]) || '',
        triggerType === 'scheduled' ? SCHEDULED_DIRECTIVE : '',
    ].filter(Boolean);
}
