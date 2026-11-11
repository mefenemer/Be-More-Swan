// netlify/functions/qr-code.ts — a QR code for a link the user chooses (src/utils/qr-link.ts).
// Used by the Website Assistant's booking link card and the chat's qr_code card (Website + Brand Designer).
//
//   GET  ?prefer=booking|offer|website → { suggestion: { url, source, label } | null }
//   POST { url }                       → { url, svg, png }   the link as checked; SVG + PNG (data URL)
//
// Signed-in workspaces only (no open QR service on our domain). Not AI work: no tasks.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import { drawQr, suggestedQrLink, type QrSuggestionSource } from '../../src/utils/qr-link';

const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    try {
        if (event.httpMethod === 'GET') {
            const p = event.queryStringParameters?.prefer;
            const prefer = p === 'booking' || p === 'offer' || p === 'website' ? p as QrSuggestionSource : undefined;
            return json(200, { suggestion: await suggestedQrLink(db, ctx.organisationId, prefer) });
        }
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }
        const qr = await drawQr(body.url);
        if (!qr) return json(400, { error: 'That doesn\'t look like a web address. Try something like yourshop.co.uk or https://yourshop.co.uk/offer.' });
        return json(200, qr);
    } catch (err) {
        console.error('[qr-code]', err instanceof Error ? err.message : err);
        return json(500, { error: 'The QR code couldn\'t be made just now. Please try again.' });
    }
});
