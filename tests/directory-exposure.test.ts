// tests/directory-exposure.test.ts
// Nothing server-only may be published to the open web.
//
// ── What this defends ────────────────────────────────────────────────────────
// `[build]` in netlify.toml sets no `publish` key, so Netlify publishes the REPO ROOT: every
// tracked file is served unless something blocks it. Measured on prod 2026-08-12, before the
// block rules existed: netlify/edge-functions/auth-guard.ts (the auth guard itself, including
// PROTECTED_PATHS), db/schema.ts, every db/*.sql migration, all 147 files in src/utils/,
// scripts/, tests/, docs/ and package-lock.json all returned 200.
//
// No credentials were exposed — .env, .git/, .claude/, netlify.toml and node_modules/ are 404 by
// Netlify's own defaults — so this was information disclosure rather than a breach. But it hands
// over the complete schema, every endpoint's logic, and exact dependency versions for CVE
// matching. Details and the fix: docs/source-exposure-plan.md.
//
// ⚠️ WHY THIS TEST EXISTS AT ALL. The fix is a DENY-LIST, and a deny-list silently stops covering
// anything nobody wrote a rule for. Add a top-level directory next month and it is public by
// default, with nothing to notice. This test is the thing that notices: every tracked directory
// must be either deliberately public (listed below, with a reason) or blocked in netlify.toml.
//
// ⚠️ THE /src/ SUBTLETY. src/ is MIXED and must never be blocked wholesale — the browser loads
// real modules from under it. The four client-side .js files that used to sit in src/config/ and
// src/lib/ were moved to src/public/ so the boundary is structural rather than a list of
// exceptions; those two directories are now TypeScript-only and safe to block entirely.
//
// Run:  npx tsx tests/directory-exposure.test.ts

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { landmark } from './landmark';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOML = readFileSync(join(root, 'netlify.toml'), 'utf8');

/**
 * Top-level directories that are deliberately reachable from a browser, each with the reason.
 * Adding to this list is a decision to publish that directory to the open web.
 */
const PUBLIC_DIRS: Record<string, string> = {
    components: 'footer.html and friends are fetched at runtime by the marketing pages',
    favicon: 'icons referenced from every page head',
    images: 'site imagery',
    locales: 'i18n bundles fetched by src/i18n.js',
    src: 'MIXED — see PUBLIC_SRC_DIRS; the rest is blocked per-subdirectory',
};

/** Subdirectories of src/ that the browser genuinely loads. Everything else under src/ is server-only. */
const PUBLIC_SRC_DIRS: Record<string, string> = {
    components: 'browser IIFE modules loaded by script tags',
    generated: 'the generated client constants mirror',
    public: 'hand-written client-side .js that used to be stranded in src/config and src/lib',
};

/** Directories git tracks, ignoring dotfiles (Netlify excludes those itself). */
function trackedDirs(prefix = ''): string[] {
    const out = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
        .split('\n')
        .filter((p) => p && (!prefix || p.startsWith(prefix)))
        .map((p) => p.slice(prefix.length).split('/')[0])
        .filter((seg, i, arr) => seg && !seg.startsWith('.') && arr.indexOf(seg) === i);
    // Keep directories only — a top-level file is not what this test is about.
    return out.filter((seg) => {
        try { return statSync(join(root, prefix, seg)).isDirectory(); } catch { return false; }
    });
}

/** Is there a forced 404 redirect covering this path prefix? */
function isBlocked(pathPrefix: string): boolean {
    const re = new RegExp(
        `from\\s*=\\s*"${pathPrefix.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')}/\\*"[\\s\\S]{0,120}?force\\s*=\\s*true`,
    );
    const m = TOML.match(re);
    return !!m && /status\s*=\s*404/.test(m[0]);
}

// ── 1. Every tracked directory is either public-by-decision or blocked ───────

check('every top-level directory is either allow-listed or blocked', () => {
    const unaccounted = trackedDirs().filter((d) => !(d in PUBLIC_DIRS) && !isBlocked(`/${d}`));
    assert.deepEqual(unaccounted, [],
        `these directories are published to the open web with no rule and no decision: ${unaccounted.join(', ')}. `
        + 'Either add a forced 404 redirect in netlify.toml, or add it to PUBLIC_DIRS with a reason.');
});

check('every src/ subdirectory is either public or blocked', () => {
    const unaccounted = trackedDirs('src/')
        .filter((d) => !(d in PUBLIC_SRC_DIRS) && !isBlocked(`/src/${d}`));
    assert.deepEqual(unaccounted, [],
        `these src/ subdirectories are public with no rule: ${unaccounted.join(', ')}`);
});

// ── 2. The rules that were the actual leak ───────────────────────────────────

check('the paths measured as exposed on prod are all blocked', () => {
    // Not a generic list — every one of these returned 200 on bemoreswan.com.
    for (const p of ['/netlify', '/db', '/src/utils', '/src/lib', '/src/config', '/scripts', '/tests', '/docs']) {
        assert.ok(isBlocked(p), `${p}/* is no longer blocked — it was publicly readable on prod`);
    }
});

check('the root manifests are blocked', () => {
    // package-lock.json is the one that matters most: exact versions turn CVE matching into a lookup.
    for (const f of ['/package.json', '/package-lock.json', '/tsconfig.json', '/deno.lock', '/drizzle.config.ts']) {
        const re = new RegExp(`from\\s*=\\s*"${f.replace(/[/.]/g, '\\$&')}"[\\s\\S]{0,120}?force\\s*=\\s*true`);
        assert.ok(re.test(TOML), `${f} is no longer blocked`);
    }
});

check('every block rule carries force = true', () => {
    // ⚠️ Without force, a redirect LOSES to the real file sitting at that path — so the rule does
    // nothing while reading as correct. This is the single easiest way to think this is fixed
    // when it is not.
    const blocks = TOML.split('[[redirects]]').filter((b) => /status\s*=\s*404/.test(b));
    assert.ok(blocks.length >= 15, `expected the full set of 404 blocks, found ${blocks.length}`);
    for (const b of blocks) {
        const from = b.match(/from\s*=\s*"([^"]+)"/)?.[1] ?? '(unknown)';
        assert.ok(/force\s*=\s*true/.test(b), `the 404 rule for ${from} is missing force = true, so it does nothing`);
    }
});

// ── 3. The public subtree must keep working ──────────────────────────────────

check('the public src/ subdirectories are NOT blocked', () => {
    // Blocking these white-screens the workspace. This is the failure mode worth a test of its own.
    for (const d of Object.keys(PUBLIC_SRC_DIRS)) {
        assert.ok(!isBlocked(`/src/${d}`), `/src/${d}/* is blocked — the browser loads modules from there`);
    }
    assert.ok(!/from\s*=\s*"\/src\/\*"/.test(TOML),
        'a blanket /src/* block exists — that takes the entire workspace UI down');
});

check('every client script tag points at a public directory', () => {
    // The moved files are the reason src/config and src/lib became safe to block. If a script tag
    // still points into a blocked directory, that page 404s its own JavaScript.
    const publicSrc = new Set(Object.keys(PUBLIC_SRC_DIRS));
    const offenders: string[] = [];
    for (const f of readdirSync(root).filter((f) => f.endsWith('.html'))) {
        const html = readFileSync(join(root, f), 'utf8');
        for (const m of html.matchAll(/src="\.?\/?(src\/[A-Za-z0-9_./-]+)"/g)) {
            const sub = m[1].split('/')[1];
            if (!publicSrc.has(sub) && m[1] !== 'src/i18n.js') offenders.push(`${f} → ${m[1]}`);
        }
    }
    assert.deepEqual(offenders, [], `these script tags load from a blocked directory: ${offenders.join(', ')}`);
});

console.log(`\n${passed} checks passed.`);
