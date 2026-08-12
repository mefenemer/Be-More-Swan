import postgres from 'postgres';
async function main() {
    const sql = postgres(process.env.PROD_DATABASE_URL!, { ssl: 'require', max: 1 });
    const [j] = await sql`SELECT status, stage, attempt, leads_found, search_calls_made,
        cost_gbp, error_message, (cursor->>'queryIndex')::int AS q_index,
        jsonb_array_length(cursor->'flat') AS q_total, updated_at
        FROM discovery_jobs WHERE job_id = '3d5fa32e-839f-4121-bb75-ae7c9065df9e'`;
    console.log(`  status=${j.status} stage=${j.stage} attempt=${j.attempt} query ${j.q_index}/${j.q_total} leads=${j.leads_found} searches=${j.search_calls_made} cost=£${j.cost_gbp}`);
    if (j.error_message) console.log(`  ⚠️ error: ${j.error_message}`);
    const leads = await sql`SELECT domain, rating, score FROM discovered_leads
        WHERE campaign_id = 2 AND job_id = (SELECT id FROM discovery_jobs WHERE job_id = '3d5fa32e-839f-4121-bb75-ae7c9065df9e')
        ORDER BY id`;
    if (leads.length) { console.log(`  ${leads.length} leads so far:`); for (const l of leads) console.log(`     ${String(l.rating ?? '—').padEnd(5)} ${String(l.score ?? '').padStart(3)}  ${l.domain}`); }
    await sql.end();
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
