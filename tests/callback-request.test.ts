// tests/callback-request.test.ts
// "Request a call back" — Help & Support form, the ticket it becomes, and the chat card.
//
// WHY THIS EXISTS (owner, 2026-10-19). A customer who left said it felt like there were no humans.
// What can break without anything failing:
//   · a time creeps back in — the owner cannot commit to one, so nothing may offer or promise it
//   · a number nobody can dial is accepted, or a real one is refused
//   · the chat offers a call for "call to action" or a phone number on a website — or misses
//     "can I speak to a real person?"
//   · the chat starts claiming it booked a call
//
// Run:  npx tsx tests/callback-request.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    asksForACall, callbackTicket, cleanPhone, cleanTimezone, validateCallback, CALLBACK_OFFER_TYPE,
} from '../src/utils/callback-request';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(root, f), 'utf8');

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}`); throw err; }
}

console.log('callback-request');

check('phone numbers people actually type are accepted; junk is refused', () => {
    for (const ok of ['+1 202 555 0143', '(202) 555-0143', '07791 680223', '+44 7791 680 223', '202.555.0143']) assert.ok(cleanPhone(ok), ok);
    for (const bad of ['', '12345', 'call me', '+1 202 555 0143 ext 4', '1234567890123456', null]) assert.strictEqual(cleanPhone(bad), null, String(bad));
});

check('a bad timezone is dropped, not refused', () => {
    assert.strictEqual(cleanTimezone('America/New_York'), 'America/New_York');
    assert.strictEqual(cleanTimezone('Mars/Olympus'), null);
    const v = validateCallback({ phone: '+1 202 555 0143', timezone: 'nonsense' });
    assert.ok(v.ok && v.value.timezone === null);
    assert.ok(!validateCallback({ phone: 'abc' }).ok);
});

check('the ticket carries the number and timezone and promises NO time', () => {
    const v = validateCallback({ phone: '+1 202 555 0143', timezone: 'America/New_York', notes: 'Setting up Instagram' });
    assert.ok(v.ok);
    const t = callbackTicket(v.ok ? v.value : (null as never));
    assert.strictEqual(t.subject, 'Call-back request');
    assert.match(t.description, /Phone: \+1 202 555 0143/);
    assert.match(t.description, /America\/New_York/);
    assert.match(t.description, /Setting up Instagram/);
    assert.ok(!/morning|afternoon|evening|within|hours?\b/i.test(t.subject + t.description));
});

check('the chat spots a request for a call or a person…', () => {
    for (const s of [
        'Can someone call me?', 'please ring me tomorrow', 'I want a call back', 'Can I speak to a real person?',
        'is there a human I can talk to', 'I need to talk to someone from your team', 'can we book a call',
        'Can I have a phone call with support', 'speak with the founder please',
    ]) assert.ok(asksForACall(s), s);
});

check('…and does not mistake ordinary content work for one', () => {
    for (const s of [
        'Write a post with a strong call to action', 'Add my phone number to the website', 'Make the CTA "Call us today"',
        'a person in my audience asked about pricing', 'Draft a post about calling your mum', 'Recap the call I had with a client',
    ]) assert.ok(!asksForACall(s), s);
});

check('the server: category callback → validated, high priority, no time in either email', () => {
    const src = read('netlify/functions/support-tickets.ts');
    assert.ok(src.includes('if (category === CALLBACK_CATEGORY)') && src.includes("priority: 'high'"));
    assert.ok(src.includes('A person from our team will call you back on'));
    assert.ok(!/whenLine|bestTime|aiming for/.test(src));
    // The customer's own words are escaped in their confirmation email.
    assert.ok(src.includes('${escHtml(newTicket.description)}'));
});

check('call back is its OWN form, beside the support form — never a mode of it', () => {
    // Owner, 2026-10-19: the first version switched "How can we help?" into a phone form, so it
    // looked as if raising a support request had been replaced. They must stay separate.
    const html = read('help-content.html');
    assert.ok(html.includes('id="cb-form"') && html.includes('id="cb-phone"') && html.includes('id="cb-notes"') && html.includes('id="cb-submit"'));
    // Owner: "Prefer to talk" sits UNDER "How can we help?".
    assert.ok(html.indexOf('id="cu-form-card"') < html.indexOf('id="cb-card"'), 'the call-back card must come after the support form');
    assert.ok(html.indexOf('id="cb-card"') < html.indexOf('id="cb-phone"'), 'the phone field belongs to the call-back card');
    assert.ok(!html.includes('value="callback"'), 'call back is a topic of the support form again');
    assert.ok(!html.includes('cu-callback-fields'));
    assert.ok(!html.includes('cb-time'), 'a time picker came back');
    const js = read('help.js');
    assert.ok(js.includes("category: 'callback', callback: { phone, timezone: _tz, notes }"));
    assert.ok(!/topic === 'callback'/.test(js), 'the support form submits call-backs again');
    assert.ok(js.includes("qs.get('callback') === '1'"));
});

check('the chat attaches the card from the CUSTOMER\'s words and never claims a booking', () => {
    const src = read('netlify/functions/chat-orchestrator.ts');
    assert.ok(src.includes('if (!uiElement && asksForACall(typed)) uiElement = callbackOfferElement();'));
    assert.ok(src.includes('Never promise a time, never say you have booked or made a call'));
    const reg = read('src/components/disruptive-ui-registry.js');
    assert.ok(reg.includes(`register('${CALLBACK_OFFER_TYPE}', renderCallbackOfferCard)`));
    assert.ok(reg.includes("'/workspace.html?help=contact&callback=1'"));
});

check('Team Chat answers "request a call back" with the form, not "Noted"', () => {
    assert.ok(asksForACall('request a call back'));
    const src = read('src/utils/team-messages.ts');
    assert.ok(src.includes('const wantsACall = asksForACall(body);'));
    assert.ok(src.includes("{ assistantId: a.id, callback: true, label: 'Request a call back' }"));
    const feed = read('src/components/team-feed.js');
    assert.ok(feed.includes('if (l.callback) {') && feed.includes("'/workspace.html?help=contact&callback=1'"));
    // The callback branch must come before the generic "open the assistant" handling.
    assert.ok(feed.indexOf('if (l.callback) {') < feed.indexOf('if (l.chat) {'));
});

check('leaving the Overview before its layout arrives does not throw on the next page', () => {
    // 2026-10-19: opening Help & Support straight after the Overview threw "Cannot read
    // properties of null (reading 'style')" — renderGrid ran after its page was gone.
    const html = read('dashboard-content.html');
    const at = html.indexOf('function renderGrid() {');
    const body = html.slice(at, at + 900);
    assert.ok(body.includes('if (!grid.isConnected) return;'));
    assert.ok(!/getElementById\('dw-empty'\)\.style/.test(body), 'dw-empty is read without a null check again');
});

console.log(`\n${passed} passed`);
