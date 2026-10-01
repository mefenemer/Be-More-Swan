// src/utils/form-chat-draft.ts
// Normalise the `audience_form_draft` uiElement the Email Marketing Assistant's chat emits — a sign-up
// form it designed in conversation (Mode A of docs/form-builder-plan.md). The sibling of
// newsletter-campaign-chat-draft.ts, and for the same reasons: the card holds the only copy of what
// the person iterated on, and the model's output reaches it unvalidated.
//
// Through normaliseFormDefinition — the SAME gate the builder and the public endpoint use — plus two
// things only the chat path needs:
//   • THE CHAT CANNOT SEE THE ORG'S SEGMENTS OR CAMPAIGNS, so any id it wrote is a guess. Both are
//     cleared; the person links them in the form builder, where they can see the real lists.
//   • A LOGO IT NAMED is an asset id it cannot have seen — cleared for the same reason.

import { normaliseFormDefinition, type FormDefinition } from './form-definition';

export const AUDIENCE_FORM_DRAFT_TYPE = 'audience_form_draft';

export interface FormChatDraft {
    form: FormDefinition;
    warnings: string[];
}

export function formDraftFromUiElement(uiElement: unknown): FormChatDraft | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== AUDIENCE_FORM_DRAFT_TYPE) return null;
    // Accept the definition wrapped ({ form: {...} }, as the prompt asks) or flat.
    const raw = ui.form && typeof ui.form === 'object' ? ui.form : ui;
    const { definition, warnings } = normaliseFormDefinition(raw);
    if (!definition.fields.length) return null;
    definition.audience.segmentId = null;
    definition.campaign = { sequenceId: null, skipWelcome: false };
    definition.style.logo = null;
    return { form: definition, warnings };
}
