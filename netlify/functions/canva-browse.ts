// netlify/functions/canva-browse.ts
// Canva connector, US2: read-only proxy over Canva's Connect REST browse endpoints.
//
// GET ?resource=designs&query=&continuation=      → list/search the user's designs
// GET ?resource=folder&folderId=root&continuation= → list a folder's contents
//
// Everything is proxied rather than called from the browser for two reasons: the access token
// must never reach the client, and per-user rate limits (folder listing is 100 req/min) are
// absorbed server-side where we can see them.
//
// Three Canva API facts shape the response we hand back:
//   - Pagination is continuation-token based. There is no offset, no page number and no total
//     count, so the client can only ever "load more" — never jump to page 5.
//   - Thumbnail URLs expire after ~15 minutes, so they are passed straight through and MUST NOT
//     be persisted anywhere. The client re-fetches a stale page instead.
//   - There is no parent-chain API, so breadcrumbs are the client's job (it knows its descent
//     path); this function has no opinion about where the user has been.

import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import { logApiCall } from '../../src/utils/vault';
import { getFreshAccessToken, IntegrationError } from '../../src/utils/workspace-integrations';
import { withLambda } from '@netlify/aws-lambda-compat';

const CANVA_API = 'https://api.canva.com/rest/v1';
const PAGE_LIMIT = 30;               // designs max 100 / folder items max 100; 30 fills a grid

function json(statusCode: number, body: unknown) {
    return { statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** Canva design/folder/asset item → the minimal shape the picker grid needs. */
function toItem(raw: any): Record<string, unknown> | null {
    if (!raw) return null;

    // Folder items are wrapped: { type: 'folder'|'design'|'image', folder?, design?, image? }
    if (raw.type === 'folder' && raw.folder) {
        return { kind: 'folder', id: raw.folder.id, name: raw.folder.name || 'Untitled folder' };
    }
    const design = raw.type === 'design' ? raw.design : (raw.id && raw.thumbnail !== undefined ? raw : null);
    if (design) {
        // page_count is absent on some design types; absent is not the same as 1, so leave it
        // null and let the client omit the badge rather than assert a wrong count.
        const pageCount = typeof design.page_count === 'number' ? design.page_count : null;
        return {
            kind: 'design',
            id: design.id,
            name: design.title || 'Untitled design',
            // Expires ~15 min after this request — never store it.
            thumbnailUrl: design.thumbnail?.url || null,
            pageCount,
            // Rides along to the import so the worker knows whether to ask Canva for mp4 or png
            // without spending an extra API call re-fetching the design.
            designType: design.design_type?.type ?? design.design_type ?? null,
            updatedAt: design.updated_at ?? null,
        };
    }
    // An uploaded image is an ASSET, not a design, and the two id spaces are not interchangeable:
    // POST /exports takes a design id only, so an asset id 404s ("Design with id ... not found").
    // Canva has no asset-download endpoint at any resolution — GET /assets/{id} returns metadata
    // plus a 15-min thumbnail — so these can never be imported, via REST or MCP. Returned anyway,
    // under their own kind, so the grid still matches what the user sees in Canva; the client
    // renders `asset` non-selectable. Do NOT map these to kind 'design'.
    if (raw.type === 'image' && raw.image) {
        return { kind: 'asset', id: raw.image.id, name: raw.image.name || 'Untitled image', thumbnailUrl: raw.image.thumbnail?.url || null, updatedAt: raw.image.updated_at ?? null };
    }
    return null;
}

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const { userId, organisationId } = ctx;

    const q = event.queryStringParameters || {};
    const resource = q.resource === 'folder' ? 'folder' : 'designs';
    const continuation = q.continuation || '';
    const query = (q.query || '').trim();
    const folderId = q.folderId || 'root';

    let accessToken: string;
    let integrationId: number;
    try {
        const fresh = await getFreshAccessToken(db, organisationId, 'canva');
        accessToken = fresh.accessToken;
        integrationId = fresh.integrationId;
    } catch (err) {
        if (err instanceof IntegrationError) {
            // not_connected / expired are normal states the picker renders as a connect prompt,
            // not errors to shout about.
            return json(err.statusCode, { error: err.message, code: err.code });
        }
        throw err;
    }

    // Canva's search is a `query` param on the designs list; folder listing has no search, so a
    // non-empty query always means "search all designs" regardless of where the user is.
    const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (continuation) params.set('continuation', continuation);

    let path: string;
    if (resource === 'folder' && !query) {
        params.set('item_types', 'folder,design,image');
        path = `/folders/${encodeURIComponent(folderId)}/items`;
    } else {
        if (query) params.set('query', query);
        path = '/designs';
    }

    const url = `${CANVA_API}${path}?${params.toString()}`;
    let res: Response;
    try {
        res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    } catch (err) {
        console.error('[canva-browse] network error:', err);
        return json(502, { error: 'Could not reach Canva — please try again.' });
    }

    // Audit the endpoint path only — never the query string (it carries the user's search text).
    await logApiCall(db, { userId, integrationId, endpoint: `GET ${path}`, httpStatus: res.status }).catch(() => {});

    if (res.status === 429) {
        return json(429, { error: 'Canva is rate-limiting this account — wait a moment and try again.' });
    }
    if (!res.ok) {
        console.error(`[canva-browse] ${path} → ${res.status}`);
        return json(502, { error: 'Canva rejected the request — please reconnect it if this continues.' });
    }

    const data: any = await res.json().catch(() => ({}));
    const rawItems: any[] = data.items || data.designs || [];
    const items = rawItems.map(toItem).filter(Boolean);

    return json(200, {
        items,
        // Absent continuation = last page. The client stops asking for more.
        continuation: data.continuation ?? null,
        // Lets the client expire a page it has been sitting on (thumbnails die at ~15 min).
        fetchedAt: Date.now(),
    });
});
