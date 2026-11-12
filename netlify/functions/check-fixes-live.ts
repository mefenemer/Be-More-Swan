// netlify/functions/check-fixes-live.ts — scheduled (netlify.toml): Issues live check + auto-close.
//
// Confirms merged fixes are inside the commit this deploy was built from, tells each reporter once
// their fix is live, and closes issues nobody replied to 7 days later. The same tick closes support
// tickets left waiting on the customer for 7 days (src/utils/ticket-auto-close.ts). All the logic and its safety
// notes are in src/utils/issue-fix-live.ts.
//
// ⚠️ Netlify fires scheduled functions ONLY on the production deploy. Staging is a branch deploy, so
// this never runs there — .github/workflows/staging-crons.yml pokes run-fix-live-check instead,
// which calls the same function. The two must stay in step.
//
// Needs GITHUB_FIX_CHECK_TOKEN (fine-grained, this repo only, read-only Contents + Pull requests).
// Without it the live check is skipped and logged; auto-close still runs.

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { runFixLiveCheck, type FixLiveResult } from '../../src/utils/issue-fix-live';
import { syncOpenCloudMerges } from '../../src/utils/issue-cloud-merge';
import { autoCloseQuietTickets } from '../../src/utils/ticket-auto-close';

export async function runFixesLiveCheck(): Promise<FixLiveResult & { mergesSynced?: number; ticketsAutoClosed: number }> {
    const db = getDb();
    // Merges to staging running in GitHub Actions first, so one that just landed is checked below.
    const mergesSynced = await syncOpenCloudMerges(db);
    const result = { ...(await runFixLiveCheck(db)), mergesSynced };
    if (result.skipped) console.warn(`[check-fixes-live] live check skipped: ${result.skipped}`);
    // Support tickets follow the same 7-quiet-days rule (src/utils/ticket-auto-close.ts) on the same tick.
    const ticketsAutoClosed = await autoCloseQuietTickets(db);
    return { ...result, ticketsAutoClosed };
}

export default withLambda(async () => {
    try {
        const result = await runFixesLiveCheck();
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: true, ...result }),
        };
    } catch (err) {
        console.error('[check-fixes-live]', err);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ok: false, error: err instanceof Error ? err.message : 'error' }),
        };
    }
});
