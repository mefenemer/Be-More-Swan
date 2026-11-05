// src/utils/site-listing-post.ts — "Post your event": a visitor sends a listing in from a listings
// section that allows it (docs/website-types-plan.md §4.3). GET /_post?s=<sectionId>&p=<back path>
// draws the form; it posts to /_form with _k=listing (the sites host forwards only /_form, /_buy and
// /_book). Served by site-serve.ts. tests/site-listings.test.ts.
//
// No script. What they send is saved as 'pending' — it appears on the site ONLY once the owner
// approves it (Listings tab or chat). Going live straight away would make the site a user-to-user
// service under the Online Safety Act 2023 and put spam live. Their name and email are kept for the
// owner only and never shown. Bots: a hidden field, a minimum time to fill, and a cap per address.

import type { getDb } from '../../db/client';
import { siteListings } from '../../db/schema';
import { FORM_ACTION, LISTING_POST_PATH, esc, renderSiteShell, type RenderContext } from './site-render';
import type { SiteDefinition, ListingsProps } from './site-definition';
import { checkWhole, cleanListing, freeSlug, LISTING_LIMITS, LISTING_MIN_FILL_MS, LISTING_PER_IP, ukToday, whenText } from './site-listings';
import { checkRateLimit } from './rate-limit';
import { ownerOf } from './bookings';
import { sendEmail } from './email';
import type { SiteRow } from './site-store';

type Db = ReturnType<typeof getDb>;
export interface ListingPostCtx { db: Db; site: SiteRow; def: SiteDefinition; ctx: RenderContext; now: Date; }
export type ListingPostPage = { status: number; html: string } | { status: 303; location: string };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The listings section the form belongs to — only one that allows posts. */
function sectionOf(def: SiteDefinition, id: string): { props: ListingsProps; path: string } | null {
    for (const p of def.pages) {
        const s = p.sections.find((x) => x.id === id);
        if (s && s.type === 'listings' && s.props.allowPosts) return { props: s.props, path: p.slug ? `/${p.slug}` : '/' };
    }
    return null;
}
const page = (b: ListingPostCtx, title: string, inner: string, status = 200): ListingPostPage =>
    ({ status, html: renderSiteShell(b.def, b.ctx, title, `<section><div class="w n">${inner}</div></section>`) });

export function listingPostPage(b: ListingPostCtx, q: URLSearchParams, message: string | null = null, kept: Record<string, string> = {}): ListingPostPage {
    const sid = String(q.get('s') || '').slice(0, 40);
    const sec = sectionOf(b.def, sid);
    const business = b.def.settings.siteName;
    if (!sec) return page(b, 'Not available', `<h1>This form isn't available</h1><p>${esc(business)} isn't taking listings from visitors here.</p><p><a class="btn s" href="/">Back to the website</a></p>`, 404);
    const back = `<p><a class="btn s" href="${esc(sec.path)}">Back to the website</a></p>`;
    if (q.get('done') === '1') {
        return page(b, 'Thank you', `<h1>Thank you</h1><p>${esc(business)} will look at it before it appears on the website.</p>${back}`);
    }
    const event = sec.props.kind === 'event';
    const cats = sec.props.categories;
    const v = (k: string) => esc(kept[k] ?? '');
    const catField = cats.length
        ? `<label>Category<select name="category"><option value="">Choose…</option>${cats.map((c) => `<option${kept.category === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>`
        : `<label>Category (optional)<input name="category" maxlength="${LISTING_LIMITS.category}" value="${v('category')}" placeholder="${event ? 'e.g. Music' : 'e.g. Cafés'}"></label>`;
    return page(b, sec.props.postLabel, `<h1>${esc(sec.props.postLabel)}</h1>
<p>${esc(business)} reads everything sent in before it appears on the website.</p>
${message ? `<p class="fine" role="alert" style="color:#b91c1c"><strong>${esc(message)}</strong></p>` : ''}
<form class="fm" method="post" action="${FORM_ACTION}">
<input type="hidden" name="_k" value="listing"><input type="hidden" name="_s" value="${esc(sid)}"><input type="hidden" name="_t" value="${b.now.getTime()}">
<div class="hp" aria-hidden="true"><label>Leave this empty <input name="website" tabindex="-1" autocomplete="off"></label></div>
<label>${event ? 'Name of the event' : 'Name'}<input name="title" maxlength="${LISTING_LIMITS.title}" required value="${v('title')}"></label>
${event ? `<label>Date<input type="date" name="startsOn" required value="${v('startsOn')}"></label>
<label>Starts at (optional)<input type="time" name="startTime" value="${v('startTime')}"></label>
<label>Ends at (optional)<input type="time" name="endTime" value="${v('endTime')}"></label>
<label>Last day, if it runs over several days (optional)<input type="date" name="endsOn" value="${v('endsOn')}"></label>` : ''}
<label>Where${event ? '' : ' (optional)'}<input name="location" maxlength="${LISTING_LIMITS.location}" ${event ? 'required' : ''} value="${v('location')}"></label>
${catField}
<label>In a sentence<input name="summary" maxlength="${LISTING_LIMITS.summary}" required value="${v('summary')}"></label>
<label>More about it (optional)<textarea name="body" rows="5" maxlength="2000">${v('body')}</textarea></label>
<label>A link for tickets or details (optional)<input name="linkUrl" maxlength="${LISTING_LIMITS.url}" inputmode="url" value="${v('linkUrl')}" placeholder="https://…"></label>
<label>Your name<input name="name" maxlength="${LISTING_LIMITS.name}" required autocomplete="name" value="${v('name')}"></label>
<label>Your email<input type="email" name="email" maxlength="${LISTING_LIMITS.email}" required autocomplete="email" value="${v('email')}"></label>
<label class="opt"><input type="checkbox" name="consent" value="yes" required ${kept.consent === 'yes' ? 'checked' : ''}> <span>This is accurate, and ${esc(business)} may show it on their website.</span></label>
<button class="btn" type="submit">Send it in</button>
<p class="fine">Your name and email are only for ${esc(business)}, in case they need to ask you something — they're never shown.</p>
</form>${back}`);
}

/** The form, posted to /_form with _k=listing. */
export async function listingPostSubmit(b: ListingPostCtx, body: URLSearchParams, ip: string): Promise<ListingPostPage> {
    const sid = String(body.get('_s') || '').slice(0, 40);
    const sec = sectionOf(b.def, sid);
    if (!sec) return listingPostPage(b, new URLSearchParams({ s: sid }));
    const done = { status: 303 as const, location: `${LISTING_POST_PATH}?s=${encodeURIComponent(sid)}&done=1` };
    // A bot: the hidden field, or faster than a person could fill it in. Thanked; nothing saved.
    const started = Number(body.get('_t'));
    if (String(body.get('website') || '').trim() || !Number.isFinite(started) || b.now.getTime() - started < LISTING_MIN_FILL_MS) return done;

    const keys = ['title', 'startsOn', 'startTime', 'endTime', 'endsOn', 'location', 'category', 'summary', 'body', 'linkUrl', 'name', 'email', 'consent'];
    const kept = Object.fromEntries(keys.map((k) => [k, String(body.get(k) || '').slice(0, 2000)]));
    const retry = (m: string) => listingPostPage(b, new URLSearchParams({ s: sid }), m, kept);
    if (kept.consent !== 'yes') return retry('Please tick the box to say it may be shown.');
    const name = kept.name.replace(/\s+/g, ' ').trim().slice(0, LISTING_LIMITS.name);
    const email = kept.email.trim().slice(0, LISTING_LIMITS.email);
    if (!name) return retry('Add your name.');
    if (!EMAIL_RE.test(email)) return retry('Check your email address.');
    if (!kept.summary.trim()) return retry('Say what it is in a sentence.');
    const event = sec.props.kind === 'event';
    const category = sec.props.categories.length
        ? (sec.props.categories.find((c) => c === kept.category) ?? null)
        : kept.category;
    const raw: Record<string, unknown> = {
        kind: sec.props.kind, title: kept.title, summary: kept.summary, body: kept.body, location: kept.location, category,
        linkUrl: kept.linkUrl || null,
        ...(event ? { startsOn: kept.startsOn, startTime: kept.startTime || null, endTime: kept.endTime || null, endsOn: kept.endsOn || null } : {}),
    };
    const cleaned = cleanListing(raw, false);
    if (!cleaned.ok) return retry(cleaned.error);
    const v = cleaned.value as Record<string, string | null>;
    const whole = checkWhole({ kind: sec.props.kind, startsOn: v.startsOn ?? null, endsOn: v.endsOn ?? null, startTime: v.startTime ?? null, endTime: v.endTime ?? null, imageAssetId: null, imageAlt: null });
    if (whole) return retry(whole);
    if (event && v.startsOn && v.startsOn < ukToday(b.now)) return retry('That date has already passed.');
    if (event && !v.location) return retry('Say where it is.');
    try {
        const limit = await checkRateLimit(b.db, 'site_listing_ip', ip, LISTING_PER_IP);
        if (!limit.allowed) return retry('Lots of listings have been sent from here just now. Please try again later.');
    } catch (err) {
        console.error('[site-listing-post] rate limiter unavailable — allowing it', err);
    }
    const slug = await freeSlug(b.db, b.site.organisationId, String(v.title));
    const [row] = await b.db.insert(siteListings).values({
        ...(cleaned.value as Record<string, unknown>), organisationId: b.site.organisationId, slug,
        status: 'pending', source: 'public', submitterName: name, submitterEmail: email,
    } as typeof siteListings.$inferInsert).returning();
    await tellOwner(b, row);
    return done;
}

/** The owner hears about it by email, with what was sent and where to approve it. */
async function tellOwner(b: ListingPostCtx, row: typeof siteListings.$inferSelect): Promise<void> {
    const owner = await ownerOf(b.db, b.site.aiAssistantId ?? null);
    if (!owner?.email) return;
    const when = whenText(row);
    await sendEmail({
        to: owner.email,
        ...(row.submitterEmail ? { replyTo: row.submitterEmail } : {}),
        subject: `Waiting for your approval: "${row.title}"`,
        html: `<p><strong>${esc(row.submitterName || 'A visitor')}</strong>${row.submitterEmail ? ` (${esc(row.submitterEmail)} — reply to this email to write to them)` : ''} sent this in on your website:</p>
<p><strong>${esc(row.title)}</strong>${when ? `<br>${esc(when)}` : ''}${row.location ? `<br>${esc(row.location)}` : ''}${row.category ? `<br>Category: ${esc(row.category)}` : ''}</p>
${row.summary ? `<p>${esc(row.summary)}</p>` : ''}${row.body ? `<blockquote>${esc(row.body).replace(/\n/g, '<br>')}</blockquote>` : ''}
${row.linkUrl ? `<p>Link: ${esc(row.linkUrl)}</p>` : ''}
<p>It isn't on your website yet. Approve or decline it on your Website Assistant's Listings tab, or ask ${esc(owner.name)} in the chat.</p>`,
    }).catch((err: unknown) => console.error('[site-listing-post] owner email failed', err instanceof Error ? err.message : err));
}
