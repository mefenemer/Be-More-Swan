// A recipe's "Connect" button inside an assistant must bring the user back to that assistant after
// sign-in (oauth-integrations.ts returns to workspace.html?assistantId=… only when the link carries it).
// Without it, connecting Slack/Notion/Jira from the Minute Taker landed on integrations.html (2026-11-16).
// Run: npx tsx tests/recipe-connect-returns.test.ts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync('src/components/assistant-integrations.js', 'utf8');
assert.ok(!src.includes(`'<a href="/api/oauth/' + esc(s.providerKey) + '/connect"`), 'no bare connect link left');
assert.ok(src.includes(`'<a href="' + connectHref(s.providerKey) + '"`));

// Evaluate connectHref as written.
const fnSrc = src.slice(src.indexOf('  function connectHref('), src.indexOf('\n  }\n', src.indexOf('  function connectHref(')) + 4);
const ctx: Record<string, unknown> = { state: { assistantId: 66 } };
vm.runInNewContext(`${fnSrc}; result = connectHref('notion');`, ctx);
assert.equal(ctx.result, '/api/oauth/notion/connect?assistantId=66');
const ctx2: Record<string, unknown> = { state: { assistantId: null } };
vm.runInNewContext(`${fnSrc}; result = connectHref('slack');`, ctx2);
assert.equal(ctx2.result, '/api/oauth/slack/connect');

const hub = readFileSync('src/components/assistant-data-hub.js', 'utf8');
assert.ok(hub.includes('/connect${Number(state.assistantId) > 0 ? `?assistantId=${Number(state.assistantId)}` : \'\'}'), 'the data hub recipe link carries it too');

// The server side this relies on.
const oauth = readFileSync('netlify/functions/oauth-integrations.ts', 'utf8');
assert.ok(oauth.includes('return redirect(`/workspace.html?oauth_success=${provider}&assistantId=${returnAssistantId}${where}`);'));
console.log('recipe-connect-returns: all checks passed');
