// tests/issue-ai-fix-screenshot.test.ts
// The AI fixer sees the reporter's screenshot: a signed two-hour link from the app
// (src/utils/issue-screenshot-link.ts), served by netlify/functions/issue-screenshot.ts, fetched by
// ai-fix.yml into Claude's copy and never committed.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    signScreenshot, verifyScreenshotToken, issueScreenshotUrl, parseScreenshotDataUrl, SCREENSHOT_LINK_TTL_SECS,
} from '../src/utils/issue-screenshot-link';
import { buildAiFixIssueText, dispatchAiFix } from '../src/utils/issue-ai-fix';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

const KEY = 'test-secret';
const NOW = 1_800_000_000;

async function main() {
    console.log('issue-ai-fix-screenshot');

    await check('a link opens one issue for two hours, and nothing else', () => {
        const url = issueScreenshotUrl('https://staging--bemoreswan.netlify.app/', 40, NOW, KEY)!;
        const u = new URL(url);
        assert.strictEqual(u.origin + u.pathname, 'https://staging--bemoreswan.netlify.app/api/issue-screenshot');
        const exp = Number(u.searchParams.get('exp'));
        const t = u.searchParams.get('t')!;
        assert.strictEqual(exp, NOW + SCREENSHOT_LINK_TTL_SECS);
        assert.ok(verifyScreenshotToken(40, exp, t, NOW, KEY));
        assert.ok(verifyScreenshotToken(40, exp, t, exp, KEY), 'valid up to the expiry');
        assert.ok(!verifyScreenshotToken(40, exp, t, exp + 1, KEY), 'expired');
        assert.ok(!verifyScreenshotToken(41, exp, t, NOW, KEY), 'another issue');
        assert.ok(!verifyScreenshotToken(40, exp + 1, t, NOW, KEY), 'expiry tampered');
        assert.ok(!verifyScreenshotToken(40, exp, t.slice(0, -1) + (t.endsWith('0') ? '1' : '0'), NOW, KEY), 'token tampered');
        assert.ok(!verifyScreenshotToken(40, exp, t, NOW, 'other-key'), 'other secret');
        const far = NOW + 30 * 86400;
        assert.ok(!verifyScreenshotToken(40, far, signScreenshot(40, far, KEY), NOW, KEY), 'longer than the TTL is refused');
        assert.strictEqual(issueScreenshotUrl(null, 40, NOW, KEY), null);
    });

    await check('only the four image types come out of a stored data URL', () => {
        assert.deepStrictEqual(parseScreenshotDataUrl('data:image/png;base64,iVBO\nRw=='), { mime: 'image/png', b64: 'iVBORw==' });
        assert.strictEqual(parseScreenshotDataUrl('data:image/svg+xml;base64,PHN2Zz4='), null);
        assert.strictEqual(parseScreenshotDataUrl('data:text/html;base64,PGI+'), null);
        assert.strictEqual(parseScreenshotDataUrl(null), null);
    });

    await check('Claude is told to read the screenshot only when one was sent', () => {
        const sent = buildAiFixIssueText({ id: 40, description: 'I get this page', hasImage: true, screenshotSent: true });
        assert.match(sent, /\.issue-screenshot\.\*/);
        assert.match(sent, /read it before anything else/);
        const notSent = buildAiFixIssueText({ id: 40, description: 'I get this page', hasImage: true });
        assert.match(notSent, /It is not available here/);
        assert.ok(!/screenshot/i.test(buildAiFixIssueText({ id: 40, description: 'x' })));
    });

    await check('dispatch passes the link as the screenshot_url input', async () => {
        let body: any;
        const err = await dispatchAiFix({ issueId: 40, issueText: 'x', screenshotUrl: 'https://bemoreswan.com/api/issue-screenshot?id=40&exp=1&t=ab', token: 't',
            fetchImpl: async (_u: string, init: any) => { body = JSON.parse(init.body); return { ok: true, status: 204, json: async () => ({}) } as any; } });
        assert.strictEqual(err, null);
        assert.strictEqual(body.inputs.screenshot_url, 'https://bemoreswan.com/api/issue-screenshot?id=40&exp=1&t=ab');
    });

    await check('the admin API mints the link on the deployment that holds the issue', () => {
        const s = read('netlify/functions/admin-issue-reports.ts');
        assert.ok(s.includes('issue.imageMime ? issueScreenshotUrl(resolveBaseUrl(headers), issue.id) : null'));
        assert.ok(s.includes('screenshotSent: !!screenshotUrl'));
        assert.ok(!/dispatchForIssue\(db, issue\)/.test(s), 'every caller passes the request headers');
    });

    await check('the endpoint checks the signature first and sends only images, never cached', () => {
        const s = read('netlify/functions/issue-screenshot.ts');
        assert.ok(s.indexOf('verifyScreenshotToken(') < s.indexOf('getDb()'), 'no DB read before the signature check');
        assert.ok(s.includes('parseScreenshotDataUrl(row?.data)'));
        assert.ok(s.includes("'Cache-Control': 'private, no-store'"));
        assert.ok(read('netlify.toml').includes('from = "/api/issue-screenshot"\n  to = "/.netlify/functions/issue-screenshot"'));
    });

    await check('the workflow fetches only from the app, only images, and never commits the file', () => {
        const w = read('.github/workflows/ai-fix.yml');
        assert.ok(w.includes("      screenshot_url:\n        description:") && w.includes("required: false"));
        assert.ok(w.includes('SHOT_URL: ${{ inputs.screenshot_url }}'), 'input through env, not inlined in the script');
        assert.ok(!/run:[^\n]*\$\{\{\s*inputs\.screenshot_url/.test(w));
        assert.ok(w.includes('/api/issue-screenshot\\?id=[0-9]+\\&exp=[0-9]+\\&t=[0-9a-f]+$ ]]'), 'allow-listed URL shape');
        assert.ok(w.includes('--proto =https') && w.includes('--max-filesize 6000000'));
        assert.ok(w.includes("--exclude='.issue-screenshot.*' \"$WORK/\" ./"), 'never brought back into the commit');
        assert.ok(w.indexOf('name: Fetch the screenshot') < w.indexOf('name: Run Claude Code'));
    });

    console.log(`\n${passed} passed`);
}
main();
