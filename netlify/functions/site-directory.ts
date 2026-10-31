// netlify/functions/site-directory.ts — the site page directory (docs/site-directory-plan.md):
// Business Information ▸ Website Pages and the chat's site_directory card both call this, the same
// server action (memory: assistant-gui-chat-parity).
//
//   GET                                   → DirectoryView (pages, status, when it can be re-read)
//   POST { action: 'refresh' }            → re-read the site (once an hour; hosted sites at once)
//   POST { action: 'exclude', path }      → leave a page out of every assistant's view
//   POST { action: 'include', path }      → put it back
//
// Costs no task (plan D6). Any member of the workspace; impersonation is read-only (requireTenant).

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import { cleanDirectoryPath } from '../../src/utils/site-directory';
import { directoryView, loadDirectoryRow, requestDirectoryRefresh, setDirectoryPageExcluded } from '../../src/utils/site-directory-store';

const json = (statusCode: number, body: unknown) => ({ statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body: JSON.stringify(body) });

export default withLambda(async (event) => {
    const method = event.httpMethod;
    if (method !== 'GET' && method !== 'POST') return json(405, { error: 'Method not allowed.' });
    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    try {
        if (method === 'GET') return json(200, directoryView(await loadDirectoryRow(db, orgId)));

        let body: Record<string, unknown> = {};
        try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Bad request.' }); }
        const action = body.action;
        if (action === 'refresh') {
            const r = await requestDirectoryRefresh(db, orgId, { userId: ctx.userId, manual: true });
            return r.ok ? json(200, r.view) : json(r.status, { error: r.error });
        }
        if (action === 'exclude' || action === 'include') {
            const path = cleanDirectoryPath(body.path);
            if (!path) return json(400, { error: 'Which page? Send its address, e.g. /about.' });
            const r = await setDirectoryPageExcluded(db, orgId, path, action === 'exclude');
            return r.ok ? json(200, r.view) : json(r.status, { error: r.error });
        }
        return json(400, { error: 'Unknown action.' });
    } catch (err) {
        console.error('[site-directory]', err);
        return json(500, { error: 'Your website pages aren\'t available just now.' });
    }
});
