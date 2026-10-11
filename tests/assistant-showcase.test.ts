// tests/assistant-showcase.test.ts — the public assistant page (assistant.html) and its content.
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const PAGE = read('assistant.html');
const FN = read('netlify/functions/assistant-showcase.ts');
const DATA = JSON.parse(read('db/assistant-showcases.json'));
const SQL = read('db/z-assistant-showcases.sql');

check('the page is public — no auth-check', () => assert.ok(!/<script[^>]*auth-check\.js/.test(PAGE)));
check('admin-edited URLs only reach an href/src through safeUrl (no javascript: links)', () => {
    assert.match(PAGE, /const safeUrl = \(u\) => \(\/\^\(\\\/\|https:\\\/\\\/\)\//);
    assert.ok(!/src="\$\{esc\(f\.image\)\}"/.test(PAGE), 'feature images must go through safeUrl');
});
check('a missing table degrades to the short page, never an error', () => {
    assert.match(FN, /42P01/);
    assert.ok(!/statusCode: 500|json\(500/.test(FN));
});
check('the showcase is its own table, so the public library never selects a missing column', () => {
    assert.ok(!/showcase/.test(read('db/schema.ts').slice(read('db/schema.ts').indexOf('export const masterAssistants'), read('db/schema.ts').indexOf('export const masterAssistants') + 4000)));
    assert.match(SQL, /CREATE TABLE IF NOT EXISTS assistant_showcases/);
});
check('the generated SQL is current with the JSON', () => {
    for (const role of Object.keys(DATA).filter((k) => !k.startsWith('_'))) {
        assert.ok(SQL.includes(JSON.stringify(DATA[role])), `${role} differs — run node scripts/build-showcase-sql.mjs`);
    }
});
check('every referenced screenshot and video exists in the repo', () => {
    for (const [role, sc] of Object.entries<any>(DATA)) {
        if (role.startsWith('_')) continue;
        for (const f of sc.features || []) if (f.image) assert.ok(existsSync(join(root, f.image)), f.image);
        assert.ok(existsSync(join(root, `videos/assistants/${role}.mp4`)), `${role}.mp4`);
        assert.ok(existsSync(join(root, `videos/assistants/${role}.jpg`)), `${role}.jpg poster`);
    }
});
check('the library opens the page, not the old pop-up', () => {
    assert.match(read('assistants.html'), /window\.location\.href = `assistant\.html\?role=\$\{encodeURIComponent\(roleKey\)\}`/);
});
check('the explainer is NOT in the Lambda-deployed Remotion bundle', () => {
    assert.ok(!/AssistantExplainer/.test(read('remotion/Root.tsx')));
});
console.log(`\n${passed} checks passed.`);
