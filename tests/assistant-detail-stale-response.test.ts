// tests/assistant-detail-stale-response.test.ts
// A slow get-assistant-context for one assistant must not repaint the page of the assistant the
// user has moved on to. Staging, 2026-11-19: open Orbit Scribe (Meeting Note Taker), click Felix
// (Social) before Orbit Scribe's context lands → Felix's page shows Orbit Scribe's name, the
// "New meeting" button and the Note Taker's review queue. initAssistantDetail now takes a ticket
// per call and bails after each await once a newer call has started.
// Source-scan checks. Run:  npx tsx tests/assistant-detail-stale-response.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}

const ROOT = path.resolve(import.meta.dirname, '..');
const js = readFileSync(path.join(ROOT, 'assistants.js'), 'utf8');

function at(hay: string, marker: string, from = 0): number {
    const i = hay.indexOf(marker, from);
    assert.ok(i !== -1, `marker not found: ${marker}`);
    assert.strictEqual(hay.indexOf(marker, i + 1), -1, `marker not unique: ${marker}`);
    return i;
}

const start = at(js, 'window.initAssistantDetail = async function(assistantId, loadViewCb) {');
const end = js.indexOf('\n};\n', start);
assert.ok(end > start, 'initAssistantDetail end not found');
const fn = js.slice(start, end);
const STALE = 'if (_detailStale()) return;';

console.log('\ninitAssistantDetail ignores a superseded response');

check('a module-level ticket counter, bumped once per call', () => {
    assert.ok(js.slice(start - 600, start).includes('let _detailInitSeq = 0;'), 'counter declared just above the function');
    assert.ok(fn.includes('const _detailSeq = ++_detailInitSeq;'), 'each call takes a ticket');
    assert.ok(fn.includes('const _detailStale = () => _detailSeq !== _detailInitSeq;'), 'stale = a newer call exists');
    // Taken before the first await, or two overlapping calls could hold the same ticket.
    assert.ok(fn.indexOf('++_detailInitSeq') < fn.indexOf('await '), 'ticket taken before any await');
});

check('bails straight after the context fetch resolves', () => {
    const f = at(fn, 'await fetch(`/.netlify/functions/get-assistant-context?id=${assistantId}`);');
    const next = fn.indexOf('\n', f) + 1;
    assert.ok(fn.slice(next, next + 60).trim().startsWith(STALE), 'stale check is the next line');
});

check('bails after the JSON body is read and before currentData or any window.* is written', () => {
    const body = at(fn, 'const _ctx = await res.json();');
    const check1 = fn.indexOf(STALE, body);
    const assign = at(fn, 'currentData = _ctx;');
    assert.ok(check1 > body && check1 < assign, 'stale check between the read and the assignment');
    assert.ok(!/\n\s*currentData = await res\.json\(\)/.test(fn), 'the context body is never assigned straight from the await');
    for (const painter of ["window._currentAssistantName = currentData.name", '_applyDashboardRegistry(currentData);', '_detailHydrate(currentData);']) {
        assert.ok(at(fn, painter) > check1, `${painter} runs only after the stale check`);
    }
});

check('the DPA branch does not raise the modal for a superseded call', () => {
    const err = at(fn, 'const errBody = await res.json().catch(() => ({}));');
    const c = fn.indexOf(STALE, err);
    assert.ok(c > err && c < at(fn, "if (errBody.code === 'DPA_REQUIRED')"), 'stale check before the DPA modal');
});

check('a superseded call leaves the skeleton alone and starts no loaders', () => {
    const fin = at(fn, '} finally {');
    const guarded = fn.indexOf('if (!_detailStale()) {', fin);
    assert.ok(guarded > fin && guarded < fn.indexOf("getElementById('assistant-detail-skeleton')", fin), 'skeleton reveal is guarded');
    const after = fn.indexOf(STALE, fin);
    assert.ok(after > fin && after < at(fn, 'const _loads = [];'), 'returns before the background loaders start');
    assert.ok(after < at(fn, 'if (window._assistantDetailShowWelcome) {'), 'and before the welcome banner');
});

console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exit(1);
