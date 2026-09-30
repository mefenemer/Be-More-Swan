// scripts/repair-json-blog-bodies.ts
// Convert blog posts whose body was saved as the Blog Writer's raw layout JSON into readable text.
//
// Before d1fd5db4 (2026-09-30) a layout reply that failed to parse whole was saved verbatim, so a
// post read `{"kind": "prose", "markdown": …}` top to bottom — first seen on Restorative Futures,
// "Restorative Practice with Gang-Involved Young People: Safety and Belonging". That commit stops
// new ones; this converts the ones already saved, keeping the wording that is there.
// src/utils/blog-json-body-repair.ts does the conversion and says what it cannot recover
// (pictures, link addresses).
//
// ── ⚠️ PUBLISHED POSTS ARE SERVED FROM A SNAPSHOT ──────────────────────────────────────────────
// blog-page, widget-api and the Swan Index read `published_payload` (HTML + description frozen at
// publish), not body_markdown. Fixing only the body would leave the live page showing the JSON. For
// a published post this rebuilds the snapshot's html and description exactly as blog-publish.ts
// does, and keeps everything else in it (title, tags, feature image). A copy already syndicated to
// LinkedIn cannot be edited from here — the script names those so you can fix them by hand.
//
// A meta description that is itself JSON is cleared, so the description falls back to the excerpt.
//
// ── Safety ──────────────────────────────────────────────────────────────────────────────────────
// DRY RUN by default: prints each post and a preview of its converted opening. --apply writes.
// Each write is conditional on the body being unchanged since it was read, so an edit made in Blog
// Studio mid-run is never overwritten. Before writing, every original body (and snapshot) is saved
// to a local backup file, named in the output.
//
//   npx tsx scripts/repair-json-blog-bodies.ts                                   # staging, dry run
//   npx tsx scripts/repair-json-blog-bodies.ts --url-var=DATABASE_URL_PROD       # prod, dry run
//   npx tsx scripts/repair-json-blog-bodies.ts --url-var=DATABASE_URL_PROD --id=123 --apply
//   npx tsx scripts/repair-json-blog-bodies.ts --url-var=DATABASE_URL_PROD --apply
//
// ⚠️ --url-var takes the NAME of an environment variable, never a connection string: a URL on the
// command line ends up in shell history and in transcripts.

import { config } from 'dotenv';
import path from 'path';
import { writeFileSync } from 'fs';

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
const onlyOrg = Number(flag('org')) || null;

/** Host + database only — never the password. */
function describeTarget(): string {
    const raw = process.env[urlVar];
    if (!raw) return `${urlVar} is not set`;
    try { const u = new URL(raw); return `${u.host}${u.pathname}  [${urlVar}]`; }
    catch { return `unparseable ${urlVar}`; }
}

async function main() {
    const conn = process.env[urlVar];
    if (!conn) {
        // No fallback to another variable, deliberately — see db/seed-connection.ts.
        console.error(`\n${urlVar} is not set. Load .env, or pass --url-var=<NAME> naming the variable that holds the database URL.\n`);
        process.exit(1);
    }
    process.env.NETLIFY_DATABASE_URL = conn;

    const { getDb } = await import('../db/client');
    const { and, eq } = await import('drizzle-orm');
    const { blogPosts, organisations } = await import('../db/schema');
    const { repairJsonBody, looksLikeLayoutJson } = await import('../src/utils/blog-json-body-repair');
    const { renderMarkdown, excerpt } = await import('../src/utils/markdown-render');
    const db = getDb();

    console.log('\nRepair: blog posts saved as raw layout JSON');
    console.log(`  target : ${describeTarget()}`);
    console.log(`  mode   : ${apply ? 'APPLY (writes)' : 'DRY RUN (writes nothing)'}`);
    console.log(`  scope  : ${onlyId ? `post ${onlyId}` : onlyOrg ? `organisation ${onlyOrg}` : 'all organisations'}\n`);

    // Same shape test as the code, done in SQL to find candidates, then re-checked in JS.
    const idClause = onlyId ? `AND bp.id = ${onlyId}` : '';
    const orgClause = onlyOrg ? `AND bp.organisation_id = ${onlyOrg}` : '';
    const rows = await db.execute<{ id: number }>(
        `SELECT bp.id FROM blog_posts bp
          WHERE (bp.body_markdown ~ '^\\s*(\`\`\`[a-z]*\\s*)?\\{' OR bp.body_markdown ~ '"kind"\\s*:\\s*"(prose|heading|image)"')
          ${idClause} ${orgClause}
          ORDER BY bp.id`
    );
    if (!rows.length) { console.log('  No posts need repairing.\n'); return; }

    const backup: unknown[] = [];
    let fixed = 0, skipped = 0;
    for (const { id } of rows) {
        const [post] = await db
            .select({
                id: blogPosts.id, title: blogPosts.title, status: blogPosts.status,
                body: blogPosts.bodyMarkdown, payload: blogPosts.publishedPayload,
                metaDescription: blogPosts.metaDescription, destinations: blogPosts.destinations,
                org: organisations.name,
            })
            .from(blogPosts)
            .leftJoin(organisations, eq(organisations.id, blogPosts.organisationId))
            .where(eq(blogPosts.id, Number(id)))
            .limit(1);
        if (!post || !looksLikeLayoutJson(post.body)) continue;

        const result = repairJsonBody(post.body);
        console.log(`— #${post.id}  [${post.status}]  ${post.org ?? '?'} — "${post.title}"`);
        if (!result) {
            console.log('    ✗ could not recover any complete section — left untouched; redraft it in Blog Studio\n');
            skipped++;
            continue;
        }

        const notes = [
            result.salvaged ? 'only its complete sections were kept (the saved JSON was cut off)' : '',
            result.droppedImages ? `${result.droppedImages} picture${result.droppedImages === 1 ? '' : 's'} it asked for were never added — add images in Blog Studio` : '',
            result.unlinkedLinks ? `${result.unlinkedLinks} link${result.unlinkedLinks === 1 ? '' : 's'} kept as text without an address — re-add any real ones` : '',
        ].filter(Boolean);
        const words = result.markdown.split(/\s+/).filter(Boolean).length;
        console.log(`    ✓ ${words} words. Opens: ${JSON.stringify(result.markdown.slice(0, 140))}…`);
        notes.forEach((n) => console.log(`    · ${n}`));

        const dest = (post.destinations as Record<string, unknown> | null) || {};
        // A target records 'published' either as the bare string or as { status: 'published', … }.
        const isOut = (v: unknown) => v === 'published' || (!!v && typeof v === 'object' && (v as { status?: string }).status === 'published');
        const syndicated = Object.entries(dest).filter(([k, v]) => k !== 'widget' && k !== 'selected' && isOut(v)).map(([k]) => k);
        if (syndicated.length) console.log(`    ⚠ already sent to ${syndicated.join(', ')} — those copies are NOT changed by this; fix them there`);

        const metaIsJson = !!post.metaDescription && looksLikeLayoutJson(post.metaDescription);
        let payload = post.payload as Record<string, unknown> | null;
        if (payload && typeof payload === 'object') {
            payload = {
                ...payload,
                html: await renderMarkdown(result.markdown),
                description: (metaIsJson ? '' : post.metaDescription) || await excerpt(result.markdown, 200),
                renderedAt: new Date().toISOString(),
            };
            console.log('    · published snapshot will be rebuilt, so the live page changes too');
        }
        if (metaIsJson) console.log('    · meta description was JSON too — cleared (falls back to the excerpt)');

        if (apply) {
            backup.push({ id: post.id, title: post.title, body_markdown: post.body, published_payload: post.payload, meta_description: post.metaDescription });
            const updated = await db.update(blogPosts)
                .set({
                    bodyMarkdown: result.markdown,
                    ...(payload ? { publishedPayload: payload } : {}),
                    ...(metaIsJson ? { metaDescription: null } : {}),
                    updatedAt: new Date(),
                })
                // Only if nobody has edited it since we read it.
                .where(and(eq(blogPosts.id, post.id), eq(blogPosts.bodyMarkdown, post.body)))
                .returning({ id: blogPosts.id });
            if (updated.length) { console.log('    → repaired\n'); fixed++; }
            else { console.log('    ✗ changed since it was read — left alone\n'); skipped++; }
        } else {
            console.log('');
            fixed++;
        }
    }

    if (apply && backup.length) {
        // `.tmp-*` is git-ignored, so this never gets committed by accident.
        const file = path.resolve(process.cwd(), `.tmp-blog-json-repair-backup-${Date.now()}.json`);
        writeFileSync(file, JSON.stringify(backup, null, 2));
        console.log(`  Originals saved to ${file}`);
    }
    console.log(apply
        ? `  Repaired ${fixed}, left ${skipped}.\n`
        : `  ${fixed} would be repaired, ${skipped} cannot be. Re-run with --apply to write.\n`);
    process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
