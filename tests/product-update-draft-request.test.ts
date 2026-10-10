// tests/product-update-draft-request.test.ts
// "Draft this week's email now" on Admin ▸ What's New (2026-10-10). The button raises a request; the
// scheduled Mac task polls, claims, drafts and reports. Nothing in this path can send an email.
//
// Run:  npx tsx tests/product-update-draft-request.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    raiseRequest, hasWork, claimRequest, finishRequest, describeRequest, parseDraftRequest, STALE_CLAIM_MS,
    type DraftRequest,
} from '../src/utils/product-update-draft-request';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const NOW = new Date('2026-10-10T10:00:00Z');
const later = (ms: number) => new Date(NOW.getTime() + ms);

console.log('\nThe request');
check('pressing the button raises a pending request, who asked and when', () => {
    const r = raiseRequest(null, { by: 'admin@example.com', draftWaiting: false, now: NOW });
    assert.ok(r.ok);
    assert.strictEqual(r.next.status, 'pending');
    assert.strictEqual(r.next.requestedBy, 'admin@example.com');
});
check('refused while a draft is already waiting for review', () => {
    const r = raiseRequest(null, { by: 'a', draftWaiting: true, now: NOW });
    assert.ok(!r.ok && /waiting for review/.test(r.error));
});
check('refused while one is already asked for or being drafted', () => {
    const pending = (raiseRequest(null, { by: 'a', draftWaiting: false, now: NOW }) as { next: DraftRequest }).next;
    assert.ok(!raiseRequest(pending, { by: 'a', draftWaiting: false, now: NOW }).ok);
    const working = (claimRequest(pending, NOW) as { next: DraftRequest }).next;
    const r = raiseRequest(working, { by: 'a', draftWaiting: false, now: NOW });
    assert.ok(!r.ok && /drafting it now/.test(r.error));
});
check('a finished request can be asked for again', () => {
    const pending = (raiseRequest(null, { by: 'a', draftWaiting: false, now: NOW }) as { next: DraftRequest }).next;
    const done = finishRequest(pending, 'nothing', 'quiet week', NOW)!;
    assert.ok(raiseRequest(done, { by: 'a', draftWaiting: false, now: later(1000) }).ok);
});

console.log('\nThe Mac');
check('there is work only for a pending request — not for none, a claimed one, or a finished one', () => {
    const pending = (raiseRequest(null, { by: 'a', draftWaiting: false, now: NOW }) as { next: DraftRequest }).next;
    assert.strictEqual(hasWork(null, NOW), false);
    assert.strictEqual(hasWork(pending, NOW), true);
    const working = (claimRequest(pending, NOW) as { next: DraftRequest }).next;
    assert.strictEqual(hasWork(working, later(60_000)), false, 'a second run would draft it twice');
    assert.strictEqual(hasWork(finishRequest(working, 'uploaded', null, NOW), NOW), false);
});
check('a claim abandoned for 3 hours (Mac asleep, run died) is offered again — and can be re-asked', () => {
    const pending = (raiseRequest(null, { by: 'a', draftWaiting: false, now: NOW }) as { next: DraftRequest }).next;
    const working = (claimRequest(pending, NOW) as { next: DraftRequest }).next;
    assert.strictEqual(hasWork(working, later(STALE_CLAIM_MS + 1)), true);
    assert.ok(raiseRequest(working, { by: 'a', draftWaiting: false, now: later(STALE_CLAIM_MS + 1) }).ok);
});
check('finishing records the outcome and a capped plain-text note; finishing twice changes nothing', () => {
    const pending = (raiseRequest(null, { by: 'a', draftWaiting: false, now: NOW }) as { next: DraftRequest }).next;
    const done = finishRequest(pending, 'failed', '  not   signed in ' + 'x'.repeat(900), NOW)!;
    assert.strictEqual(done.status, 'done');
    assert.strictEqual(done.outcome, 'failed');
    assert.ok(done.note!.startsWith('not signed in') && done.note!.length <= 500);
    assert.strictEqual(finishRequest(done, 'uploaded', null, NOW), null);
});
check('a malformed stored value reads as no request', () => {
    assert.strictEqual(parseDraftRequest({ status: 'weird', requestedAt: 'x' }), null);
    assert.strictEqual(parseDraftRequest('nope'), null);
});
check('the admin is told what is happening in plain words', () => {
    const pending = (raiseRequest(null, { by: 'a', draftWaiting: false, now: NOW }) as { next: DraftRequest }).next;
    assert.ok(/waiting for your Mac/.test(describeRequest(pending, NOW)!));
    assert.ok(/nothing customer-facing/.test(describeRequest(finishRequest(pending, 'nothing', null, NOW), NOW)!));
});

console.log('\nWiring');
const api = read('netlify/functions/product-updates.ts');
check('the machine routes need the upload token; the button needs an admin session', () => {
    assert.ok(/resource\.startsWith\('draft-request-'\)\) \{\s*if \(!isMachine\(event\)\)/.test(api));
    const adminRoute = api.slice(api.indexOf("if (resource === 'draft-request') {"));
    assert.ok(api.indexOf('const admin = await requireAdmin(event);') < api.indexOf("if (resource === 'draft-request') {"));
    assert.ok(/raiseRequest\(/.test(adminRoute.slice(0, 1500)));
});
check('no draft-request route can send — triggerWorker is reached only from approve and resume', () => {
    const calls = api.match(/await triggerWorker\(/g) || [];
    assert.strictEqual(calls.length, 2);
    const reqBlock = api.slice(api.indexOf("resource.startsWith('draft-request-')"), api.indexOf("if (resource === 'last' && method === 'GET')"));
    assert.ok(!/triggerWorker|sendEmail/.test(reqBlock));
});
check('an uploaded draft closes the request, whoever started the run', () => {
    const ingest = api.slice(api.indexOf("if (resource === 'ingest' && method === 'POST')"), api.indexOf('return json(201'));
    assert.ok(/finishRequest\(await readDraftRequest\(\), 'uploaded'/.test(ingest));
});
check('the page has the button, and the script has --pending / --claim / --done', () => {
    const admin = read('admin.html');
    assert.ok(admin.includes('id="pu-draft-now" onclick="puRequestDraft()"'));
    assert.ok(/_puFetch\('resource=draft-request', \{ method: 'POST' \}\)/.test(admin));
    const script = read('scripts/product-updates/upload-draft.ts');
    for (const r of ["'resource=draft-request-poll'", "'resource=draft-request-claim'", "'resource=draft-request-done'"]) assert.ok(script.includes(r), r);
    assert.ok(/hasWork \? 0 : 3/.test(script), '--pending must exit 3 when there is nothing to do');
});

console.log('\nThe Mac watcher (no Claude until the button is pressed)');
const watcher = read('scripts/whats-new-draft-watcher.mjs');
check('it polls with a plain HTTP request and starts Claude only after a successful claim', () => {
    const loop = watcher.slice(watcher.indexOf('async function main()'));
    assert.ok(/api\('GET', 'draft-request-poll'\)/.test(loop));
    assert.ok(/if \(poll\.data\?\.hasWork\) await handleRequest\(\)/.test(loop), 'Claude would run on every poll');
    const handle = watcher.slice(watcher.indexOf('async function handleRequest()'), watcher.indexOf('async function main()'));
    assert.ok(handle.indexOf("api('POST', 'draft-request-claim'") < handle.indexOf('runClaude('), 'Claude started before the claim');
});
check('a run that neither uploads nor reports is marked failed, so the button is never stuck', () => {
    assert.ok(/request\?\.status === 'working'[\s\S]{0,400}outcome: 'failed'/.test(watcher));
});
check('the unattended run cannot push, merge, delete or send', () => {
    const tools = watcher.slice(watcher.indexOf('export const ALLOWED_TOOLS'), watcher.indexOf('];', watcher.indexOf('export const ALLOWED_TOOLS')));
    assert.ok(!/git push|git merge|gh |rm |Bash\(\*\)|curl/.test(tools), tools);
    assert.ok(/NEVER approve or send/.test(watcher));
});
check('the launchd template is a template the user activates', () => {
    const plist = read('scripts/com.aura.whats-new-watcher.plist');
    assert.ok(plist.includes('whats-new-watcher-service.sh') && /you, not the assistant/.test(plist));
});

console.log(`\n${passed} checks passed${process.exitCode ? ' — with FAILURES above' : ''}`);
