// netlify/functions/linkedin-ads-media.ts
// Put an image into LinkedIn's asset store so an advert can use it.
//
//   POST { action: 'upload', imageUrl } → { mediaUrn }
//
// ── Why this exists at all ──────────────────────────────────────────────────────────────────────
// A LinkedIn Sponsored Content ad is a POST WITH MEDIA. Both of LinkedIn's own createInline
// examples carry `content.media.id`, and there is no documented text-only variant of this ad type.
// So without an uploaded image, no advert can be created — this was the last blocking gap in the
// whole paid pipeline.
//
// ── It takes a URL, not a file ──────────────────────────────────────────────────────────────────
// Deliberately. The workspace already has images: brand cards rendered by satori/resvg, content
// assets, blog feature images. Taking a URL means every one of those is usable immediately, and a
// file picker can be added later as another way to produce a URL rather than a second upload path.
//
// ⚠️ FETCHED THROUGH safe-fetch. The caller supplies a URL that OUR SERVER then requests, which is
// textbook SSRF — cloud instance metadata, localhost admin ports, anything in the VPC. safe-fetch
// pins the connection to a pre-validated public address and re-checks every redirect hop.

import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import { hasFeatureByOrg } from '../../src/utils/plan-features';
import { PAID_ADS_FEATURE } from '../../src/config/ad-networks';
import { assessAdsReadiness, getAdsConnection, getAdsToken } from '../../src/utils/linkedin-ads-connection';
import {
    ALLOWED_IMAGE_TYPES, MAX_IMAGE_PIXELS, fetchAccountOrganization, uploadImage,
} from '../../src/utils/ad-networks/linkedin';
import { safeFetchBinary } from '../../src/utils/safe-fetch';
import { isProductionDeploy } from '../../src/utils/deploy-context';
import { withLambda } from '@netlify/aws-lambda-compat';

/**
 * Bytes we are willing to pull and forward.
 *
 * LinkedIn's own limit is a PIXEL count, which cannot be known without decoding the image — so this
 * is a proxy that costs nothing to enforce. 10MB is comfortably above any sane advert image and
 * comfortably below anything that would strain a function's memory.
 */
const MAX_BYTES = 10 * 1024 * 1024;

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    if (!await hasFeatureByOrg(db, orgId, PAID_ADS_FEATURE)) {
        return json(403, { error: 'Paid advertising is not available on this plan.' });
    }
    // Same environment gate as staging itself: the Development Tier adapter is not for production,
    // and uploading an asset for an advert that could never be created would be pure waste.
    if (isProductionDeploy(event.headers as Record<string, string | undefined>)) {
        return json(400, { error: 'Advertising is not available here yet.' });
    }

    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    if (String(body.action || '') !== 'upload') return json(400, { error: 'Unknown action.' });

    const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
    if (!imageUrl) return json(400, { error: 'Which image should this advert use?' });

    const readiness = assessAdsReadiness(await getAdsConnection(db, orgId));
    if (!readiness.ready) return json(400, { error: readiness.reason });
    const token = await getAdsToken(db, orgId);
    if (!token) return json(400, { error: 'The LinkedIn advertising connection needs reconnecting.' });

    // Fetch the bytes. SSRF-fenced — see the header.
    let bytes: ArrayBuffer;
    let contentType: string;
    try {
        // ⚠️ safeFetchBINARY. safeFetchText decodes as UTF-8 and would replace every invalid byte
        // sequence with U+FFFD — silently destroying the JPEG, with no error anywhere until the
        // advert shows a broken image.
        const res = await safeFetchBinary(imageUrl, { maxBytes: MAX_BYTES });
        contentType = String(res.contentType || '').split(';')[0].trim().toLowerCase();
        if (!ALLOWED_IMAGE_TYPES.includes(contentType as never)) {
            return json(400, {
                error: `LinkedIn accepts JPG, PNG and GIF images. That link returned ${contentType || 'an unknown file type'}.`,
            });
        }
        // Node Buffer → ArrayBuffer, sliced to this buffer's own view: Buffer instances share a
        // pooled ArrayBuffer, so handing over `.buffer` unsliced would send the neighbouring
        // allocations too.
        bytes = res.bytes.buffer.slice(res.bytes.byteOffset, res.bytes.byteOffset + res.bytes.byteLength) as ArrayBuffer;
    } catch (err) {
        // ⚠️ The message is the SSRF fence's own, and it is deliberately not echoed back verbatim:
        // a refusal that names the internal address it blocked tells a prober what exists.
        console.error('[linkedin-ads-media] fetch refused or failed', { orgId }, err);
        return json(400, { error: 'That image could not be downloaded. Use a public https:// link to a JPG or PNG.' });
    }

    try {
        const owner = await fetchAccountOrganization(token, readiness.connection.selectedAccountUrn!);
        const mediaUrn = await uploadImage(token, owner, bytes, contentType);
        return json(200, { mediaUrn });
    } catch (err) {
        // LinkedIn's own sentence where there is one — it names the real problem (too large, wrong
        // format, still processing) far better than anything generic we could substitute.
        console.error('[linkedin-ads-media] upload failed', { orgId }, err);
        return json(400, {
            error: err instanceof Error ? err.message : 'That image could not be uploaded to LinkedIn.',
            maxPixels: MAX_IMAGE_PIXELS,
        });
    }
});
