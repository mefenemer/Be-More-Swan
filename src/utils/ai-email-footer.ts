// src/utils/ai-email-footer.ts
// US-GOV-3.1.2: Mandatory AI disclosure footer for all outbound emails drafted by an assistant.
// Injected at the infrastructure level — cannot be removed by system prompt or integration config.

import { DISCLOSURE } from '../config/compliance';

export const FOOTER_VERSION = '1.0';

// Default disclosure copy is owned by the compliance config (AC4.1 modular compliance layer).
const DEFAULT_FOOTER_TEXT = DISCLOSURE.emailFooterDefault;

/**
 * Returns the disclosure footer text for an assistant.
 * Uses the integration's custom disclosure text if provided and valid;
 * otherwise falls back to the default.
 */
export function resolveFooterText(assistantName: string, customDisclosureText?: string | null): string {
    const base = customDisclosureText?.trim()
        ? customDisclosureText.trim()
        : DEFAULT_FOOTER_TEXT;
    return base.replace('[Assistant Name]', assistantName);
}

/**
 * Appends the mandatory AI disclosure footer to an email body (plain-text or HTML).
 * For HTML bodies the footer is appended as a visually distinct paragraph.
 * For plain text the standard separator is used.
 */
export function injectAiFooter(
    body: string,
    assistantName: string,
    customDisclosureText?: string | null,
    isHtml = false,
): string {
    const footerText = resolveFooterText(assistantName, customDisclosureText);

    if (isHtml) {
        const htmlFooter = `<hr style="margin-top:24px;border:none;border-top:1px solid #e5e7eb;">` +
            `<p style="color:#6b7280;font-size:12px;font-family:sans-serif;margin:8px 0 0;">${_esc(footerText)}</p>`;
        return body + htmlFooter;
    }

    return body + `\n\n${footerText}`;
}

/**
 * Validates that a custom disclosure string explicitly mentions AI involvement.
 * Returns null on success or an error message string on failure.
 */
export function validateDisclosureText(text: string): string | null {
    const lower = text.toLowerCase();
    if (!lower.includes('ai') && !lower.includes('artificial intelligence')) {
        return "Disclosure text must indicate AI involvement. The text must contain the word 'AI' or 'artificial intelligence'.";
    }
    return null;
}

function _esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
