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
    // Its own generated page (/ai-…, tests/ai-readability.test.ts) when the build made one, else the
    // ?role= shell — a page either way, never the pop-up.
    assert.match(read('assistants.html'), /window\.location\.href = slug \? `\/\$\{slug\}` : `assistant\.html\?role=\$\{encodeURIComponent\(roleKey\)\}`/);
});
check('the explainer is NOT in the Lambda-deployed Remotion bundle', () => {
    assert.ok(!/AssistantExplainer/.test(read('remotion/Root.tsx')));
});
// ── Admin editing (Admin ▸ Assistants ▸ Website page) ─────────────────────────
import { normaliseShowcase, cleanImageUrl, SHOWCASE_KEY_RE } from '../src/utils/assistant-showcase';

check('the admin save refuses unsafe screenshot links rather than storing them', () => {
    for (const bad of ['javascript:alert(1)', 'data:image/png;base64,AAAA', '//evil.example/x.png', 'http://insecure.example/x.png']) {
        assert.strictEqual(cleanImageUrl(bad), '', bad);
    }
    const r = normaliseShowcase({ headline: 'H', features: [{ title: 'T', body: 'B', image: 'javascript:alert(1)' }] });
    assert.ok(!r.ok, 'a refused link must fail the save with a reason, not vanish silently');
});
check('our own paths, uploads and https links are kept', () => {
    for (const ok of ['/images/assistants/x.jpg', '/.netlify/functions/showcase-media?key=showcase%2Fa%2Fb.png', 'https://cdn.example.com/a.png']) {
        assert.strictEqual(cleanImageUrl(ok), ok, ok);
    }
});
check('a headline is required, and lists are trimmed to their limits', () => {
    assert.ok(!normaliseShowcase({ headline: '  ' }).ok);
    const r = normaliseShowcase({ headline: 'H', highlights: Array(20).fill('x'), faqs: [{ q: 'Q', a: '' }, { q: 'Q2', a: 'A2' }] });
    assert.ok(r.ok);
    if (r.ok) { assert.strictEqual(r.showcase.highlights.length, 6); assert.strictEqual(r.showcase.faqs.length, 1, 'an unanswered question is dropped'); }
});
check('every seeded showcase passes the same validation the admin save uses', () => {
    for (const [role, sc] of Object.entries<any>(DATA)) {
        if (role.startsWith('_')) continue;
        const r = normaliseShowcase(sc);
        assert.ok(r.ok, `${role}: ${(r as any).error}`);
    }
});
check('the media endpoint only serves keys of the exact shape the upload writes', () => {
    assert.ok(SHOWCASE_KEY_RE.test('showcase/lead_qualifier/lzq1abc-1a2b3c4d.png'));
    for (const bad of ['org-5/assets/secret.png', 'showcase/../org-5/a.png', 'showcase/x/../../a.png']) assert.ok(!SHOWCASE_KEY_RE.test(bad), bad);
});
check('every assistant with a page has at least one real screenshot', () => {
    for (const [role, sc] of Object.entries<any>(DATA)) {
        if (role.startsWith('_')) continue;
        assert.ok((sc.features || []).some((f: any) => f.image), `${role} has no screenshot`);
    }
});

console.log(`\n${passed} checks passed.`);
