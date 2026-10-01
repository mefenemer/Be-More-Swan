// src/utils/form-definition.ts
// The sign-up FORM DEFINITION — one JSON shape for the chat (Email Marketing Assistant), the form
// builder, and the renderer that draws the form on a customer's website, on the page we host, and
// in every preview. docs/form-builder-plan.md §1 is the design.
//
// ── One gate ─────────────────────────────────────────────────────────────────────────────────────
// normaliseFormDefinition() is called on EVERY path a definition enters by: a chat card, a builder
// save, a legacy settings update, and the public render. Whatever it returns is safe to store and
// safe to draw. Two reasons that matters more than usual here:
//   • STYLE IS WRITTEN INTO A <style> BLOCK ON SOMEBODY ELSE'S WEBSITE. A colour of
//     `red; } body { display:none } .x {` closes the rule and opens another. So style is a closed set
//     of tokens — hex colours and enums — never CSS text. (Same rule as validateFormTheme.)
//   • THE PUBLIC ENDPOINT VALIDATES ANSWERS AGAINST IT. The browser is never trusted for `required`
//     or for which options exist; the stored definition is.
//
// ── Single source of truth ───────────────────────────────────────────────────────────────────────
// audience_forms.definition is authoritative. The older columns (fields, theme, double_opt_in,
// segment_id, allowed_origins, hosted_*, consent_text, success_message, redirect_url) are DERIVED
// from it on every save by columnsFromDefinition(), so the code that already reads them — the origin
// check, the confirmation path, segment assignment — keeps working and cannot disagree with it.
// A row saved before definitions existed has definition NULL; legacyToDefinition() reads it.

import { createHash, randomBytes } from 'crypto';
import { DEFAULT_CONSENT_TEXT, DEFAULT_SUCCESS_MESSAGE, SINGLE_OPT_IN_SUCCESS_MESSAGE, validateRedirectUrl } from './audience-forms';

export const FORM_DEFINITION_VERSION = 1;

export const FIELD_TYPES = ['email', 'text', 'textarea', 'phone', 'select', 'radio', 'checkbox'] as const;
export type FieldType = typeof FIELD_TYPES[number];

export const CONTACT_COLUMNS = ['email', 'first_name', 'last_name', 'company', 'phone'] as const;
export type ContactColumn = typeof CONTACT_COLUMNS[number];

export const FORM_PURPOSES = ['newsletter', 'lead_magnet', 'waitlist', 'event', 'enquiry', 'onboarding', 'custom'] as const;
export const FONTS = ['inherit', 'system', 'serif', 'rounded', 'mono'] as const;
export const RADII = ['none', 'small', 'large'] as const;
export const LAYOUTS = ['stacked', 'inline'] as const;

export const MAX_FIELDS = 12;
export const MAX_OPTIONS = 20;
export const MAX_TAGS = 10;

export type FieldTarget =
    | { kind: 'contact'; column: ContactColumn }
    | { kind: 'custom'; key: string }
    | { kind: 'tag' };

export interface FormField {
    id: string;
    type: FieldType;
    label: string;
    placeholder: string;
    help: string;
    required: boolean;
    options: { value: string; label: string }[];
    target: FieldTarget;
}

export interface FormStyle {
    accent: string;
    background: string;
    text: string;
    pageBackground: string;
    font: typeof FONTS[number];
    radius: typeof RADII[number];
    layout: typeof LAYOUTS[number];
    /** A content_assets id, verified to belong to the org at save time; drawn via the signed media URL. */
    logo: { assetId: number } | null;
    useBrandKit: boolean;
}

export interface FormDefinition {
    version: 1;
    name: string;
    purpose: typeof FORM_PURPOSES[number];
    content: { headline: string; intro: string; buttonLabel: string; successMessage: string; redirectUrl: string | null };
    fields: FormField[];
    consent: { text: string; requireCheckbox: boolean };
    style: FormStyle;
    delivery: {
        embed: { enabled: boolean; allowedOrigins: string[] | null };
        hosted: { enabled: boolean; slug: string | null };
    };
    audience: { doubleOptIn: boolean; segmentId: number | null; tags: string[] };
    /** sequenceId null = the welcome sequence. skipWelcome is meaningful only with a linked campaign. */
    campaign: { sequenceId: number | null; skipWelcome: boolean };
}

export const DEFAULT_STYLE: FormStyle = {
    accent: '#059669', background: '#ffffff', text: '#111827', pageBackground: '#f9fafb',
    font: 'system', radius: 'small', layout: 'stacked', logo: null, useBrandKit: true,
};

const HEX = /^#[0-9a-f]{6}$/i;
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;
export const CUSTOM_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** Slugs that would read as ours, or collide with a route, or invite impersonation of the platform. */
export const RESERVED_SLUGS = new Set([
    'admin', 'api', 'app', 'login', 'logout', 'register', 'signup', 'sign-up', 'subscribe', 'unsubscribe',
    'help', 'support', 'billing', 'pricing', 'about', 'contact', 'blog', 'privacy', 'terms', 'security',
    'bemoreswan', 'be-more-swan', 'swan', 'official', 'verify', 'account', 'settings', 'static', 'assets',
]);

/** Words in a custom-field key or label that point at data this form cannot protect. Advisory. */
const SENSITIVE = /\b(password|passport|ssn|social.?security|national.?insurance|credit.?card|card.?number|cvv|iban|sort.?code|bank|religio|ethnic|health|medical|diagnos|sexual|politic|criminal)\b/i;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const pick = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T =>
    (allowed as readonly string[]).includes(String(v)) ? (v as T) : dflt;
const hex = (v: unknown, dflt: string) => (typeof v === 'string' && HEX.test(v.trim()) ? v.trim().toLowerCase() : dflt);

export const newFieldId = () => 'f_' + randomBytes(5).toString('hex');

function slugifyKey(label: string): string {
    const k = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'f_$1').slice(0, 40);
    return CUSTOM_KEY_RE.test(k) ? k : '';
}

function normaliseTarget(raw: unknown, type: FieldType, label: string): FieldTarget | null {
    if (type === 'email') return { kind: 'contact', column: 'email' };
    const t = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    if (t.kind === 'contact' && (CONTACT_COLUMNS as readonly string[]).includes(String(t.column)) && t.column !== 'email') {
        return { kind: 'contact', column: t.column as ContactColumn };
    }
    if (t.kind === 'tag' && (type === 'select' || type === 'radio' || type === 'checkbox')) return { kind: 'tag' };
    const key = typeof t.key === 'string' && CUSTOM_KEY_RE.test(t.key) ? t.key : slugifyKey(label);
    return key ? { kind: 'custom', key } : null;
}

export interface NormaliseContext {
    /** The org's brand kit colours, used when style.useBrandKit or when a colour is invalid. */
    brand?: { accent?: string; text?: string } | null;
}

export interface NormaliseResult { definition: FormDefinition; warnings: string[] }

/**
 * Turn anything into a valid definition, saying what was changed.
 *
 * Never throws and never returns null: a half-formed definition becomes a working form with
 * warnings, because the alternative on the chat path is losing the user's work, and on the public
 * path is a broken form on their website.
 */
export function normaliseFormDefinition(raw: unknown, ctx: NormaliseContext = {}): NormaliseResult {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
    const warnings: string[] = [];

    // ── Fields ────────────────────────────────────────────────────────────────────────────────
    const seenIds = new Set<string>();
    const seenTargets = new Set<string>();
    const fields: FormField[] = [];
    let hasEmail = false;
    for (const f of (Array.isArray(r.fields) ? r.fields : []).slice(0, MAX_FIELDS * 2)) {
        if (!f || typeof f !== 'object') continue;
        const type = pick(f.type, FIELD_TYPES, 'text');
        if (type === 'email' && hasEmail) { warnings.push('A form can only ask for one email address, so the second was removed.'); continue; }
        const label = str(f.label, 80) || (type === 'email' ? 'Email' : 'Untitled question');
        const target = normaliseTarget(f.target, type, label);
        if (!target) { warnings.push(`"${label}" had nowhere to save its answer, so it was removed.`); continue; }
        const targetKey = target.kind === 'tag' ? `tag:${fields.length}` : target.kind === 'contact' ? `c:${target.column}` : `x:${target.key}`;
        if (seenTargets.has(targetKey)) { warnings.push(`"${label}" saved to the same place as another question, so it was removed.`); continue; }
        if (target.kind === 'custom' && SENSITIVE.test(`${target.key} ${label}`)) {
            warnings.push(`"${label}" looks like sensitive information. A sign-up form cannot protect it — consider removing it.`);
        }
        let options: { value: string; label: string }[] = [];
        if (type === 'select' || type === 'radio' || type === 'checkbox') {
            const seen = new Set<string>();
            for (const o of (Array.isArray(f.options) ? f.options : []).slice(0, MAX_OPTIONS)) {
                const lab = str(typeof o === 'string' ? o : o?.label, 80);
                const val = str(typeof o === 'string' ? o : o?.value, 80) || lab;
                if (!lab || seen.has(val)) continue;
                seen.add(val);
                options.push({ value: val, label: lab });
            }
            // A single checkbox ("Yes, I'd like the guide") is legitimate; a choice needs two.
            if (type !== 'checkbox' && options.length < 2) {
                warnings.push(`"${label}" needs at least two choices, so it was removed.`);
                continue;
            }
            if (type === 'checkbox' && !options.length) options = [{ value: 'yes', label }];
        }
        let id = typeof f.id === 'string' && /^f_[a-z0-9_]{1,24}$/i.test(f.id) ? f.id : newFieldId();
        if (seenIds.has(id)) id = newFieldId();
        seenIds.add(id);
        seenTargets.add(targetKey);
        if (type === 'email') hasEmail = true;
        fields.push({
            id, type, label,
            placeholder: str(f.placeholder, 120),
            help: str(f.help, 200),
            required: type === 'email' ? true : f.required === true,
            options,
            target,
        });
        if (fields.length >= MAX_FIELDS) break;
    }
    if (!hasEmail) {
        // Email is not optional — a sign-up form without it collects nothing we can send to. It takes
        // the LAST question's place when the form is already full, never a thirteenth slot.
        if (fields.length >= MAX_FIELDS) { const dropped = fields.pop()!; warnings.push(`"${dropped.label}" was removed to make room for the email address.`); }
        fields.unshift({ id: 'f_email', type: 'email', label: 'Email', placeholder: '', help: '', required: true, options: [], target: { kind: 'contact', column: 'email' } });
        if (Array.isArray(r.fields) && r.fields.length) warnings.push('Every form needs an email address, so one was added.');
    }

    // ── Style — tokens only ──────────────────────────────────────────────────────────────────────
    const s = (r.style && typeof r.style === 'object' ? r.style : {}) as Record<string, any>;
    const useBrandKit = s.useBrandKit !== false;
    const brandAccent = ctx.brand?.accent && HEX.test(ctx.brand.accent) ? ctx.brand.accent.toLowerCase() : DEFAULT_STYLE.accent;
    const style: FormStyle = {
        accent: useBrandKit ? brandAccent : hex(s.accent, brandAccent),
        background: hex(s.background, DEFAULT_STYLE.background),
        text: hex(s.text, DEFAULT_STYLE.text),
        pageBackground: hex(s.pageBackground, DEFAULT_STYLE.pageBackground),
        font: pick(s.font, FONTS, DEFAULT_STYLE.font),
        radius: pick(s.radius, RADII, DEFAULT_STYLE.radius),
        layout: pick(s.layout, LAYOUTS, DEFAULT_STYLE.layout),
        logo: s.logo && Number(s.logo.assetId) > 0 ? { assetId: Math.floor(Number(s.logo.assetId)) } : null,
        useBrandKit,
    };
    // An inline layout only makes sense for email + a button; anything more stacks.
    if (style.layout === 'inline' && fields.length > 1) style.layout = 'stacked';

    // ── Content, consent, delivery, audience, campaign ───────────────────────────────────────────
    const c = (r.content && typeof r.content === 'object' ? r.content : {}) as Record<string, any>;
    const a = (r.audience && typeof r.audience === 'object' ? r.audience : {}) as Record<string, any>;
    const doubleOptIn = a.doubleOptIn !== false;
    const redirectRaw = str(c.redirectUrl, 500);
    const redirectUrl = validateRedirectUrl(redirectRaw);
    if (redirectRaw && !redirectUrl) warnings.push('The redirect address was not a full http(s) link, so it was removed.');

    const d = (r.delivery && typeof r.delivery === 'object' ? r.delivery : {}) as Record<string, any>;
    const slugRaw = str(d.hosted?.slug, 48).toLowerCase();
    let slug: string | null = null;
    if (slugRaw) {
        if (!SLUG_RE.test(slugRaw)) warnings.push('The page address can use only lower-case letters, numbers and dashes (3–48 characters), so it was cleared.');
        else if (RESERVED_SLUGS.has(slugRaw)) warnings.push(`"${slugRaw}" is reserved, so the page address was cleared.`);
        else slug = slugRaw;
    }
    const origins = d.embed?.allowedOrigins;

    const tags = [...new Set((Array.isArray(a.tags) ? a.tags : [])
        .map((t: unknown) => str(t, 40)).filter(Boolean))].slice(0, MAX_TAGS) as string[];

    const camp = (r.campaign && typeof r.campaign === 'object' ? r.campaign : {}) as Record<string, any>;
    const sequenceId = Number(camp.sequenceId) > 0 ? Math.floor(Number(camp.sequenceId)) : null;

    const definition: FormDefinition = {
        version: 1,
        name: str(r.name, 80) || 'Sign-up form',
        purpose: pick(r.purpose, FORM_PURPOSES, 'newsletter'),
        content: {
            headline: str(c.headline, 120),
            intro: str(c.intro, 600),
            buttonLabel: str(c.buttonLabel, 40) || 'Subscribe',
            successMessage: str(c.successMessage, 300) || (doubleOptIn ? DEFAULT_SUCCESS_MESSAGE : SINGLE_OPT_IN_SUCCESS_MESSAGE),
            redirectUrl,
        },
        fields,
        consent: { text: str(r.consent?.text, 500) || DEFAULT_CONSENT_TEXT, requireCheckbox: r.consent?.requireCheckbox === true },
        style,
        delivery: {
            embed: {
                enabled: d.embed?.enabled !== false,
                // null = any origin; [] = none. Kept as-is here; the API normalises each origin.
                allowedOrigins: origins === null || origins === undefined ? null
                    : Array.isArray(origins) ? origins.map((o: unknown) => str(o, 200)).filter(Boolean).slice(0, 20) : null,
            },
            hosted: { enabled: d.hosted?.enabled === true, slug },
        },
        audience: {
            doubleOptIn,
            segmentId: Number(a.segmentId) > 0 ? Math.floor(Number(a.segmentId)) : null,
            tags,
        },
        campaign: { sequenceId, skipWelcome: sequenceId ? camp.skipWelcome !== false : false },
    };
    return { definition, warnings: [...new Set(warnings)] };
}

/** A form saved before definitions existed, read as one. */
export function legacyToDefinition(row: {
    name?: string | null; fields?: unknown; theme?: unknown; doubleOptIn?: boolean | null; segmentId?: number | null;
    allowedOrigins?: string[] | null; hostedEnabled?: boolean | null; hostedHeadline?: string | null; hostedIntro?: string | null;
    consentText?: string | null; successMessage?: string | null; redirectUrl?: string | null;
}): FormDefinition {
    const LABELS: Record<string, string> = { email: 'Email address', first_name: 'First name', last_name: 'Last name', company: 'Company' };
    const cols = (Array.isArray(row.fields) ? row.fields : ['email']).map(String).filter((f) => LABELS[f]);
    const theme = (row.theme && typeof row.theme === 'object' ? row.theme : {}) as Record<string, unknown>;
    return normaliseFormDefinition({
        name: row.name,
        fields: cols.map((col) => ({
            id: `f_${col.replace(/_/g, '')}`, type: col === 'email' ? 'email' : 'text', label: LABELS[col],
            required: col === 'email', target: { kind: 'contact', column: col },
        })),
        content: {
            headline: row.hostedHeadline || row.name || '', intro: row.hostedIntro || '',
            buttonLabel: theme.buttonLabel, successMessage: row.successMessage, redirectUrl: row.redirectUrl,
        },
        consent: { text: row.consentText },
        style: { accent: theme.accent, layout: theme.layout, useBrandKit: !theme.accent },
        delivery: { embed: { enabled: true, allowedOrigins: row.allowedOrigins ?? null }, hosted: { enabled: !!row.hostedEnabled, slug: null } },
        audience: { doubleOptIn: row.doubleOptIn !== false, segmentId: row.segmentId ?? null, tags: [] },
    }).definition;
}

/** The older columns, derived — so every reader of them agrees with the definition. */
export function columnsFromDefinition(def: FormDefinition) {
    return {
        name: def.name,
        fields: def.fields.filter((f) => f.target.kind === 'contact').map((f) => (f.target as { column: string }).column),
        theme: { accent: def.style.accent, layout: def.style.layout, buttonLabel: def.content.buttonLabel },
        doubleOptIn: def.audience.doubleOptIn,
        segmentId: def.audience.segmentId,
        allowedOrigins: def.delivery.embed.allowedOrigins,
        hostedEnabled: def.delivery.hosted.enabled,
        hostedHeadline: def.content.headline || null,
        hostedIntro: def.content.intro || null,
        consentText: def.consent.text,
        successMessage: def.content.successMessage,
        redirectUrl: def.content.redirectUrl,
        slug: def.delivery.hosted.slug,
        sequenceId: def.campaign.sequenceId,
        definition: def,
    };
}

/** What a stranger's browser may see. No segment, campaign, origins or anything internal. */
export function publicDefinition(def: FormDefinition, extra: { logoUrl: string | null; senderName: string }) {
    return {
        version: def.version,
        content: def.content,
        fields: def.fields.map(({ id, type, label, placeholder, help, required, options }) => ({ id, type, label, placeholder, help, required, options })),
        consent: def.consent,
        style: { ...def.style, logo: undefined, logoUrl: extra.logoUrl },
        senderName: extra.senderName,
    };
}

export function definitionHash(def: FormDefinition): string {
    return createHash('sha256').update(JSON.stringify({ c: def.content, f: def.fields, k: def.consent })).digest('hex');
}

export interface ValidatedAnswers {
    email: string;
    contact: Partial<Record<Exclude<ContactColumn, 'email'>, string>>;
    custom: Record<string, string>;
    tags: string[];
    /** Answers that are not contact columns, keyed by field id — stored on the submission. */
    stored: Record<string, string | string[]>;
}

/**
 * Check a submission against the definition. The browser's idea of the form is never trusted:
 * unknown field ids are dropped, required is enforced here, and a choice must be one of the options.
 */
export function validateAnswers(def: FormDefinition, raw: unknown):
    { ok: true; answers: ValidatedAnswers } | { ok: false; error: string } {
    const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const out: ValidatedAnswers = { email: '', contact: {}, custom: {}, tags: [], stored: {} };
    for (const f of def.fields) {
        const v = input[f.id];
        let values: string[] = [];
        if (f.type === 'checkbox') values = (Array.isArray(v) ? v : v == null || v === '' || v === false ? [] : [v]).map((x) => String(x).slice(0, 80));
        else if (v != null) values = [String(v).trim().slice(0, f.type === 'textarea' ? 2000 : 300)].filter(Boolean);

        if (f.options.length) {
            const allowed = new Set(f.options.map((o) => o.value));
            values = values.filter((x) => allowed.has(x));
            if (f.type !== 'checkbox') values = values.slice(0, 1);
        }
        if (f.required && !values.length) return { ok: false, error: `Please answer "${f.label}".` };
        if (!values.length) continue;

        if (f.type === 'phone' && !/^[+()\d\s.-]{5,30}$/.test(values[0])) return { ok: false, error: `"${f.label}" does not look like a phone number.` };

        const t = f.target;
        if (t.kind === 'contact') {
            if (t.column === 'email') out.email = values[0];
            else out.contact[t.column] = values[0];
        } else if (t.kind === 'custom') {
            const labels = values.map((x) => f.options.find((o) => o.value === x)?.label ?? x);
            out.custom[t.key] = labels.join(', ');
            out.stored[f.id] = f.type === 'checkbox' ? values : values[0];
        } else {
            out.tags.push(...values.map((x) => f.options.find((o) => o.value === x)?.label ?? x));
            out.stored[f.id] = values;
        }
    }
    out.tags = [...new Set([...def.audience.tags, ...out.tags].map((t) => t.slice(0, 40)))].slice(0, MAX_TAGS * 2);
    return { ok: true, answers: out };
}
