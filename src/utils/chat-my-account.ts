// src/utils/chat-my-account.ts
// What the signed-in user has set in My Account — profile, sounds, notification preferences — as
// every chat sees it. READ-ONLY by owner decision (2026-10-22): the chat answers "are my email alerts
// on?" or "why does it make a noise?" and says where to change it; changing stays on the page.
//
// ── Why ──────────────────────────────────────────────────────────────────────────────────────────
// No chat could see any of it, so "why didn't I get an email about my post?" or "turn the sound off"
// got a guess, or directions to a page by a name that does not exist.
//
// ── Where the values come from ───────────────────────────────────────────────────────────────────
// The same reads and the same helpers as the page: update-profile.ts GET (names, email, timezone,
// hourly rate, the sound switches — default ON when unset) and notification-preferences.ts GET
// (PREF_CATEGORIES with buildDefaults / resolveInAppPrefs; locked channels forced ON; this
// assistant's own overrides through overrideFor). Place names are user-settings.html's tab and
// control labels, pinned by tests/chat-my-account.test.ts.
//
// ⚠️ Never throws. The user's own details only — never another member's.

import { eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { userProfiles, users } from '../../db/schema';
import {
    PREF_CATEGORIES, assistantCategoryAppliesToRole, buildDefaults, overrideFor, pushRule, resolveInAppPrefs,
    type AssistantOverrideMap,
} from './notification-prefs';

type Db = ReturnType<typeof getDb>;
type PrefMap = Record<string, boolean>;

/** user-settings.html's Sounds tab, in order: preference key → the switch's label. */
export const SOUND_LABELS: Array<[string, string]> = [
    ['soundOnLogin', 'Play the Aurora sound on login'],
    ['soundOnMilestone', 'Play a sound for milestones & ready assistants'],
    ['soundOnNotification', 'Play a sound when a notification is received'],
    ['tourNarrationEnabled', 'Narrate the guided tour'],
];

export interface MyAccountInput {
    firstName: string; lastName: string; email: string; timezone: string;
    preferences: Record<string, unknown>;
    emailPrefs: PrefMap | null; inAppPrefs: PrefMap | null; pushPrefs: PrefMap | null;
    assistantPrefs: AssistantOverrideMap; legacyAvailability: boolean | null;
}

const onOff = (b: boolean) => (b ? 'on' : 'off');

/** Render the block. Pure — tested without a database. */
export function renderMyAccount(a: MyAccountInput, aiAssistantId: number, roleKey: string | null | undefined): string {
    const p = a.preferences || {};
    const name = [a.firstName, a.lastName].filter(Boolean).join(' ') || '(not set)';
    const rate = p.hourlyRateGbp != null && p.hourlyRateGbp !== '' ? `£${p.hourlyRateGbp}` : 'not set';
    const emailVals: PrefMap = { ...buildDefaults('email'), ...(a.emailPrefs ?? {}) };
    const inAppVals = resolveInAppPrefs(a.inAppPrefs as PrefMap, a.legacyAvailability);
    const pushVals: PrefMap = { ...buildDefaults('push'), ...(a.pushPrefs ?? {}) };

    const row = (cat: typeof PREF_CATEGORIES[number], own: boolean) => {
        const pick = (ch: 'inApp' | 'email' | 'push', base: boolean, locked: boolean) => {
            if (locked) return 'always on';
            const o = own ? overrideFor(a.assistantPrefs, aiAssistantId, cat.key, ch) : undefined;
            return o === undefined ? onOff(base) : `${onOff(o)} (just for this assistant)`;
        };
        return `- ${cat.label}: in the app ${pick('inApp', !!inAppVals[cat.key], cat.inApp.locked)}; email ${pick('email', !!emailVals[cat.key], cat.email.locked)}; phone/browser alerts ${pick('push', !!pushVals[cat.key], pushRule(cat).locked)}`;
    };
    const account = PREF_CATEGORIES.filter((c) => c.scope === 'account').map((c) => row(c, false));
    const mine = PREF_CATEGORIES.filter((c) => c.scope === 'assistant' && assistantCategoryAppliesToRole(c.key, roleKey)).map((c) => row(c, true));

    return `THE USER'S OWN ACCOUNT SETTINGS (My Account) — what they have set right now. You can READ these but never change them: when they ask to change one, tell them exactly where it is (below) and that it saves as soon as they switch it. Never say you have changed one.
Profile (My Account ▸ Profile Information): name ${name}; email ${a.email || '(not set)'}; timezone ${a.timezone || 'Europe/London'}; hourly rate ${rate} (only used to work out time saved in £). "Show it as one post" (Profile Information ▸ Posts on several platforms): ${onOff(p.combineCrossPosts !== false)}.
Sounds (My Account ▸ Sounds): ${SOUND_LABELS.map(([k, l]) => `"${l}" ${onOff(p[k] !== false)}`).join('; ')}.
Notifications about their account (My Account ▸ Notification Preferences):
${account.join('\n')}
Notifications about this assistant's work (Assistant Profile ▸ Notifications on this assistant's page):
${mine.join('\n')}
Phone/browser alerts also need "Push notifications on this device" allowed in My Account ▸ Notification Preferences, on each device — you cannot see whether they have. "Always on" ones cannot be turned off.`;
}

/** The block for this turn's prompt. Null when the read fails (the turn goes on without it). */
export async function buildMyAccountBlock(db: Db, userId: number, aiAssistantId: number, roleKey: string | null | undefined): Promise<string | null> {
    try {
        const [[u], [prof]] = await Promise.all([
            db.select({ firstName: users.firstName, lastName: users.lastName, email: users.email }).from(users).where(eq(users.id, userId)).limit(1),
            db.select({
                timezone: userProfiles.timezone, preferences: userProfiles.preferences,
                emailPrefs: userProfiles.emailPreferences, inAppPrefs: userProfiles.inAppPreferences, pushPrefs: userProfiles.pushPreferences,
                assistantPrefs: userProfiles.assistantNotifPrefs, legacyAvailability: userProfiles.notifyAvailability,
            }).from(userProfiles).where(eq(userProfiles.userId, userId)).limit(1),
        ]);
        if (!u) return null;
        return renderMyAccount({
            firstName: u.firstName ?? '', lastName: u.lastName ?? '', email: u.email ?? '', timezone: prof?.timezone ?? 'Europe/London',
            preferences: (prof?.preferences as Record<string, unknown>) ?? {},
            emailPrefs: (prof?.emailPrefs as PrefMap) ?? null, inAppPrefs: (prof?.inAppPrefs as PrefMap) ?? null, pushPrefs: (prof?.pushPrefs as PrefMap) ?? null,
            assistantPrefs: (prof?.assistantPrefs as AssistantOverrideMap) ?? null, legacyAvailability: prof?.legacyAvailability ?? null,
        }, aiAssistantId, roleKey);
    } catch (err) {
        console.error('[chat-my-account] could not read account settings (non-fatal)', err);
        return null;
    }
}
