// tests/connection-recovery.test.ts
// Every side-effect a connection failure inflicts must have a path that undoes it.
//
// Run:  npx tsx tests/connection-recovery.test.ts
//
// A credential failure pauses posts and halts assistants, and the user is emailed a promise that
// both "will resume once you reconnect". Nothing kept that promise: three writers set
// scheduled_posts.status='paused' and zero readers ever set it back, so every breakage stranded
// its posts permanently. The symptom was silence — the publisher requires status='scheduled', so
// stranded posts simply never came up again, and no error was raised anywhere.
//
// Same shape as connection-status-vocabulary.test.ts: the bug is not that something throws, it is
// that a half of a round-trip was never written. Only a source scan catches that.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
    CONNECTION_RESTORED_TYPES,
    PLATFORM_TOKEN_REFRESH_FAILED_TYPES,
    categoryOf,
    kindOf,
    resolvesOnClick,
} from '../src/utils/notification-actions';
import { connectionPauseReasons } from '../src/utils/connection-recovery';

let passed = 0;
const test = (name: string, fn: () => void) => {
    try { fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (err) { console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`); process.exitCode = 1; }
};

const src = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

console.log('\nConnection recovery — every pause has a resume\n');

// ── Pause sites ─────────────────────────────────────────────────────────────────────────────────

// Files that put a scheduled_post into 'paused' because a credential died. If a fourth one
// appears, it must also be reachable by restoreConnectionDependents — which resumes by
// connection_id, so the new writer has to scope its pause the same way.
const POST_PAUSE_SITES = [
    'netlify/functions/refresh-social-tokens.ts',
    'netlify/functions/refresh-meta-tokens.ts',
    'netlify/functions/publish-instagram.ts',
];

test('every post-pause site scopes by connection_id, so the resume can find them', () => {
    for (const path of POST_PAUSE_SITES) {
        const text = src(path);
        assert.ok(
            /status\s*[:=]\s*'paused'/.test(text),
            `${path} no longer pauses posts — remove it from POST_PAUSE_SITES`,
        );
        assert.ok(
            /connection_id|connectionId/.test(text),
            `${path} pauses posts without scoping by connection_id; restoreConnectionDependents ` +
            `resumes by connection_id and would never reach them`,
        );
    }
});

test('the resume path exists and is the only thing writing posts back to scheduled', () => {
    const recovery = src('src/utils/connection-recovery.ts');
    assert.ok(
        /status:\s*'scheduled'/.test(recovery),
        'connection-recovery.ts no longer resumes posts to scheduled',
    );
    assert.ok(
        /gt\(scheduledPosts\.publishDate/.test(recovery),
        'the resume must skip past-dated slots — those are missed, not recoverable',
    );
});

// ── Reconnect sites ─────────────────────────────────────────────────────────────────────────────

// Every OAuth callback that can bring a dead connection back. Each must call the recovery helper;
// setting status='active' alone leaves the posts and assistants exactly where the failure left them.
const RECONNECT_SITES = [
    'netlify/functions/social-oauth-callback.ts',  // X + LinkedIn
    'netlify/functions/meta-oauth.ts',             // Instagram + Facebook
];

test('every reconnect path calls restoreConnectionDependents', () => {
    for (const path of RECONNECT_SITES) {
        const text = src(path);
        assert.ok(
            text.includes('restoreConnectionDependents'),
            `${path} reactivates a connection without undoing the pause side-effects`,
        );
    }
});

test('social-oauth-callback wires BOTH platforms it handles', () => {
    const text = src('netlify/functions/social-oauth-callback.ts');
    for (const platform of ['x', 'linkedin']) {
        assert.ok(
            new RegExp(`serviceName:\\s*'${platform}'`).test(text),
            `the ${platform} branch does not pass its serviceName to the recovery helper`,
        );
    }
});

// ── Assistant resume reasons ────────────────────────────────────────────────────────────────────

test('system-pause reasons match what the resume guard looks for', () => {
    // transitionAssistantStatus records the reason; connection-recovery matches on it to decide
    // whether a given assistant may resume. A reason written in a shape the guard does not
    // recognise leaves the assistant halted forever with no error anywhere.
    const SITES: Record<string, string[]> = {
        'netlify/functions/refresh-social-tokens.ts': ['x', 'linkedin'],
        'netlify/functions/refresh-meta-tokens.ts': ['instagram', 'facebook'],
    };

    for (const [path, services] of Object.entries(SITES)) {
        const text = src(path);
        // Both sites build the reason as a template literal off the connection's own serviceName.
        assert.ok(
            /`token_refresh_failed:\$\{conn\.serviceName\}`/.test(text),
            `${path} must derive its pause reason from conn.serviceName — a hardcoded platform ` +
            `means reconnecting the OTHER platform it handles can never resume the assistant`,
        );
        for (const s of services) {
            assert.ok(
                connectionPauseReasons(s).includes(`token_refresh_failed:${s}`),
                `the resume guard does not recognise token_refresh_failed:${s}`,
            );
        }
    }
});

// ── Notification round-trip ─────────────────────────────────────────────────────────────────────

test('computed per-platform reconnect types are categorised as actions', () => {
    // notify.ts stamps `${serviceName}_token_refresh_failed` via typeOverride. Unlisted types fall
    // back to 'informational', which files an "Action required: reconnect" card under Updates.
    for (const type of PLATFORM_TOKEN_REFRESH_FAILED_TYPES) {
        assert.equal(categoryOf(type), 'suggested_action', `${type} is not categorised as an action`);
        assert.equal(kindOf(type), 'action', `${type} would not appear in the Action Required tab`);
    }
});

test('reconnect prompts do not resolve on click', () => {
    // They have a real completion hook now (connection-recovery clears them), so clicking the CTA
    // must only navigate — marking Done at click closes the card before the user has reconnected.
    for (const type of [...PLATFORM_TOKEN_REFRESH_FAILED_TYPES, ...CONNECTION_RESTORED_TYPES]) {
        if (kindOf(type) !== 'action') continue;
        assert.equal(resolvesOnClick(type), false, `${type} resolves on click despite having a completion hook`);
    }
});

test('the shared restore list stays platform-agnostic', () => {
    // Restoring X must not clear LinkedIn's still-valid prompt, so the computed per-platform types
    // are appended by the caller for the one platform it restored — never listed globally.
    for (const type of PLATFORM_TOKEN_REFRESH_FAILED_TYPES) {
        assert.ok(
            !CONNECTION_RESTORED_TYPES.includes(type),
            `${type} is in the shared restore list — reconnecting any platform would clear it`,
        );
    }
    const recovery = src('src/utils/connection-recovery.ts');
    assert.ok(
        /\$\{serviceName\}_token_refresh_failed/.test(recovery),
        'connection-recovery must append the restored platform\'s own prompt type',
    );
});

// ── The reconnect link ──────────────────────────────────────────────────────────────────────────

test('every reconnect email builds its link with reconnectUrl()', () => {
    // Hand-built `?reconnect=` strings drifted out of reach of the frontend handler for as long as
    // they existed. One builder, so the link shape and its reader cannot diverge again.
    for (const path of ['netlify/functions/refresh-social-tokens.ts', 'netlify/functions/refresh-meta-tokens.ts']) {
        const text = src(path);
        assert.ok(text.includes('reconnectUrl('), `${path} must build its reconnect link with reconnectUrl()`);
        assert.ok(
            !/workspace\.html\?reconnect=/.test(text),
            `${path} hand-builds a ?reconnect= URL instead of calling reconnectUrl()`,
        );
    }
});

test('the frontend actually reads the reconnect param', () => {
    // The whole point. This param was emitted for months and read by nothing.
    const html = src('workspace.html');
    assert.ok(
        /qs\.get\('reconnect'\)/.test(html),
        'workspace.html does not read ?reconnect= — the email link is a dead param again',
    );
    assert.ok(
        /handleReconnectPrompt/.test(html),
        'the reconnect handler is gone from workspace.html',
    );
});

// ── Per-platform copy ───────────────────────────────────────────────────────────────────────────

test('the Meta failure path names the platform that actually failed', () => {
    // This cron serves Instagram AND Facebook, but every user-facing string was hardcoded to
    // Instagram — a dead Facebook Page told the user to reconnect Instagram.
    const text = src('netlify/functions/refresh-meta-tokens.ts');
    assert.ok(/LABELS\[conn\.serviceName\]/.test(text), 'the email label must be derived from the connection');
    assert.ok(
        /typeOverride: `\$\{conn\.serviceName\}_token_refresh_failed`/.test(text),
        'the notification type must be per-platform, not hardcoded',
    );
    // Check the subject line itself, not the file — the comment above it quotes the old copy.
    const subject = /subject: (.+),\n/.exec(text)?.[1] ?? '';
    assert.ok(
        subject.includes('${label}'),
        `the email subject is not derived from the connection: ${subject}`,
    );
});

console.log(`\n${passed} passed\n`);
