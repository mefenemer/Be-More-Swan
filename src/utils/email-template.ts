// src/utils/email-template.ts
// US-COMMS-1.1.3 / 1.2: The "Be More Swan" master email wrapper + merge-variable engine.
//
// Two responsibilities, kept dependency-free so both the live senders (sendTemplatedEmail)
// and the admin preview/test-send endpoints can call them identically:
//
//   1. renderMasterTemplate(bodyHtml, opts) — wraps admin-edited inner body content in the
//      IMMUTABLE branded shell (logo header, brand colours, mobile-responsive layout, legal
//      footer + unsubscribe). Admins only ever edit the inner body; this shell is code-owned.
//
//   2. renderMergeVars(text, context) — resolves {{path}} tags with optional fallbacks,
//      e.g. {{user.first_name | "there"}} → "there" when the value is null/missing.
//
// The variable CATALOG (EMAIL_VARIABLES) is the single source of truth for the admin
// "Insert Variable" dropdown (AC1.2.1) and the dummy data used by test sends (AC1.3.2).

const BASE_URL = process.env.BASE_URL || 'https://bemoreswan.com';

// ── Brand tokens — the only place email colours/identity are defined ──────────
const BRAND = {
    primary: '#0f766e',      // teal-700 — matches the app's emerald/teal identity
    text: '#1f2937',         // gray-800
    muted: '#6b7280',        // gray-500
    border: '#e5e7eb',       // gray-200
    bg: '#f3f4f6',           // gray-100 page background
    card: '#ffffff',
    logoText: 'Be More Swan',
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. Master wrapper (AC1.1.3)
// ─────────────────────────────────────────────────────────────────────────────

export interface MasterTemplateOptions {
    /** Preview/preheader text shown in the inbox list (hidden in the body). */
    preheader?: string;
    /** Override the unsubscribe URL; defaults to the account notification settings page. */
    unsubscribeUrl?: string;
    /** When true, omit the unsubscribe link (transactional/critical mail, e.g. password reset). */
    transactional?: boolean;
}

/**
 * Wrap inner body HTML in the immutable branded shell. The body is inserted verbatim —
 * callers are responsible for having already resolved merge variables and sanitised any
 * admin-authored HTML (see sanitiseBodyHtml).
 */
export function renderMasterTemplate(bodyHtml: string, opts: MasterTemplateOptions = {}): string {
    const year = new Date().getFullYear();
    const unsubscribe = opts.transactional
        ? ''
        : `<a href="${opts.unsubscribeUrl || `${BASE_URL}/account.html#notifications`}" style="color:${BRAND.muted};text-decoration:underline;">Unsubscribe</a> &nbsp;·&nbsp; `;

    const preheader = opts.preheader
        ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(opts.preheader)}</div>`
        : '';

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="x-apple-disable-message-reformatting">
<title>${BRAND.logoText}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.bg};">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.bg};padding:24px 0;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        <!-- Logo header -->
        <tr>
          <td style="padding:8px 24px 20px;text-align:center;">
            <span style="font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:22px;font-weight:800;color:${BRAND.primary};letter-spacing:-0.5px;">${BRAND.logoText}</span>
          </td>
        </tr>
        <!-- Card body -->
        <tr>
          <td style="background:${BRAND.card};border:1px solid ${BRAND.border};border-radius:16px;padding:32px;font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:${BRAND.text};">
            ${bodyHtml}
          </td>
        </tr>
        <!-- Legal footer -->
        <tr>
          <td style="padding:24px;text-align:center;font-family:'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;line-height:1.5;color:${BRAND.muted};">
            ${unsubscribe}<a href="${BASE_URL}/privacy.html" style="color:${BRAND.muted};text-decoration:underline;">Privacy</a> &nbsp;·&nbsp; <a href="${BASE_URL}/terms.html" style="color:${BRAND.muted};text-decoration:underline;">Terms</a>
            <br><br>
            © ${year} ${BRAND.logoText}. All rights reserved.
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Merge-variable engine (AC1.2.2 / 1.2.3)
// ─────────────────────────────────────────────────────────────────────────────

export type MergeContext = Record<string, unknown>;

const VAR_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|\s*(?:"([^"]*)"|'([^']*)'|([^}|\s]+))\s*)?\}\}/g;

/**
 * Resolve {{path}} and {{path | "fallback"}} tags against a nested context object.
 * Missing/null/empty values use the fallback (or "" when none is given), so templates
 * never render a literal "{{user.first_name}}" or an awkward "Hi ,".
 *
 * `escape` (default true) HTML-escapes resolved values to keep user-supplied data from
 * injecting markup. Pass false only for trusted, pre-formatted values.
 */
export function renderMergeVars(text: string, context: MergeContext, escape = true): string {
    if (!text) return '';
    return text.replace(VAR_PATTERN, (_match, path: string, dq?: string, sq?: string, bare?: string) => {
        const fallback = dq ?? sq ?? bare ?? '';
        const value = resolvePath(context, path);
        const resolved = value === null || value === undefined || value === '' ? fallback : String(value);
        return escape ? escapeHtml(resolved) : resolved;
    });
}

function resolvePath(obj: MergeContext, path: string): unknown {
    return path.split('.').reduce<unknown>((acc, key) => {
        if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
            return (acc as Record<string, unknown>)[key];
        }
        return undefined;
    }, obj);
}

// ─────────────────────────────────────────────────────────────────────────────
// Variable catalog — drives the admin "Insert Variable" dropdown + test dummy data
// ─────────────────────────────────────────────────────────────────────────────

export interface EmailVariable {
    /** The merge path, e.g. "user.first_name". */
    key: string;
    /** Human label for the dropdown. */
    label: string;
    group: 'User' | 'Workspace' | 'Assistant' | 'Billing' | 'System';
    /** Dummy value used when rendering a test send / preview. */
    sample: string;
}

export const EMAIL_VARIABLES: EmailVariable[] = [
    { key: 'user.first_name', label: 'First name', group: 'User', sample: 'Jane' },
    { key: 'user.last_name', label: 'Last name', group: 'User', sample: 'Doe' },
    { key: 'user.email', label: 'Email address', group: 'User', sample: 'jane@example.com' },
    { key: 'workspace.name', label: 'Workspace name', group: 'Workspace', sample: 'Acme Marketing' },
    { key: 'assistant.name', label: 'Assistant name', group: 'Assistant', sample: 'Aura' },
    { key: 'assistant.role', label: 'Assistant role', group: 'Assistant', sample: 'Lead Generator' },
    { key: 'billing.amount', label: 'Amount', group: 'Billing', sample: '£49.00' },
    { key: 'billing.plan_name', label: 'Plan name', group: 'Billing', sample: 'Growth' },
    { key: 'billing.portal_url', label: 'Billing portal URL', group: 'Billing', sample: `${BASE_URL}/billing.html` },
    { key: 'link.action_url', label: 'Primary action URL', group: 'System', sample: `${BASE_URL}/dashboard.html` },
    { key: 'system.app_url', label: 'App URL', group: 'System', sample: BASE_URL },
];

/** Build the dummy-data context used for previews and test sends (AC1.3.2). */
export function sampleContext(): MergeContext {
    const ctx: Record<string, Record<string, string>> = {};
    for (const v of EMAIL_VARIABLES) {
        const [group, field] = v.key.split('.');
        (ctx[group] ||= {})[field] = v.sample;
    }
    return ctx;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Minimal allow-list sanitiser for admin-authored body HTML coming out of the WYSIWYG
 * editor. Strips <script>/<style>/<iframe> and on*= event handlers and javascript: URLs.
 * The editor only emits a small tag set (p, br, strong, em, ul/ol/li, a, h1-h3), so this
 * is a defence-in-depth backstop, not the primary control.
 */
export function sanitiseBodyHtml(html: string): string {
    return html
        .replace(/<\s*(script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
        .replace(/<\s*(script|style|iframe|object|embed)\b[^>]*\/?>/gi, '')
        .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
        .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1=$2#$2');
}
