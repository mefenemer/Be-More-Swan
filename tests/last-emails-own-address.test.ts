// tests/last-emails-own-address.test.ts
// The last customer emails off Be More Swan senders (owner 2026-11-27): a form's free download (form-reward.ts), the
// sign-up confirmation (audience-email.ts), and an assistant's outbound email (send-outbound-email.ts) go only from
// the workspace's own address (business-email.ts). A double opt-in form with no own address refuses BEFORE writing
// anything; Audience ▸ Sign-up forms tells the owner.
//
// Run:  npx tsx tests/last-emails-own-address.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sendConfirmationEmail } from '../src/utils/audience-email';
import { sendBusinessEmail, signupConfirmBlocked } from '../src/utils/business-email';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const db = {} as never;
const gmail = (async () => ({ route: { provider: 'gmail', from: null, replyTo: null, engagementTracked: false } })) as never;
const none = (async () => ({ error: 'none' })) as never;
const INPUT = { to: 'sam@x.example', firstName: 'Sam', senderName: 'Kudzu <Candles>', sourceUrl: null, baseUrl: 'https://bemoreswan.com', token: 'tok' };

async function main() {
    console.log('\nlast-emails-own-address');

    await check('sign-up confirmation: sent on the own route with its own text part; no route or a refusal throws', async () => {
        const seen: Array<{ to: string; text: string; subject: string }> = [];
        await sendConfirmationEmail(db, 7, INPUT as never, { resolveRoute: gmail, deliver: (async (_d: unknown, _r: unknown, _o: number, m: never) => { seen.push(m); return null; }) as never });
        assert.strictEqual(seen.length, 1);
        assert.ok(seen[0].text.includes('Confirm your subscription by opening this link:'), 'the hand-written text part, not a derived one');
        await assert.rejects(sendConfirmationEmail(db, 7, INPUT as never, { resolveRoute: none }), /No own address/);
        await assert.rejects(sendConfirmationEmail(db, 7, INPUT as never, { resolveRoute: gmail, deliver: (async () => { throw new Error('x'); }) as never }), /could not be sent/);
    });

    await check('onSent tells the caller the provider (a Resend cost only for the own domain)', async () => {
        const got: string[] = [];
        await sendBusinessEmail(db, 7, { business: 'K', to: 'a@b.example', subject: 's', html: 'h' }, { resolveRoute: gmail, deliver: (async () => null) as never, onSent: (p) => { got.push(p); } });
        assert.deepStrictEqual(got, ['gmail']);
    });

    await check('the owner\'s warning on Sign-up forms', async () => {
        assert.ok(/Nobody can sign up on a form that asks people to confirm by email/.test(String(await signupConfirmBlocked(db, 7, none))));
        assert.strictEqual(await signupConfirmBlocked(db, 7, gmail), null);
    });

    await check('wired: no Be More Swan sender left; double opt-in refused before any write; forms list warns; outbound 409', () => {
        assert.ok(!/noreply@|\(via Be More Swan\)/.test(read('src/utils/form-reward.ts')) && read('src/utils/form-reward.ts').includes('sendBusinessEmail(db, form.organisationId'));
        assert.ok(!/from: `|noreply@bemoreswan/.test(read('src/utils/audience-email.ts')));
        const pub = read('netlify/functions/audience-public.ts');
        assert.ok(pub.indexOf('if (form.doubleOptIn && await signupConfirmBlocked(db, orgId))') > -1);
        assert.ok(pub.indexOf('if (form.doubleOptIn && await signupConfirmBlocked(db, orgId))') < pub.indexOf('.from(audienceContacts)\n            .where(and(eq(audienceContacts.organisationId, orgId), eq(audienceContacts.email, email)))'), 'refused before the contact is read or written');
        assert.ok(pub.includes('await sendConfirmationEmail(db, orgId, {'));
        const out = read('netlify/functions/send-outbound-email.ts');
        assert.ok(!/assistant@|outbound\.bemoreswan|new Resend\(/.test(out) && out.includes("code: 'NO_SENDING_ADDRESS'"));
        assert.ok(out.includes('injectAiFooter(bodyText, assistant.name, customDisclosureText, false, workspaceText)'), 'the AI notice is still added');
        assert.ok(read('netlify/functions/audience-forms.ts').includes('confirmBlocked,') && read('src/components/signup-forms.js').includes('data-sf-confirm-blocked'));
    });

    console.log(`\n${passed}/${total} passed`);
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
