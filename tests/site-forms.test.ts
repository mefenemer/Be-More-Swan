// tests/site-forms.test.ts
// The Website Assistant, step 3b: forms on hosted sites — the contact (enquiry) and sign-up
// sections, drawn as script-free HTML (site-render.ts), and what a POST to /_form does
// (src/utils/site-forms.ts → site-serve.ts → audience-public.ts for sign-ups).
//
// Run:  npx tsx tests/site-forms.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { normaliseSiteDefinition, SECTION_TYPES, type SiteDefinition } from '../src/utils/site-definition';
import { renderSitePage, FORM_ACTION, type SiteSignupForm } from '../src/utils/site-render';
import { answersFromForm, handleSiteForm, safeBackPath, sentLocation, SITE_FORM_MIN_FILL_MS } from '../src/utils/site-forms';
import { publishBlocker, type SiteRow } from '../src/utils/site-store';
import { WORKSPACE_TABLES } from '../src/utils/workspace-export';
import { getNotificationDefault } from '../src/utils/notification-templates-catalog';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const site = (sections: unknown[]): SiteDefinition => normaliseSiteDefinition({
    settings: { siteName: 'Willowbrook Coffee' },
    pages: [
        { title: 'Home', slug: '', sections: [{ type: 'hero', props: { headline: 'Fresh coffee' } }] },
        { title: 'Contact', slug: 'contact', sections },
    ],
}).definition;
const live = { origin: 'https://willowbrook.bemoreswan.site', preview: false, reportUrl: '#', creditUrl: null, renderedAt: 1_000_000 };
const signupForm: SiteSignupForm = {
    content: { headline: 'Join the list', intro: 'Monthly news.', buttonLabel: 'Sign me up' },
    fields: [
        { id: 'f_email', type: 'email', label: 'Email', placeholder: '', help: '', required: true, options: [] },
        { id: 'f_name', type: 'text', label: 'First name', placeholder: '', help: '', required: false, options: [] },
        { id: 'f_int', type: 'checkbox', label: 'Interests', placeholder: '', help: '', required: false, options: [{ value: 'beans', label: 'Beans' }, { value: 'kit', label: 'Kit' }] },
    ],
    consent: { text: 'I agree to receive emails.', requireCheckbox: true },
};
const row = (over: Partial<SiteRow> = {}): SiteRow => ({
    id: 1, organisationId: 1, aiAssistantId: 1, createdBy: null, status: 'published', draft: {}, slug: 'willowbrook', credit: true,
    draftingAt: null, draftNote: null, createdAt: new Date(), updatedAt: new Date(), publishedVersion: 1, publishedAt: null,
    suspendedAt: null, suspendedReason: null, ...over,
});
const noDb = null as unknown as Parameters<typeof handleSiteForm>[0];
const neverSubscribe = async () => { throw new Error('subscribe must not be called'); };

async function main() {
    console.log('\nThe sections');

    await check('contact and signup are section types, cleaned by the one gate', () => {
        assert.ok(SECTION_TYPES.includes('contact') && SECTION_TYPES.includes('signup'));
        const d = site([{ type: 'contact', props: { heading: 'Get in touch', askPhone: 'yes', buttonLabel: '' } }, { type: 'signup', props: { formId: '42' } }, { type: 'signup', props: { formId: -3 } }]);
        const [c, s1, s2] = d.pages[1].sections;
        assert.deepStrictEqual(c.props, { heading: 'Get in touch', intro: null, askPhone: false, buttonLabel: 'Send message', offerUpdates: true }, 'askPhone must be literally true; the news-and-offers box is offered unless switched off');
        assert.strictEqual((s1.props as { formId: number }).formId, 42);
        assert.strictEqual((s2.props as { formId: number | null }).formId, null);
    });

    await check('a contact form is plain HTML that posts to the site itself, with a honeypot and a timestamp', () => {
        const d = site([{ type: 'contact', props: { heading: 'Get in touch', askPhone: true } }]);
        const html = renderSitePage(d, '/contact', live).html;
        assert.ok(html.includes(`<form class="fm" method="post" action="${FORM_ACTION}">`));
        assert.ok(html.includes('name="_k" value="contact"') && html.includes('name="_t" value="1000000"') && html.includes('name="_p" value="/contact"'));
        assert.ok(html.includes('class="hp"') && html.includes('name="website"'));
        assert.ok(html.includes('name="phone"'));
        assert.ok(html.includes('<button class="btn" type="submit">Send message</button>'));
        assert.ok(!/<script(?![^>]*application\/ld\+json)/.test(html), 'still no JavaScript');
    });

    await check('in the editor preview the forms are drawn but switched off', () => {
        const d = site([{ type: 'contact', props: {} }]);
        const html = renderSitePage(d, '/contact', { ...live, preview: true }).html;
        assert.ok(html.includes('type="submit" disabled') && html.includes('Forms work on your live site'));
    });

    await check('a sign-up section draws its form\'s questions and consent; with no usable form the live site draws nothing', () => {
        const d = site([{ type: 'signup', props: { formId: 7 } }]);
        const html = renderSitePage(d, '/contact', { ...live, forms: { 7: signupForm } }).html;
        assert.ok(html.includes('Join the list') && html.includes('name="_k" value="signup"'));
        assert.ok(html.includes('type="email" name="a_f_email"') && html.includes(' required'));
        assert.strictEqual((html.match(/type="checkbox" name="a_f_int"/g) || []).length, 2);
        assert.ok(html.includes('name="_consent" value="yes" required> I agree to receive emails.'));
        assert.ok(html.includes('Sign me up'));
        const missing = renderSitePage(d, '/contact', live).html;
        assert.ok(!missing.includes('name="_k" value="signup"') && !missing.includes('Sign-up section'));
        assert.ok(renderSitePage(d, '/contact', { ...live, preview: true }).html.includes('choose one of your sign-up forms'));
    });

    await check('publishing is refused while a sign-up section has no form', () => {
        const d = site([{ type: 'signup', props: {} }]);
        assert.match(publishBlocker(row(), d)!, /sign-up form for the sign-up section on "Contact"/);
        assert.strictEqual(publishBlocker(row(), site([{ type: 'signup', props: { formId: 3 } }])), null);
    });

    console.log('\nPosting a form');

    await check('form answers map onto field ids; checkboxes keep every value', () => {
        const q = new URLSearchParams('a_f_email=a%40b.co&a_f_int=beans&a_f_int=kit&a_other=x');
        assert.deepStrictEqual(answersFromForm(q, signupForm.fields), { f_email: 'a@b.co', f_int: ['beans', 'kit'] });
    });

    await check('the way back is always one of the site\'s own pages', () => {
        const d = site([]);
        assert.strictEqual(safeBackPath(d, '/contact'), '/contact');
        assert.strictEqual(safeBackPath(d, 'https://evil.example/'), '/');
        assert.strictEqual(safeBackPath(d, '//evil.example'), '/');
        assert.strictEqual(sentLocation('contact', 's1', '/contact'), '/_sent?k=contact&s=s1&b=%2Fcontact');
    });

    await check('a bot gets the same thank-you as a person, and nothing is written', async () => {
        const d = site([{ type: 'contact', props: {} }]);
        const sid = d.pages[1].sections[0].id;
        const base = { site: row(), definition: d, origin: live.origin, ip: '1.2.3.4', userAgent: null, subscribe: neverSubscribe, now: 2_000_000 };
        const honeypot = await handleSiteForm(noDb, { ...base, body: new URLSearchParams({ _s: sid, _k: 'contact', _t: '1000000', _p: '/contact', website: 'x', name: 'Bot', email: 'b@b.co', message: 'hi' }) });
        assert.deepStrictEqual(honeypot, { kind: 'sent', location: sentLocation('contact', sid, '/contact') });
        const tooFast = await handleSiteForm(noDb, { ...base, body: new URLSearchParams({ _s: sid, _k: 'contact', _t: String(2_000_000 - SITE_FORM_MIN_FILL_MS + 1), _p: '/contact', name: 'Bot', email: 'b@b.co', message: 'hi' }) });
        assert.strictEqual(tooFast.kind, 'sent');
    });

    await check('a post naming a section that is not on the published site (or of another kind) is refused', async () => {
        const d = site([{ type: 'contact', props: {} }]);
        const sid = d.pages[1].sections[0].id;
        const base = { site: row(), definition: d, origin: live.origin, ip: '1.2.3.4', userAgent: null, subscribe: neverSubscribe, now: 2_000_000 };
        const wrongKind = await handleSiteForm(noDb, { ...base, body: new URLSearchParams({ _s: sid, _k: 'signup', _t: '1000000' }) });
        assert.strictEqual(wrongKind.kind === 'error' && wrongKind.status, 404);
        const unknown = await handleSiteForm(noDb, { ...base, body: new URLSearchParams({ _s: 'nope', _k: 'contact', _t: '1000000' }) });
        assert.strictEqual(unknown.kind === 'error' && unknown.status, 404);
    });

    await check('an enquiry with a missing name, bad email or empty message is refused before anything is written', async () => {
        const d = site([{ type: 'contact', props: {} }]);
        const sid = d.pages[1].sections[0].id;
        const base = { site: row(), definition: d, origin: live.origin, ip: '1.2.3.4', userAgent: null, subscribe: neverSubscribe, now: 2_000_000 };
        const send = (o: Record<string, string>) => handleSiteForm(noDb, { ...base, body: new URLSearchParams({ _s: sid, _k: 'contact', _t: '1000000', _p: '/contact', ...o }) });
        for (const [o, re] of [[{ email: 'a@b.co', message: 'hi' }, /name/], [{ name: 'Sam', email: 'nope', message: 'hi' }, /email/], [{ name: 'Sam', email: 'a@b.co', message: '  ' }, /message/]] as const) {
            const r = await send(o as Record<string, string>);
            assert.ok(r.kind === 'error' && r.status === 400 && re.test(r.message), JSON.stringify(r));
        }
    });

    console.log('\nWhere the answers go');

    await check('an enquiry never touches the Audience; the owner is told at the ACCOUNT\'s email', () => {
        const src = read('src/utils/site-forms.ts');
        const enquiry = src.slice(src.indexOf('async function handleEnquiry'), src.indexOf('export async function sentMessage'));
        assert.ok(!/audience-store|upsertContact|audienceContacts|recordConsentEvent/.test(src), 'no Audience writes from this module');
        assert.ok(enquiry.includes('db.insert(siteEnquiries)'));
        assert.ok(enquiry.indexOf('checkRateLimit(') < enquiry.indexOf('db.insert(siteEnquiries)'));
        assert.ok(enquiry.includes("createNotification(db, 'site_enquiry_received'") && enquiry.includes("category: 'suggested_action'") && enquiry.includes('metadata: { assistantId:'));
        assert.ok(enquiry.includes('to: owner.email') && enquiry.includes('replyTo: email'));
        assert.ok(!enquiry.includes('settings.email'), 'never the address typed on the site');
    });

    await check('a sign-up goes through audience-public\'s subscribe, with consent enforced on the server first', () => {
        const src = read('src/utils/site-forms.ts');
        const signup = src.slice(src.indexOf('// ── Sign-up: through the one subscribe path'), src.indexOf('async function handleEnquiry'));
        assert.ok(signup.indexOf("body.get('_consent') !== 'yes'") < signup.indexOf('req.subscribe('));
        const serve = read('netlify/functions/site-serve.ts');
        assert.ok(serve.includes("import audiencePublic from './audience-public'"));
        assert.ok(serve.includes('/api/audience/subscribe'));
    });

    await check('audience-public: a site may post to a form only when it is that workspace\'s own PUBLISHED site', () => {
        const fn = read('netlify/functions/audience-public.ts');
        assert.ok(fn.indexOf('isOwnPublishedSite(db, origin, form.organisationId)') < fn.indexOf('!originAllowed(form.allowedOrigins, origin)'));
        const store = read('src/utils/site-store.ts');
        const own = store.slice(store.indexOf('export async function isOwnPublishedSite'), store.indexOf('/** Whether the draft differs'));
        assert.ok(own.includes("u.protocol !== 'https:'"));
        assert.ok(own.includes('eq(sites.organisationId, orgId)') && own.includes("eq(sites.status, 'published')"));
    });

    await check('serving: forms post only to /_form, and the page may only post to itself', () => {
        const serve = read('netlify/functions/site-serve.ts');
        assert.ok(serve.includes("form-action 'self' https://checkout.stripe.com"));
        assert.ok(serve.includes('if (isPost && path !== FORM_ACTION && path !== BUY_ACTION && path !== BOOK_PATH)'));
        assert.ok(serve.indexOf("keyMatches(h['x-site-serve-key']") < serve.indexOf('const isPost'), 'the key is checked before anything else');
        assert.ok(serve.includes("h['x-site-client-ip']"));
        const edge = read('sites-host/edge-functions/serve.ts');
        assert.ok(edge.includes("request.method === 'POST' && FORM_PATHS.has(url.pathname)"));
        assert.ok(edge.includes("new Set(['/_form', '/_buy', '/_book'])"));
        assert.ok(edge.includes("'x-site-client-ip': context?.ip"));
        assert.ok(edge.includes('MAX_FORM_BYTES'));
    });

    await check('the enquiry notification is registered everywhere a notification type must be', () => {
        assert.ok(read('src/utils/notification-actions.ts').includes("site_enquiry_received: 'suggested_action'"));
        assert.ok(read('src/utils/notification-prefs.ts').includes("'site_enquiry_received'"));
        assert.ok(read('db/notifications-categorization.sql').includes("WHEN 'site_enquiry_received' THEN 'suggested_action'"));
        assert.strictEqual(getNotificationDefault('site_enquiry_received')?.type, 'site_enquiry_received');
    });

    await check('enquiries and sites are in the workspace data export; the table is migrated and mirrored', () => {
        assert.ok(WORKSPACE_TABLES.websiteEnquiries && WORKSPACE_TABLES.websites);
        const sqlFile = read('db/z-website-forms.sql');
        assert.ok(sqlFile.includes('CREATE TABLE IF NOT EXISTS site_enquiries') && sqlFile.includes("CHECK (status IN ('new', 'done'))"));
        assert.ok(read('db/schema.ts').includes('export const siteEnquiries = pgTable("site_enquiries"'));
    });

    await check('the editor offers both sections, a form picker and an Enquiries tab; the chat knows both', () => {
        const ed = read('src/components/assistant-site-editor.js');
        assert.ok(ed.includes("contact: 'Contact form', signup: 'Sign-up form'"));
        assert.ok(ed.includes("kind: 'formpick'") && ed.includes("action: 'enquiries'") && ed.includes("action: 'enquiry_done'"));
        const chat = read('netlify/functions/chat-orchestrator.ts');
        assert.ok(chat.includes('contact {heading, intro, askPhone') && chat.includes('signup {heading, intro, formId, image:{assetId,alt}|null}'));
        assert.ok(read('src/utils/site-store.ts').includes('for a signup section\'s formId'));
    });

    console.log(`\n${passed}/${total} passed`);
}

void main();
