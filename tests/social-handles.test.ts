// tests/social-handles.test.ts
// Social handles have ONE home — Business Information (organisations.social_handles). The Social
// Media Assistant's set-up asks for them too and writes them back there (onboarding.ts), in the same
// prefix + handle shape, so the two pages never disagree.
//
// Run:  npx tsx tests/social-handles.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanSocialHandles, mergeSocialHandles } from '../src/utils/social-handles';

let passed = 0;
let total = 0;
function check(name: string, fn: () => void): void {
    total++;
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

console.log('\nSocial handles');

check('clean keeps known platforms only, trims, drops blanks', () => {
    assert.deepStrictEqual(cleanSocialHandles({ instagram: ' https://www.instagram.com/a ', myspace: 'x', x: '' }), { instagram: 'https://www.instagram.com/a' });
    assert.strictEqual(cleanSocialHandles({}), null);
    assert.strictEqual(cleanSocialHandles(['x']), null);
});

check('merge: a platform set-up names takes the new address, every other keeps its own', () => {
    const stored = { instagram: 'https://www.instagram.com/old', pinterest: 'https://www.pinterest.com/p' };
    assert.deepStrictEqual(mergeSocialHandles(stored, { instagram: 'https://www.instagram.com/new', x: 'https://x.com/n' }), {
        instagram: 'https://www.instagram.com/new', pinterest: 'https://www.pinterest.com/p', x: 'https://x.com/n',
    });
    assert.strictEqual(mergeSocialHandles(stored, {}), null, 'nothing named → nothing written');
    assert.deepStrictEqual(mergeSocialHandles(null, { x: 'https://x.com/n' }), { x: 'https://x.com/n' });
});

check('onboarding writes them to the organisation; Business Information uses the same cleaner', () => {
    assert.match(read('netlify/functions/onboarding.ts'), /mergeSocialHandles\(org\?\.socialHandles, body\.socialHandles\)/);
    assert.match(read('netlify/functions/organisation-profile.ts'), /socialHandles:\s+cleanSocialHandles\(body\.socialHandles\)/);
    assert.match(read('onboarding-social-media.html'), /socialHandles: collectSocialHandles\(\),/);
});

check('the set-up form uses the Business Information shape: fixed address + handle box, shared URL helper', () => {
    const page = read('onboarding-social-media.html');
    assert.ok(page.includes('<script src="/src/components/social-profile-url.js"></script>'));
    for (const [code, slug] of [['fb', 'facebook'], ['ig', 'instagram'], ['li', 'linkedin'], ['x', 'x'], ['threads', 'threads'], ['tiktok', 'tiktok'], ['youtube', 'youtube']]) {
        assert.ok(page.includes(`<input type="text" id="${code}_handle" data-platform="${slug}"`), code);
    }
    assert.ok(!/type="url" id="\w+_handle"/.test(page), 'no full-URL boxes left');
    assert.match(page, /id="li_handle_path" data-social-path="linkedin"/);
    assert.match(page, /await prefillSocialsFromBusinessInfo\(\);\s*await prefillSocialsFromConnections\(\);/);
});

console.log(`\n${passed}/${total} passed`);
