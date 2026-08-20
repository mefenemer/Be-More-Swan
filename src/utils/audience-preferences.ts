// src/utils/audience-preferences.ts
// Something to press other than "unsubscribe".
//
// Until this existed the only exit was permanent, so a reader who thought "this is good, just too
// often" had one button and it was the last one. A pause and a frequency cap keep people who would
// otherwise leave for good — but only if they are REAL. Everything here is honoured by the send
// path itself:
//
//   · A PAUSE binds every assistant, through src/utils/audience-consent.ts. Somebody who asks for
//     quiet and then gets a welcome-sequence email two days later has been told no.
//   · A FREQUENCY CAP is newsletter-only and enforced when recipients are materialised, so a capped
//     subscriber is not even counted as a recipient of an issue they will not receive.
//
// ⚠️ THE ONE-CLICK UNSUBSCRIBE IS NOT A PREFERENCE. RFC 8058 says a List-Unsubscribe-Post request
// must unsubscribe immediately, with no further interaction — mail clients present that button as
// "unsubscribe" and some send it on the reader's behalf. Answering it with a menu would be a dark
// pattern and a spec violation at the same time. The choices below live on the GET page only.

import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { audienceContacts } from '../../db/schema';
import { recordConsentEvent } from './audience-store';
import { normaliseEmail } from './audience-contacts';

type Db = ReturnType<typeof getDb>;

/** At most one email a month, measured from audience_contacts.last_sent_at. */
export const MONTHLY_GAP_DAYS = 28;

export type PreferenceChoice = 'pause_30' | 'pause_90' | 'monthly' | 'all' | 'unsubscribe';

export interface PreferenceOption {
    choice: PreferenceChoice;
    label: string;
    /** The line under the label. Says what will actually happen, in the reader's terms. */
    detail: string;
}

/**
 * What the preference page offers, in this order.
 *
 * ⚠️ Unsubscribe is LAST but never hidden, never collapsed behind another click, and never phrased
 * as a lesser option. A preference centre that makes leaving harder than it was is worse than no
 * preference centre: the reader who cannot find the exit presses "report spam" instead, and that
 * costs the sending domain far more than one lost subscriber.
 */
export const PREFERENCE_OPTIONS: PreferenceOption[] = [
    { choice: 'pause_30',    label: 'Pause for 30 days',        detail: 'No emails at all for a month. They start again on their own — you do not need to do anything.' },
    { choice: 'pause_90',    label: 'Pause for 3 months',       detail: 'No emails at all until then. They start again on their own.' },
    { choice: 'monthly',     label: 'Send at most one a month', detail: 'You stay subscribed, but you will not get more than one email every four weeks.' },
    { choice: 'unsubscribe', label: 'Stop all emails',          detail: 'You will not hear from us again. This is permanent.' },
];

export interface ApplyPreferenceArgs {
    organisationId: number;
    email: string;
    contactId?: number | null;
    choice: PreferenceChoice;
    /** For the consent record: how they told us. */
    channel?: string | null;
    issueId?: number | null;
}

export interface ApplyPreferenceResult {
    applied: PreferenceChoice;
    /** What to tell the reader. Written for them, not for the tenant. */
    message: string;
    pausedUntil?: Date | null;
}

/** Parse whatever arrived on the form. Anything unrecognised is not a preference at all. */
export function parseChoice(value: unknown): PreferenceChoice | null {
    const v = String(value ?? '').trim();
    return (['pause_30', 'pause_90', 'monthly', 'all', 'unsubscribe'] as const)
        .find((c) => c === v) ?? null;
}

/**
 * Apply one preference to a contact, with the consent event that evidences it.
 *
 * Does NOT handle 'unsubscribe' — that goes through setContactStatus, which is the only writer
 * allowed to change a contact's status and does it in one transaction with its own event. Splitting
 * it would create a second path to the most consequential write in the product.
 *
 * Returns null when there is no such contact: the caller already knows the address from a send
 * ledger row, so this means the contact was erased, and there is nothing to pause.
 */
export async function applyPreference(
    db: Db,
    args: ApplyPreferenceArgs,
): Promise<ApplyPreferenceResult | null> {
    const email = normaliseEmail(args.email);
    const now = new Date();

    const pauseDays = args.choice === 'pause_30' ? 30 : args.choice === 'pause_90' ? 90 : 0;
    const pausedUntil = pauseDays ? new Date(now.getTime() + pauseDays * 24 * 60 * 60 * 1000) : null;

    const patch = pauseDays
        ? { pausedUntil, preferencesUpdatedAt: now, updatedAt: now }
        : args.choice === 'monthly'
            // Choosing a frequency also LIFTS a pause: the reader has just told us what they want
            // instead of silence, and leaving them muted underneath it would make the choice a lie.
            ? { emailFrequency: 'monthly', pausedUntil: null, preferencesUpdatedAt: now, updatedAt: now }
            : { emailFrequency: 'all', pausedUntil: null, preferencesUpdatedAt: now, updatedAt: now };

    const [updated] = await db.update(audienceContacts)
        .set(patch)
        .where(and(
            eq(audienceContacts.organisationId, args.organisationId),
            eq(audienceContacts.email, email),
        ))
        .returning({ id: audienceContacts.id });
    if (!updated) return null;

    const event = pauseDays ? 'paused' : args.choice === 'monthly' ? 'frequency_changed' : 'resumed';
    // ⚠️ Best effort, and deliberately after the write. The preference is the thing the reader asked
    // for; losing the audit line is bad, but refusing the request because we could not write the
    // audit line would be worse — they would press unsubscribe instead.
    try {
        await recordConsentEvent(db, {
            organisationId: args.organisationId,
            contactId: updated.id,
            email,
            event,
            channel: args.channel ?? 'email_link',
            issueId: args.issueId ?? null,
            evidence: pauseDays
                ? `Paused their own emails for ${pauseDays} days from the preference page.`
                : args.choice === 'monthly'
                    ? 'Asked for at most one email a month from the preference page.'
                    : 'Asked for every email again from the preference page.',
        });
    } catch (err) {
        console.error('[audience-preferences] preference saved, consent event was NOT recorded', { organisationId: args.organisationId }, err);
    }

    const until = pausedUntil
        ? pausedUntil.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
        : '';
    return {
        applied: args.choice,
        pausedUntil,
        message: pauseDays
            ? `You will not hear from us until ${until}. Nothing else changes, and you do not need to do anything to start them again.`
            : args.choice === 'monthly'
                ? 'You will get at most one email a month from now on.'
                : 'You will get every email again.',
    };
}
