// scripts/submit-missing-swan-index.ts
// Submit published blog posts that never reached The Swan Index to its editorial desk
// (admin.html?view=swan-queue), where an editor reviews them as normal.
//
// Why they are missing: a post is sent to the desk ONLY at the moment it is published
// (publishBlogPost → syndicatePublishedPost), and only if its workspace has an active Swan Index
// profile. Profiles became default-on for every workspace on 2026-09-29, but that does not reach
// back — anything published before its workspace had a profile was never sent, and nothing retries.
//
// Eligible = all of:
//   · blog_posts.status = 'published' with a body;
//   · no swan_index_posts row for it (never submitted — a withdrawn or rejected piece HAS a row and
//     is left alone: those are editorial decisions);
//   · its workspace has an ACTIVE swan_index_profiles row (a 'withdrawn' profile is an explicit
//     Disconnect and is respected);
//   · the author did not exclude the magazine for that post (destinations.selected, when set, must
//     include 'swanindex' — an empty list means "my site only").
//
// Each post goes through the normal send path restricted to The Swan Index only, so LinkedIn and any
// other connected platform are NOT re-sent. It lands as 'pending' (noindex until an editor takes it
// live), with the usual safety check, and the desk's arrival email fires once per piece.
//
// DRY RUN by default.
//   npx tsx scripts/submit-missing-swan-index.ts --url-var=DATABASE_URL_PROD
//   npx tsx scripts/submit-missing-swan-index.ts --url-var=DATABASE_URL_PROD --apply
//   npx tsx scripts/submit-missing-swan-index.ts --url-var=DATABASE_URL_PROD --id=123 --apply
//
// ⚠️ --url-var takes the NAME of an environment variable, never a connection string.

import { config } from 'dotenv';
import path from 'path';

config({ path: path.resolve(process.cwd(), '.env') });

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const flag = (name: string) => {
    const eq = args.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const i = args.indexOf(`--${name}`);
    return i !== -1 ? args[i + 1] : undefined;
};
const urlVar = flag('url-var') ?? 'NETLIFY_DATABASE_URL';
const onlyId = Number(flag('id')) || null;

function describeTarget(): string {
    const raw = process.env[urlVar];
    if (!raw) return `${urlVar} is not set`;
    try { const u = new URL(raw); return `${u.host}${u.pathname}  [${urlVar}]`; }
    catch { return `unparseable ${urlVar}`; }
}

async function main() {
    const conn = process.env[urlVar];
    if (!conn) {
        console.error(`\n${urlVar} is not set. Load .env, or pass --url-var=<NAME> naming the variable that holds the database URL.\n`);
        process.exit(1);
    }
    process.env.NETLIFY_DATABASE_URL = conn;

    const { getDb } = await import('../db/client');
    const { eq } = await import('drizzle-orm');
    const { blogPosts } = await import('../db/schema');
    const { syndicatePublishedPost } = await import('../src/utils/blog-destinations/syndicate');
    const db = getDb();

    console.log('\nSubmit published blog posts missing from The Swan Index');
    console.log(`  target : ${describeTarget()}`);
    console.log(`  mode   : ${apply ? 'APPLY (submits to the editorial desk)' : 'DRY RUN (writes nothing)'}`);
    console.log(`  scope  : ${onlyId ? `post ${onlyId}` : 'all organisations'}\n`);

    const idClause = onlyId ? `AND bp.id = ${onlyId}` : '';
    const rows = await db.execute<{
        id: number; organisation_id: number; org: string | null; title: string; published_at: string | null;
        excluded: boolean; profile_status: string | null;
    }>(
        `SELECT bp.id, bp.organisation_id, o.name AS org, bp.title, bp.published_at,
                (jsonb_typeof(bp.destinations->'selected') = 'array'
                   AND NOT (bp.destinations->'selected') ? 'swanindex') AS excluded,
                p.status AS profile_status
           FROM blog_posts bp
           JOIN organisations o ON o.id = bp.organisation_id
           LEFT JOIN swan_index_profiles p ON p.organisation_id = bp.organisation_id
          WHERE bp.status = 'published'
            AND coalesce(btrim(bp.body_markdown), '') <> ''
            AND NOT EXISTS (SELECT 1 FROM swan_index_posts sp WHERE sp.blog_post_id = bp.id)
            ${idClause}
          ORDER BY bp.organisation_id, bp.published_at`
    );

    const eligible = rows.filter((r) => r.profile_status === 'active' && !r.excluded);
    const skipped = rows.filter((r) => !(r.profile_status === 'active' && !r.excluded));

    console.log(`  Published posts not on The Swan Index: ${rows.length}`);
    console.log(`  Eligible to submit: ${eligible.length}\n`);
    for (const r of eligible) {
        console.log(`  · #${r.id}  ${r.org ?? r.organisation_id} — "${r.title}"  (published ${r.published_at ? new Date(r.published_at).toISOString().slice(0, 10) : '?'})`);
    }
    if (skipped.length) {
        console.log('\n  Left alone:');
        for (const r of skipped) {
            const why = r.excluded ? 'the author excluded The Swan Index for this post'
                : r.profile_status ? `the workspace's Swan Index profile is ${r.profile_status}`
                : 'the workspace has no Swan Index profile';
            console.log(`  · #${r.id}  ${r.org ?? r.organisation_id} — "${r.title}": ${why}`);
        }
    }

    if (!apply) {
        console.log(`\n  DRY RUN — nothing sent. Re-run with --apply to submit ${eligible.length} post${eligible.length === 1 ? '' : 's'}.\n`);
        process.exit(0);
    }

    let ok = 0, failed = 0;
    console.log('');
    for (const r of eligible) {
        const [post] = await db.select().from(blogPosts).where(eq(blogPosts.id, r.id)).limit(1);
        if (!post || post.status !== 'published') { console.log(`  ✗ #${r.id}: no longer published — skipped`); failed++; continue; }
        try {
            const results = await syndicatePublishedPost(db, r.organisation_id, post, { only: ['swanindex'] });
            const out = results.swanindex as { status?: string; error?: string } | undefined;
            if (out && out.status !== 'error' && out.status !== 'not_connected') {
                console.log(`  ✓ #${r.id} submitted (${out.status})`);
                ok++;
            } else {
                console.log(`  ✗ #${r.id}: ${out?.error || out?.status || 'nothing was sent'}`);
                failed++;
            }
        } catch (err) {
            console.log(`  ✗ #${r.id}: ${err instanceof Error ? err.message : String(err)}`);
            failed++;
        }
    }
    console.log(`\n  Submitted ${ok}, failed ${failed}. They are waiting at admin.html?view=swan-queue.\n`);
    process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
