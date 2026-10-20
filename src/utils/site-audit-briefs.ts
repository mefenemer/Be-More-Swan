// src/utils/site-audit-briefs.ts — wording shared by the Mystery Shopper's Website tab and its API.
//
// The "isn't on your site yet" nudge (assistant-site-audit.js) types this into the Social Media
// Assistant's chat, and site-audits.ts `brief` records the same words in History — so what History
// says was briefed is exactly what was typed. src/public copy: the tab builds it in the browser from
// the same sentence (tests/mystery-shopper-wiring.test.ts keeps the two equal).

export function stalledFixBrief(afterText: string): string {
    return `Please draft a post that leads with this message: "${afterText}". It is how we now describe what we do, and our website will say the same soon. Keep any [placeholders] for me to fill in.`;
}
