// netlify/functions/meta-ads-media.ts
// Put an image into the selected Meta ad account's image library so a creative can use it.
//
//   POST { action: 'upload', imageUrl } → { mediaUrn: <image hash> }
//
// Mirrors linkedin-ads-media.ts: takes a URL (every workspace image already has one), fetched
// through safe-fetch because the caller chooses a URL our server then requests (SSRF). The returned
// "mediaUrn" is Meta's image HASH — stage_paid passes it through as the variant's media, and the
// Meta adapter cites it in the creative.
import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import { hasFeatureByOrg } from '../../src/utils/plan-features';
import { PAID_ADS_FEATURE } from '../../src/config/ad-networks';
import {
    assessMetaAdsReadiness, getMetaAdsConnection, getMetaAdsToken, metaAdsAllowedInProduction, metaAdsCreateProblem,
} from '../../src/utils/meta-ads-connection';
import { META_ALLOWED_IMAGE_TYPES, metaErrorDetail, uploadMetaImage } from '../../src/utils/ad-networks/meta';
import { safeFetchBinary } from '../../src/utils/safe-fetch';
import { isProductionDeploy } from '../../src/utils/deploy-context';
import { withLambda } from '@netlify/aws-lambda-compat';

/** Meta's own image limit is 30MB; 10MB is plenty for an advert and kind to function memory. */
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
    // The Meta adapter is development only (plus META_ADS_PROD_ORG_IDS); an asset for an advert that
    // cannot be created is waste.
    if (isProductionDeploy(event.headers as Record<string, string | undefined>) && !metaAdsAllowedInProduction(orgId)) {
        return json(400, { error: 'Advertising is not available here yet.' });
    }

    let body: Record<string, unknown>;
    try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON' }); }
    if (String(body.action || '') !== 'upload') return json(400, { error: 'Unknown action.' });
    const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
    if (!imageUrl) return json(400, { error: 'Which image should this advert use?' });

    const connection = await getMetaAdsConnection(db, orgId);
    const readiness = assessMetaAdsReadiness(connection);
    if (!readiness.ready) return json(400, { error: readiness.reason });
    const createProblem = metaAdsCreateProblem(connection);
    if (createProblem) return json(400, { error: createProblem, code: 'meta_ads_not_ready' });
    const token = await getMetaAdsToken(db, orgId);
    if (!token) return json(400, { error: 'The Meta advertising connection needs reconnecting.' });

    let bytes: ArrayBuffer;
    try {
        // safeFetchBINARY — the text variant would UTF-8-decode and destroy the image silently.
        const res = await safeFetchBinary(imageUrl, { maxBytes: MAX_BYTES });
        const contentType = String(res.contentType || '').split(';')[0].trim().toLowerCase();
        if (!META_ALLOWED_IMAGE_TYPES.includes(contentType as never)) {
            return json(400, { error: `Meta accepts JPG, PNG and GIF images. That link returned ${contentType || 'an unknown file type'}.` });
        }
        // Sliced to this Buffer's own view: pooled Buffers share an ArrayBuffer with neighbours.
        bytes = res.bytes.buffer.slice(res.bytes.byteOffset, res.bytes.byteOffset + res.bytes.byteLength) as ArrayBuffer;
    } catch (err) {
        // The SSRF fence's message is not echoed: naming a blocked internal address helps a prober.
        console.error(`[meta-ads-media] fetch refused or failed (org ${orgId}): ${err instanceof Error ? err.message : String(err)}`);
        return json(400, { error: 'That image could not be downloaded. Use a public https:// link to a JPG or PNG.' });
    }

    try {
        const hash = await uploadMetaImage(token, readiness.connection.selectedAccountId!, bytes);
        return json(200, { mediaUrn: hash });
    } catch (err) {
        const detail = metaErrorDetail(err) ?? (err instanceof Error ? err.message : String(err));
        console.error(`[meta-ads-media] upload failed (org ${orgId}): ${detail}`);
        return json(400, { error: 'That image could not be uploaded to Meta.', detail });
    }
});
