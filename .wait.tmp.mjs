import 'dotenv/config';
import postgres from 'postgres';
const sql = postgres(process.env.NETLIFY_DATABASE_URL, { max: 1, onnotice: () => {} });
const c = await sql`SELECT value FROM platform_config WHERE key = 'strategy_agent.last_run'`;
const at = c.length ? c[0].value?.at : null;
await sql.end();
// exit 0 once the run timestamp has moved past the known-old 2026-08-04 record
process.exit(at && at > '2026-08-05' ? 0 : 1);
