// tests/meta-messages-privacy.test.ts
// Facebook + Instagram messages: the privacy work that must land before META_MESSAGING_ENABLED goes
// on in prod (docs/meta-messages-plan.md §6). Messages are written by members of the public, so:
//   · the self-serve workspace export carries the conversations and messages (and LinkedIn Page
//     comments, the same kind of data), stripped of secrets like every section
//   · the admin access-request export carries the replies a user sent
//   · a conversation can be deleted on request — owners and admins only, scoped to the workspace
//     and assistant — and its messages go with it
//   · Meta's data-deletion callback erases the messages received through the connection, and its
//     status page says so
//   · the privacy notice and the data-deletion page no longer claim private messages are never
//     stored, and state the 90-day text retention and the person's-click-only rule
// No network, no database.
//
// Run:  npx tsx tests/meta-messages-privacy.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { getTableName } from 'drizzle-orm';
import { WORKSPACE_TABLES } from '../src/utils/workspace-export';

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
    try { await fn(); console.log(`✓ ${name}`); }
    catch (err) { failed++; console.error(`✗ ${name}\n  ${(err as Error).message}`); }
}
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

async function main() {
    await check('the workspace export carries conversations, messages and LinkedIn Page comments', () => {
        const tables = Object.entries(WORKSPACE_TABLES).map(([k, t]) => [k, getTableName(t)]);
        assert.deepEqual(tables.filter(([, t]) => ['social_conversations', 'social_messages', 'page_comments'].includes(t as string)).map(([k]) => k).sort(),
            ['facebookInstagramConversations', 'facebookInstagramMessages', 'linkedInPageComments']);
    });
    await check('the admin access-request export carries the replies a user sent, and survives a missing table', () => {
        const sar = read('netlify/functions/admin-sar-export.ts');
        assert.ok(sar.includes('db.select().from(socialMessages).where(eq(socialMessages.sentBy, targetUserId)).catch(() => [])'));
        assert.ok(sar.includes('facebookInstagramRepliesSent: sentMessages,'));
    });
    await check('deleting a conversation is owners/admins only and scoped to the workspace and assistant', () => {
        const fn = read('netlify/functions/social-messages.ts');
        const del = fn.slice(fn.indexOf("if (action === 'delete')"));
        assert.ok(del.indexOf("ctx.role !== 'owner' && ctx.role !== 'admin'") < del.indexOf('deleteConversation('));
        assert.ok(fn.includes("requireTenant(event, db, { mutates: action !== 'list' })"), 'refused while impersonating');
        const lib = read('src/utils/social-messages.ts');
        const d = lib.slice(lib.indexOf('export async function deleteConversation'));
        assert.ok(d.includes('eq(socialConversations.organisationId, organisationId), eq(socialConversations.aiAssistantId, assistantId)'));
        assert.ok(d.includes("sql`${notifications.metadata}->>'conversationId' = ${String(id)}`"), "its notification cards (with the person's name) go too");
        // Messages go with the conversation, by the database.
        assert.ok(read('db/z-social-messages.sql').includes('conversation_id   INTEGER NOT NULL REFERENCES social_conversations(id) ON DELETE CASCADE'));
    });
    await check('the tab offers Delete behind a destructive confirm that escapes the name', () => {
        const comp = read('src/components/assistant-messages.js');
        assert.ok(comp.includes('data-msg-delete="${c.id}"'));
        assert.ok(comp.includes("this conversation with ${esc(c.personLabel)} and every message in it"));
        assert.ok(comp.includes("confirmLabel: 'Delete', tone: 'destructive'"));
        assert.ok(!comp.includes('window.confirmModal?.('), 'no optional call: a missing dialog must never mean "yes"');
        assert.ok(comp.includes("return window.confirm("), 'falls back to the browser confirm');
        assert.equal((comp.match(/if \(!ok\) return;/g) || []).length, 2, 'Send and Delete both stop on anything but a yes');
        assert.ok(comp.includes('${state.canDelete ? `'), 'only owners and admins see Delete');
        assert.ok(read('netlify/functions/social-messages.ts').includes("canDelete: ctx.role === 'owner' || ctx.role === 'admin'"));
    });
    await check("Meta's deletion request erases the messages before the connection, and the status page says so", () => {
        const cb = read('netlify/functions/meta-callbacks.ts');
        const erase = cb.slice(cb.indexOf('async function revokeMetaConnections'));
        const msgsAt = erase.indexOf('db.delete(socialConversations).where(inArray(socialConversations.connectionId, ids))');
        const connAt = erase.indexOf('db.delete(systemConnections).where(inArray(systemConnections.id, ids))');
        const revokeReturn = erase.indexOf("if (mode === 'revoke')");
        assert.ok(msgsAt !== -1 && connAt !== -1 && revokeReturn < msgsAt && msgsAt < connAt, 'erase only, children first');
        assert.ok(cb.includes('and the messages people had sent your Page or account through it.'));
        // The FK must keep cascading — the explicit delete is belt and braces, not the only line.
        assert.ok(read('db/z-social-messages.sql').includes('connection_id        INTEGER NOT NULL REFERENCES system_connections(id) ON DELETE CASCADE'));
    });
    await check('the privacy notice and data-deletion page describe messages truthfully', () => {
        const privacy = read('privacy.html');
        assert.ok(privacy.includes('<strong>Messages from members of the public.</strong>'));
        assert.ok(privacy.includes('A reply is only ever sent when someone in your workspace presses Send'));
        assert.ok(privacy.includes('The text of each message is deleted 90 days after it was sent.'));
        assert.ok(privacy.includes('Facebook and Instagram messages people send you'));
        assert.ok(!privacy.includes('is used solely to publish the content you approve and to report back on how it performed.'), 'the old "solely to publish" claim is gone');
        const del = read('data-deletion.html');
        assert.ok(!del.includes('your private messages, or the contents of your inbox'), 'no longer claims messages are never stored');
        assert.ok(del.includes('Their text is deleted 90 days after it was sent'));
        // The purge the copy promises is the one the code runs.
        assert.ok(read('src/utils/social-messages.ts').includes('export const RETENTION_DAYS = 90;'));
    });

    if (failed) { console.error(`\n${failed} check(s) failed`); process.exit(1); }
    console.log('\nAll meta-messages privacy checks passed');
    process.exit(0);
}

main();
