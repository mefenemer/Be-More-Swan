// netlify/functions/build-info.ts — the git commit this deploy was built from.
//
//   GET /.netlify/functions/build-info → { "commit": "<40-char sha>" | null }
//
// Public on purpose: the prod site's Fix pipeline asks the STAGING site which commit it runs, to tick
// "Live on staging" before the owner approves a fix for production (src/utils/issue-fix-proof.ts).
// Only the commit id, which is already in every deploy's public Netlify URL history; nothing else.

import { BUILD_COMMIT } from '../../src/generated/build-commit';
import { isFullSha } from '../../src/utils/issue-fix-live';

export default async (req: Request): Promise<Response> => {
    if (req.method !== 'GET') return new Response('Method Not Allowed', { status: 405 });
    return new Response(JSON.stringify({ commit: isFullSha(BUILD_COMMIT) ? BUILD_COMMIT : null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
};
