// contact-type.ts
// Classify an inbound contact by email so the CRM Contacts pill reflects reality instead of
// defaulting everyone to 'lead'. Three auto-managed tiers, weakest → strongest:
//   'lead'       — no account: a prospect.
//   'registered' — the email belongs to a registered user account.
//   'client'     — that account also holds an active paid subscription (status active/past_due,
//                  the same signal the rest of the app treats as a live paid plan).
// 'other' is a manual-only tier and is never assigned or overwritten automatically.
// Also returns the userId so callers can link the record to the account in one lookup.

import { and, eq, inArray } from 'drizzle-orm';
import { plans, users } from '../../db/schema';

export type ContactType = 'lead' | 'registered' | 'client';

export async function lookupContact(
    db: any,
    email: string,
): Promise<{ userId: number | null; contactType: ContactType }> {
    const resolved = (email || '').trim().toLowerCase();
    if (!resolved) return { userId: null, contactType: 'lead' };

    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.email, resolved)).limit(1);
    if (!u) return { userId: null, contactType: 'lead' };

    // Registered user. Promote to 'client' only if they hold an active paid subscription.
    const [p] = await db.select({ id: plans.id })
        .from(plans)
        .where(and(eq(plans.userId, u.id), inArray(plans.status, ['active', 'past_due'])))
        .limit(1);

    return { userId: u.id, contactType: p ? 'client' : 'registered' };
}

// Rank of the auto-managed tiers. 'other' (and anything else) is absent → treated as a manual
// choice that classification must never touch.
const TYPE_RANK: Record<string, number> = { lead: 0, registered: 1, client: 2 };

// Decide the contact_type to persist for an existing record: only ever upgrade (never downgrade),
// and never override a manual tier such as 'other'. Returns the unchanged value when nothing moves.
export function promoteContactType(current: string, detected: ContactType): string {
    if (!(current in TYPE_RANK)) return current; // manual tier ('other'/unknown) — leave as-is
    return TYPE_RANK[detected] > TYPE_RANK[current] ? detected : current;
}
