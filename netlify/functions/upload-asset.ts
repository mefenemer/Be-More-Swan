// netlify/functions/upload-asset.ts
import { HandlerEvent } from '@netlify/functions';
import Busboy from 'busboy';
import { getDb } from '../../db/client';
import { workspaceAssets } from '../../db/schema';
import { logAuditEvent } from '../../src/utils/audit';
import { resolveBaseUrl } from '../../src/utils/base-url';
import { requireTenant } from '../../src/utils/tenant';
import { withLambda } from '@netlify/aws-lambda-compat';

const parseMultipartForm = (event: HandlerEvent): Promise<any> => {
    return new Promise((resolve, reject) => {
        const fields: Record<string, string> = {};
        let fileData: Buffer | null = null;
        let fileName = '';
        let mimeType = '';

        const busboy = Busboy({
            headers: {
                'content-type': event.headers['content-type'] || event.headers['Content-Type']
            }
        });

        busboy.on('file', (name, file, info) => {
            fileName = info.filename;
            mimeType = info.mimeType;
            const chunks: Buffer[] = [];
            file.on('data', (data) => chunks.push(data));
            file.on('end', () => { fileData = Buffer.concat(chunks); });
        });

        busboy.on('field', (name, val) => { fields[name] = val; });
        busboy.on('finish', () => resolve({ fields, file: fileData, fileName, mimeType }));
        busboy.on('error', reject);

        busboy.end(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64') : event.body);
    });
};

export default withLambda(async (event: HandlerEvent) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    // Authenticate + resolve the active organisation (verifies membership; never trusts the claim alone).
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId: orgId } = ctx;

    try {
        const { fields, file, fileName } = await parseMultipartForm(event);
        const { category, url } = fields;

        if (!category) return { statusCode: 400, body: JSON.stringify({ error: 'Category is required.' }) };

        let assetName = '';
        let finalStorageUrl = null;
        let finalExternalUrl = null;
        const assetType = file ? 'file' : 'url';

        if (assetType === 'file') {
            if (!file) return { statusCode: 400, body: JSON.stringify({ error: 'No file detected.' }) };
            assetName = fileName;
            return { statusCode: 501, body: JSON.stringify({ error: 'File upload storage is not yet configured.' }) };
        } else {
            if (!url) return { statusCode: 400, body: JSON.stringify({ error: 'No URL provided.' }) };
            assetName = url;
            finalExternalUrl = url;
        }

        const [newAsset] = await db.insert(workspaceAssets).values({
            organisationId: orgId,
            uploaderId: userId,
            name: assetName,
            assetType: assetType,
            category: category,
            storageUrl: finalStorageUrl,
            externalUrl: finalExternalUrl,
            status: 'processing'
        }).returning();

        logAuditEvent({
            userId: userId,
            actionType: 'CREATE',
            resourceType: 'workspace_assets',
            resourceId: newAsset.id,
            newState: newAsset,
            ipAddress: event.headers['client-ip'] || event.headers['x-forwarded-for'] || 'unknown',
            userAgent: event.headers['user-agent'] || 'unknown'
        });

        // 6. Trigger Background Scraper/RAG Worker
        console.log(`[RAG TRIGGERED] Kicked off extraction job for Asset ID: ${newAsset.id}`);
        const uploadBaseUrl = resolveBaseUrl(event.headers);
        if (uploadBaseUrl) {
            // MUST be awaited: on Lambda the runtime freezes as soon as the handler returns, so an
            // un-awaited fetch gets frozen mid-flight and never reaches the worker. The background
            // function returns 202 before the work runs, so the await only costs the trigger
            // round-trip; the AbortController caps a stalled trigger.
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 5_000);
            try {
                await fetch(`${uploadBaseUrl}/.netlify/functions/process-asset-background`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ assetId: newAsset.id }),
                    signal: controller.signal,
                });
            } catch (err) {
                console.error("Failed to trigger background worker:", err);
            } finally {
                clearTimeout(timer);
            }
        } else {
            console.error('[upload-asset] Could not resolve base URL — background RAG worker not triggered for asset', newAsset.id);
        }

        return { statusCode: 200, body: JSON.stringify({ success: true, asset: newAsset }) };

    } catch (error) {
        console.error('Upload Asset Error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to upload asset.' }) };
    }
});