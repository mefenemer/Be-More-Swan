// src/utils/prompt-sanitiser.ts
// US-GDPR-4.2.1: Prompt PII minimisation layer before LLM API calls.
// Strips identified PII from prompts before they cross the UK/EU → US boundary,
// reducing transfer risk and supporting the Article 46 TIA.
//
// Returns the sanitised prompt and the list of redacted data category labels
// for logging to ai_usage_log.dataCategories (US-GDPR-4.2.2).
//
// Design: regex-only, no LLM call. Latency target < 5ms for typical prompts.

import type { DataCategory } from './ai-usage';

export interface SanitisedPrompt {
    sanitised: string;
    dataCategories: DataCategory[];
    // True when special category data was detected and the call should be blocked.
    blocked: boolean;
    // Human-readable reason shown to the user when blocked === true.
    blockReason?: string;
}

// ── Patterns ──────────────────────────────────────────────────────────────────

// Each entry: the regex, the placeholder label, and the DataCategory to tag.
// Patterns are applied in order; overlaps are fine — earlier match wins if
// we scan left-to-right with replaceAll.
const PII_RULES: Array<{
    pattern: RegExp;
    placeholder: string;
    category: DataCategory;
    blocks: boolean;   // true = special category → block the call
}> = [
    // ── Special category (block) ──────────────────────────────────────────────

    // IBAN (financial account — high risk)
    {
        pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
        placeholder: '[REDACTED_IBAN]',
        category: 'financial',
        blocks: true,
    },
    // UK National Insurance number
    {
        pattern: /\b[A-CEGHJ-PR-TW-Z]{2}\d{6}[A-D]\b/gi,
        placeholder: '[REDACTED_NI_NUMBER]',
        category: 'special_category_suspected',
        blocks: true,
    },
    // US Social Security number
    {
        pattern: /\b(?!000|666|9\d\d)\d{3}[-\s]?(?!00)\d{2}[-\s]?(?!0000)\d{4}\b/g,
        placeholder: '[REDACTED_SSN]',
        category: 'special_category_suspected',
        blocks: true,
    },
    // Passport number (generic: letter(s) + 6–9 digits — broad but acceptable as false-positive trade-off per AC)
    {
        pattern: /\b[A-Z]{1,2}\d{6,9}\b/g,
        placeholder: '[REDACTED_PASSPORT]',
        category: 'special_category_suspected',
        blocks: true,
    },
    // Credit / debit card numbers (Luhn pattern: 13–19 contiguous digits or spaced groups)
    {
        pattern: /\b(?:\d[ -]?){13,19}\b/g,
        placeholder: '[REDACTED_CARD_NUMBER]',
        category: 'financial',
        blocks: true,
    },
    // Health keywords heuristic (diagnoses, medication mentions)
    {
        pattern: /\b(diagnosis|diagnos(?:ed|is)|prescription|medication|symptom|cancer|diabetes|hiv|aids|hepatitis|epilepsy|schizophrenia|bipolar|depression|anxiety disorder)\b/gi,
        placeholder: '[REDACTED_HEALTH_TERM]',
        category: 'health',
        blocks: true,
    },

    // ── Non-blocking PII (redact but allow) ───────────────────────────────────

    // Email addresses
    {
        pattern: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
        placeholder: '[REDACTED_EMAIL]',
        category: 'pii_redacted',
        blocks: false,
    },
    // UK mobile / international phone numbers (+44 07xxx; +1 NXX; generic intl)
    {
        pattern: /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{1,4}\)?[\s.-]?)?\d{3,5}[\s.-]?\d{3,5}[\s.-]?\d{0,5}(?:\s?(?:x|ext)\.?\s?\d{1,5})?/g,
        placeholder: '[REDACTED_PHONE]',
        category: 'pii_redacted',
        blocks: false,
    },
    // UK sort code + account number pattern (sort: 12-34-56, account: 8 digits)
    {
        pattern: /\b\d{2}[-\s]\d{2}[-\s]\d{2}(?:\s+\d{8})?\b/g,
        placeholder: '[REDACTED_ACCOUNT_NUMBER]',
        category: 'financial',
        blocks: false,
    },
];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Sanitise a prompt string before it is sent to an LLM API.
 *
 * @param prompt - The assembled prompt string (system + user combined, or just user turn).
 * @returns      - Sanitised string, categories list, and a blocked flag.
 *
 * Usage:
 *   const { sanitised, dataCategories, blocked, blockReason } = sanitisePromptForTransfer(rawPrompt);
 *   if (blocked) return { statusCode: 422, body: JSON.stringify({ error: blockReason }) };
 *   // proceed with `sanitised` in the LLM call
 *   await logAiUsage({ ..., dataCategories });
 */
export function sanitisePromptForTransfer(prompt: string): SanitisedPrompt {
    let text = prompt;
    const categoriesFound = new Set<DataCategory>();
    let blocked = false;
    let blockReason: string | undefined;

    for (const rule of PII_RULES) {
        // Reset lastIndex for stateful global regexes
        rule.pattern.lastIndex = 0;
        if (rule.pattern.test(text)) {
            rule.pattern.lastIndex = 0;
            text = text.replace(rule.pattern, rule.placeholder);
            categoriesFound.add(rule.category);
            if (rule.blocks) {
                blocked = true;
            }
        }
    }

    if (blocked) {
        blockReason =
            'Your message appears to contain sensitive personal information. ' +
            'Please remove it before sending.';
    }

    const dataCategories: DataCategory[] =
        categoriesFound.size > 0 ? [...categoriesFound] : ['general'];

    return { sanitised: text, dataCategories, blocked, blockReason };
}
