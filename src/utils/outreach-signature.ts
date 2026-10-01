// src/utils/outreach-signature.ts
// The Lead Generator's email signature — typed by the user in the assistant's Operational set-up
// (onboarding_context.outreachSignature) and added to EVERY outreach email that assistant sends:
// the first email, every follow-up, and replies from the Conversations tab.
//
// ⚠️ PLAIN TEXT, deliberately (decided 2026-10-01). Outreach is sent text/plain so it reads as a
// person wrote it and stays out of junk folders (see the outreach-sends-from-tenant-mailbox note). A
// plain-text email has no fonts, so the signature is exactly the lines typed — the recipient's email
// app chooses the typeface. A styled or handwritten signature would need HTML and an image.
//
// ⚠️ APPENDED IN CODE, at the send sites, between the message and the compliance footer — the same
// rule as the footer: a model asked to write a signature paraphrases it, and a reviewer editing the
// draft would have to retype it on every lead. And when one is set, the drafting prompts are told NOT
// to sign off (src/config/sender-identity.ts), or every email would sign twice.

const MAX_LINES = 10;
const MAX_LINE = 120;
const MAX_TOTAL = 800;

/** Clean a typed signature: plain lines only, bounded. Returns '' for none. */
export function normaliseSignature(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    const lines = raw
        // eslint-disable-next-line no-control-regex
        .replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
        .split('\n')
        .map((l) => l.replace(/\s+$/g, '').slice(0, MAX_LINE));
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    // No more than one blank line in a row.
    const out: string[] = [];
    for (const l of lines) { if (!l.trim() && out.length && !out[out.length - 1].trim()) continue; out.push(l); }
    return out.slice(0, MAX_LINES).join('\n').slice(0, MAX_TOTAL);
}

/** The signature from an assistant's onboarding answers, or '' when none is set. */
export function signatureFromContext(ctx: unknown): string {
    const c = (ctx && typeof ctx === 'object' ? ctx : {}) as Record<string, unknown>;
    return normaliseSignature(c.outreachSignature);
}

/**
 * The message, then the signature. Idempotent: a draft whose author already pasted the signature in
 * is not given a second copy.
 */
export function appendSignature(body: string, signature: string): string {
    const sig = normaliseSignature(signature);
    const text = String(body ?? '').replace(/\s+$/g, '');
    if (!sig) return text;
    if (text.endsWith(sig)) return text;
    return `${text}\n\n${sig}`;
}
