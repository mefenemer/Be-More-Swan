import 'dotenv/config';
const { sql } = await import('drizzle-orm');
const { getDb } = await import('../../db/client');
const db = getDb();
const j = (await db.execute(sql`
  SELECT id, status, stage, leads_found, search_calls_made, tokens_used, cost_gbp,
         jsonb_array_length(coalesce(cursor->'flat','[]'::jsonb)) AS planned,
         coalesce((cursor->>'queryIndex')::int,0) AS done,
         cursor->'coverage' AS coverage, cursor->>'stopReason' AS stop,
         jsonb_array_length(coalesce(cursor->'territorySlice','[]'::jsonb)) AS slice
  FROM discovery_jobs WHERE campaign_id = 9 ORDER BY id DESC LIMIT 1`) as any)[0];
console.log(`job ${j.id}  ${j.status}/${j.stage ?? '—'}  ${j.done} of ${j.planned} queries  ${j.search_calls_made} searches  £${j.cost_gbp}  ${j.leads_found} leads`);
console.log(`  coverage ${j.coverage ? JSON.stringify(j.coverage) : '(pending)'}  stop=${j.stop ?? '(running)'}  slice=${j.slice}`);
const p = (await db.execute(sql`
  SELECT jsonb_array_length(approved_brief #> '{territoryPlan,territories}') AS total,
         jsonb_array_length(approved_brief #> '{territoryPlan,covered}') AS covered,
         approved_brief #> '{territoryPlan,covered}' AS list
  FROM discovery_campaigns WHERE id = 9`) as any)[0];
console.log(`  territories covered: ${p.covered} of ${p.total}`);
if (p.list && (p.list as string[]).length) console.log(`    ${(p.list as string[]).join(', ')}`);
process.exit(0);
