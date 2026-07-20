// Read-only prod schema introspection. Pulls the connection string from the Netlify CLI at
// runtime so no credential is ever written into a shell command or this file.
import { execSync } from 'node:child_process';
import postgres from 'postgres';

const url = execSync('netlify env:get NETLIFY_DATABASE_URL --context production').toString().trim();
const sql = postgres(url, { ssl: 'require' });

const cols = [
  ['content_generation_jobs', 'content_type', 'blog-autopilot.sql'],
  ['content_generation_jobs', 'result_blog_post_id', 'blog-autopilot.sql'],
  ['scheduled_posts', 'youtube_upload_state', 'youtube-upload-resume.sql'],
  ['blog_posts', 'slug', 'blog-seo-metadata.sql'],
  ['blog_posts', 'meta_description', 'blog-seo-metadata.sql'],
];

console.log('=== COLUMNS ===');
for (const [t, c, src] of cols) {
  const r = await sql`SELECT data_type FROM information_schema.columns WHERE table_name=${t} AND column_name=${c}`;
  console.log(`${r.length ? 'PRESENT' : 'MISSING'}  ${t}.${c}  (${src})`);
}

console.log('\n=== CHECK CONSTRAINTS on assistant_records ===');
const ck = await sql`SELECT con.conname, pg_get_constraintdef(con.oid) def
  FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
  WHERE c.relname = 'assistant_records' AND con.contype = 'c'`;
for (const r of ck) console.log(`${r.conname}: ${r.def}`);

console.log('\n=== TABLES for memory-flagged pending DDL ===');
for (const t of ['plan_features', 'plan_prices', 'plan_card_fields', 'master_assistants', 'schema_migrations', 'action_items', 'inspo_items', 'integration_scenarios']) {
  const r = await sql`SELECT 1 FROM information_schema.tables WHERE table_name=${t}`;
  console.log(`${r.length ? 'PRESENT' : 'MISSING'}  ${t}`);
}

console.log('\n=== schema_migrations ledger ===');
try {
  const n = await sql`SELECT count(*)::int n FROM schema_migrations`;
  console.log('rows:', n[0].n);
  const l = await sql`SELECT filename, applied_at, baselined FROM schema_migrations ORDER BY applied_at DESC LIMIT 12`;
  for (const r of l) console.log(` ${r.applied_at.toISOString().slice(0, 10)}  ${r.baselined ? '[baselined]' : '[executed] '}  ${r.filename}`);
} catch (e) {
  console.log('no ledger:', e.message);
}
