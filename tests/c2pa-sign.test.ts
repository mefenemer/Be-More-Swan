// tests/c2pa-sign.test.ts
// Locks the dependency-free surface of the C2PA image-signing scaffold (US 6.1): the enable gate,
// the manifest builder shape, and the disabled passthrough. The native signing + R2 round-trip
// cannot run without a cert, so they are out of scope here. No network, no DB, no native lib.
// Run:  npx tsx tests/c2pa-sign.test.ts

import assert from 'node:assert';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
}

async function main() {
    // Ensure the gate reads as OFF regardless of the ambient environment, before the module (which
    // snapshots env at import time) is loaded.
    delete process.env.C2PA_SIGN_CERT;
    delete process.env.C2PA_SIGN_KEY;
    const { isC2paSigningEnabled, buildManifest, signImageBytes } = await import('../src/utils/c2pa-sign');

    // ── isC2paSigningEnabled ─────────────────────────────────────────────────
    await check('signing is OFF unless BOTH cert and key are set', () => {
        assert.equal(isC2paSigningEnabled(), false);
    });

    // ── buildManifest ────────────────────────────────────────────────────────
    await check('AI-generated media claims the trainedAlgorithmicMedia source type', () => {
        const m = buildManifest({ title: 'Hero', aiGenerated: true, modelHint: 'ai-generated' }, 'image/png') as any;
        assert.equal(m.claim_generator, 'be_more_swan/1.0');
        assert.equal(m.format, 'image/png');
        assert.equal(m.title, 'Hero');
        const created = m.assertions.find((a: any) => a.label === 'c2pa.actions').data.actions[0];
        assert.equal(created.action, 'c2pa.created');
        assert.match(created.digitalSourceType, /trainedAlgorithmicMedia$/);
        assert.match(created.softwareAgent, /ai-generated/);
    });

    await check('human-authored media claims the digitalCapture source type, no softwareAgent', () => {
        const created = (buildManifest({ title: 'Photo', aiGenerated: false }, 'image/jpeg') as any)
            .assertions.find((a: any) => a.label === 'c2pa.actions').data.actions[0];
        assert.match(created.digitalSourceType, /digitalCapture$/);
        assert.equal(created.softwareAgent, undefined);
    });

    await check('contentId + authorLabel flow into the schema.org CreativeWork assertion', () => {
        const work = (buildManifest({ title: 'T', aiGenerated: true, contentId: 'uuid-123', authorLabel: 'AI: Mike' }, 'image/webp') as any)
            .assertions.find((a: any) => a.label === 'stds.schema-org.CreativeWork').data;
        assert.equal(work['@type'], 'CreativeWork');
        assert.equal(work.identifier, 'uuid-123');
        assert.equal(work.author[0].name, 'AI: Mike');
        assert.equal(work.creator[0].name, 'Be More Swan');
    });

    await check('optional fields are omitted when absent', () => {
        const work = (buildManifest({ title: 'T', aiGenerated: false }, 'image/jpeg') as any)
            .assertions.find((a: any) => a.label === 'stds.schema-org.CreativeWork').data;
        assert.equal('identifier' in work, false);
        assert.equal('author' in work, false);
    });

    // ── signImageBytes (disabled passthrough) ─────────────────────────────────
    await check('disabled signing is a byte-for-byte identity passthrough', async () => {
        const input = new Uint8Array([1, 2, 3, 4, 5]);
        const res = await signImageBytes(input, 'image/png', { title: 'X', aiGenerated: true });
        assert.equal(res.signed, false);
        assert.equal(res.skippedReason, 'disabled');
        assert.deepEqual(res.bytes, input);
        assert.equal(res.manifest, undefined);
    });

    console.log(`\n${passed} checks passed.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
