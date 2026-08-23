import 'dotenv/config';
const { sql } = await import('drizzle-orm');
const { getDb } = await import('../../db/client');
const db = getDb();
console.log('── all jobs on campaign 9 ──');
console.log(await db.execute(sql`
  SELECT id, status, stage, trigger_type, created_at::timestamp(0) AS created,
         jsonb_array_length(coalesce(cursor->'flat','[]'::jsonb)) AS planned,
         jsonb_array_length(coalesce(cursor->'territorySlice','[]'::jsonb)) AS slice
  FROM discovery_jobs WHERE campaign_id = 9 ORDER BY id`));
console.log('\n── job 14: first 8 planned queries ──');
console.log((await db.execute(sql`
  SELECT e->>'query' AS q FROM discovery_jobs j, jsonb_array_elements(j.cursor->'flat') e
  WHERE j.id = 14 LIMIT 8`) as any).map((r: any) => '  ' + r.q).join('\n'));
console.log('\n── the stored territoryPlan ──');
console.log((await db.execute(sql`
  SELECT jsonb_array_length(approved_brief #> '{territoryPlan,territories}') AS territories,
         jsonb_array_length(coalesce(approved_brief #> '{territoryPlan,parents}','[]'::jsonb)) AS parents,
         approved_brief #> '{territoryPlan,granularity}' AS granularity,
         approved_brief #> '{territoryPlan,templates}' AS templates,
         jsonb_array_length(approved_brief #> '{queries,niche_scrape}') AS niche_q
  FROM discovery_campaigns WHERE id = 9`) as any)[0]);
process.exit(0);
