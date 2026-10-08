// tests/media-failure-evidence.test.ts
// The SQL behind "AI images/videos are failing across workspaces" (check-provider-balances.ts,
// readMediaFailureEvidence), run against REAL Postgres — Brand Designer plan, Phase 0.
//
// WHY A DATABASE TEST. The rules (assessMediaFailures) are pure and tested in provider-balances.test.ts,
// but the alert is only as good as the rows it is fed. A query that counts the lock twice sends two
// emails for one outage; one that counts a policy refusal or operator clean-up cries wolf; one that
// misses a video stuck in `processing` stays silent through the failure it was written for. Those
// are all SQL, so they are proven here on a schema built from db/schema.ts.
//
// HOW. Copies of media_generation_jobs and content_assets (`LIKE … INCLUDING DEFAULTS` — the real
// columns, without the foreign keys) in a throwaway schema, on ONE connection with search_path set to
// it. Nothing touches the real tables, and a renamed column fails here, not in prod.
//
// ⚠️ Runs ONLY against a database on localhost (CI's Postgres service, rls job). db/client loads
// .env, and locally that is STAGING — this test must never create schemas there.
//
// Run:  npx tsx tests/media-failure-evidence.test.ts

import assert from 'node:assert';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { readMediaFailureEvidence } from '../netlify/functions/check-provider-balances';
import { assessMediaFailures } from '../src/utils/provider-balance';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
    try {
        await fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

function isLocal(url: string | undefined): url is string {
    if (!url) return false;
    try { return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(url).hostname); }
    catch { return false; }
}

async function main() {
    console.log('Media failure evidence — the SQL, on real Postgres');
    const url = process.env.NETLIFY_DATABASE_URL;
    if (!isLocal(url)) { console.log('  ⊘ skipped — no LOCAL database (CI rls job only; never staging/prod)'); return; }

    const schema = `media_evidence_test_${Date.now()}`;
    const sql = postgres(url, { max: 1 });
    try {
        await sql.unsafe(`CREATE SCHEMA ${schema}`);
        await sql.unsafe(`CREATE TABLE ${schema}.media_generation_jobs (LIKE public.media_generation_jobs INCLUDING DEFAULTS)`);
        await sql.unsafe(`CREATE TABLE ${schema}.content_assets (LIKE public.content_assets INCLUDING DEFAULTS)`);
        await sql.unsafe(`SET search_path TO ${schema}`);

        const job = (org: number, mediaType: string, status: string, error: string | null, createdAgo: string, updatedAgo: string) =>
            sql.unsafe(
                `INSERT INTO media_generation_jobs (organisation_id, media_type, prompt, aspect_ratio, model, credit_cost, status, error_message, created_at, updated_at)
                 VALUES ($1, $2, 'p', '1:1', 'm', 1, $3, $4, now() - $5::interval, now() - $6::interval)`,
                [org, mediaType, status, error, createdAgo, updatedAgo],
            );
        const asset = (assetType: string, provider: string, ago: string) =>
            sql.unsafe(`INSERT INTO content_assets (user_id, name, asset_type, provider, created_at) VALUES (1, 'a', $1, $2, now() - $3::interval)`,
                [assetType, provider, ago]);

        const NOT_FOUND = 'Fal request failed (404): {"detail":"Application not found"}';
        // Video — two real failures, one stuck job, and everything that must NOT count.
        await job(1, 'video', 'failed', NOT_FOUND, '2 hours', '2 hours');
        await job(2, 'video', 'failed', NOT_FOUND, '1 hour', '1 hour');
        await job(6, 'video', 'processing', null, '3 hours', '2 hours');                     // stuck
        await job(3, 'video', 'failed', 'Fal request unavailable (403): {"detail":"User is locked. Reason: Exhausted balance."}', '1 hour', '1 hour');
        await job(4, 'video', 'failed', 'Superseded: retired by an operator', '1 hour', '1 hour');
        await job(5, 'video', 'flagged', 'Prompt flagged for policy violation.', '1 hour', '1 hour');
        await job(9, 'video', 'failed', 'Owning user no longer exists.', '1 hour', '1 hour');
        await job(7, 'video', 'processing', null, '20 minutes', '10 minutes');              // still running
        await job(8, 'video', 'failed', NOT_FOUND, '30 hours', '30 hours');                 // outside 24h
        await job(10, 'video', 'queued', null, '3 days', '3 days');                        // ancient, already alerted
        await asset('video', 'fal', '5 hours');
        // Image — one workspace only, and its only "success" is a stock photo.
        await job(1, 'image', 'failed', 'timeout', '1 hour', '1 hour');
        await asset('image', 'pexels', '10 minutes');

        const db = drizzle({ client: sql });
        const evidence = await readMediaFailureEvidence(db as never);
        const video = evidence.find(e => e.mediaType === 'video');
        const image = evidence.find(e => e.mediaType === 'image');

        await check('video: two failures + one stuck job, across three workspaces', () => {
            assert.ok(video, 'no video row');
            assert.strictEqual(video!.failures, 2, 'lock, Superseded, flagged, deleted owner and >24h must not count');
            assert.strictEqual(video!.stuck, 1, 'processing >1h counts; 10 min does not; 3 days ago is out of window');
            assert.strictEqual(video!.organisations, 3);
        });

        await check('the most common error is reported, and the last fal video is found', () => {
            assert.strictEqual(video!.topError, NOT_FOUND);
            assert.ok(video!.lastSuccessAt && video!.latestAt);
            assert.ok(new Date(video!.lastSuccessAt!) < new Date(video!.latestAt!), 'the success predates the failures');
        });

        await check('a stock photo is not a fal success', () => {
            assert.ok(image);
            assert.strictEqual(image!.organisations, 1);
            assert.strictEqual(image!.lastSuccessAt, null);
        });

        await check('fed to the rules: video is DOWN, a single-workspace image failure is quiet', () => {
            const problems = assessMediaFailures(evidence);
            assert.deepStrictEqual(problems.map(p => [p.severity, p.headline]), [['down', 'AI videos are failing for 3 workspaces']]);
        });
    } finally {
        await sql.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
        await sql.end();
    }
    console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
