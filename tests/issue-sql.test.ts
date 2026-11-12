// tests/issue-sql.test.ts
// The Fix pipeline runs a fix's SQL unattended on staging (Merge to staging) and prod (Approve for
// production), but ONLY when every statement is additive (owner decision 2026-11-12). Pins: the
// splitter, the additive allowlist, the checks that follow a run, the hash, and which DB is which.
import assert from 'node:assert';
import { splitSqlStatements, classifySql, whyNotAdditive, verificationChecks, sqlHash, pipelineDbUrls, runAdditiveSql } from '../src/utils/issue-sql';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

(async () => {
    await check('splitter respects quotes, dollar quotes and comments', () => {
        const s = splitSqlStatements(`-- a; comment\nINSERT INTO t (a) VALUES ('x;y'); /* b; */ DO $$ BEGIN PERFORM 1; END $$;\nSELECT "a;b" FROM t`);
        assert.deepStrictEqual(s.length, 3);
        assert.match(s[0], /'x;y'/);
        assert.match(s[1], /^DO \$\$ BEGIN PERFORM 1; END \$\$$/);
    });

    await check('additive statements pass', () => {
        for (const st of [
            'BEGIN', 'COMMIT',
            'CREATE TABLE IF NOT EXISTS foo (id serial primary key, name text)',
            'CREATE UNIQUE INDEX IF NOT EXISTS foo_name ON foo (name)',
            'CREATE INDEX CONCURRENTLY IF NOT EXISTS foo_x ON foo (x)',
            'ALTER TABLE blog_posts ADD COLUMN IF NOT EXISTS pillar_id INTEGER REFERENCES content_pillars(id) ON DELETE SET NULL, ADD COLUMN IF NOT EXISTS pillar TEXT',
            "INSERT INTO help_articles (title, body) VALUES ('a', 'b') ON CONFLICT (title) DO NOTHING",
            "COMMENT ON COLUMN foo.name IS 'x'",
        ]) assert.strictEqual(whyNotAdditive(st), null, st);
    });

    await check('anything that changes or removes is refused', () => {
        for (const st of [
            'UPDATE foo SET a = 1', 'DELETE FROM foo', 'DROP TABLE foo', 'TRUNCATE foo',
            'ALTER TABLE foo DROP COLUMN a', 'ALTER TABLE foo ADD COLUMN IF NOT EXISTS a text, DROP COLUMN b',
            'ALTER TABLE foo ALTER COLUMN a TYPE int', 'ALTER TABLE foo ADD COLUMN a text',
            "INSERT INTO help_articles (title) VALUES ('a') ON CONFLICT (title) DO UPDATE SET body = 'x'",
            'DO $$ BEGIN END $$', 'CREATE TABLE foo (id int)', 'GRANT ALL ON foo TO bar',
            'CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql',
        ]) assert.ok(whyNotAdditive(st), st);
    });

    await check('classifySql: none / additive / manual', () => {
        assert.strictEqual(classifySql('').safety, 'none');
        assert.strictEqual(classifySql('  -- only a comment\n').safety, 'none');
        assert.strictEqual(classifySql('BEGIN; ALTER TABLE t ADD COLUMN IF NOT EXISTS a text; COMMIT;').safety, 'additive');
        const m = classifySql('ALTER TABLE t ADD COLUMN IF NOT EXISTS a text; UPDATE t SET a = 1;');
        assert.strictEqual(m.safety, 'manual');
        assert.strictEqual(m.refused.length, 1);
    });

    await check('verification checks: tables, indexes and every added column', () => {
        const c = verificationChecks(splitSqlStatements('CREATE TABLE IF NOT EXISTS public.x (id int); CREATE INDEX IF NOT EXISTS x_i ON x (id); ALTER TABLE x ADD COLUMN IF NOT EXISTS a text, ADD COLUMN IF NOT EXISTS "b" int;'));
        assert.deepStrictEqual(c.map((x) => x.label), ['table public.x', 'index x_i', 'column x.a', 'column x.b']);
    });

    await check('hash ignores whitespace, not content', () => {
        assert.strictEqual(sqlHash('ALTER  TABLE t\nADD COLUMN IF NOT EXISTS a text;'), sqlHash('ALTER TABLE t ADD COLUMN IF NOT EXISTS a text;'));
        assert.notStrictEqual(sqlHash('a'), sqlHash('b'));
    });

    await check('which DB is which: prod site needs STAGING_DATABASE_URL; never falls back to DATABASE_URL', () => {
        assert.deepStrictEqual(pipelineDbUrls({ NETLIFY_DATABASE_URL: 'own', STAGING_DATABASE_URL: 'stg' }), { staging: 'stg', production: 'own', onProdSite: true });
        assert.deepStrictEqual(pipelineDbUrls({ NETLIFY_DATABASE_URL: 'own' }), { staging: 'own', production: undefined, onProdSite: false });
        assert.strictEqual(pipelineDbUrls({ DATABASE_URL: 'prod-from-dotenv' }).staging, undefined);
    });

    await check('runAdditiveSql refuses manual SQL and names the DB, without connecting', async () => {
        let connected = false;
        const connect = (() => { connected = true; throw new Error('should not connect'); }) as any;
        const r = await runAdditiveSql('postgres://x', 'DELETE FROM foo', 'production', { connect });
        assert.strictEqual(r.ok, false);
        assert.match(r.outcome, /Not run on production/);
        assert.strictEqual(connected, false);
        const none = await runAdditiveSql(undefined, '', 'staging', { connect });
        assert.strictEqual(none.ok, true);
        const nourl = await runAdditiveSql(undefined, 'ALTER TABLE t ADD COLUMN IF NOT EXISTS a text', 'staging', { connect });
        assert.match(nourl.outcome, /STAGING_DATABASE_URL/);
    });

    await check('runAdditiveSql runs, then checks, and reports what is still missing', async () => {
        const ran: string[] = [];
        const fake: any = () => ({
            unsafe: (q: string, params?: string[]) => {
                ran.push(q);
                const p: any = Promise.resolve(params ? [{ ok: params[1] !== 'b' }] : []);
                p.simple = () => Promise.resolve([]);
                return p;
            },
            end: () => Promise.resolve(),
        });
        const r = await runAdditiveSql('postgres://x', 'ALTER TABLE t ADD COLUMN IF NOT EXISTS a text, ADD COLUMN IF NOT EXISTS b text;', 'staging', { connect: fake });
        assert.strictEqual(r.ok, false);
        assert.match(r.outcome, /still missing: column t\.b/);
        assert.ok(ran.some((q) => /information_schema/.test(q)));
    });

    console.log(`\nissue-sql: ${passed} passed`);
})();
