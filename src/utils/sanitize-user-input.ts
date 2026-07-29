// src/utils/sanitize-user-input.ts
// Direct prompt-injection / jailbreak defence for free text that gets embedded in a system prompt.
//
// Lived privately inside netlify/functions/onboarding.ts. Extracted when the guardrail backfill
// (scripts/backfill-onboarding-guardrails.ts) needed to apply the IDENTICAL transformation to text
// onboarding would have sanitised at hire time — a second copy would drift, and a drifted copy of a
// sanitiser is the kind that silently stops catching something. Same reasoning as
// src/config/execution-budgets.ts and src/utils/operational-setup.ts.
//
// This does NOT replace the structural safety fence in the system prompt template — it is
// belt-and-braces input sanitisation.

export function sanitizeUserInput(str: string): string {
    if (!str || typeof str !== 'string') return str;
    return str
        .replace(/ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/gi, '[removed]')
        .replace(/disregard\s+(all\s+)?(previous|prior|above)/gi, '[removed]')
        .replace(/you\s+are\s+now\s+(a|an|acting\s+as)\s+/gi, '[removed] ')
        .replace(/\[system\]/gi, '[removed]')
        .replace(/<\|im_start\|>|<\|im_end\|>/g, '')
        .replace(/SYSTEM:/gi, '[removed]:')
        .replace(/new\s+instructions?\s*:/gi, '[removed]:')
        // Strip null bytes and C0/C1 control characters (invisible injection)
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '')
        .trim();
}
