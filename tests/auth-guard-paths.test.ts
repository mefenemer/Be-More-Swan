// tests/auth-guard-paths.test.ts
//
// Run:  npx tsx tests/auth-guard-paths.test.ts
//
// Guards the invariant that an auth-guard bypass depends on:
//
//   an edge function can only protect a path it is actually invoked on.
//
// Netlify serves every page at BOTH /foo.html and /foo. auth-guard was bound to "/*.html" and
// "/" only, so /admin — the extensionless spelling — never reached it and returned the full
// admin page unauthenticated. admin.html carries no client-side auth-check.js, so nothing else
// was watching. The repair binds each protected page's extensionless spelling explicitly rather
// than switching to a "/*" catch-all, which would put the edge function in front of every static
// asset on the site.
//
// That choice trades drift-proofing for blast radius, and THIS FILE is the other half of the
// trade: a page added to PROTECTED_PATHS without its netlify.toml bindings fails here instead of
// shipping silently unprotected.
//
// Pure text analysis — no DB, no network. auth-guard.ts cannot be imported under tsx (it pulls
// jose from deno.land and @netlify/edge-functions), so the source is parsed instead. Every parse
// step below asserts it actually matched: a regex that quietly stops matching would turn this
// file into a test that passes by examining nothing, which is worse than having no test at all.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUARD_SRC = readFileSync(join(ROOT, 'netlify/edge-functions/auth-guard.ts'), 'utf8');
const TOML_SRC = readFileSync(join(ROOT, 'netlify.toml'), 'utf8');

let passed = 0;
function check(name: string, fn: () => void): void {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`);
        process.exitCode = 1;
    }
}

// ── Parse PROTECTED_PATHS out of auth-guard.ts ─────────────────────────────────
function parseProtectedPaths(): string[] {
    const m = GUARD_SRC.match(/export const PROTECTED_PATHS\s*=\s*\[([^\]]*)\]/);
    assert.ok(
        m,
        'Could not find `export const PROTECTED_PATHS = [...]` in auth-guard.ts. If it was ' +
        'renamed or reshaped, update this parser — do not delete the test.',
    );
    const paths = [...m![1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
    assert.ok(paths.length > 0, 'PROTECTED_PATHS parsed as empty — the parser is broken.');
    return paths;
}

// ── Parse the auth-guard edge-function bindings out of netlify.toml ────────────
function parseAuthGuardBindings(): string[] {
    // Blocks look like:
    //   [[edge_functions]]
    //     function = "auth-guard"
    //     path = "/workspace"
    const blocks = TOML_SRC.split(/\[\[edge_functions\]\]/).slice(1);
    assert.ok(blocks.length > 0, 'No [[edge_functions]] blocks found in netlify.toml.');

    const bound: string[] = [];
    for (const block of blocks) {
        // Stop at the next top-level table so a block cannot swallow unrelated config.
        const body = block.split(/\n\[/)[0];
        const fn = body.match(/function\s*=\s*["']([^"']+)["']/)?.[1];
        const path = body.match(/path\s*=\s*["']([^"']+)["']/)?.[1];
        if (fn === 'auth-guard' && path) bound.push(path);
    }
    assert.ok(bound.length > 0, 'No auth-guard bindings found in netlify.toml — parser broken.');
    return bound;
}

const PROTECTED = parseProtectedPaths();
const BOUND = parseAuthGuardBindings();

console.log(`auth-guard path bindings`);
console.log(`  PROTECTED_PATHS: ${PROTECTED.join(', ')}`);
console.log(`  netlify.toml   : ${BOUND.join(', ')}\n`);

check('PROTECTED_PATHS are all normalised (no .html spellings)', () => {
    for (const p of PROTECTED) {
        assert.ok(
            !p.endsWith('.html'),
            `PROTECTED_PATHS contains "${p}". Entries are compared against the NORMALISED path ` +
            `(auth-guard.ts strips a trailing .html), so an .html entry can never match and the ` +
            `page would be unprotected in both spellings.`,
        );
        assert.ok(p.startsWith('/'), `PROTECTED_PATHS entry "${p}" must start with "/".`);
    }
});

check('every protected page has its extensionless spelling bound in netlify.toml', () => {
    for (const p of PROTECTED) {
        assert.ok(
            BOUND.includes(p),
            `"${p}" is in PROTECTED_PATHS but netlify.toml has no auth-guard binding for it.\n` +
            `    Netlify serves this page at "${p}" as well as "${p}.html". Without this binding ` +
            `the edge function is never invoked on "${p}" and the page is served unauthenticated ` +
            `— the exact bypass this test exists to prevent.\n` +
            `    Add to netlify.toml:\n\n` +
            `    [[edge_functions]]\n      function = "auth-guard"\n      path = "${p}"\n`,
        );
    }
});

check('the .html spelling stays covered by the /*.html binding', () => {
    assert.ok(
        BOUND.includes('/*.html'),
        'netlify.toml no longer binds auth-guard to "/*.html". That rule is what covers the ' +
        '.html spelling of every protected page AND carries maintenance mode across the whole ' +
        'site. If it was replaced by a catch-all, update this assertion deliberately.',
    );
});

check('the homepage stays bound (maintenance mode covers "/")', () => {
    assert.ok(BOUND.includes('/'), 'netlify.toml no longer binds auth-guard to "/".');
});

check('the .html-only early return that caused the bypass has not come back', () => {
    // The original guard opened with:
    //     if (!url.pathname.endsWith('.html') && url.pathname !== '/') return context.next();
    // which discarded every extensionless request before any protection ran. Anything shaped
    // like that reintroduces the vulnerability wholesale.
    const reintroduced = /!\s*url\.pathname\.endsWith\(\s*['"]\.html['"]\s*\)\s*&&/.test(GUARD_SRC);
    assert.ok(
        !reintroduced,
        'auth-guard.ts early-returns on any path not ending in .html again. That is the original ' +
        'bypass: /admin and /workspace skip the guard entirely.',
    );
});

check('auth-guard normalises before comparing, and compares the normalised value', () => {
    assert.ok(
        /normalisePath/.test(GUARD_SRC),
        'auth-guard.ts no longer defines/uses normalisePath — both URL spellings must collapse ' +
        'to one key before any allow/deny list is consulted.',
    );
    assert.ok(
        !/protectedPaths\.includes\(\s*url\.pathname\s*\)/.test(GUARD_SRC),
        'auth-guard.ts compares protectedPaths against the RAW url.pathname somewhere. It must ' +
        'compare the normalised path, or the extensionless spelling slips through.',
    );
    assert.ok(
        !/ALWAYS_ALLOWED\.includes\(\s*url\.pathname\s*\)/.test(GUARD_SRC),
        'auth-guard.ts compares ALWAYS_ALLOWED against the RAW url.pathname. It must compare the ' +
        'normalised path, or /login (extensionless) is not recognised as a public page.',
    );
});

check('admin is protected — it has no client-side fallback', () => {
    // Stated explicitly because admin.html is the one standalone app page with no auth-check.js:
    // the edge function is its ONLY guard, so losing this entry has no second line of defence.
    assert.ok(
        PROTECTED.includes('/admin'),
        '"/admin" is missing from PROTECTED_PATHS. admin.html loads no auth-check.js, so the ' +
        'edge function is the only thing standing in front of it.',
    );
    const adminHtml = readFileSync(join(ROOT, 'admin.html'), 'utf8');
    if (adminHtml.includes('auth-check.js')) {
        console.log(
            '    note: admin.html now loads auth-check.js — it has a client-side guard as well. ' +
            'That is an improvement; this assertion still stands.',
        );
    }
});

// ── The registration lock ──────────────────────────────────────────────────────
// This switch was dead code from the day it was written: '/register' sat in ALWAYS_ALLOWED and
// returned early, so the check it drives was never reached and the admin control blocked nothing.
// The repair is a one-line exception, and a future tidy-up that "simplifies" the short-circuit
// back to a plain `ALWAYS_ALLOWED.includes(path)` silently kills the switch again — with no test
// failure and no symptom, because a lock that never engages looks exactly like one nobody used.

check('the ALWAYS_ALLOWED short-circuit still excludes /register', () => {
    assert.ok(
        /isAlwaysAllowed\s*&&\s*path\s*!==\s*['"]\/register['"]/.test(GUARD_SRC),
        "auth-guard.ts short-circuits every ALWAYS_ALLOWED path again. /register must fall " +
        "through to the platform-config fetch, or new_registration_lock goes back to being dead " +
        "code — the admin 'lock registrations' control silently stops blocking signups.",
    );
});

check('/register is still publicly reachable (it is in ALWAYS_ALLOWED)', () => {
    // The fix must not accidentally turn the signup page into a protected route.
    assert.ok(
        /ALWAYS_ALLOWED\s*=\s*\[[^\]]*['"]\/register['"]/.test(GUARD_SRC),
        '/register was removed from ALWAYS_ALLOWED. It requires no session — the registration ' +
        'LOCK is a config switch, not an auth requirement.',
    );
    assert.ok(
        !PROTECTED.includes('/register'),
        '/register is in PROTECTED_PATHS. Signup would demand a session, which nobody signing ' +
        'up can have.',
    );
});

check('maintenance mode still exempts the ALWAYS_ALLOWED pages', () => {
    // /register only reaches the maintenance check because of the fix above. Without this guard
    // it would start redirecting to /maintenance.html — a behaviour change riding in unannounced
    // on the registration-lock repair. /login and /logout must stay reachable too, or an admin
    // cannot sign in to lift maintenance.
    assert.ok(
        /cfg\.maintenanceMode\s*&&\s*!isAlwaysAllowed/.test(GUARD_SRC),
        'The maintenance-mode redirect is no longer guarded by !isAlwaysAllowed. /register, ' +
        '/login, /logout and /check-email must stay reachable during maintenance.',
    );
});

check('the registration lock compares the normalised path', () => {
    assert.ok(
        /registrationLocked\s*&&\s*path\s*===\s*['"]\/register['"]/.test(GUARD_SRC),
        'The registration lock compares something other than the normalised `path === "/register"`. ' +
        'Against a raw pathname it would miss one of the two URL spellings Netlify serves.',
    );
});

if (process.exitCode) {
    console.error(`\nauth-guard path bindings: FAILED`);
} else {
    console.log(`\nauth-guard path bindings: ${passed} passed`);
}
