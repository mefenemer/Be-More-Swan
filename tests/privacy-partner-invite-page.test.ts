// tests/privacy-partner-invite-page.test.ts
// privacy.html must describe a partner's invite page as the code handles it (2026-11-23): public only while approved,
// checked before it goes live, the photo in Cloudflare R2 (visible before approval only to the partner and the partner
// team — partner-photo.ts), deleted on replace / remove / take-down / erasure / account deletion (partner-hub.ts,
// admin-partners.ts, partner-erasure.ts deleteAllPhotos). And the retention table has a row for it.
//
// Run:  npx tsx tests/privacy-partner-invite-page.test.ts
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}\n    ${(e as Error).message}`); process.exitCode = 1; }
}
const privacy = read('privacy.html');

check('invite page: public only while approved, checked first, R2, who sees it before approval, when it is deleted', () => {
    for (const s of ['publicly while you are an approved partner', 'We check what you send before it goes live',
        'Cloudflare R2, see section 7', 'until it is approved only you and our partner team can see it',
        'when you replace or remove them, when we take the page down, or when you ask us to erase your data or close your account']) {
        assert.ok(privacy.includes(s), s);
    }
});

check('section 7 is the one that lists Cloudflare R2', () => {
    const s7 = privacy.slice(privacy.indexOf('7. Who we share it with'), privacy.indexOf('8. International data transfers'));
    assert.ok(s7.includes('Cloudflare R2'));
});

check('retention table has the invite page row', () => {
    assert.ok(privacy.includes('Partner invite page (photo, headline and words)'));
});

check('the code really does what the policy says', () => {
    assert.ok(read('netlify/functions/partner-photo.ts').includes("requirePermission(u?.role, 'manage_partners')"), 'pending photo: partner or partner admins only');
    assert.ok(read('src/utils/partner-erasure.ts').includes('await deleteAllPhotos(partnerId)'), 'erasure deletes the photos');
    assert.ok(read('netlify/functions/invite-lookup.ts').includes("eq(partners.status, 'approved')"), 'public only while approved');
});

console.log(`\n${passed} passed`);
