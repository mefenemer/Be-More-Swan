// db/seed-connection.ts
// How every seed script resolves which database it is about to write to.
//
// ── The bug this replaces ───────────────────────────────────────────────────────────────────────
// The four seed scripts each opened with:
//
//     const connectionString = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
//
// which reads as a harmless fallback and is not one. In this repo `NETLIFY_DATABASE_URL` is
// STAGING and bare `DATABASE_URL` is PRODUCTION. So the fallback's only effect was: whenever
// `.env` failed to load — a different working directory, a shell without dotenv, a CI job, a
// `cd` into a subfolder — the script silently seeded PROD instead of failing.
//
// That is the worst shape a failure can take. It required nothing to go visibly wrong, it produced
// no error, and `db/seed-catalog.ts` writes integration providers and scenarios with
// `onConflictDoUpdate` — so the quiet outcome was overwriting live production rows nobody asked it
// to touch.
//
// ── What replaces it ────────────────────────────────────────────────────────────────────────────
// 1. NO implicit fallback. One variable, named on purpose. Missing means stop, loudly.
// 2. `--url-var <NAME>` to point somewhere else, matching scripts/db-migrate.mjs and
//    scripts/rescore-lead-prospect-type.ts. Reaching production is now something you TYPE, which
//    is the whole difference between a decision and an accident.
// 3. Every run announces its target host and database first. A seed that overwrites rows should
//    never leave the operator guessing which server it was talking to.
//
// ⚠️ It prints host and database ONLY — never the connection string, which carries the password.
// Credentials have leaked into this project's transcripts before; the habit is to name the host.

/**
 * Resolve the connection string for a seed script.
 *
 * @param scriptName  Used in the error message, so a failure names the thing to re-run.
 * @param argv        Defaults to process.argv. Injectable for tests.
 */
export function resolveSeedConnection(scriptName: string, argv: string[] = process.argv.slice(2)): string {
    const urlVar = readUrlVar(argv);
    const connectionString = process.env[urlVar];

    if (!connectionString) {
        // Named, actionable, and it does NOT suggest another variable to try — suggesting a
        // fallback here is how the original bug would grow back.
        throw new Error(
            `${urlVar} is not set, so ${scriptName} does not know which database to write to.\n`
            + `  • Check .env is loaded from the directory you are running in.\n`
            + `  • To target a different database, pass --url-var <NAME> naming the variable that holds it.\n`
            + '  (There is deliberately no fallback: the previous one silently wrote to production.)',
        );
    }
    return connectionString;
}

/**
 * `--url-var NAME` or `--url-var=NAME`, defaulting to NETLIFY_DATABASE_URL.
 *
 * Both spellings accepted because both already exist in this repo — db-migrate.mjs uses the space
 * form, rescore-lead-prospect-type.ts the equals form — and an operator who has learned one should
 * not be told the other is wrong.
 */
export function readUrlVar(argv: string[]): string {
    const eq = argv.find((a) => a.startsWith('--url-var='));
    if (eq) return eq.slice('--url-var='.length) || 'NETLIFY_DATABASE_URL';
    const i = argv.indexOf('--url-var');
    if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
    return 'NETLIFY_DATABASE_URL';
}

/**
 * Host and database of a connection string, for confirming the target out loud.
 *
 * ⚠️ Never returns the password, the username, or the raw URL. If it cannot be parsed it says so
 * rather than echoing the string back — an unparseable value is exactly the case where echoing it
 * would spill a credential into a terminal or a CI log.
 */
export function describeTarget(connectionString: string, urlVar: string): string {
    try {
        const u = new URL(connectionString);
        return `${u.host}${u.pathname}  [${urlVar}]`;
    } catch {
        return `(unparseable connection string)  [${urlVar}]`;
    }
}

/** Resolve, announce, and hand back the connection string. The one call a seed script makes. */
export function seedConnection(scriptName: string, argv: string[] = process.argv.slice(2)): string {
    const urlVar = readUrlVar(argv);
    const connectionString = resolveSeedConnection(scriptName, argv);
    console.log(`${scriptName} → ${describeTarget(connectionString, urlVar)}`);
    return connectionString;
}
