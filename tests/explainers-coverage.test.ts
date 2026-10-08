// tests/explainers-coverage.test.ts
// The Be More Swan "i" explainers (explainers.js) — every icon the UI asks for must exist.
//
// WHY THIS EXISTS. An element marked `data-explain="<slug>"` gets the round "i" icon only if the
// slug is in explainers.js GLOSSARY; an unknown slug logs a console warning and renders NOTHING.
// So a typo, or a glossary entry deleted while its markup stayed, silently removes the help the
// user was promised — exactly the "renders and does nothing" class this repo keeps finding.
//
// Also pinned: an icon is a <button> appended INSIDE the marked element, so the mark must never be
// on (or inside) another <button> — a button in a button is invalid HTML and the click would
// trigger both. Campaign Assistant help added 2026-10-08 (§9 release follow-up).
//
// Run:  npx tsx tests/explainers-coverage.test.ts

import assert from 'node:assert';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
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
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const explainers = read('explainers.js');
const glossaryBody = explainers.slice(explainers.indexOf('var GLOSSARY = {'), explainers.indexOf('\n  };', explainers.indexOf('var GLOSSARY = {')));
const SLUGS = new Set([...glossaryBody.matchAll(/^\s{4}'([a-z0-9-]+)':\s*\{/gm)].map((m) => m[1]));

/** Every file that can carry markup the explainer scanner will see. */
const SOURCES = [
    ...readdirSync(join(root, 'src/components')).filter((f) => f.endsWith('.js')).map((f) => `src/components/${f}`),
    'assistants.js',
    ...readdirSync(root).filter((f) => f.endsWith('.html')),
];

check('the glossary parses and has entries', () => {
    assert.ok(SLUGS.size > 50, `Only ${SLUGS.size} glossary slugs found — did the GLOSSARY shape change?`);
});

check('every literal data-explain slug in the UI exists in the glossary', () => {
    const missing: string[] = [];
    for (const f of SOURCES) {
        const src = read(f);
        for (const m of src.matchAll(/data-explain="([a-z0-9-]+)"/g)) {
            if (!SLUGS.has(m[1])) missing.push(`${f}: ${m[1]}`);
        }
    }
    assert.deepStrictEqual(missing, [], `No icon would render for: ${missing.join(', ')}`);
});

check('every registry `explain` slug exists in the glossary', () => {
    const reg = read('src/components/assistant-dashboard-registry.js');
    const missing = [...reg.matchAll(/explain:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]).filter((s) => !SLUGS.has(s));
    assert.deepStrictEqual(missing, [], `Registry explain slugs with no glossary entry: ${missing.join(', ')}`);
});

check('no explainer is placed inside a <button>', () => {
    const bad: string[] = [];
    for (const f of SOURCES) {
        const src = read(f);
        for (const m of src.matchAll(/data-explain="([a-z0-9-]+)"/g)) {
            const before = src.slice(0, m.index);
            const open = before.lastIndexOf('<button');
            const close = before.lastIndexOf('</button>');
            if (open !== -1 && open > close) bad.push(`${f}: ${m[1]}`);
        }
    }
    assert.deepStrictEqual(bad, [], `An icon inside a button is a button in a button: ${bad.join(', ')}`);
});

check('the Campaign Assistant\'s main surfaces carry an explainer', () => {
    const tab = read('src/components/assistant-campaigns.js');
    for (const slug of [
        'campaign', 'campaign-capacity', 'campaign-stop-everything', 'campaign-task-budget', 'campaign-outcome',
        'campaign-funnel-stage', 'campaign-audience', 'campaign-plan', 'campaign-add-work', 'campaign-human-tasks',
        'campaign-ab-test', 'campaign-pictures', 'campaign-summary', 'campaign-lessons', 'campaign-year',
    ]) {
        assert.ok(tab.includes(`data-explain="${slug}"`), `No "i" on the ${slug} surface.`);
    }
    const reg = read('src/components/assistant-dashboard-registry.js');
    assert.match(reg, /explain: 'campaign-orders'/);
    assert.match(reg, /explain: 'campaign-decisions'/);
});

check('the shared headings honour a registry `explain` slug', () => {
    assert.match(read('src/components/assistant-data-hub.js'), /\$\{hub\.explain \? ` data-explain="\$\{esc\(hub\.explain\)\}"` : ''\}/);
    const a = read('assistants.js');
    assert.match(a, /rqHeading\.removeAttribute\('data-explain-ready'\)/,
        'The heading is reused across assistants — without clearing the mark, a second role never gets its icon.');
});

check('the campaign glossary entries say what happens, in plain words', () => {
    for (const slug of [...SLUGS].filter((s) => s.startsWith('campaign'))) {
        const entry = glossaryBody.slice(glossaryBody.indexOf(`'${slug}':`));
        assert.match(entry.split('\n')[0], /term: (['"]).+?\1, emoji: '.+', plain: ".{60,}"/, `${slug} needs a term, an emoji and a real explanation.`);
    }
});

console.log(`\n${passed} checks passed.`);
