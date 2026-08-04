// tests/esm-only-imports.test.ts
// Guards the one import mistake that CANNOT be caught by running the code locally.
//
// ── The failure ──────────────────────────────────────────────────────────────
// `marked` is ESM-only (v18: "type": "module", and even its `require` condition resolves to
// marked.esm.js). Netlify's bundler externalises it rather than inlining it, and package.json is
// "type": "commonjs", so a STATIC value import compiles to `require("marked")` in the function
// bundle. On the deploy runtime that throws ERR_REQUIRE_ESM **at module load** — before the handler
// runs — which takes down every function that transitively imports the file. publish-blog-posts sat
// in a crash loop on staging for exactly this reason, and no blog post could publish.
//
// ── Why a test and not "just run it" ─────────────────────────────────────────
// Node 22.12+ ALLOWS require() of ESM. Local dev machines are past that; the deploy runtime is not.
// So the broken form works perfectly on the machine of whoever writes it and fails only in
// production. There is no local run that catches this — hence a static check.
//
// The safe forms are `import type { … } from 'marked'` (erased at compile time) and
// `await import('marked')` (a real dynamic import, which esbuild preserves in CJS output and which
// Node supports on every version).
//
// Run:  npx tsx tests/esm-only-imports.test.ts

import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0;
function check(name: string, fn: () => void): void {
    try {
        fn();
        passed++; console.log(`  ✓ ${name}`);
    } catch (err) {
        console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1;
    }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Packages that must never be reached by a static value import from server code.
 *
 * Add to this list whenever a dependency goes ESM-only. The symptom is always the same and always
 * invisible locally: a function that dies at module load on deploy.
 */
const ESM_ONLY = ['marked'];

/** Server code that gets bundled into CJS functions. Browser bundles and tests are exempt. */
function serverFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const p = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules') continue;
                walk(p);
            } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
                out.push(p);
            }
        }
    };
    walk(join(root, 'src'));
    walk(join(root, 'netlify'));
    return out;
}

check('the ESM-only guard list is not empty (a vacuous scan proves nothing)', () => {
    assert.ok(ESM_ONLY.length > 0);
    // And the package really is ESM-only — if it ever ships CJS again this test should be revisited
    // rather than silently guarding nothing.
    const pkg = JSON.parse(readFileSync(join(root, 'node_modules/marked/package.json'), 'utf8'));
    assert.equal(pkg.type, 'module', 'marked is no longer ESM-only — revisit this guard');
});

check('no server file statically value-imports an ESM-only package', () => {
    const offenders: string[] = [];
    for (const file of serverFiles()) {
        const text = readFileSync(file, 'utf8');
        const rel = relative(root, file);
        for (const pkg of ESM_ONLY) {
            // `import type { X } from 'pkg'` is erased and therefore fine.
            // `import { type X } from 'pkg'` is NOT — it still emits a require for the module.
            const re = new RegExp(`^\\s*import\\s+(?!type\\s)[^;]*?from\\s+['"]${pkg}(?:/[^'"]*)?['"]`, 'm');
            if (re.test(text)) offenders.push(`${rel} → ${pkg}`);
            // A bare side-effect import emits a require too.
            const bare = new RegExp(`^\\s*import\\s+['"]${pkg}['"]`, 'm');
            if (bare.test(text)) offenders.push(`${rel} → ${pkg} (side-effect import)`);
        }
    }
    assert.deepEqual(offenders, [],
        'these compile to require() of an ESM module and will crash the function at module load '
        + `on deploy (they work locally on Node 22.12+):\n    ${offenders.join('\n    ')}`);
});

check('the modules that DO use marked reach it dynamically', () => {
    // Positive assertion: without this, deleting the usage entirely would also make the test above
    // pass, and the guard would be protecting nothing.
    for (const rel of ['src/utils/markdown-render.ts', 'src/utils/blog-publish.ts']) {
        const text = readFileSync(join(root, rel), 'utf8');
        assert.ok(/await import\(['"]marked['"]\)|import\(['"]marked['"]\)/.test(text),
            `${rel} no longer loads marked dynamically`);
    }
});

check('renderMarkdown and excerpt are async, so callers cannot forget to await', () => {
    // They became async when marked moved behind a dynamic import. A future "simplification" back
    // to sync would have to reinstate the static import, which is the crash.
    const text = readFileSync(join(root, 'src/utils/markdown-render.ts'), 'utf8');
    assert.ok(/export async function renderMarkdown\(/.test(text), 'renderMarkdown must stay async');
    assert.ok(/export async function excerpt\(/.test(text), 'excerpt must stay async');
});

console.log(`\n${passed} checks passed.`);
