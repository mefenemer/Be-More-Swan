// tests/connections-list-rows.test.ts
// The assistant profile's Connections panel is a LIST of rows, not a grid of tiles (2026-09-30).
//
// Each tile ("Publish approved posts to Facebook" + tagline + a greyed-out Connect button + a boxed
// toggle) showed about two and a half platforms per screen. A row carries exactly one control for
// its state; everything else sits behind ⋮. What could break without anything failing:
//   · a state showing the wrong control (a switch on a dead connection looks like it works)
//   · the manage actions (Disconnect, Reconnect, troubleshooting) vanishing with the tile
//   · the switch losing its handler, so it flips and saves nothing
//
// Renders the REAL integrations.js in a sandbox. Run:  npx tsx tests/connections-list-rows.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'integrations.js'), 'utf8');

const stubEl = () => ({ addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} }, style: {}, querySelector: () => null, querySelectorAll: () => [] });
const sandbox: any = {
    console, setTimeout, clearTimeout, URLSearchParams,
    window: { PlatformConstants: { isConnectionDead: (s: string) => s === 'token_expired' } },
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, createElement: stubEl },
    location: { search: '', pathname: '/', hash: '' }, history: { replaceState() {} },
    fetch: async () => ({ ok: false, json: async () => ({}) }),
};
sandbox.window.location = sandbox.location;
createContext(sandbox);
// Top-level `let`s are not properties of the context, so the setup runs in the SAME script.
runInContext(`${src}
;globalThis.__render = (scoped) => {
    _assistantScoped = scoped;
    _socialHandles = { facebook: 'bms', x: 'BeMoreSwan', youtube: 'bms' };
    _userConnections = [
        { id: 1, serviceName: 'facebook', status: 'active', externalUserId: '1256236320900132' },
        { id: 4, serviceName: 'x', status: 'active', externalUserId: 'BeMoreSwan' },
        { id: 5, serviceName: 'youtube', status: 'token_expired', externalUserId: 'bms' },
    ];
    _assistantSelectedIds = new Set([1]);
    const by = (id) => PLATFORMS.find(p => p.id === id);
    const conn = (svc) => _userConnections.find(c => c.serviceName === svc);
    return {
        facebook: _platformCard(by('Facebook'), conn('facebook')),
        x: _platformCard(by('X'), conn('x')),
        youtube: _platformCard(by('YouTube'), conn('youtube')),
        threads: _platformCard(by('Threads'), undefined),
        linkedin: _platformCard(by('LinkedIn'), undefined),
        canva: _sourceCard(SOURCES[0], undefined),
    };
};`, sandbox);

const rows = sandbox.__render(true);
const tiles = sandbox.__render(false);

check('the assistant panel renders rows, not tiles', () => {
    for (const [k, html] of Object.entries<string>(rows)) {
        assert.match(html, /data-conn-row=/, `${k} is not a row`);
        assert.doesNotMatch(html, /Publish approved posts to/, `${k} still carries the tile headline`);
    }
});

check('live + selected → a switch, ON, wired to the real save handler', () => {
    assert.match(rows.facebook, /aria-label="Use Facebook for this assistant" checked onchange="window\._intToggleUseForAssistant\(1, this\.checked\)"/);
    assert.match(rows.facebook, /1256236320900132/, 'the account is shown on the row');
});

check('live + not selected → the same switch, OFF', () => {
    assert.match(rows.x, /onchange="window\._intToggleUseForAssistant\(4, this\.checked\)"/);
    assert.match(rows.x, /aria-label="Use X \(Twitter\) for this assistant"  onchange=/, 'no checked attribute');
});

check('a dead connection gets Reconnect, never a switch that looks like it works', () => {
    assert.match(rows.youtube, />Reconnect</);
    assert.doesNotMatch(rows.youtube, /type="checkbox"/);
    assert.match(rows.youtube, /text-amber-700 truncate">Disconnected/, 'the state is named, in amber');
});

check('not connected → Connect; no handle yet → points at Business Information', () => {
    assert.match(rows.linkedin, />Add handle</);
    assert.match(rows.linkedin, /Add your handle in Business Information first/);
    assert.match(rows.canva, />Connect</);
});

check('the manage actions survive behind ⋮ on every connected row', () => {
    for (const k of ['facebook', 'x', 'youtube']) {
        assert.match(rows[k], /aria-label="Manage [^"]+ connection"/, `${k} has no ⋮`);
        assert.match(rows[k], /data-conn-manage class="hidden/, `${k}'s manage panel must start closed`);
        assert.match(rows[k], /_intPromptDisconnect\(/, `${k} lost Disconnect`);
    }
    assert.doesNotMatch(rows.linkedin, /data-conn-manage/, 'nothing to manage on an unconnected row');
});

check('the standalone Integrations page keeps its tiles', () => {
    assert.doesNotMatch(tiles.facebook, /data-conn-row=/);
});

check('the rows are wrapped in ONE list in the assistant panel', () => {
    assert.match(src, /if \(_assistantScoped && \(platformHtml \|\| sourceHtml\)\) \{\s*grid\.insertAdjacentHTML\('beforeend', `<div data-conn-list class="col-span-full/);
});

console.log(`\n${passed} checks passed`);
