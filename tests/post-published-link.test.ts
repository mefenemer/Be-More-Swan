// tests/post-published-link.test.ts
// "Post published to LinkedIn — tap to view" with nothing to tap (reported 2026-10-01), and the
// workspace header's identity block moved into the avatar menu.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { livePostUrl } from '../src/utils/post-live-url';
import { landmark } from './landmark';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
function check(name: string, fn: () => void) {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

check('a live URL is built only where the id determines it', () => {
    assert.strictEqual(livePostUrl('linkedin', 'urn:li:share:7123'), 'https://www.linkedin.com/feed/update/urn:li:share:7123/');
    assert.strictEqual(livePostUrl('facebook', '123_456'), 'https://www.facebook.com/123_456');
    assert.strictEqual(livePostUrl('x', '1700000000000000000'), 'https://x.com/i/web/status/1700000000000000000');
    assert.strictEqual(livePostUrl('instagram', '17890000000000000'), null, 'an Instagram id is opaque — the permalink is looked up');
    assert.strictEqual(livePostUrl('linkedin', 'javascript:alert(1)'), null);
    assert.strictEqual(livePostUrl('facebook', '../evil'), null);
});

check('every publisher stamps the URL on the post and the notification', () => {
    for (const f of ['publish-social-posts', 'publish-facebook']) {
        const src = read(`netlify/functions/${f}.ts`);
        assert.match(src, /livePostUrl\(/, f);
        assert.match(src, /platform_post_url = /, `${f} writes the column`);
        assert.match(src, /postUrl: liveUrl/, `${f} puts it in the notification`);
    }
    const ig = read('netlify/functions/publish-instagram.ts');
    assert.match(ig, /fields=permalink/);
    assert.match(ig, /AbortSignal\.timeout\(4000\)/, 'a slow lookup must not hold up a publish');
    assert.match(ig, /postUrl: liveUrl/);
});

check('the notification offers "View post", only to an allow-listed platform URL, with an in-app fallback', () => {
    const n = read('notifications.js');
    const branch = n.slice(landmark(n, "if (notif.type === 'post_published'"), landmark(n, '// Opens the post editor modal in place'));
    assert.match(branch, /label: 'View post', run: \(\) => window\.open\(live, '_blank', 'noopener'\)/);
    assert.match(branch, /window\.openPostReview\(meta\.postId\)/, 'old notifications without a URL still open the post');
    assert.match(n, /const POST_HOSTS = \/\^https:/, 'never an arbitrary URL from metadata');
});

check('the header shows only the avatar; identity lives in its menu', () => {
    const w = read('workspace.html');
    const menu = w.slice(landmark(w, 'id="header-user-menu"'), landmark(w, '</nav>'));
    assert.match(menu, /<button type="button" id="header-user-initials"/);
    assert.match(menu, /id="header-user-panel" role="menu" class="hidden /, 'closed until clicked');
    for (const id of ['header-user-name', 'header-user-email', 'header-role-badges']) {
        assert.ok(landmark(menu, `id="${id}"`) > landmark(menu, 'id="header-user-panel"'), `${id} is inside the panel`);
    }
});

console.log(`\n${passed} checks passed.`);
