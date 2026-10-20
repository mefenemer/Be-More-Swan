// netlify/functions/publish-now-background.ts
// Run the publisher(s) for the given platforms straight away — dispatched by approve-post on a
// "Post now", so the post goes out in seconds rather than on the next 10-minute cron tick.
//
// It runs the SAME handlers the cron runs, in-process, so there is one publishing path. They pick up
// every due post on that platform, not just the one that was approved — harmless, those were due.
// Overlapping a cron tick is safe because each publisher claims its rows in ONE atomic UPDATE (see
// the claim in publish-social-posts.ts).
//
// AUTH: the shared background-worker secret, failing closed — this publishes to customers' accounts.

import publishInstagram from './publish-instagram';
import publishFacebook from './publish-facebook';
import publishSocialPosts from './publish-social-posts';
import { withLambda } from '@netlify/aws-lambda-compat';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

type Runner = (req: Request, ctx: unknown) => Promise<unknown>;
const RUNNERS: Record<'instagram' | 'facebook' | 'social', Runner> = {
    instagram: publishInstagram as unknown as Runner,
    facebook: publishFacebook as unknown as Runner,
    social: publishSocialPosts as unknown as Runner,   // linkedin, x, threads, youtube
};
const runnerFor = (platform: string) =>
    platform === 'instagram' ? 'instagram' : platform === 'facebook' ? 'facebook' : 'social';

export default withLambda(async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    const secret = process.env.CRON_TRIGGER_SECRET;
    if (!secret) return json(503, { ok: false, error: 'Worker not configured.' });
    const auth = event.headers['authorization'] || event.headers['Authorization'] || '';
    if (auth.replace(/^Bearer\s+/i, '').trim() !== secret) return json(401, { ok: false, error: 'Unauthorized.' });

    let platforms: string[] = [];
    try { platforms = (JSON.parse(event.body || '{}').platforms ?? []).filter((p: unknown) => typeof p === 'string'); }
    catch { return json(400, { ok: false, error: 'Invalid JSON.' }); }

    const which = [...new Set(platforms.map(runnerFor))];
    // The handlers ignore their input, but withLambda still builds an event from a real Request.
    const host = event.headers['host'] || 'localhost';
    for (const key of which) {
        try {
            await RUNNERS[key](new Request(`https://${host}/.netlify/functions/publish-now-background`, {
                method: 'POST',
                headers: { 'x-forwarded-host': host, 'x-forwarded-proto': 'https' },
            }), {});
        } catch (err) {
            // The post stays due, so the cron picks it up on its next tick.
            console.error(`[publish-now-background] ${key} publisher failed:`, err instanceof Error ? err.message : err);
        }
    }
    return json(200, { ok: true, ran: which });
});
