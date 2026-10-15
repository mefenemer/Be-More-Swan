// netlify/functions/form-download.ts — a sign-up form's free download, from the link in its email.
// GET /api/forms/download?f=<formId>&a=<assetId>&s=<signature>   (src/utils/form-reward.ts)
//
// The signature is checked before the database. Then the form is read and must STILL offer this very
// file, and the file must be the form's workspace's own PDF — so removing or replacing the download
// retires every link sent for it. A good link gets a short-lived storage address (302); anything else
// gets a plain page saying the download is no longer available.

import { and, eq } from 'drizzle-orm';
import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { audienceForms, contentAssets } from '../../db/schema';
import { normaliseFormDefinition } from '../../src/utils/form-definition';
import { verifyReward } from '../../src/utils/form-reward';
import { presignR2Get } from '../../src/utils/social-publish';

type Res = { statusCode: number; headers?: Record<string, string>; body: string };
const gone = (): Res => ({
    statusCode: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
    body: '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Download not available</title><body style="font-family:system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 16px;color:#111"><h1 style="font-size:1.4rem">This download is no longer available</h1><p>The business may have replaced or removed it. If you still want it, please get in touch with them.</p></body>',
});

export default withLambda(async (event): Promise<Res> => {
    if (event.httpMethod !== 'GET' && event.httpMethod !== 'HEAD') return { statusCode: 405, body: 'Method Not Allowed' };
    const formId = Number(event.queryStringParameters?.f);
    const assetId = Number(event.queryStringParameters?.a);
    const sig = String(event.queryStringParameters?.s || '');
    if (!Number.isInteger(formId) || formId <= 0 || !Number.isInteger(assetId) || assetId <= 0 || !verifyReward(formId, assetId, sig)) return gone();
    try {
        const db = getDb();
        const [form] = await db.select({ organisationId: audienceForms.organisationId, definition: audienceForms.definition }).from(audienceForms).where(eq(audienceForms.id, formId)).limit(1);
        const reward = form?.definition ? normaliseFormDefinition(form.definition).definition.reward : null;
        if (!form || !reward || reward.assetId !== assetId) return gone();
        const [asset] = await db.select({ storageKey: contentAssets.storageKey, storageUrl: contentAssets.storageUrl })
            .from(contentAssets)
            .where(and(eq(contentAssets.id, assetId), eq(contentAssets.organisationId, form.organisationId), eq(contentAssets.assetType, 'document'))).limit(1);
        const url = asset?.storageKey ? await presignR2Get(asset.storageKey, 600) : asset?.storageUrl ?? null;
        if (!url) return gone();
        return { statusCode: 302, headers: { Location: url, 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }, body: '' };
    } catch (err) {
        console.error('[form-download] failed', { formId, assetId }, err);
        return { statusCode: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': '60' }, body: 'The download is not available right now. Please try the link again in a minute.' };
    }
});
