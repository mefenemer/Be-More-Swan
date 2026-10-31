// netlify/functions/dispatch-site-directories.ts
// The site page directory's weekly refresh — scheduled daily on PRODUCTION by netlify.toml
// ([functions.dispatch-site-directories]). Starts every due refresh (src/utils/site-directory-store.ts
// dispatchDueDirectories); external sites are read in site-directory-background.ts.
//
// Staging never fires Netlify schedules, so run-site-directory-dispatch.ts wraps the same function
// for .github/workflows/staging-crons.yml (memory: nightly-sweeps-never-ran).

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { dispatchDueDirectories } from '../../src/utils/site-directory-store';

export default withLambda(async () => {
    try {
        const result = await dispatchDueDirectories(getDb());
        console.log('[dispatch-site-directories]', JSON.stringify(result));
        return { statusCode: 200, body: JSON.stringify({ ok: true, ...result }) };
    } catch (err) {
        console.error('[dispatch-site-directories] failed', err);
        return { statusCode: 500, body: JSON.stringify({ ok: false }) };
    }
});
