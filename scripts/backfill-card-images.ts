// scripts/backfill-card-images.ts
// Fill in blog_posts.card_image_* (and the copy on swan_index_posts) for posts published BEFORE
// those columns existed.
//
// New publishes derive the thumbnail themselves — blog-publish.ts calls pickCardImage on the
// payload it is freezing. Everything already published has NULL, and would keep showing no picture
// until its author happened to re-publish it. This walks the back catalogue once.
//
// ⚠️ It reuses pickCardImage rather than reimplementing the choice in SQL. That is the entire
// reason this is a script and not a few UPDATE ... regexp_replace lines in the migration: "the
// first <img> in the body, whichever kind it is" cannot be said in one regexp, and a second
// almost-identical implementation would put a different picture on old posts than on new ones.
//
// DRY RUN by default. Nothing is written without --apply.
//
//   npx tsx scripts/backfill-card-images.ts
//   npx tsx scripts/backfill-card-images.ts --apply
//   npx tsx scripts/backfill-card-images.ts --apply --url-var=DATABASE_URL_PROD
//
// ⚠️ --url-var takes the NAME of an environment variable, never a connection string: a URL on the
// command line ends up in shell history and in this session's transcript.

import { config } from 'dotenv';
import path from 'path';
import { eq, and, isNull, isNotNull } from 'drizzle-orm';

config({ path: path.resolve(process.cwd(), '.env') });

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const urlVar = flag('url-var') ?? 'NETLIFY_DATABASE_URL';
const limit = Number(flag('limit')) || null;

/** Host + database of the connection, so the operator can confirm the target. Never the password. */
function describeTarget(): string {
    const raw = process.env[urlVar];
    if (!raw) return `${urlVar} is not set — the script will fail to connect`;
    try {
        const u = new URL(raw);
        return `${u.host}${u.pathname}  [${urlVar}]`;
    } catch {
        return `unparseable ${urlVar}`;
    }
}

async function main() {
    // getDb() reads NETLIFY_DATABASE_URL. Redirecting it is what makes --url-var work at all, and
    // it happens before the first call so no connection is ever opened against the default.
    if (urlVar !== 'NETLIFY_DATABASE_URL') {
        const override = process.env[urlVar];
        if (!override) {
            console.error(`\n${urlVar} is not set. Export it, or drop --url-var to use NETLIFY_DATABASE_URL.\n`);
            process.exit(1);
        }
        process.env.NETLIFY_DATABASE_URL = override;
    }

    const { getDb } = await import('../db/client');
    const { blogPosts, swanIndexPosts } = await import('../db/schema');
    const { pickCardImage, cardImageColumns } = await import('../src/utils/blog-card-image');

    const db = getDb();

    console.log('\nBackfill: blog_posts.card_image_* → swan_index_posts.card_image_*');
    console.log(`  target : ${describeTarget()}`);
    console.log(`  mode   : ${apply ? 'APPLY (writes)' : 'DRY RUN (writes nothing)'}`);
    console.log(`  scope  : published posts with no card image yet${limit ? `, first ${limit}` : ''}`);
    console.log('');

    // Only posts that are published (there is a payload to read) and have no image recorded yet.
    // Re-runnable by construction: a row that got one is out of scope next time.
    const rows = await db
        .select({
            id: blogPosts.id,
            organisationId: blogPosts.organisationId,
            title: blogPosts.title,
            publishedPayload: blogPosts.publishedPayload,
        })
        .from(blogPosts)
        .where(and(
            eq(blogPosts.status, 'published'),
            isNotNull(blogPosts.publishedPayload),
            isNull(blogPosts.cardImageAssetId),
            isNull(blogPosts.cardImageUrl),
        ))
        .limit(limit ?? 5000);

    let withImage = 0;
    let withoutImage = 0;
    let syndicated = 0;

    for (const row of rows) {
        const cols = cardImageColumns(pickCardImage(row.publishedPayload));
        const found = cols.cardImageAssetId ?? cols.cardImageUrl;
        if (!found) {
            withoutImage++;
            // Deliberately no write: the columns are already NULL, and a no-op UPDATE would bump
            // updated_at on every text-only post in the catalogue for nothing.
            continue;
        }
        withImage++;
        const where = cols.cardImageAssetId ? `asset ${cols.cardImageAssetId}` : cols.cardImageUrl;
        console.log(`  #${row.id}  ${String(row.title).slice(0, 58).padEnd(58)}  ${where}`);

        if (!apply) continue;

        await db.update(blogPosts).set(cols).where(eq(blogPosts.id, row.id));

        // The syndicated copy, if this post is on The Swan Index. Same values, because the copy is
        // exactly what the adapter would have written — see the note in blog-destinations/swanindex.ts.
        const res = await db.update(swanIndexPosts).set(cols)
            .where(eq(swanIndexPosts.blogPostId, row.id))
            .returning({ id: swanIndexPosts.id });
        syndicated += res.length;
    }

    console.log('');
    console.log(`  scanned            : ${rows.length}`);
    console.log(`  image found        : ${withImage}`);
    console.log(`  no usable image    : ${withoutImage}  (these keep their placeholder — a real answer)`);
    if (apply) console.log(`  swan index copies  : ${syndicated}`);
    console.log(apply ? '\n  Applied.\n' : '\n  Dry run — nothing written. Re-run with --apply.\n');
    process.exit(0);
}

main().catch((err) => {
    console.error('\nBackfill failed:', err);
    process.exit(1);
});
