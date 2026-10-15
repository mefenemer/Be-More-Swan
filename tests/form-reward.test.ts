// tests/form-reward.test.ts
// A sign-up form's free download (a lead magnet): part of the form's definition, checked at save,
// emailed once the person is subscribed (on sign-up, or on confirming), through a signed link that
// stops working when the file is removed or replaced. And a cover picture beside a website sign-up.
// src/utils/form-reward.ts, form-download.ts, audience-public.ts, form-builder.js, site-render.ts.
//
// Run:  npx tsx tests/form-reward.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-downloads';

import { normaliseFormDefinition } from '../src/utils/form-definition';
import { rewardDownloadUrl, rewardEmail, signReward, verifyReward } from '../src/utils/form-reward';
import { assetIdsIn, normaliseSiteDefinition, withoutAssets, type SignupProps } from '../src/utils/site-definition';
import { renderSitePage } from '../src/utils/site-render';
import { isAllowedUploadType } from '../netlify/functions/content-upload-url';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

console.log('\nThe form');

check('a form may name a free download; none by default; nonsense is dropped', () => {
    assert.strictEqual(normaliseFormDefinition({}).definition.reward, null);
    assert.deepStrictEqual(normaliseFormDefinition({ reward: { assetId: '42', label: '  2026 price list ' } }).definition.reward, { assetId: 42, label: '2026 price list' });
    assert.deepStrictEqual(normaliseFormDefinition({ reward: { assetId: 7 } }).definition.reward, { assetId: 7, label: 'your free download' });
    assert.strictEqual(normaliseFormDefinition({ reward: { assetId: -1, label: 'x' } }).definition.reward, null);
    assert.strictEqual(normaliseFormDefinition({ reward: 'file.pdf' }).definition.reward, null);
});
check('saving checks the file is this workspace\'s own PDF document', () => {
    const src = read('netlify/functions/audience-forms.ts');
    assert.ok(src.includes("eq(contentAssets.id, def.reward.assetId), eq(contentAssets.organisationId, orgId), eq(contentAssets.assetType, 'document')"));
});
check('the library takes PDFs (as documents, up to 25 MB) and still refuses other files', () => {
    assert.ok(isAllowedUploadType('application/pdf'));
    assert.ok(!isAllowedUploadType('application/zip') && !isAllowedUploadType('application/msword'));
    assert.ok(read('netlify/functions/content-upload-url.ts').includes("A PDF can be up to 25 MB."));
    assert.ok(read('netlify/functions/content-assets.ts').includes("assetType === 'document' && String(mimeType || '').toLowerCase() !== 'application/pdf'"));
});

console.log('\nThe link and the email');

check('the link is signed per form AND file: changing either breaks it', () => {
    const s = signReward(5, 42);
    assert.ok(verifyReward(5, 42, s));
    assert.ok(!verifyReward(6, 42, s) && !verifyReward(5, 43, s) && !verifyReward(5, 42, s.slice(1)));
    assert.strictEqual(rewardDownloadUrl('https://bemoreswan.com/', 5, 42), `https://bemoreswan.com/api/forms/download?f=5&a=42&s=${s}`);
});
check('the email names the download and the business, and says why they got it', () => {
    const e = rewardEmail({ business: 'Willowbrook <Florist>', label: '2026 price list', link: 'https://x/d?a=1&s=2' });
    assert.strictEqual(e.subject, 'Your 2026 price list — Willowbrook <Florist>');
    assert.ok(e.html.includes("Here's your 2026 price list") && e.html.includes('href="https://x/d?a=1&amp;s=2"'));
    assert.ok(e.html.includes('signed up with Willowbrook &lt;Florist&gt;'));
    assert.ok(rewardEmail({ business: 'B', label: 'your free download', link: 'l' }).html.includes("Here's your free download"));
});
check('the download page re-reads the form: only the file it offers NOW, only the workspace\'s own', () => {
    const src = read('netlify/functions/form-download.ts');
    const verifyAt = src.indexOf('verifyReward(formId, assetId, sig)');
    const dbAt = src.indexOf('getDb()');
    assert.ok(verifyAt > 0 && dbAt > verifyAt, 'the signature is checked before the database');
    assert.ok(src.includes('reward.assetId !== assetId') && src.includes("eq(contentAssets.organisationId, form.organisationId), eq(contentAssets.assetType, 'document')"));
    assert.ok(read('netlify.toml').includes('from = "/api/forms/download"\n  to = "/.netlify/functions/form-download"'));
});

console.log('\nWhen it is sent');

check('sent when subscribed: straight away for single opt-in, on confirming for double opt-in', () => {
    const src = read('netlify/functions/audience-public.ts');
    const single = src.indexOf('await deliverFormReward(db, { formId: form.id, contactId, email');
    const singleReturn = src.indexOf('return json(200, successBody, origin);', single);
    const doubleStart = src.indexOf('Double opt-in: mint, store the HASH, send');
    assert.ok(single > 0 && singleReturn > single && single < doubleStart, 'inside the single opt-in branch, before it returns');
    assert.ok(src.includes('await deliverFormReward(db, { formId: row.formId ?? null, contactId: row.contactId, email: row.email'), 'and in the confirmation');
    const rw = read('src/utils/form-reward.ts');
    assert.ok(rw.includes("checkRateLimit(db, 'form_reward', `${form.id}:${p.contactId}`, REWARD_RESEND)"), 'one a day per person per form');
    assert.ok(/catch \(err\) \{\s*console\.error\('\[form-reward\] delivery failed'/.test(rw), 'never throws');
});

console.log('\nOn the website');

const site = (props: Record<string, unknown>) => normaliseSiteDefinition({
    settings: { siteName: 'Willowbrook Florist' },
    pages: [{ title: 'Home', slug: '', sections: [{ id: 's1', type: 'signup', props }] }],
}).definition;
const forms = { 3: { content: { headline: 'Get the guide', intro: '', buttonLabel: 'Send it to me', successMessage: '', redirectUrl: null }, fields: [{ id: 'f_email', type: 'email', label: 'Email', placeholder: '', help: '', required: true, options: [] }], consent: { text: 'We will email you.', requireCheckbox: false } } } as never;
const ctx = { origin: 'https://x.bemoreswan.site', preview: false, reportUrl: '#', creditUrl: null, forms, assetUrl: (id: number) => `https://media/${id}` };

check('a sign-up section can carry a cover beside the form (described, and checked like any picture)', () => {
    const d = site({ formId: 3, heading: 'Free wedding flowers guide', image: { assetId: 9, alt: 'The guide\'s front cover' } });
    assert.deepStrictEqual((d.pages[0].sections[0].props as SignupProps).image, { url: '', alt: 'The guide\'s front cover', assetId: 9 });
    assert.deepStrictEqual(assetIdsIn(d), [9]);
    assert.strictEqual((withoutAssets(d, new Set([9])).pages[0].sections[0].props as SignupProps).image, null);
    const html = renderSitePage(d, '/', ctx).html;
    assert.ok(html.includes('<div class="w tx left"><img src="https://media/9" alt="The guide&#39;s front cover" loading="lazy"><div><h2>Free wedding flowers guide</h2>') || html.includes('<div class="w tx left"><img src="https://media/9"'));
    assert.ok(html.includes('Send it to me'));
});
check('without a cover it is drawn as before', () => {
    const html = renderSitePage(site({ formId: 3 }), '/', ctx).html;
    assert.ok(html.includes('<div class="w n"><h2>Get the guide</h2>') || html.includes('<div class="w n">'));
    assert.ok(!html.includes('w tx left'));
});

console.log('\nWiring');

check('the form builder, the editor and the chats know about free downloads', () => {
    const fb = read('src/components/form-builder.js');
    assert.ok(fb.includes('function panelReward()') && fb.includes("assetType: 'document'") && fb.includes('data-fb-reward-pick'));
    assert.ok(read('src/components/assistant-site-editor.js').includes('sends “${esc(x.download)}”'));
    assert.ok(read('src/utils/site-store.ts').includes('emails a free download'));
    const chat = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(chat.includes('A FREE DOWNLOAD (lead magnet') && chat.includes('(Words → Free download); you cannot attach it'));
    assert.ok(read('my-content.js').includes("document: 'Document'"));
});

console.log(`\n${passed}/${total} passed\n`);
