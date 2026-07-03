// netlify/functions/get-workspace-assets.ts
// US-STOR-1.2.1: List the active organisation's brand/workspace assets for the Brand Assets page.
//
// GET → { assets: [{ id, name, category, assetType, status, mimeType, fileSizeBytes, isFile, externalUrl, createdAt }] }
//
// Org is resolved from the session (requireTenant); only the caller's org's assets are returned.

import { HandlerEvent } from '@netlify/functions';
import { and, desc, eq, ne } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { workspaceAssets } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

export const handler = async (event: HandlerEvent) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { organisationId: orgId } = ctx;

    try {
        const rows = await db
            .select({
                id:            workspaceAssets.id,
                name:          workspaceAssets.name,
                category:      workspaceAssets.category,
                assetType:     workspaceAssets.assetType,
                status:        workspaceAssets.status,
                mimeType:      workspaceAssets.mimeType,
                fileSizeBytes: workspaceAssets.fileSizeBytes,
                r2Key:         workspaceAssets.r2Key,
                externalUrl:   workspaceAssets.externalUrl,
                createdAt:     workspaceAssets.createdAt,
            })
            .from(workspaceAssets)
            .where(and(
                eq(workspaceAssets.organisationId, orgId),
                // hide soft-deleted / tombstoned rows
                ne(workspaceAssets.status, 'deleted'),
                ne(workspaceAssets.status, 'tombstoned'),
            ))
            .orderBy(desc(workspaceAssets.createdAt));

        // isFile = stored object (has an r2Key); don't leak r2Key to the client.
        const assets = rows.map(({ r2Key, ...a }) => ({ ...a, isFile: !!r2Key }));
        return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ assets }) };
    } catch (e) {
        console.error('[get-workspace-assets]', e);
        return { statusCode: 500, body: JSON.stringify({ error: 'Failed to load assets.' }) };
    }
};
