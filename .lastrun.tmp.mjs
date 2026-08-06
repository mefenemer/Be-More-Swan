import 'dotenv/config';
import postgres from 'postgres';
const sql = postgres(process.env.NETLIFY_DATABASE_URL, { max: 1, onnotice: () => {} });
const c = await sql`SELECT key, value, updated_at FROM platform_config WHERE key = 'strategy_agent.last_run'`;
console.log('last_run:', c.length ? JSON.stringify(c[0].value) : '(no row)', c.length ? `updated_at=${c[0].updated_at?.toISOString?.() ?? c[0].updated_at}` : '');
const p = await sql`SELECT id, organisation_id, ai_assistant_id, source, status, target_field, created_at FROM strategy_proposals ORDER BY id`;
console.log(`strategy_proposals: ${p.length}`);
for (const r of p) console.log(`  ${r.id} org=${r.organisation_id} assistant=${r.ai_assistant_id} source=${r.source} status=${r.status} field=${r.target_field}`);
await sql.end();
