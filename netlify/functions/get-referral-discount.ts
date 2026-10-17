// netlify/functions/get-referral-discount.ts
// US-ONB-2.2.1 AC20: Return referral discount details for banner display.
// Public endpoint — no auth required (discount info is not sensitive).
//
// GET /get-referral-discount?ref=<code>
// → { valid: boolean, discountPct: number, discountMonths: number, display: string }

import { Handler } from '@netlify/functions';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';
import { withLambda } from '@netlify/aws-lambda-compat';
import { REFERRAL_OFFER_DISPLAY } from '../../src/utils/referral-offer';

// The offer is fixed: the referred friend's first month is free (src/utils/referral-offer.ts holds
// the coupons). The old REFERRAL_DISCOUNT_PCT / _MONTHS env vars advertised a discount nothing applied.
const DISCOUNT_PCT    = 100;
const DISCOUNT_MONTHS = 1;

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const ref = event.queryStringParameters?.ref?.trim();
    if (!ref) {
        return { statusCode: 400, body: JSON.stringify({ valid: false, error: 'ref param required' }) };
    }

    try {
        const db = getDb();
        const [referrer] = await db
            .select({ id: users.id })
            .from(users)
            .where(eq(users.referralCode, ref))
            .limit(1);

        if (!referrer) {
            return { statusCode: 200, body: JSON.stringify({ valid: false }) };
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                valid:          true,
                discountPct:    DISCOUNT_PCT,
                discountMonths: DISCOUNT_MONTHS,
                display:        REFERRAL_OFFER_DISPLAY,
            }),
        };
    } catch (err) {
        console.error('[get-referral-discount]', err);
        return { statusCode: 500, body: JSON.stringify({ valid: false }) };
    }
});
