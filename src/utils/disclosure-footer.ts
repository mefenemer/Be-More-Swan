// src/utils/disclosure-footer.ts
// Single source of truth for the AI disclosure footer that goes on social posts (EU AI Act Art. 50).
//
// The footer used to be added by instructing the LLM to "append this verbatim" — unreliable for a
// legal string (the model could reword or drop it) and impossible to strip cleanly for a per-post
// opt-out. It is now DETERMINISTIC: generation appends the resolved footer to the caption itself, so
// the exact text is known and can be added/removed on a per-post basis.
//
// `{assistant}` in either the default template or a workspace override is filled with the generating
// assistant's name at resolve time, e.g.
//   "Composed with Ava, our Be More Swan Digital Assistant. What's yours called 😉?"

import { DISCLOSURE } from '../config/compliance';

export const ASSISTANT_TOKEN = '{assistant}';

/** Substitute the {assistant} token; falls back to a neutral phrase when the name is unknown. */
export function fillAssistantToken(text: string, assistantName?: string | null): string {
    return text.split(ASSISTANT_TOKEN).join((assistantName && assistantName.trim()) || 'your assistant');
}

/** The default social footer with the assistant's name filled in. */
export function resolveWorkspaceFooterDefault(assistantName?: string | null): string {
    return fillAssistantToken(DISCLOSURE.workspaceFooterDefaultTemplate, assistantName);
}

export interface FooterInputs {
    orgEnabled: boolean;
    /** Workspace override text (organisations.ai_disclosure_footer_text); null/empty → use default. */
    orgText?: string | null;
    /** Per-assistant disclosure (ai_assistants.disclosure_text) — used only when the org footer is off. */
    perAssistantText?: string | null;
    assistantName?: string | null;
}

/**
 * Resolve the footer string for a post, or null when none applies. Preserves the long-standing
 * precedence: the workspace (org) footer wins when enabled; otherwise the per-assistant disclosure.
 */
export function resolveDisclosureFooter({ orgEnabled, orgText, perAssistantText, assistantName }: FooterInputs): string | null {
    if (orgEnabled) {
        const base = orgText && orgText.trim() ? orgText : DISCLOSURE.workspaceFooterDefaultTemplate;
        return fillAssistantToken(base, assistantName);
    }
    return perAssistantText && perAssistantText.trim() ? fillAssistantToken(perAssistantText, assistantName) : null;
}

/** Append the footer to a caption, separated by a blank line. No-op if empty or already present. */
export function appendFooter(caption: string | null | undefined, footer: string | null): string {
    const c = (caption ?? '').replace(/\s+$/, '');
    if (!footer) return c;
    if (c.includes(footer)) return c;           // idempotent — never double-append
    return c ? `${c}\n\n${footer}` : footer;
}

/** Remove the footer (and any orphaned blank lines it leaves) from a caption. */
export function stripFooter(caption: string | null | undefined, footer: string | null): string {
    let out = caption ?? '';
    if (footer) {
        const idx = out.lastIndexOf(footer);
        if (idx >= 0) out = out.slice(0, idx) + out.slice(idx + footer.length);
    }
    return out.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
}
