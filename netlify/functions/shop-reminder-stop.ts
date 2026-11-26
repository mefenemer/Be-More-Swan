// netlify/functions/shop-reminder-stop.ts
// The unsubscribe link in a shop's abandoned-checkout reminder (src/utils/shop-checkout-reminder.ts; online shop
// Phase 2, slice 5). The person never signed up to Be More Swan, so the page names the BUSINESS, not us.
//
//   HEAD               → 200, changes nothing (link scanners pre-fetch)
//   GET  ?b=<basket>   → a page with one "Unsubscribe" button. It does NOT unsubscribe: corporate link scanners
//                        open every link in an email.
//   POST ?b=<basket>   → the address that basket was reminded at becomes UNSUBSCRIBED from this business (a
//                        contact row is written if there is none, so a later ticked order can't add them back).
//                        Also the RFC 8058 one-click POST mail clients fire from List-Unsubscribe.
//
// The basket id is the credential: 24 random characters, already in the reminder's "Go back to your basket"
// link, and only a basket that WAS reminded answers. Reminded baskets are kept 60 days (shop-basket.ts sweep).
//
// ⚠️ FIVE unsubscribe routes now exist (see newsletter-unsubscribe.ts). This one is a SHOP BUYER leaving a
// business's email; it writes the same audience_contacts status every other route reads.
//
// Never 500: a person clicking unsubscribe must see a page, and a one-click POST must not be retried into a loop.

import { getDb } from '../../db/client';
import { stopRemindedAddress } from '../../src/utils/shop-checkout-reminder';
import { isBasketId } from '../../src/utils/shop-basket';
import { withLambda } from '@netlify/aws-lambda-compat';

const esc = (s: string): string => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function page(statusCode: number, heading: string, bodyHtml: string) {
    return {
        statusCode,
        headers: {
            'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex',
            'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        },
        body: `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(heading)}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb;padding:16px;box-sizing:border-box}
.card{background:#fff;border-radius:1rem;padding:2.5rem;max-width:460px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#4b5563;font-size:.95rem;line-height:1.6;margin:.5rem 0}
button{font:inherit;font-weight:700;padding:.7rem 1.4rem;border-radius:.6rem;border:0;background:#111827;color:#fff;cursor:pointer;margin-top:1rem}</style></head>
<body><div class="card"><h1>${esc(heading)}</h1>${bodyHtml}</div></body></html>`,
    };
}

export default withLambda(async (event) => {
    const method = event.httpMethod;
    if (method === 'HEAD') return { statusCode: 200, body: '' };
    const b = event.queryStringParameters?.b;
    if (!isBasketId(b)) return page(404, 'This link isn\'t valid', '<p>Reply to the email you got, or contact the business, and they will stop emailing you.</p>');

    if (method === 'GET') {
        const action = `?b=${encodeURIComponent(b)}`;
        return page(200, 'Unsubscribe', `<p>Stop getting emails from this business at the address the basket reminder was sent to?</p><form method="post" action="${esc(action)}"><button type="submit">Unsubscribe</button></form>`);
    }
    if (method !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        const r = await stopRemindedAddress(getDb(), b);
        if (!r) return page(404, 'This link has expired', '<p>Reply to the email you got, or contact the business, and they will stop emailing you.</p>');
        return page(200, 'You\'re unsubscribed', `<p>${esc(r.business)} won't email you any more.</p>`);
    } catch (err) {
        // An unrecorded opt-out means emailing someone who asked us not to: log it loudly, and tell them what to do.
        console.error('[shop-reminder-stop] FAILED to record an unsubscribe', { basket: b, message: err instanceof Error ? err.message : String(err) });
        return page(200, 'Something went wrong', '<p>We couldn\'t record that just now. Please try the link again in a minute, or reply to the email and the business will stop emailing you.</p>');
    }
});
