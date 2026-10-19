// src/utils/referral-code.ts
// A user's referral code (users.referral_code) — the one code behind both a customer's refer-a-friend
// link and a partner's invite link (/invite/<code>). 8 characters from an alphabet with no 0/O/1/I,
// so it survives being read out on a podcast. Moved here from referral.ts so partner approval can
// make sure a partner has one (src/utils/partner-applications.ts).

import { eq, and, isNull } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { users } from '../../db/schema';

type Db = ReturnType<typeof getDb>;

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateReferralCode(): string {
    let code = '';
    for (let i = 0; i < 8; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return code;
}

/** The user's code, creating one if they have none yet. Null only if five candidates all collided. */
export async function ensureReferralCode(db: Db, userId: number): Promise<string | null> {
    const [user] = await db.select({ referralCode: users.referralCode }).from(users).where(eq(users.id, userId)).limit(1);
    if (!user) return null;
    if (user.referralCode) return user.referralCode;
    for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = generateReferralCode();
        const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.referralCode, candidate)).limit(1);
        if (taken) continue;
        // Conditional: if a concurrent request already gave them a code, keep that one.
        const set = await db.update(users).set({ referralCode: candidate, updatedAt: new Date() })
            .where(and(eq(users.id, userId), isNull(users.referralCode))).returning({ code: users.referralCode });
        if (set.length) return candidate;
        const [again] = await db.select({ referralCode: users.referralCode }).from(users).where(eq(users.id, userId)).limit(1);
        return again?.referralCode ?? null;
    }
    return null;
}
