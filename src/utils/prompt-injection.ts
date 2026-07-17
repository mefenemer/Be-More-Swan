// src/utils/prompt-injection.ts
// Prompt-injection sanitiser for untrusted external content (scraped websites, PDFs,
// user-submitted documents) before it reaches an LLM prompt.
//
// Extracted verbatim from the private `_stripPromptInjection` in
// netlify/functions/process-asset-background.ts so the Inspo ingestion path
// (process-inspo-background.ts) shares one implementation. A security sanitiser copied
// into two files is one that drifts, and the weaker copy becomes the way in.
//
// IMPORTANT — this is belt-and-braces, NOT the actual defence. Pattern-stripping cannot
// enumerate every phrasing of "ignore your instructions", and treating it as sufficient is
// how injection ships. The primary protection is STRUCTURAL: wrap retrieved content in an
// explicit boundary (e.g. "DOCUMENT CONTENT START/END", "INSPO CONTENT START/END") in the
// system prompt so the model is told the span is data, not instructions. This function only
// removes attempts to break out of that boundary.

/**
 * Strip common LLM instruction-override patterns from untrusted text.
 * Always pair with a structural data boundary in the prompt — see the note above.
 */
export function stripPromptInjection(text: string): string {
    return text
        // Classic instruction override patterns
        .replace(/ignore\s+(all\s+)?(previous|prior|above)\s+instructions?/gi, '[content removed]')
        .replace(/disregard\s+(all\s+)?(previous|prior|above)\s+instructions?/gi, '[content removed]')
        .replace(/forget\s+(all\s+)?(previous|prior)\s+instructions?/gi, '[content removed]')
        .replace(/you\s+are\s+now\s+(?:acting\s+as|a|an)\s+/gi, '[content removed] ')
        .replace(/new\s+instructions?\s*:/gi, '[content removed]:')
        .replace(/system\s*:\s*/gi, '[content removed]: ')
        .replace(/\[system\]/gi, '[content removed]')
        .replace(/<\|im_start\|>|<\|im_end\|>/g, '')  // OpenAI special tokens
        .replace(/###\s*instruction/gi, '### [removed]')
        .replace(/HUMAN:|ASSISTANT:|USER:|SYSTEM:/g, '[role removed]:')
        // Trim to prevent whitespace smuggling
        .trim();
}
