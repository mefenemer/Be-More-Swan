// tests/chat-my-account.test.ts
// Every chat can READ the user's own My Account settings — profile, sounds, notification
// preferences — and says where to change them; it never changes them (owner, 2026-10-22).
//
// WHY THIS EXISTS. No chat could see any of it, so "why didn't I get an email?" got a guess. These pin
// that the values are the page's (same defaults, locked channels always on, this assistant's own
// overrides), that every place named is a real label on user-settings.html, and that the block says
// read-only.
//
// Run:  npx tsx tests/chat-my-account.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SOUND_LABELS, renderMyAccount, type MyAccountInput } from '../src/utils/chat-my-account';
import { PREF_CATEGORIES } from '../src/utils/notification-prefs';

let passed = 0;
let total = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    total++;
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');
const html = read('user-settings.html').replace(/&amp;/g, '&');

const BASE: MyAccountInput = {
    firstName: 'Jo', lastName: 'Bloggs', email: 'jo@example.com', timezone: 'Europe/London',
    preferences: { soundOnLogin: false, hourlyRateGbp: 40 },
    emailPrefs: null, inAppPrefs: null, pushPrefs: null, assistantPrefs: null, legacyAvailability: null,
};
const accountCats = PREF_CATEGORIES.filter((c) => c.scope === 'account');
const assistantCats = PREF_CATEGORIES.filter((c) => c.scope === 'assistant');

async function main() {
    console.log('\nThe values');

    await check('profile and sounds as the page shows them; unset sounds default on', () => {
        const text = renderMyAccount(BASE, 5, 'social_media_manager');
        assert.ok(text.includes('name Jo Bloggs; email jo@example.com; timezone Europe/London; hourly rate £40'), text);
        assert.ok(text.includes('"Play the Aurora sound on login" off') && text.includes('"Narrate the guided tour" on'));
        assert.ok(text.includes('"Show it as one post" (Profile Information ▸ Posts on several platforms): on'));
    });

    await check('every account notification row is listed; locked channels read "always on"', () => {
        const text = renderMyAccount(BASE, 5, 'social_media_manager');
        for (const c of accountCats) assert.ok(text.includes(`- ${c.label}:`), c.label);
        const locked = PREF_CATEGORIES.find((c) => c.email.locked)!;
        assert.ok(new RegExp(`- ${locked.label}: [^\\n]*email always on`).test(text));
    });

    await check('a stored choice beats the default, and this assistant’s override is marked', () => {
        const free = assistantCats.find((c) => !c.email.locked)!;
        const text = renderMyAccount({ ...BASE, emailPrefs: { [free.key]: !free.email.default }, assistantPrefs: { 5: { [free.key]: { inApp: false } } } }, 5, 'social_media_manager');
        const line = text.split('\n').find((l) => l.startsWith(`- ${free.label}:`))!;
        assert.ok(line.includes(`email ${free.email.default ? 'off' : 'on'}`), line);
        assert.ok(line.includes('in the app off (just for this assistant)'), line);
        const other = renderMyAccount({ ...BASE, assistantPrefs: { 6: { [free.key]: { inApp: false } } } }, 5, 'social_media_manager');
        assert.ok(!other.includes('just for this assistant'), 'another assistant’s override must not show');
    });

    await check('publishing-only rows drop for a role that does not publish', () => {
        const cal = PREF_CATEGORIES.find((c) => c.key === 'content_calendar');
        if (!cal) return;
        assert.ok(renderMyAccount(BASE, 5, 'social_media_manager').includes(`- ${cal.label}:`));
        assert.ok(!renderMyAccount(BASE, 5, 'lead_qualifier').includes(`- ${cal.label}:`));
    });

    console.log('\nThe places it names, and read-only');

    await check('every tab, heading and switch it names is on user-settings.html', () => {
        for (const label of ['Profile Information', 'Notification Preferences', 'Sounds', 'Posts on several platforms', 'Show it as one post', 'Push notifications on this device']) {
            assert.ok(html.includes(`>${label}<`), label);
        }
        for (const [key, label] of SOUND_LABELS) {
            assert.ok(html.includes(`data-sound-key="${key}"`) && html.includes(`>${label}<`), label);
        }
        assert.strictEqual(SOUND_LABELS.length, (html.match(/data-sound-key="/g) || []).length, 'every Sounds switch is listed');
    });

    await check('the block says it can read but not change them', () => {
        const text = renderMyAccount(BASE, 5, null);
        assert.ok(text.includes('never change them') && text.includes('Never say you have changed one'));
    });

    await check('every chat gets it', () => {
        const orch = read('netlify/functions/chat-orchestrator.ts');
        assert.ok(orch.includes('const myAccountBlock = await buildMyAccountBlock(db, userId, session.aiAssistantId, assistantRow.roleKey);'), 'not gated by route');
    });

    console.log(`\n${passed}/${total} passed`);
    if (passed !== total) process.exitCode = 1;
}

main();
