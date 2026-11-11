// tests/render-error-message.test.ts
// SWAN-6 (2026-11-01): a failed video render showed customers Remotion's own error — our AWS region,
// the Lambda function name, a CloudWatch console link and "Consider increasing the timeout of your
// function." — in the Review Queue banner. customerRenderError is the one translation; these lock it
// in, and the source checks below make sure the two places that show render state go through it.
//
// Run:  npx tsx tests/render-error-message.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { customerRenderError } from '../src/utils/render-error-message';

let passed = 0;
function check(name: string, fn: () => void): void {
    try { fn(); passed++; console.log(`  ✓ ${name}`); }
    catch (err) { console.error(`  ✗ ${name}\n    ${(err as Error).message}`); process.exitCode = 1; }
}

// What staging actually stored for "3 Signs Your Boiler Needs a Service Before Winter".
const LAMBDA_TIMEOUT = 'The main function timed out after 299999ms. The following chunks are missing (showing 1 out of 1): Chunk 0 (Frames 0 - 453) ▸ Logs for chunk 0: https://eu-west-2.console.aws.amazon.com/cloudwatch/home?region=eu-west-2#logsV2:log-groups/log-group/$252Faws$252Flambda$252Fremotion-render-4-0-498-mem2048mb-disk2048mb-300sec/log-events Consider increasing the timeout of your function. ▸ You can use';

check('a Lambda timeout becomes a sentence with no infrastructure in it', () => {
    const out = customerRenderError(LAMBDA_TIMEOUT)!;
    assert.match(out, /took too long to render/);
    assert.match(out, /Try the render again/);
    for (const leak of ['aws', 'amazon', 'cloudwatch', 'lambda', 'remotion', 'eu-west-2', 'http', 'ms.', 'chunk', 'increasing the timeout']) {
        assert.ok(!out.toLowerCase().includes(leak), `leaked "${leak}": ${out}`);
    }
});

check('an unknown error is never echoed', () => {
    const out = customerRenderError('TypeError: Cannot read properties of undefined (reading "frames") at /var/task/index.js:12')!;
    assert.match(out, /Something went wrong while rendering your video/);
    assert.ok(!out.includes('TypeError') && !out.includes('/var/task'));
});

check('a concurrency failure keeps its own advice', () => {
    assert.match(customerRenderError('AWS Concurrency limit reached (Original Error: Rate Exceeded.)')!, /renderer was busy/);
});

check('our own worker sentences pass through unchanged', () => {
    assert.equal(customerRenderError('The post no longer has media to render.'), 'The post no longer has media to render.');
    assert.equal(customerRenderError('The render took too long and was abandoned.'), 'The render took too long and was abandoned.');
});

check('nothing stored means no message (the banner has its own default)', () => {
    assert.equal(customerRenderError(null), null);
    assert.equal(customerRenderError('   '), null);
});

check('get-social-drafts sends the translated message, never the stored one', () => {
    const src = readFileSync('netlify/functions/get-social-drafts.ts', 'utf8');
    assert.match(src, /renderError: d\.renderStatus === 'failed' \? customerRenderError\(renderErrors\.get\(d\.id\)\)/);
});

check('the Videos tab says when a built video failed its final render', () => {
    const view = readFileSync('src/utils/video-producer.ts', 'utf8');
    assert.match(view, /postRenderStatus/);
    const tab = readFileSync('src/components/assistant-videos.js', 'utf8');
    assert.match(tab, /render_failed: 'Made, but the final render failed/);
    assert.match(tab, /v\.status === 'built' && v\.postRenderStatus === 'failed' \? 'post_render_failed'/);
});

console.log(`\n${passed} passed`);
