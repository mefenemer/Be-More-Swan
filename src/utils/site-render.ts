// src/utils/site-render.ts — turn a site definition into the pages a visitor gets.
// docs/website-assistant-plan.md §5.2. PURE: definition in, strings out. tests/site-render.test.ts.
//
// What every page this renders is guaranteed to have, because the definition gate
// (site-definition.ts) allows nothing else and this file adds nothing else:
//   · exactly one <h1>, a title, a search description, a canonical address and share tags;
//   · structured data saying what the business is (and FAQPage for its questions) — the things the
//     Mystery Shopper checks for, so a site we build starts by passing those checks;
//   · a mobile viewport and its own small stylesheet — NO JavaScript at all (the only <script> is
//     JSON-LD data), so there is nothing on a customer's site to break or to be exploited;
//   · every piece of text escaped; links are only what the gate allowed;
//   · a "Report this site" link in the footer — we host it, so anyone must be able to report abuse;
//   · on a draft preview, noindex and a robots.txt that disallows everything.
//   · forms (contact, sign-up — step 3b) are plain HTML that POST to the site's own /_form: they work
//     with no script at all. In the editor's preview they are drawn but switched off.

import { directionsUrl, openingHoursSpecification, openStatus, upcomingClosures, weekRows, whatsappUrl } from './business-hours';
import { formatDate } from './booking-time';
import type { WeeklyHours } from './booking-availability';
import { buttonInk, menuOf, type Link, type Section, type SiteDefinition, type SitePageDef, type SiteTheme } from './site-definition';

/** What a sign-up section needs to draw one Form Builder form (form-definition.ts publicDefinition). */
export interface SiteSignupForm {
    content: { headline: string; intro: string; buttonLabel: string };
    fields: Array<{ id: string; type: string; label: string; placeholder: string; help: string; required: boolean; options: Array<{ value: string; label: string }> }>;
    consent: { text: string; requireCheckbox: boolean };
}

/** Where forms post, on the site's own origin (sites-host forwards it to site-serve.ts). */
export const FORM_ACTION = '/_form';
/** A product as drawn: from Business Information, never typed into the site (site-shop.ts SiteProduct). */
export interface SiteRenderProduct { id: number; name: string; description: string | null; price: string | null; buyPence: number | null; imageAssetId: number | null; durationMinutes?: number | null; }

/** "45 min", "1 hr", "1 hr 30 min". */
export function formatDuration(minutes: number): string {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return [h ? `${h} hr` : '', m ? `${m} min` : ''].filter(Boolean).join(' ');
}

/** A booking section's first step needs only this: the services (with duration) and the largest party. */
/** Business Information's hours and location, as the site needs them (bookings.ts businessSummary). */
export interface SiteRenderBusiness { timezone: string; weeklyHours: WeeklyHours; closures: Array<{ date: string; note?: string | null }>; visitAddress: string | null; whatsapp: string | null; }

export interface SiteRenderBooking { ready: boolean; services: Array<{ id: number; name: string; price: string | null; durationMinutes: number }>; maxPartySize: number; }

/** Where every booking step lives (booking-render.ts, served by site-serve.ts). */
export const BOOK_PATH = '/_book';

/** Where a Buy button posts (step 3c) — site-serve.ts starts a Stripe Checkout and redirects. */
export const BUY_ACTION = '/_buy';

/** Pence → "£12.50" ("£12" when whole). Sites sell in pounds sterling. */
export function formatPrice(pence: number): string {
    const pounds = pence / 100;
    return `£${Number.isInteger(pounds) ? pounds.toLocaleString('en-GB') : pounds.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The page a form lands on afterwards — drawn by site-serve.ts in the site's own look. */
export const FORM_SENT_PATH = '/_sent';

export interface RenderContext {
    /** The site's own origin, e.g. https://willowbrook.bemoreswan.site — canonical URLs start here. */
    origin: string;
    /** A draft preview: noindex, and a banner saying it is not live. */
    preview: boolean;
    /** Where "Report this site" goes (our abuse form, carrying the site's id). */
    reportUrl: string;
    /** "Made with Be More Swan" link target; null leaves the credit out. */
    creditUrl: string | null;
    /** For the copyright line; defaults to now. */
    year?: number;
    /**
     * Where an internal link ('/', '/contact') really points. The live site leaves them as they are;
     * the editor's preview maps them onto its own preview address, so clicking around the preview
     * stays inside it instead of landing on the app.
     */
    pagePath?: (path: string) => string;
    /** Sign-up forms by audience_forms id, already checked to be this workspace's and active. */
    forms?: Record<number, SiteSignupForm>;
    /** When this page was drawn (ms) — a form posted back faster than a person could is a bot. */
    renderedAt?: number;
    /** The workspace's Stripe account can take payments — Buy buttons are drawn (live site only). */
    canSell?: boolean;
    /** Business Information products the products sections name (site-shop.ts loadSiteProducts). */
    products?: Record<number, SiteRenderProduct>;
    /** What a booking section can offer (bookings.ts loadBookingSetup, summarised); null = not set up. */
    booking?: SiteRenderBooking | null;
    /** Opening hours and where to find the business (Business Information) — the hours section and search data. */
    business?: SiteRenderBusiness | null;
    /** "Now", for the Open-now badge (tests pass a fixed time). */
    now?: Date;
    /**
     * The public address of a library picture (signed, permanent — newsletterMediaUrl). Without it a
     * library picture is not drawn (it has no web address of its own).
     */
    assetUrl?: (assetId: number) => string | null;
}

export interface RenderedPage { status: 200 | 404; html: string; }

export function esc(v: unknown): string {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** JSON for a <script type="application/ld+json"> block — `<` escaped so text can never close it. */
export function jsonLd(value: unknown): string {
    return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

const FONT_STACK: Record<SiteTheme['font'], string> = {
    sans: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    system: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    serif: 'Georgia, Cambria, "Times New Roman", Times, serif',
    rounded: 'ui-rounded, "SF Pro Rounded", system-ui, -apple-system, "Segoe UI", sans-serif',
};
const RADIUS: Record<SiteTheme['radius'], string> = { none: '0', small: '4px', medium: '10px', large: '18px' };

/** The stylesheet: tokens from the theme, nothing else. Hex colours only (the gate made sure). */
export function themeCss(theme: SiteTheme): string {
    const ink = buttonInk(theme);
    return `:root{--p:${theme.primaryColor};--t:${theme.textColor};--b:${theme.backgroundColor};--ink:${ink};--r:${RADIUS[theme.radius]};--f:${FONT_STACK[theme.font]}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}body{margin:0;font-family:var(--f);color:var(--t);background:var(--b);line-height:1.6;font-size:17px}
img{max-width:100%;height:auto;display:block}a{color:var(--p)}h1,h2,h3{line-height:1.2;margin:0 0 .5em}h1{font-size:clamp(2rem,5vw,3.2rem)}h2{font-size:clamp(1.5rem,3.5vw,2.2rem)}h3{font-size:1.15rem}
p{margin:0 0 1em}.w{max-width:1080px;margin:0 auto;padding:0 20px}.n{max-width:760px}
.hd{border-bottom:1px solid rgba(0,0,0,.08)}.hd .w{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;padding-top:14px;padding-bottom:14px}
.brand{font-weight:800;font-size:1.15rem;text-decoration:none;color:var(--t)}.brand img{max-height:40px;width:auto}
.nav{display:flex;flex-wrap:wrap;gap:4px 18px;margin:0;padding:0;list-style:none}.nav a{text-decoration:none;color:var(--t);font-weight:600;font-size:.95rem}.nav a[aria-current=page]{color:var(--p)}
section{padding:64px 0}.alt{background:rgba(0,0,0,.035)}
.btn{display:inline-block;padding:12px 22px;border-radius:var(--r);background:var(--p);color:var(--ink);font-weight:700;text-decoration:none;margin:4px 8px 4px 0}.btn.s{background:transparent;color:var(--p);border:2px solid var(--p)}
.hero{text-align:center}.hero .eb{text-transform:uppercase;letter-spacing:.08em;font-weight:700;font-size:.8rem;color:var(--p);margin-bottom:.8em}.hero .sub{font-size:1.2rem;max-width:680px;margin:0 auto 1.4em;opacity:.85}
.hero.split .w{display:grid;gap:32px;align-items:center;text-align:left}@media(min-width:800px){.hero.split .w{grid-template-columns:1.1fr 1fr}}.hero.split .sub{margin-left:0}
.hero.banner{background:var(--p);color:var(--ink)}.hero.banner .eb,.hero.banner a.btn.s{color:var(--ink);border-color:var(--ink)}.hero.banner .btn:not(.s){background:var(--ink);color:var(--p)}
.hero img{border-radius:var(--r);margin:24px auto 0}.hero.split img{margin:0}
.grid{display:grid;gap:24px;margin-top:28px}@media(min-width:700px){.grid{grid-template-columns:repeat(auto-fit,minmax(240px,1fr))}}
.card{border:1px solid rgba(0,0,0,.08);border-radius:var(--r);padding:22px;background:var(--b)}.num{display:inline-flex;width:34px;height:34px;border-radius:50%;background:var(--p);color:var(--ink);align-items:center;justify-content:center;font-weight:800;margin-bottom:10px}
.intro{max-width:680px;opacity:.85}details{border:1px solid rgba(0,0,0,.1);border-radius:var(--r);padding:14px 18px;margin:10px 0;background:var(--b)}summary{cursor:pointer;font-weight:700}details p{margin:.6em 0 0}
.cta{text-align:center}.cta .box{background:var(--p);color:var(--ink);border-radius:var(--r);padding:44px 24px}.cta .btn{background:var(--ink);color:var(--p)}
.ft{border-top:1px solid rgba(0,0,0,.08);padding:28px 0;font-size:.85rem;opacity:.85}.ft .w{display:flex;flex-wrap:wrap;gap:8px 20px;justify-content:space-between}.ft a{color:inherit}
.pv{background:#111;color:#fff;text-align:center;font-size:.85rem;padding:8px}
.menu{list-style:none;padding:0;margin:8px 0 0}.menu li{padding:10px 0;border-bottom:1px solid rgba(0,0,0,.08)}.mi{display:flex;align-items:baseline;gap:8px}.mn{font-weight:600}.mt{font-weight:400;font-size:.85rem;opacity:.7;white-space:nowrap}.ml{flex:1;min-width:16px;border-bottom:1px dotted currentColor;opacity:.35}.mp{font-weight:700;white-space:nowrap}.md{margin:4px 0 0;font-size:.92rem;opacity:.8}.mnote{margin-top:20px}
.badge{display:inline-block;padding:6px 12px;border-radius:999px;font-size:.9rem}.badge.on{background:#dcfce7;color:#14532d}.badge.off{background:#f3f4f6;color:#1f2937}
.hrs{border-collapse:collapse;margin:8px 0 12px;min-width:min(100%,360px)}.hrs th{text-align:left;font-weight:600;padding:6px 24px 6px 0}.hrs td{padding:6px 0}.hrs tr.today{font-weight:800}.hrs tr+tr{border-top:1px solid rgba(0,0,0,.08)}
address{font-style:normal;margin:0 0 12px}
html{scroll-behavior:smooth}section[id]{scroll-margin-top:12px}
.band{background:var(--p);color:var(--ink)}.band a:not(.btn){color:var(--ink)}.band .card,.band details{color:var(--t)}.band .btn{background:var(--ink);color:var(--p)}
@media(min-width:700px){.grid.c2{grid-template-columns:repeat(2,minmax(0,1fr))}.grid.c3{grid-template-columns:repeat(3,minmax(0,1fr))}}
.tx{display:grid;gap:28px;align-items:center}.tx img{border-radius:var(--r)}@media(min-width:800px){.tx{grid-template-columns:1fr 1fr}.tx.left img{order:0}.tx.right img{order:2}}
.fm{display:grid;gap:14px;margin-top:20px;max-width:560px}.fm label{display:grid;gap:4px;font-weight:600;font-size:.95rem}.fm .opt{display:flex;gap:8px;align-items:flex-start;font-weight:400}
.fm input:not([type=checkbox]):not([type=radio]),.fm textarea,.fm select{font:inherit;color:var(--t);background:var(--b);border:1px solid rgba(0,0,0,.25);border-radius:var(--r);padding:10px 12px;width:100%}
.fm fieldset{border:0;padding:0;margin:0;display:grid;gap:6px}.fm legend{font-weight:600;font-size:.95rem;margin-bottom:4px}.fm .help,.fm .fine{font-size:.85rem;opacity:.8;font-weight:400;margin:0}
.fm button{border:0;cursor:pointer;font:inherit;justify-self:start}.fm button[disabled]{opacity:.6;cursor:not-allowed}.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}`;
}

const paragraphs = (text: string) => text.split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');

/** Set per render call (renderSitePage) — internal links go through the context's pagePath. */
let mapPath: (path: string) => string = (p) => p;
/** Set per render call — library pictures (assetId) resolve through the context's assetUrl. */
let assetUrlOf: (id: number) => string | null = () => null;
/** Where a picture loads from: its library link, else its web address; '' when it has neither. */
export function imageSrc(img: { url: string; assetId?: number | null } | null | undefined): string {
    if (!img) return '';
    if (img.assetId) return assetUrlOf(img.assetId) || '';
    return img.url || '';
}
function logoSrc(theme: SiteTheme): string {
    return theme.logoAssetId ? (assetUrlOf(theme.logoAssetId) || theme.logoUrl || '') : (theme.logoUrl || '');
}
/** Set per render call — forms are drawn live, or switched off in the preview. */
let business: { info: SiteRenderBusiness | null; now: Date; settings: SiteDefinition['settings'] | null } = { info: null, now: new Date(0), settings: null };
let formState: { preview: boolean; forms: Record<number, SiteSignupForm>; renderedAt: number; path: string; canSell: boolean; products: Record<number, SiteRenderProduct>; booking: SiteRenderBooking | null } = { preview: true, forms: {}, renderedAt: 0, path: '/', canSell: false, products: {}, booking: null };

function formOpen(sectionId: string, kind: 'contact' | 'signup'): string {
    return `<form class="fm" method="post" action="${FORM_ACTION}">
<input type="hidden" name="_s" value="${esc(sectionId)}"><input type="hidden" name="_k" value="${kind}"><input type="hidden" name="_t" value="${formState.renderedAt}"><input type="hidden" name="_p" value="${esc(formState.path)}">
<div class="hp" aria-hidden="true"><label>Leave this empty <input name="website" tabindex="-1" autocomplete="off"></label></div>`;
}
function formButton(label: string): string {
    return formState.preview
        ? `<button class="btn" type="submit" disabled>${esc(label)}</button><p class="fine">Forms work on your live site, not in this preview.</p>`
        : `<button class="btn" type="submit">${esc(label)}</button>`;
}

function signupFieldHtml(f: SiteSignupForm['fields'][number]): string {
    const name = `a_${f.id}`;
    const req = f.required ? ' required' : '';
    const help = f.help ? `<span class="help">${esc(f.help)}</span>` : '';
    const ph = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : '';
    if (f.type === 'radio' || f.type === 'checkbox') {
        const kind = f.type === 'radio' ? 'radio' : 'checkbox';
        if (!f.options.length) return `<label class="opt"><input type="checkbox" name="${esc(name)}" value="yes"${req}> ${esc(f.label)}</label>${help}`;
        return `<fieldset><legend>${esc(f.label)}</legend>${help}${f.options.map((o) => `<label class="opt"><input type="${kind}" name="${esc(name)}" value="${esc(o.value)}"${f.type === 'radio' ? req : ''}> ${esc(o.label)}</label>`).join('')}</fieldset>`;
    }
    if (f.type === 'select') {
        return `<label>${esc(f.label)}${help}<select name="${esc(name)}"${req}><option value="">Choose…</option>${f.options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select></label>`;
    }
    if (f.type === 'textarea') return `<label>${esc(f.label)}${help}<textarea name="${esc(name)}" rows="4" maxlength="2000"${ph}${req}></textarea></label>`;
    const type = f.type === 'email' ? 'email' : f.type === 'phone' ? 'tel' : 'text';
    const auto = f.type === 'email' ? ' autocomplete="email"' : f.type === 'phone' ? ' autocomplete="tel"' : '';
    return `<label>${esc(f.label)}${help}<input type="${type}" name="${esc(name)}" maxlength="300"${auto}${ph}${req}></label>`;
}
const href = (h: string) => (h.startsWith('/') ? mapPath(h) : h);

function linkHtml(l: Link, secondary = false): string {
    return `<a class="btn${secondary ? ' s' : ''}" href="${esc(href(l.href))}">${esc(l.label)}</a>`;
}

/** One section. `h1` is true for the single section that carries the page's main heading. */
/** The background a section is drawn on: none, the soft tint, or the brand colour (look.background). */
type SectionBg = '' | 'alt' | 'band';

function sectionHtml(s: Section, h1: boolean, bg: SectionBg): string {
    const H = h1 ? 'h1' : 'h2';
    const cls = bg ? ` class="${bg}"` : '';
    switch (s.type) {
        case 'hero': {
            const p = s.props;
            const buttons = [p.primaryCta && linkHtml(p.primaryCta), p.secondaryCta && linkHtml(p.secondaryCta, true)].filter(Boolean).join('');
            const copy = `${p.eyebrow ? `<p class="eb">${esc(p.eyebrow)}</p>` : ''}<${H}>${esc(p.headline)}</${H}>${p.subheadline ? `<p class="sub">${esc(p.subheadline)}</p>` : ''}${buttons ? `<p>${buttons}</p>` : ''}`;
            const src = imageSrc(p.image);
            const img = p.image && src ? `<img src="${esc(src)}" alt="${esc(p.image.alt)}" loading="eager">` : '';
            return `<section class="hero ${p.layout}" id="${esc(s.id)}"><div class="w">${p.layout === 'split' ? `<div>${copy}</div>${img}` : `${copy}${img}`}</div></section>`;
        }
        case 'features':
        case 'steps': {
            const p = s.props;
            const cards = p.items.map((it, i) => `<div class="card">${s.type === 'steps' ? `<span class="num">${i + 1}</span>` : ''}<h3>${esc(it.title)}</h3>${it.body ? paragraphs(it.body) : ''}</div>`).join('');
            const list = s.type === 'steps' ? `<ol class="grid" style="list-style:none;padding:0">${p.items.map((it, i) => `<li class="card"><span class="num">${i + 1}</span><h3>${esc(it.title)}</h3>${it.body ? paragraphs(it.body) : ''}</li>`).join('')}</ol>` : `<div class="grid">${cards}</div>`;
            return `<section${cls} id="${esc(s.id)}"><div class="w">${p.heading ? `<${H}>${esc(p.heading)}</${H}>` : ''}${p.intro ? `<div class="intro">${paragraphs(p.intro)}</div>` : ''}${list}</div></section>`;
        }
        case 'text': {
            const p = s.props;
            const words = `${p.heading ? `<${H}>${esc(p.heading)}</${H}>` : ''}${paragraphs(p.body)}`;
            const src = imageSrc(p.image);
            if (p.image && src) {
                // Beside the words on a wide screen (left or right), above them on a phone.
                return `<section${cls} id="${esc(s.id)}"><div class="w tx ${p.imageSide}"><img src="${esc(src)}" alt="${esc(p.image.alt)}" loading="lazy"><div>${words}</div></div></section>`;
            }
            return `<section${cls} id="${esc(s.id)}"><div class="w n">${words}</div></section>`;
        }
        case 'faq': {
            const p = s.props;
            return `<section${cls} id="${esc(s.id)}"><div class="w n">${p.heading ? `<${H}>${esc(p.heading)}</${H}>` : ''}${p.items.map((it) => `<details><summary>${esc(it.q)}</summary>${paragraphs(it.a)}</details>`).join('')}</div></section>`;
        }
        case 'testimonials': {
            const p = s.props;
            return `<section${cls} id="${esc(s.id)}"><div class="w">${p.heading ? `<${H}>${esc(p.heading)}</${H}>` : ''}<div class="grid">${p.items.map((it) => `<figure class="card testimonial" style="margin:0"><blockquote style="margin:0">${paragraphs(it.quote)}</blockquote><figcaption><strong>${esc(it.name)}</strong>${it.detail ? `, ${esc(it.detail)}` : ''}</figcaption></figure>`).join('')}</div></div></section>`;
        }
        case 'cta': {
            const p = s.props;
            return `<section class="cta" id="${esc(s.id)}"><div class="w"><div class="box"><${H}>${esc(p.heading)}</${H}>${p.body ? paragraphs(p.body) : ''}<p>${linkHtml(p.button)}</p></div></div></section>`;
        }
        case 'contact': {
            const p = s.props;
            return `<section${cls} id="${esc(s.id)}"><div class="w n">${p.heading ? `<${H}>${esc(p.heading)}</${H}>` : ''}${p.intro ? paragraphs(p.intro) : ''}
${formOpen(s.id, 'contact')}
<label>Your name<input name="name" required maxlength="120" autocomplete="name"></label>
<label>Email<input type="email" name="email" required maxlength="254" autocomplete="email"></label>
${p.askPhone ? '<label>Phone <span class="help">(optional)</span><input type="tel" name="phone" maxlength="30" autocomplete="tel"></label>' : ''}
<label>Message<textarea name="message" rows="5" required maxlength="4000"></textarea></label>
${formButton(p.buttonLabel)}
<p class="fine">Your details are used only to reply to you.</p>
</form></div></section>`;
        }
        case 'products': {
            const p = s.props;
            const card = (name: string, description: string | null, price: string | null, imgSrc: string, imgAlt: string, buy: string) =>
                `<div class="card">${imgSrc ? `<img src="${esc(imgSrc)}" alt="${esc(imgAlt)}" loading="lazy" style="border-radius:var(--r);margin-bottom:12px">` : ''}<h3>${esc(name)}</h3>${price ? `<p class="price"><strong>${esc(price)}</strong></p>` : ''}${description ? paragraphs(description) : ''}${buy}</div>`;
            // Business Information products, in the section's order; one archived or deleted since is skipped.
            const fromCatalogue = p.productIds.map((id) => formState.products[id]).filter(Boolean).map((pr) => {
                let buy = '';
                if (pr.buyPence !== null) {
                    if (formState.preview) buy = `<p><button class="btn" type="button" disabled>${esc(p.buyLabel)}</button></p>`;
                    else if (formState.canSell) {
                        buy = `<form method="post" action="${BUY_ACTION}"><input type="hidden" name="_s" value="${esc(s.id)}"><input type="hidden" name="_pid" value="${pr.id}"><input type="hidden" name="_n" value="${esc(pr.name)}"><input type="hidden" name="_v" value="${pr.buyPence}"><input type="hidden" name="_p" value="${esc(formState.path)}"><button class="btn" type="submit">${esc(p.buyLabel)}</button></form>`;
                    }
                }
                const src = pr.imageAssetId ? assetUrlOf(pr.imageAssetId) || '' : '';
                return card(pr.name, pr.description, pr.price, src, pr.name, buy);
            });
            // Older sites: items typed into the site itself — shown, never sold (moved via Business Information).
            const legacy = p.productIds.length ? [] : p.items.map((it) => card(it.name, it.description, it.price !== null ? formatPrice(it.price) : null, imageSrc(it.image), it.image?.alt ?? '', ''));
            const cards = [...fromCatalogue, ...legacy];
            if (!cards.length) return formState.preview
                ? `<section${cls} id="${esc(s.id)}"><div class="w n"><p class="fine">Products section: the products it shows are archived or removed in Business Information.</p></div></section>` : '';
            const note = formState.preview && fromCatalogue.length && p.productIds.some((id) => formState.products[id]?.buyPence != null)
                ? '<p class="fine">Buy buttons work on your live site once your Stripe account is connected (Orders tab).</p>' : '';
            return `<section${cls} id="${esc(s.id)}"><div class="w">${p.heading ? `<${H}>${esc(p.heading)}</${H}>` : ''}${p.intro ? `<div class="intro">${paragraphs(p.intro)}</div>` : ''}${note}<div class="grid">${cards.join('')}</div></div></section>`;
        }
        case 'menu': {
            // Names, prices, descriptions and lengths from Business Information; the groups are the owner's.
            const p = s.props;
            const groups = p.groups.map((g) => ({ title: g.title, items: g.productIds.map((id) => formState.products[id]).filter(Boolean) })).filter((g) => g.items.length);
            if (!groups.length) return formState.preview
                ? `<section${cls} id="${esc(s.id)}"><div class="w n"><p class="fine">Menu / price list: the products it shows are archived or removed in Business Information.</p></div></section>` : '';
            const line = (pr: SiteRenderProduct) => `<li><div class="mi"><span class="mn">${esc(pr.name)}${p.showDurations && pr.durationMinutes ? ` <span class="mt">${esc(formatDuration(pr.durationMinutes))}</span>` : ''}</span><span class="ml" aria-hidden="true"></span>${pr.price ? `<span class="mp">${esc(pr.price)}</span>` : ''}</div>${p.showDescriptions && pr.description ? `<p class="md">${esc(pr.description)}</p>` : ''}</li>`;
            return `<section${cls} id="${esc(s.id)}"><div class="w">${p.heading ? `<${H}>${esc(p.heading)}</${H}>` : ''}${p.intro ? `<div class="intro">${paragraphs(p.intro)}</div>` : ''}<div class="grid">${groups.map((g) => `<div>${g.title ? `<h3>${esc(g.title)}</h3>` : ''}<ul class="menu">${g.items.map(line).join('')}</ul></div>`).join('')}</div>${p.note ? `<div class="fine mnote">${paragraphs(p.note)}</div>` : ''}</div></section>`;
        }
        case 'hours': {
            // Everything from Business Information and the site's business details — nothing typed here.
            const p = s.props;
            const info = business.info;
            const st = business.settings!;
            const status = info ? openStatus(info.weeklyHours, info.closures, info.timezone, business.now) : null;
            const rows = info && status ? weekRows(info.weeklyHours, info.timezone, business.now) : [];
            const closed = info ? upcomingClosures(info.closures, info.timezone, business.now) : [];
            const wa = info?.whatsapp ? whatsappUrl(info.whatsapp) : null;
            const buttons = p.showContact ? [
                st.phone ? `<a class="btn" href="tel:${esc(st.phone.replace(/[^0-9+]/g, ''))}">Call ${esc(st.phone)}</a>` : '',
                wa ? `<a class="btn s" href="${esc(wa)}" rel="noopener">WhatsApp</a>` : '',
                st.email ? `<a class="btn s" href="mailto:${esc(st.email)}">Email us</a>` : '',
                info?.visitAddress ? `<a class="btn s" href="${esc(directionsUrl(info.visitAddress))}" rel="noopener">Get directions</a>` : '',
            ].filter(Boolean) : [];
            const hoursHtml = p.showHours && status ? `<p class="badge ${status.open ? 'on' : 'off'}"><strong>${esc(status.text)}</strong></p>
<table class="hrs"><tbody>${rows.map((r) => `<tr${r.today ? ' class="today"' : ''}><th scope="row">${esc(r.day)}</th><td>${esc(r.text)}</td></tr>`).join('')}</tbody></table>
${closed.length ? `<p class="fine">${closed.map((c) => `Closed ${esc(formatDate(c.date))}${c.note ? ` (${esc(c.note)})` : ''}`).join(' · ')}</p>` : ''}` : '';
            const addressHtml = p.showAddress && info?.visitAddress ? `<address>${info.visitAddress.split('\n').map(esc).join('<br>')}</address>` : '';
            if (!hoursHtml && !addressHtml && !buttons.length) {
                return formState.preview
                    ? `<section${cls} id="${esc(s.id)}"><div class="w n"><p class="fine">Opening hours section: add your hours and where to find you in Business Information ▸ Hours, Location &amp; Bookings, and a phone or email in the Website tab's Business details. Until then it doesn't appear on your live site.</p></div></section>`
                    : '';
            }
            return `<section${cls} id="${esc(s.id)}"><div class="w n">${p.heading ? `<${H}>${esc(p.heading)}</${H}>` : ''}${p.intro ? paragraphs(p.intro) : ''}${hoursHtml}${addressHtml}${buttons.length ? `<p>${buttons.join('')}</p>` : ''}</div></section>`;
        }
        case 'booking': {
            // Step 1 only — what, or how many. Every later step is its own page (/_book), so the whole
            // flow works with no script. A GET form: choosing a time changes nothing until the last step.
            const p = s.props;
            const b = formState.booking;
            const services = b ? b.services.filter((x) => !p.serviceIds.length || p.serviceIds.includes(x.id)) : [];
            const ready = !!b && b.ready && (p.kind === 'table' || services.length > 0);
            if (!ready) {
                return formState.preview
                    ? `<section${cls} id="${esc(s.id)}"><div class="w n"><p class="fine">Booking section: set your opening hours${p.kind === 'table' ? '' : ' and give your services a length'} in Business Information ▸ Opening hours &amp; bookings. Until then it doesn't appear on your live site.</p></div></section>`
                    : '';
            }
            const choose = p.kind === 'table'
                ? `<label>How many people?<select name="party" required>${Array.from({ length: b!.maxPartySize }, (_, i) => `<option value="${i + 1}"${i === 1 ? ' selected' : ''}>${i + 1}</option>`).join('')}</select></label>`
                : `<fieldset><legend>${p.kind === 'consultation' ? 'Which kind of session?' : 'What would you like to book?'}</legend>${services.map((x, i) => `<label class="opt"><input type="radio" name="svc" value="${x.id}" required${i === 0 ? ' checked' : ''}> <span><strong>${esc(x.name)}</strong> · ${x.durationMinutes} min${x.price ? ` · ${esc(x.price)}` : ''}</span></label>`).join('')}</fieldset>`;
            const button = formState.preview
                ? `<button class="btn" type="submit" disabled>${esc(p.buttonLabel)}</button><p class="fine">Booking works on your live site, not in this preview.</p>`
                : `<button class="btn" type="submit">${esc(p.buttonLabel)}</button>`;
            return `<section${cls} id="${esc(s.id)}"><div class="w n">${p.heading ? `<${H}>${esc(p.heading)}</${H}>` : ''}${p.intro ? paragraphs(p.intro) : ''}
<form class="fm" method="get" action="${BOOK_PATH}"><input type="hidden" name="s" value="${esc(s.id)}">${choose}${button}</form></div></section>`;
        }
        case 'signup': {
            const p = s.props;
            const form = p.formId ? formState.forms[p.formId] : undefined;
            if (!form) {
                // Nothing to sign up to: the live site draws nothing; the preview says why.
                return formState.preview
                    ? `<section${cls} id="${esc(s.id)}"><div class="w n"><p class="fine">Sign-up section: choose one of your sign-up forms for it on the Website tab. Until then it doesn't appear on your live site.</p></div></section>`
                    : '';
            }
            const heading = p.heading || form.content.headline;
            const intro = p.intro || form.content.intro;
            const consent = form.consent.requireCheckbox
                ? `<label class="opt"><input type="checkbox" name="_consent" value="yes" required> ${esc(form.consent.text)}</label>`
                : `<p class="fine">${esc(form.consent.text)}</p>`;
            return `<section${cls} id="${esc(s.id)}"><div class="w n">${heading ? `<${H}>${esc(heading)}</${H}>` : ''}${intro ? paragraphs(intro) : ''}
${formOpen(s.id, 'signup')}
${form.fields.map(signupFieldHtml).join('\n')}
${consent}
${formButton(form.content.buttonLabel || 'Sign up')}
</form></div></section>`;
        }
    }
}

/** The section that carries the page's one <h1>: the first hero, or none (the page title is used). */
function h1SectionIndex(page: SitePageDef): number {
    return page.sections.findIndex((s) => s.type === 'hero');
}

function findPage(def: SiteDefinition, path: string): SitePageDef | null {
    const clean = (path || '/').split(/[?#]/)[0].replace(/\/+$/, '') || '/';
    const slug = clean === '/' ? '' : clean.replace(/^\//, '').toLowerCase();
    return def.pages.find((p) => p.slug === slug) ?? null;
}

function structuredData(def: SiteDefinition, page: SitePageDef, origin: string): unknown[] {
    const s = def.settings;
    const out: unknown[] = [];
    if (page.slug === '') {
        out.push({
            '@context': 'https://schema.org', '@type': s.businessType, name: s.siteName, url: `${origin}/`,
            ...(s.description ? { description: s.description } : {}),
            ...(logoSrc(def.theme) ? { logo: logoSrc(def.theme) } : {}),
            ...(s.email ? { email: s.email } : {}),
            ...(s.phone ? { telephone: s.phone } : {}),
            ...(s.locality || business.info?.visitAddress ? { address: { '@type': 'PostalAddress',
                ...(business.info?.visitAddress ? { streetAddress: business.info.visitAddress.split('\n').join(', ') } : {}),
                ...(s.locality ? { addressLocality: s.locality } : {}) } } : {}),
            ...(business.info && openingHoursSpecification(business.info.weeklyHours).length ? { openingHoursSpecification: openingHoursSpecification(business.info.weeklyHours) } : {}),
        });
    }
    // Things for sale, as Product + Offer — so search engines and AI assistants can quote the price.
    // Only a fixed price becomes an Offer; "from" or "on request" is shown on the page, not claimed here.
    const listed = new Set<number>();
    for (const sec of page.sections) {
        if (sec.type !== 'products' && sec.type !== 'menu') continue;
        for (const id of sec.type === 'products' ? sec.props.productIds : sec.props.groups.flatMap((g) => g.productIds)) {
            if (listed.has(id)) continue;
            listed.add(id);
            const pr = formState.products[id];
            if (!pr) continue;
            const img = pr.imageAssetId ? assetUrlOf(pr.imageAssetId) : null;
            out.push({
                '@context': 'https://schema.org', '@type': 'Product', name: pr.name,
                ...(pr.description ? { description: pr.description } : {}),
                ...(img ? { image: img } : {}),
                ...(pr.buyPence !== null ? { offers: { '@type': 'Offer', price: (pr.buyPence / 100).toFixed(2), priceCurrency: 'GBP', seller: { '@type': 'Organization', name: s.siteName } } } : {}),
            });
        }
    }
    const faqs = page.sections.flatMap((x) => (x.type === 'faq' ? x.props.items : []));
    if (faqs.length) {
        out.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });
    }
    return out;
}

function documentHtml(def: SiteDefinition, page: SitePageDef | null, ctx: RenderContext, body: string): string {
    const s = def.settings;
    const path = page ? (page.slug ? `/${page.slug}` : '/') : null;
    const title = page ? (page.seo.title || (page.slug === '' ? s.siteName : `${page.title} | ${s.siteName}`)) : `Page not found | ${s.siteName}`;
    const description = page ? (page.seo.description || (page.slug === '' ? s.description : null)) : null;
    const canonical = path ? `${ctx.origin}${path}` : null;
    const menu = menuOf(def);
    const year = ctx.year ?? new Date().getUTCFullYear();
    const ld = page ? structuredData(def, page, ctx.origin) : [];
    return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${description ? `<meta name="description" content="${esc(description)}">` : ''}
${ctx.preview || !page ? '<meta name="robots" content="noindex, nofollow">' : ''}
${canonical && !ctx.preview ? `<link rel="canonical" href="${esc(canonical)}">` : ''}
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(s.siteName)}">
<meta property="og:title" content="${esc(title)}">
${description ? `<meta property="og:description" content="${esc(description)}">` : ''}
${canonical ? `<meta property="og:url" content="${esc(canonical)}">` : ''}
<meta name="theme-color" content="${esc(def.theme.primaryColor)}">
<style>${themeCss(def.theme)}</style>
${ld.map((x) => `<script type="application/ld+json">${jsonLd(x)}</script>`).join('\n')}
</head>
<body>
${ctx.preview ? '<div class="pv">Preview — this version is not live yet.</div>' : ''}
<header class="hd"><div class="w">
<a class="brand" href="${esc(href('/'))}">${logoSrc(def.theme) ? `<img src="${esc(logoSrc(def.theme))}" alt="${esc(s.siteName)}">` : esc(s.siteName)}</a>
${menu.length > (def.structure === 'one_page' ? 0 : 1) ? `<nav aria-label="Main"><ul class="nav">${menu.map((m) => `<li><a href="${esc(m.sectionId && page && page.slug !== '' ? `${href('/')}${m.path}` : href(m.path))}"${page && m.pageId === page.id && !m.sectionId ? ' aria-current="page"' : ''}>${esc(m.label)}</a></li>`).join('')}</ul></nav>` : ''}
</div></header>
<main>
${body}
</main>
<footer class="ft"><div class="w">
<div>${def.footer.text ? `${paragraphs(def.footer.text)}` : ''}<p>© ${year} ${esc(s.siteName)}${s.email ? ` · <a href="mailto:${esc(s.email)}">${esc(s.email)}</a>` : ''}${s.phone ? ` · <a href="tel:${esc(s.phone.replace(/[^0-9+]/g, ''))}">${esc(s.phone)}</a>` : ''}</p></div>
<div><p>${ctx.creditUrl ? `<a href="${esc(ctx.creditUrl)}">Made with Be More Swan</a> · ` : ''}<a href="${esc(ctx.reportUrl)}" rel="nofollow">Report this site</a></p></div>
</div></footer>
</body>
</html>`;
}

/** One page by path ('/', '/services'). An unknown path is a real 404 page in the site's own look. */
export function renderSitePage(def: SiteDefinition, path: string, ctx: RenderContext): RenderedPage {
    mapPath = ctx.pagePath ?? ((p) => p);
    assetUrlOf = ctx.assetUrl ?? (() => null);
    const page = findPage(def, path);
    business = { info: ctx.business ?? null, now: ctx.now ?? new Date(), settings: def.settings };
    formState = { preview: ctx.preview, forms: ctx.forms ?? {}, renderedAt: ctx.renderedAt ?? Date.now(), path: page ? (page.slug ? `/${page.slug}` : '/') : '/', canSell: ctx.canSell === true, products: ctx.products ?? {}, booking: ctx.booking ?? null };
    if (!page) {
        return { status: 404, html: documentHtml(def, null, ctx, `<section><div class="w n"><h1>Page not found</h1><p>That page isn't here. <a href="${esc(href('/'))}">Go to the home page</a>.</p></div></section>`) };
    }
    const h1At = h1SectionIndex(page);
    let body = h1At < 0 ? `<section><div class="w n"><h1>${esc(page.title)}</h1></div></section>` : '';
    let shade = false;
    body += page.sections.map((s, i) => {
        // Background: 'auto' keeps the gentle alternation pages have always had; the owner can choose
        // plain, the soft tint, or a band of their brand colour (look.background).
        const look = s.look;
        const auto: SectionBg = shade && s.type !== 'hero' && s.type !== 'cta' ? 'alt' : '';
        const bg: SectionBg = !look || look.background === 'auto' ? auto : look.background === 'soft' ? 'alt' : look.background === 'brand' ? 'band' : '';
        if (s.type !== 'hero' && s.type !== 'cta') shade = !shade;
        let html = sectionHtml(s, i === h1At, bg);
        // Columns for grid sections (look.columns) — a class on the section's one grid.
        if (look && look.columns !== 'auto') html = html.replace('class="grid"', `class="grid c${look.columns}"`);
        return html;
    }).join('\n');
    return { status: 200, html: documentHtml(def, page, ctx, body) };
}

/** A plain page in the site's own look — what a visitor sees after sending a form, or when it fails. */
export function renderSiteNotice(def: SiteDefinition, ctx: RenderContext, title: string, message: string, back: { label: string; path: string }): string {
    mapPath = ctx.pagePath ?? ((p) => p);
    assetUrlOf = ctx.assetUrl ?? (() => null);
    const body = `<section><div class="w n"><h1>${esc(title)}</h1>${paragraphs(message)}<p><a class="btn" href="${esc(href(back.path))}">${esc(back.label)}</a></p></div></section>`;
    return documentHtml(def, null, { ...ctx }, body).replace('<title>Page not found |', `<title>${esc(title)} |`);
}

/** A page of the site's own, with any body — the booking steps (booking-render.ts). Never indexed. */
export function renderSiteShell(def: SiteDefinition, ctx: RenderContext, title: string, bodyHtml: string): string {
    mapPath = ctx.pagePath ?? ((p) => p);
    assetUrlOf = ctx.assetUrl ?? (() => null);
    return documentHtml(def, null, { ...ctx }, bodyHtml).replace('<title>Page not found |', `<title>${esc(title)} |`);
}

export function renderSitemap(def: SiteDefinition, origin: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${def.pages.map((p) => `  <url><loc>${esc(`${origin}${p.slug ? `/${p.slug}` : '/'}`)}</loc></url>`).join('\n')}
</urlset>
`;
}

export function renderRobots(origin: string, preview: boolean): string {
    return preview ? 'User-agent: *\nDisallow: /\n' : `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n`;
}
