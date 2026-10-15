// src/utils/site-forms.ts — what happens when someone sends a form on a hosted Website Assistant
// site (step 3b). docs/website-assistant-plan.md §7. tests/site-forms.test.ts.
//
// Forms on a site are plain HTML (site-render.ts): they POST to the site's own /_form, sites-host
// forwards that to site-serve.ts with the shared key and the visitor's IP, and site-serve calls
// handleSiteForm. Two kinds:
//
//   contact — an ENQUIRY. Kept in site_enquiries, the owner is notified and emailed. Never an
//             Audience sign-up: asking a question is not asking for marketing email.
//   signup  — one of the workspace's Form Builder forms. Posted through the EXISTING subscribe path
//             (audience-public.ts, injected as `subscribe`) so consent evidence, double opt-in,
//             segments, tags and the welcome sequence behave exactly as they do everywhere else.
//
// Every answer is checked against the PUBLISHED site: the section must exist on it and be of that
// kind, and a sign-up section's form must be this workspace's and active. Bots (the hidden field
// filled in, or a post faster than a person could fill the form in) get the same "thank you" as a
// person, and nothing is stored.
//
// The visitor always lands on a page in the site's own look: /_sent after a success (redirect, so
// a refresh does not send it twice), or the reason it failed with a way back.

import { and, eq, inArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, audienceForms, siteEnquiries, users } from '../../db/schema';
import { createNotification } from './notify';
import { sendEmail } from './email';
import { checkRateLimit } from './rate-limit';
import { normaliseEmail, looksLikeEmail } from './audience-contacts';
import { DEFAULT_SUCCESS_MESSAGE, SINGLE_OPT_IN_SUCCESS_MESSAGE } from './audience-forms';
import { legacyToDefinition, normaliseFormDefinition, publicDefinition, type FormDefinition } from './form-definition';
import { cleanText, type Section, type SiteDefinition } from './site-definition';
import { esc, FORM_SENT_PATH, type SiteSignupForm } from './site-render';
import type { SiteRow } from './site-store';

type Db = ReturnType<typeof getDb>;

/** A person takes longer than this to read a form and fill it in. Same as the audience forms. */
export const SITE_FORM_MIN_FILL_MS = 2500;
/** A rendered page older than this is still fine to post from (someone left the tab open). */
const MAX_FORM_AGE_MS = 7 * 24 * 3600 * 1000;
export const ENQUIRY_LIMITS = { perIp: { maxAttempts: 5, windowSecs: 3600 }, perSite: { maxAttempts: 60, windowSecs: 3600 } };
export const ENQUIRY_MAX = { name: 120, email: 254, phone: 30, message: 4000 };

export type FormOutcome =
    | { kind: 'sent'; location: string }
    | { kind: 'error'; status: 400 | 404 | 429; title: string; message: string; backPath: string };

/** The form's definition, resolved the way audience-public.ts does it. */
function resolveFormDefinition(row: Parameters<typeof legacyToDefinition>[0] & { definition?: unknown }): FormDefinition {
    return row.definition ? normaliseFormDefinition(row.definition).definition : legacyToDefinition(row);
}

/**
 * The sign-up forms a site's sections point at, keyed by id — only this workspace's ACTIVE forms.
 * What the renderer is given, so a deleted or switched-off form simply disappears from the site.
 */
export async function loadSiteForms(db: Db, orgId: number, def: SiteDefinition): Promise<Record<number, SiteSignupForm & { publicKey: string; def: FormDefinition }>> {
    const ids = [...new Set(def.pages.flatMap((p) => p.sections).flatMap((s) => (s.type === 'signup' && s.props.formId ? [s.props.formId] : [])))];
    if (!ids.length) return {};
    const rows = await db.select().from(audienceForms)
        .where(and(inArray(audienceForms.id, ids), eq(audienceForms.organisationId, orgId), eq(audienceForms.status, 'active')));
    const out: Record<number, SiteSignupForm & { publicKey: string; def: FormDefinition }> = {};
    for (const r of rows) {
        const fd = resolveFormDefinition(r as Parameters<typeof legacyToDefinition>[0] & { definition?: unknown });
        const pub = publicDefinition(fd, { logoUrl: null, senderName: '' });
        out[r.id] = { content: pub.content, fields: pub.fields, consent: pub.consent, publicKey: r.publicKey, def: fd };
    }
    return out;
}

/** The workspace's sign-up forms, for the editor's picker. */
export async function listSignupForms(db: Db, orgId: number): Promise<Array<{ id: number; name: string; active: boolean }>> {
    const rows = await db.select({ id: audienceForms.id, name: audienceForms.name, status: audienceForms.status })
        .from(audienceForms).where(eq(audienceForms.organisationId, orgId));
    return rows.map((r) => ({ id: r.id, name: r.name || `Form ${r.id}`, active: r.status === 'active' })).sort((a, b) => a.name.localeCompare(b.name));
}

export function findSection(def: SiteDefinition, sectionId: string): Section | null {
    for (const p of def.pages) for (const s of p.sections) if (s.id === sectionId) return s;
    return null;
}

/** A path on this site to send the visitor back to: one of its pages, else home. */
export function safeBackPath(def: SiteDefinition, raw: unknown): string {
    const p = typeof raw === 'string' ? raw : '/';
    const known = new Set(def.pages.map((x) => (x.slug ? `/${x.slug}` : '/')));
    return known.has(p) ? p : '/';
}

export function sentLocation(kind: 'contact' | 'signup', sectionId: string, back: string): string {
    return `${FORM_SENT_PATH}?k=${kind}&s=${encodeURIComponent(sectionId)}&b=${encodeURIComponent(back)}`;
}

/** `a_<fieldId>` inputs → the answers object audience-public validates (checkboxes may repeat). */
export function answersFromForm(form: URLSearchParams, fields: Array<{ id: string; type: string }>): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const f of fields) {
        const all = form.getAll(`a_${f.id}`);
        if (!all.length) continue;
        out[f.id] = f.type === 'checkbox' ? all : all[0];
    }
    return out;
}

export interface SiteFormRequest {
    site: SiteRow;
    definition: SiteDefinition;
    origin: string;
    body: URLSearchParams;
    ip: string;
    userAgent: string | null;
    now?: number;
    /** audience-public's subscribe, called in-process (site-serve.ts). */
    subscribe: (payload: Record<string, unknown>, meta: { origin: string; ip: string; userAgent: string | null }) => Promise<{ status: number; body: { error?: string } }>;
}

export async function handleSiteForm(db: Db, req: SiteFormRequest): Promise<FormOutcome> {
    const { body, definition: def } = req;
    const now = req.now ?? Date.now();
    const back = safeBackPath(def, body.get('_p'));
    const sectionId = String(body.get('_s') || '');
    const kind = body.get('_k') === 'signup' ? 'signup' : 'contact';
    const section = findSection(def, sectionId);
    if (!section || section.type !== kind) {
        return { kind: 'error', status: 404, title: 'That form isn\'t here any more', message: 'The page may have changed since you opened it. Go back and try again.', backPath: back };
    }

    // A bot: same thank-you as a person, nothing stored.
    const startedAt = Number(body.get('_t'));
    const elapsed = now - startedAt;
    if (String(body.get('website') || '').trim() || !Number.isFinite(startedAt) || elapsed < SITE_FORM_MIN_FILL_MS || elapsed > MAX_FORM_AGE_MS) {
        return { kind: 'sent', location: sentLocation(kind, sectionId, back) };
    }

    if (kind === 'contact') return handleEnquiry(db, req, section as Extract<Section, { type: 'contact' }>, back, sectionId);

    // ── Sign-up: through the one subscribe path ──
    const formId = (section as Extract<Section, { type: 'signup' }>).props.formId;
    const forms = formId ? await loadSiteForms(db, req.site.organisationId, def) : {};
    const form = formId ? forms[formId] : undefined;
    if (!form) return { kind: 'error', status: 404, title: 'Sign-ups are closed', message: 'This sign-up form isn\'t taking sign-ups right now.', backPath: back };
    // The renderer marks the box required; the browser is not trusted to have enforced it.
    if (form.def.consent.requireCheckbox && body.get('_consent') !== 'yes') {
        return { kind: 'error', status: 400, title: 'Please tick the box', message: 'Tick the box to agree before signing up.', backPath: back };
    }
    const result = await req.subscribe({
        key: form.publicKey,
        answers: answersFromForm(body, form.fields),
        hp: '', ms: elapsed, surface: 'embed',
        url: `${req.origin}${back}`,
    }, { origin: req.origin, ip: req.ip, userAgent: req.userAgent });
    if (result.status === 200) return { kind: 'sent', location: sentLocation('signup', sectionId, back) };
    const message = typeof result.body?.error === 'string' && result.body.error ? result.body.error : 'Something went wrong. Please try again in a minute.';
    const status = result.status === 429 ? 429 : result.status === 404 ? 404 : 400;
    return { kind: 'error', status, title: 'You\'re not signed up yet', message, backPath: back };
}

async function handleEnquiry(db: Db, req: SiteFormRequest, section: Extract<Section, { type: 'contact' }>, back: string, sectionId: string): Promise<FormOutcome> {
    const b = req.body;
    const name = cleanText(b.get('name'), ENQUIRY_MAX.name);
    const email = normaliseEmail(String(b.get('email') || '').slice(0, ENQUIRY_MAX.email));
    const phone = section.props.askPhone ? cleanText(b.get('phone'), ENQUIRY_MAX.phone) || null : null;
    const message = cleanText(b.get('message'), ENQUIRY_MAX.message, true);
    const fail = (m: string): FormOutcome => ({ kind: 'error', status: 400, title: 'Your message wasn\'t sent', message: m, backPath: back });
    if (!name) return fail('Please add your name.');
    if (!looksLikeEmail(email)) return fail('Please check your email address — it doesn\'t look right.');
    if (phone && !/^[+()\d\s.-]{5,30}$/.test(phone)) return fail('Please check your phone number, or leave it empty.');
    if (!message) return fail('Please write a message.');

    try {
        const [byIp, bySite] = await Promise.all([
            checkRateLimit(db, 'site_enquiry_ip', req.ip, ENQUIRY_LIMITS.perIp),
            checkRateLimit(db, 'site_enquiry_site', String(req.site.id), ENQUIRY_LIMITS.perSite),
        ]);
        if (!byIp.allowed || !bySite.allowed) {
            return { kind: 'error', status: 429, title: 'Please try again later', message: 'Lots of messages have been sent from here just now. Please try again in an hour, or email the business directly.', backPath: back };
        }
    } catch (err) {
        console.error('[site-forms] rate limiter unavailable — allowing the enquiry', err);
    }

    const [row] = await db.insert(siteEnquiries).values({
        siteId: req.site.id, organisationId: req.site.organisationId, name, email, phone, message, pagePath: back,
    }).returning({ id: siteEnquiries.id });

    // Tell the owner: a card, and the message itself by email to the ACCOUNT's own address (never
    // the address typed on the site — that would let anyone use the form to email a stranger).
    const [owner] = await db.select({ userId: aiAssistants.userId, name: aiAssistants.name, email: users.email })
        .from(aiAssistants).leftJoin(users, eq(users.id, aiAssistants.userId))
        .where(eq(aiAssistants.id, req.site.aiAssistantId)).limit(1);
    if (owner?.userId) {
        await createNotification(db, 'site_enquiry_received', {
            userId: owner.userId, assistantId: req.site.aiAssistantId, category: 'suggested_action',
            context: { assistant: { name: owner.name }, enquiry: { name } },
            metadata: { assistantId: req.site.aiAssistantId, siteId: req.site.id, enquiryId: row.id },
        }).catch((err) => console.error('[site-forms] notification failed', err));
    }
    if (owner?.email) {
        await sendEmail({
            to: owner.email,
            replyTo: email,
            subject: `New enquiry from your website: ${name}`,
            html: `<p><strong>${esc(name)}</strong> sent a message from ${esc(req.origin.replace('https://', ''))}${esc(back === '/' ? '' : back)}.</p>
<p><strong>Email:</strong> ${esc(email)}${phone ? `<br><strong>Phone:</strong> ${esc(phone)}` : ''}</p>
<p style="white-space:pre-wrap">${esc(message)}</p>
<p>Reply to this email to answer them. It is also on your Website Assistant's Website tab, under Enquiries.</p>`,
        }).catch((err: unknown) => console.error('[site-forms] owner email failed', err instanceof Error ? err.message : err));
    }
    return { kind: 'sent', location: sentLocation('contact', sectionId, back) };
}

/** What /_sent says, read from the published site (never from the query string). */
export async function sentMessage(db: Db, site: SiteRow, def: SiteDefinition, q: URLSearchParams): Promise<{ title: string; message: string; back: string }> {
    const back = safeBackPath(def, q.get('b'));
    if (q.get('k') === 'signup') {
        const s = findSection(def, String(q.get('s') || ''));
        const formId = s?.type === 'signup' ? s.props.formId : null;
        const form = formId ? (await loadSiteForms(db, site.organisationId, def))[formId] : undefined;
        const message = form?.def.content.successMessage || (form?.def.audience.doubleOptIn === false ? SINGLE_OPT_IN_SUCCESS_MESSAGE : DEFAULT_SUCCESS_MESSAGE);
        return { title: 'Thank you for signing up', message, back };
    }
    return { title: 'Thank you — your message has been sent', message: 'We\'ll get back to you as soon as we can.', back };
}
