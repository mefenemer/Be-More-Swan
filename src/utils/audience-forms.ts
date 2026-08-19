// src/utils/audience-forms.ts
// Rules for the embeddable sign-up form — shared by the tenant-facing CRUD endpoint and the public
// ingress, because a rule that only one of them enforces is not a rule.
//
// The form is the one place in this product where an ANONYMOUS browser on someone else's website
// can write to a tenant's data. Everything here exists because of that.

/** 'aud_<24 hex>'. A WRITE key, deliberately in its own namespace — see db/audience.sql. */
export const FORM_KEY_RE = /^aud_[0-9a-f]{24}$/;

/**
 * Is this origin allowed to submit to this form?
 *
 * ⚠️ THE NULL/EMPTY DISTINCTION. `null` (never configured) means any origin, because a snippet is
 * pasted onto a site we cannot see and a form that rejected everything by default would simply
 * appear broken. An EMPTY ARRAY means the tenant configured a list and it is now empty — nothing is
 * allowed. Treating those two as the same thing turns "I cleared my allowlist" into "my form is
 * open to the world", which is the opposite of what the person clicking clear intended.
 *
 * Comparison is on the ORIGIN only (scheme + host + port). Paths and query strings are not part of
 * the security boundary and a tenant who pasted a full page URL should still work, so we normalise
 * both sides through URL().
 */
export function originAllowed(allowed: string[] | null | undefined, origin: string | null | undefined): boolean {
    if (allowed == null) return true;              // never configured → open, by design
    if (!allowed.length) return false;             // configured and emptied → closed, by design
    const got = normaliseOrigin(origin);
    if (!got) return false;                        // a locked-down form needs a stated origin
    return allowed.some((a) => normaliseOrigin(a) === got);
}

/** scheme://host[:port], lowercased. Returns null for anything that is not a usable origin. */
export function normaliseOrigin(value: string | null | undefined): string | null {
    const raw = String(value ?? '').trim();
    if (!raw || raw === 'null') return null;       // a sandboxed iframe sends the literal "null"
    try {
        const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        return u.origin.toLowerCase();
    } catch { return null; }
}

/**
 * The minimum time between a form appearing and a human submitting it.
 *
 * A person has to read a label, click a field and type an address; a script posts the instant the
 * DOM is ready. This is not a strong control on its own — it is the cheapest one, and it costs a
 * real visitor nothing.
 */
export const MIN_FILL_MS = 1500;

/** Field names the form may collect. Anything else is ignored rather than stored. */
export const FORM_FIELDS = ['email', 'first_name', 'last_name', 'company'] as const;
export type FormField = typeof FORM_FIELDS[number];

export function sanitiseFields(raw: unknown): FormField[] {
    const list = Array.isArray(raw) ? raw : [];
    const kept = list.filter((f): f is FormField => (FORM_FIELDS as readonly string[]).includes(String(f)));
    // Email is not optional — a sign-up form without it collects nothing we can use.
    return kept.includes('email') ? kept : (['email', ...kept] as FormField[]);
}

/**
 * Validate the theme before storing it.
 *
 * Same rule as save-widget-config.ts, and for the same reason: these values are written into a
 * <style> block on the CUSTOMER'S OWN WEBSITE. Being authenticated is not the same as being safe to
 * interpolate — an accent of `red; } body { display:none } .x {` closes the rule and opens another.
 * So a theme has to be something this codebase could have produced itself.
 */
export function validateFormTheme(raw: unknown): { theme: Record<string, unknown> } | { error: string } {
    if (raw == null) return { theme: {} };
    if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'theme must be an object.' };
    const input = raw as Record<string, unknown>;
    const theme: Record<string, unknown> = {};

    if (input.accent !== undefined && input.accent !== null && input.accent !== '') {
        if (typeof input.accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(input.accent.trim())) {
            return { error: 'theme.accent must be a hex colour, e.g. #059669.' };
        }
        theme.accent = input.accent.trim().toLowerCase();
    }
    if (input.layout !== undefined && input.layout !== null && input.layout !== '') {
        if (!['stacked', 'inline'].includes(String(input.layout))) {
            return { error: 'theme.layout must be "stacked" or "inline".' };
        }
        theme.layout = String(input.layout);
    }
    if (input.buttonLabel !== undefined && input.buttonLabel !== null) {
        theme.buttonLabel = String(input.buttonLabel).slice(0, 40);
    }
    return { theme };
}

/**
 * A redirect target the widget may send a visitor to after signing up.
 *
 * http(s) only, and never a javascript: or data: URL — this string becomes a navigation on the
 * customer's own page, so an unvalidated one is stored XSS with extra steps.
 */
export function validateRedirectUrl(raw: unknown): string | null {
    const v = String(raw ?? '').trim();
    if (!v) return null;
    try {
        const u = new URL(v);
        return (u.protocol === 'http:' || u.protocol === 'https:') ? u.toString().slice(0, 500) : null;
    } catch { return null; }
}

/** The default sentence beside the submit button when a tenant has not written their own. */
export const DEFAULT_CONSENT_TEXT =
    'By subscribing you agree to receive email updates. You can unsubscribe at any time.';

export const DEFAULT_SUCCESS_MESSAGE =
    'Almost there — check your inbox and click the link to confirm your subscription.';

/** Shown when the form is configured for single opt-in, where there is no email to wait for. */
export const SINGLE_OPT_IN_SUCCESS_MESSAGE = 'Thanks — you are subscribed.';
