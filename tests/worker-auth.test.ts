// tests/worker-auth.test.ts
// The asset and Inspo workers run only for our own functions, and the asset worker never writes
// over something it has nothing to read (src/utils/worker-auth.ts).
//
// WHY. Both took any POST from anyone; asset ids are sequential, and on a typed brand note the asset
// worker saved '' over its words and marked it 'ready' (found on staging, 2026-11-08).
//
// Run:  npx tsx tests/worker-auth.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { workerAuthError, workerAuthHeaders } from '../src/utils/worker-auth';

let passed = 0, total = 0;
function check(name: string, fn: () => void) {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); }
}
const read = (p: string) => readFileSync(path.join(process.cwd(), p), 'utf8');
const saved = process.env.CRON_TRIGGER_SECRET;

check('no secret configured → every call refused (fails closed)', () => {
    delete process.env.CRON_TRIGGER_SECRET;
    assert.strictEqual(workerAuthError({ authorization: 'Bearer anything' }, 't')?.statusCode, 503);
});
check('wrong, missing or different-length secret → 401', () => {
    process.env.CRON_TRIGGER_SECRET = 's3cret-value';
    assert.strictEqual(workerAuthError({}, 't')?.statusCode, 401);
    assert.strictEqual(workerAuthError({ authorization: 'Bearer s3cret-valuX' }, 't')?.statusCode, 401);
    assert.strictEqual(workerAuthError({ authorization: 'Bearer s3cret' }, 't')?.statusCode, 401);
});
check('our own headers pass', () => {
    process.env.CRON_TRIGGER_SECRET = 's3cret-value';
    const h = workerAuthHeaders();
    assert.strictEqual(workerAuthError({ authorization: h.Authorization }, 't'), null);
    assert.strictEqual(workerAuthError({ Authorization: h.Authorization }, 't'), null);
});
check('both workers check before reading the body', () => {
    for (const f of ['netlify/functions/process-asset-background.ts', 'netlify/functions/process-inspo-background.ts']) {
        const s = read(f);
        const at = s.indexOf('workerAuthError(event.headers');
        assert.ok(at > 0, `${f} has no check`);
        assert.ok(at < s.indexOf('JSON.parse(event.body'), `${f} reads the body first`);
    }
});
check('every caller sends the secret', () => {
    for (const f of ['netlify/functions/storage-confirm-upload.ts', 'netlify/functions/upload-asset.ts', 'netlify/functions/inspo-items.ts']) {
        const s = read(f);
        const at = s.search(/functions\/process-(asset|inspo)-background/);
        assert.ok(at > 0 && s.slice(at, at + 300).includes('headers: workerAuthHeaders()'), `${f} calls without the secret`);
    }
});
check('the asset worker writes nothing when there is nothing to read (typed notes)', () => {
    const s = read('netlify/functions/process-asset-background.ts');
    const guard = s.indexOf("return { statusCode: 200, body: 'Nothing to read.' }");
    assert.ok(guard > 0);
    assert.ok(guard < s.indexOf("status: 'ready'"));
});

if (saved === undefined) delete process.env.CRON_TRIGGER_SECRET; else process.env.CRON_TRIGGER_SECRET = saved;
console.log(`\n${passed}/${total} passed`);
if (passed !== total) process.exit(1);
