// src/utils/attribution.ts
// US-AUD-5.3.1 SC2: Append "Powered by Be More Swan" footer to exported deliverables.

const BASE_URL = process.env.BASE_URL || 'https://bemoreswan.com';

/**
 * Returns the attribution footer text for plain-text / markdown exports.
 * If `orgSlug` is not supplied, falls back to the generic marketing URL.
 */
export function getAttributionFooterText(orgSlug?: string | null): string {
    const url = orgSlug
        ? `${BASE_URL}/powered-by/${encodeURIComponent(orgSlug)}`
        : `${BASE_URL}`;
    return `\n\n---\nProduced with Be More Swan | ${url}`;
}

/**
 * Appends the attribution footer to a plain-text or markdown string.
 * Call this in any export handler when the org has agencyAttributionEnabled = true.
 */
export function appendAttributionFooter(content: string, orgSlug?: string | null): string {
    return content + getAttributionFooterText(orgSlug);
}

/**
 * Returns the attribution footer as an HTML snippet (for HTML/PDF exports).
 */
export function getAttributionFooterHtml(orgSlug?: string | null): string {
    const url = orgSlug
        ? `${BASE_URL}/powered-by/${encodeURIComponent(orgSlug)}`
        : `${BASE_URL}`;
    return `<hr style="margin-top:2rem;border:none;border-top:1px solid #e5e7eb;">
<p style="font-size:0.75rem;color:#6b7280;margin-top:0.5rem;">
  Produced with <a href="${url}" style="color:#059669;text-decoration:none;">Be More Swan</a>
</p>`;
}
