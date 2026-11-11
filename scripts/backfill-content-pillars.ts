// scripts/backfill-content-pillars.ts
// Turns every Social Media assistant's pillar text (onboarding_context.content_pillars), and every Blog
// or Email assistant's topics (blogTopics / newsletterTopics, src/utils/pillar-profiles.ts), into
// content_pillars rows, then links scheduled_posts.pillar_id (Social only) where the post's pillar name matches
// exactly (case-insensitive). docs/pillar-records-plan.md, phase 1 step 2. Run AFTER
// db/z-content-pillars.sql.
//
// It reuses ensurePillarRecords (the same splitter and the same "only when it has never had rows"
// rule as the profile's first load), so a backfilled assistant and one first opened later end up alike.
// Posts tagged before 2026-10-06 carry the whole pillar string and stay unlinked. That is expected.
//
// Safe to run twice: an assistant with rows is left alone, and only posts with no pillar_id are linked.
// DRY RUN by default. Nothing is written without --apply.
//
//   npx tsx scripts/backfill-content-pillars.ts
//   npx tsx scripts/backfill-content-pillars.ts --apply
//   npx tsx scripts/backfill-content-pillars.ts --apply --url-var=DATABASE_URL_PROD
//   npx tsx scripts/backfill-content-pillars.ts --assistant=123        (one assistant, read-only unless --apply)
//
// ⚠️ --url-var takes the NAME of an environment variable, never a connection string.
// ⚠️ DATABASE_URL in .env is PROD. Staging is the default (NETLIFY_DATABASE_URL).

import { config } from 'dotenv';
import path from 'path';

config({ path: path.resolve(process.cwd(), '.env') });

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const urlVar = flag('url-var') ?? 'NETLIFY_DATABASE_URL';
const onlyAssistant = Number(flag('assistant')) || null;

function describeTarget(): string {
    const raw = process.env[urlVar];
    if (!raw) return `${urlVar} is not set`;
    try { const u = new URL(raw); return `${u.host}${u.pathname}  [${urlVar}]`; } catch { return `unparseable ${urlVar}`; }
}

async function main() {
    if (urlVar !== 'NETLIFY_DATABASE_URL') {
        const override = process.env[urlVar];
        if (!override) { console.error(`\n${urlVar} is not set.\n`); process.exit(1); }
        process.env.NETLIFY_DATABASE_URL = override;
    }
    const { getDb } = await import('../db/client');
    const { aiAssistants, masterAssistants } = await import('../db/schema');
    const { and, eq, inArray, sql } = await import('drizzle-orm');
    const { PILLAR_PROFILES, pillarProfileFor } = await import('../src/utils/pillar-profiles');
    const store = await import('../src/utils/content-pillars-store');
    // UMD module: a dynamic import puts its exports under `default`.
    type Split = (raw: unknown, max: number) => string[];
    const splitter = await import('../src/public/content-pillars.js') as unknown as { parsePillarsUpTo?: Split; default?: { parsePillarsUpTo: Split } };
    const parsePillarsUpTo = splitter.parsePillarsUpTo ?? splitter.default!.parsePillarsUpTo;

    console.log(`\nTarget: ${describeTarget()}`);
    console.log(apply ? 'Mode: APPLY (writes)\n' : 'Mode: DRY RUN (no writes, pass --apply)\n');

    const db = getDb();
    if (!(await store.pillarsTableExists(db))) {
        console.error('content_pillars does not exist here. Apply db/z-content-pillars.sql first.');
        process.exit(1);
    }

    const assistants = await db.select({
        id: aiAssistants.id, orgId: aiAssistants.organisationId, name: aiAssistants.name, ctx: aiAssistants.onboardingContext,
        roleKey: masterAssistants.roleKey,
    }).from(aiAssistants)
        .innerJoin(masterAssistants, eq(masterAssistants.id, aiAssistants.masterAssistantId))
        .where(and(
            inArray(masterAssistants.roleKey, Object.keys(PILLAR_PROFILES)),
            onlyAssistant ? eq(aiAssistants.id, onlyAssistant) : sql`true`,
        ));

    let seeded = 0, skipped = 0, empty = 0, linkedTotal = 0;
    for (const a of assistants) {
        const existing = await store.listPillars(db, a.orgId, a.id);
        const prof = pillarProfileFor(a.roleKey)!;
        const names = parsePillarsUpTo((a.ctx as Record<string, unknown> | null)?.[prof.contextKey], prof.maxActive);
        if (existing && existing.length) {
            skipped++;
        } else if (!names.length) {
            empty++;
            continue;
        } else if (apply) {
            await store.ensurePillarRecords(db, a.orgId, a.id, a.ctx);
            seeded++;
        } else {
            seeded++;
        }

        // Posts that match a pillar name exactly and have no link yet. Blog posts and emails never
        // recorded a topic before db/z-content-topics.sql, so there is nothing of theirs to link.
        if (prof.contextKey !== 'content_pillars') {
            console.log(`#${a.id} ${a.name} (${prof.roleKey}, org ${a.orgId}): ${existing?.length ? `${existing.length} rows already` : `${names.length} ${prof.nounPlural} ${apply ? 'created' : 'to create'}`}  [${names.join(' | ')}]`);
            continue;
        }
        const rows = apply ? ((await store.listPillars(db, a.orgId, a.id)) ?? []) : (existing?.length ? existing : names.map((n, i) => ({ id: -1 - i, name: n })));
        let linked = 0;
        for (const p of rows) {
            if (apply && p.id > 0) {
                const res = await db.execute(sql`
                    UPDATE scheduled_posts SET pillar_id = ${p.id}
                     WHERE assistant_id = ${a.id} AND pillar_id IS NULL AND lower(pillar) = lower(${p.name})`);
                linked += Number((res as { count?: number }).count ?? 0);
            } else {
                const res = await db.execute(sql`
                    SELECT count(*)::int AS n FROM scheduled_posts
                     WHERE assistant_id = ${a.id} AND pillar_id IS NULL AND lower(pillar) = lower(${p.name})`);
                const first = (Array.isArray(res) ? res[0] : (res as { rows?: unknown[] }).rows?.[0]) as { n?: number } | undefined;
                linked += first?.n ?? 0;
            }
        }
        linkedTotal += linked;
        console.log(`#${a.id} ${a.name} (org ${a.orgId}): ${existing?.length ? `${existing.length} rows already` : `${names.length} pillars ${apply ? 'created' : 'to create'}`} · ${linked} posts ${apply ? 'linked' : 'to link'}  [${names.join(' | ')}]`);
    }
    console.log(`\n${assistants.length} Social, Blog and Email assistants: ${seeded} ${apply ? 'seeded' : 'to seed'}, ${skipped} already had rows, ${empty} with no pillars. ${linkedTotal} posts ${apply ? 'linked' : 'to link'}.`);
    process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
