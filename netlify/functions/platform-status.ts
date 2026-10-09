// netlify/functions/platform-status.ts
// GET → { issues: [{ area, message }] } — platform-wide AI outages, in customer wording, for the
// dashboard banner (src/utils/platform-status.ts). Any signed-in user; nothing tenant-specific is
// read or returned. Empty when everything is working, or when it cannot be read (a banner that
// cries wolf is worse than none).

import { withLambda } from '@netlify/aws-lambda-compat';
import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import { CONFIG_KEYS, getPlatformConfig } from '../../src/utils/platform-config';
import { platformIssuesFrom } from '../../src/utils/platform-status';
import type { HeartbeatLog } from '../../src/utils/monitor-heartbeat';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };
    const ctx = await requireTenant(event, getDb());
    if ('error' in ctx) return ctx.error;
    let issues: ReturnType<typeof platformIssuesFrom> = [];
    try {
        issues = platformIssuesFrom((await getPlatformConfig(CONFIG_KEYS.MONITOR_HEARTBEAT)) as HeartbeatLog | null);
    } catch (err) {
        console.error('[platform-status] heartbeat unreadable — no banner', err);
    }
    return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=300' }, body: JSON.stringify({ issues }) };
});
