// src/utils/issue-sql.ts — SQL that an AI fix proposes: is it safe to run unattended, and run it.
//
// Owner decision 2026-11-12 (docs/fix-pipeline-proof-plan.md): a fix's SQL runs on the STAGING DB
// automatically at "Merge to staging", and on the PROD DB when the owner clicks "Approve for
// production" — but only when every statement is ADDITIVE:
//   CREATE TABLE … IF NOT EXISTS, CREATE [UNIQUE] INDEX [CONCURRENTLY] … IF NOT EXISTS,
//   ALTER TABLE … ADD COLUMN IF NOT EXISTS (every clause), INSERT (never ON CONFLICT DO UPDATE),
//   COMMENT ON, and BEGIN/COMMIT around them.
// Anything else (UPDATE, DELETE, DROP, TRUNCATE, ALTER … other clauses, DO $$ blocks, functions,
// triggers, policies, grants, SET …) is 'manual': the pipeline refuses it and the owner runs it.
//
// Which DB is which: the Fix pipeline lives on the prod site. There, STAGING_DATABASE_URL (Netlify,
// production context only) is the staging DB and the site's own DB is prod. On the staging site (no
// STAGING_DATABASE_URL) its own DB is staging and there is no prod DB to reach.

import { createHash } from 'node:crypto';
import postgres from 'postgres';

export type SqlSafety = 'none' | 'additive' | 'manual';

/** Split SQL into statements on top-level semicolons (quotes, dollar quotes and comments respected). */
export function splitSqlStatements(text: string): string[] {
    const out: string[] = [];
    let cur = '';
    let i = 0;
    const s = String(text || '');
    while (i < s.length) {
        const c = s[i];
        const next = s[i + 1];
        if (c === '-' && next === '-') {                       // line comment
            const end = s.indexOf('\n', i);
            i = end === -1 ? s.length : end + 1;
            cur += ' ';
            continue;
        }
        if (c === '/' && next === '*') {                       // block comment
            const end = s.indexOf('*/', i + 2);
            i = end === -1 ? s.length : end + 2;
            cur += ' ';
            continue;
        }
        if (c === "'" || c === '"') {                          // quoted string / identifier
            let j = i + 1;
            while (j < s.length) {
                if (s[j] === c && s[j + 1] === c) { j += 2; continue; }
                if (s[j] === c) break;
                j++;
            }
            cur += s.slice(i, j + 1);
            i = j + 1;
            continue;
        }
        if (c === '$') {                                       // dollar quote: $$ or $tag$
            const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i));
            if (m) {
                const tag = m[0];
                const end = s.indexOf(tag, i + tag.length);
                const stop = end === -1 ? s.length : end + tag.length;
                cur += s.slice(i, stop);
                i = stop;
                continue;
            }
        }
        if (c === ';') {
            if (cur.trim()) out.push(cur.trim());
            cur = '';
            i++;
            continue;
        }
        cur += c;
        i++;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

/** Split on top-level commas (outside parentheses and quotes). */
function splitTopLevelCommas(s: string): string[] {
    const parts: string[] = [];
    let depth = 0, cur = '', q: string | null = null;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (q) { cur += c; if (c === q) q = null; continue; }
        if (c === "'" || c === '"') { q = c; cur += c; continue; }
        if (c === '(') depth++;
        if (c === ')') depth--;
        if (c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
        cur += c;
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts;
}

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\.(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*))?`;

/** Why one statement is not additive, or null when it is. */
export function whyNotAdditive(stmt: string): string | null {
    const st = stmt.replace(/\s+/g, ' ').trim();
    const u = st.toUpperCase();
    if (/^(BEGIN|COMMIT|START TRANSACTION)( (WORK|TRANSACTION))?$/.test(u)) return null;
    if (/^COMMENT ON /.test(u)) return null;
    if (new RegExp(`^CREATE TABLE IF NOT EXISTS ${IDENT}`, 'i').test(st)) return null;
    if (new RegExp(`^CREATE (UNIQUE )?INDEX (CONCURRENTLY )?IF NOT EXISTS `, 'i').test(st)) return null;
    const alter = new RegExp(`^ALTER TABLE (IF EXISTS )?(ONLY )?${IDENT} (.+)$`, 'i').exec(st);
    if (alter) {
        const clauses = splitTopLevelCommas(alter[3]);
        const bad = clauses.find((c) => !/^ADD COLUMN IF NOT EXISTS /i.test(c));
        return bad ? `ALTER TABLE may only ADD COLUMN IF NOT EXISTS (found "${bad.slice(0, 60)}")` : null;
    }
    if (/^INSERT INTO /.test(u)) {
        if (/\bON CONFLICT\b[\s\S]*\bDO UPDATE\b/.test(u)) return 'INSERT … ON CONFLICT DO UPDATE changes existing rows';
        return null;
    }
    const verb = u.split(' ').slice(0, 2).join(' ');
    return `${verb} is not additive`;
}

export function classifySql(text: string | null | undefined): { safety: SqlSafety; statements: string[]; refused: string[] } {
    const statements = splitSqlStatements(text || '');
    if (!statements.length) return { safety: 'none', statements, refused: [] };
    const refused = statements.map(whyNotAdditive).filter((r): r is string => !!r);
    return { safety: refused.length ? 'manual' : 'additive', statements, refused };
}

/** The same SQL text must run on prod as passed on staging. Whitespace-insensitive. */
export function sqlHash(text: string | null | undefined): string {
    return createHash('sha256').update(String(text || '').replace(/\s+/g, ' ').trim()).digest('hex');
}

/** One check per statement that creates something: does it exist now? */
export function verificationChecks(statements: string[]): Array<{ label: string; query: string; params: string[] }> {
    const checks: Array<{ label: string; query: string; params: string[] }> = [];
    const unq = (s: string) => s.replace(/"/g, '');
    for (const raw of statements) {
        const st = raw.replace(/\s+/g, ' ').trim();
        const table = new RegExp(`^CREATE TABLE IF NOT EXISTS (${IDENT})`, 'i').exec(st);
        if (table) { checks.push({ label: `table ${unq(table[1])}`, query: 'SELECT to_regclass($1) IS NOT NULL AS ok', params: [unq(table[1])] }); continue; }
        const index = new RegExp(`^CREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?IF NOT EXISTS (${IDENT})`, 'i').exec(st);
        if (index) { checks.push({ label: `index ${unq(index[1])}`, query: 'SELECT to_regclass($1) IS NOT NULL AS ok', params: [unq(index[1])] }); continue; }
        const alter = new RegExp(`^ALTER TABLE (?:IF EXISTS )?(?:ONLY )?(${IDENT}) (.+)$`, 'i').exec(st);
        if (alter) {
            const tbl = unq(alter[1]).split('.').pop()!;
            for (const c of splitTopLevelCommas(alter[2])) {
                const col = /^ADD COLUMN IF NOT EXISTS ("[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)/i.exec(c);
                if (col) checks.push({
                    label: `column ${tbl}.${unq(col[1])}`,
                    query: 'SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2) AS ok',
                    params: [tbl, unq(col[1])],
                });
            }
        }
    }
    return checks;
}

export interface SqlRunResult { ok: boolean; outcome: string }

/**
 * Run additive SQL on one DB, then check that what it creates exists. Refuses anything not additive.
 * `where` names the DB in every message ("staging" / "production"), so nothing claims the wrong one.
 */
export async function runAdditiveSql(url: string | undefined, sqlText: string, where: 'staging' | 'production', opts: { connect?: typeof postgres } = {}): Promise<SqlRunResult> {
    const { safety, statements, refused } = classifySql(sqlText);
    if (safety === 'none') return { ok: true, outcome: 'No SQL to run.' };
    if (safety === 'manual') return { ok: false, outcome: `✗ Not run on ${where}: this SQL is not additive, so the pipeline won't run it unattended.\n${refused.map((r) => `• ${r}`).join('\n')}\nRun it by hand if it is right.` };
    if (!url) return { ok: false, outcome: `✗ Not run: no ${where} database is configured here (${where === 'staging' ? 'STAGING_DATABASE_URL' : 'the site database'}).` };

    const notices: string[] = [];
    const client = (opts.connect || postgres)(url, {
        max: 1, connect_timeout: 8, idle_timeout: 5,
        onnotice: (n: any) => { if (n?.message) notices.push(String(n.message)); },
    });
    try {
        await client.unsafe("SET statement_timeout = '60s'").simple();
        await client.unsafe(sqlText).simple();
        const failed: string[] = [];
        const checks = verificationChecks(statements);
        for (const c of checks) {
            const rows = await client.unsafe(c.query, c.params) as Array<{ ok: boolean }>;
            if (!rows[0]?.ok) failed.push(c.label);
        }
        if (failed.length) {
            return { ok: false, outcome: `✗ The SQL ran on ${where}, but these are still missing: ${failed.join(', ')}.` };
        }
        return {
            ok: true,
            outcome: [
                `✓ Applied on ${where}. ${statements.length} statement(s).`,
                checks.length ? `Checked: ${checks.map((c) => c.label).join(', ')}.` : '',
                notices.length ? `Notices:\n${notices.join('\n')}` : '',
            ].filter(Boolean).join('\n'),
        };
    } catch (e: any) {
        return {
            ok: false,
            outcome: [
                `✗ Failed on ${where}: ${e?.message || 'SQL execution failed.'}`,
                e?.code ? `Code: ${e.code}` : '',
                e?.detail ? `Detail: ${e.detail}` : '',
                e?.hint ? `Hint: ${e.hint}` : '',
            ].filter(Boolean).join('\n'),
        };
    } finally {
        await client.end({ timeout: 2 }).catch(() => {});
    }
}

/** The staging and prod DB URLs as seen from this site (see the header). */
export function pipelineDbUrls(env: Record<string, string | undefined> = process.env): { staging?: string; production?: string; onProdSite: boolean } {
    // NETLIFY_DATABASE_URL only: locally .env DATABASE_URL is PROD, so it must never be a fallback.
    const own = env.NETLIFY_DATABASE_URL;
    if (env.STAGING_DATABASE_URL) return { staging: env.STAGING_DATABASE_URL, production: own, onProdSite: true };
    return { staging: own, production: undefined, onProdSite: false };
}
