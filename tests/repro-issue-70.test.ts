// tests/repro-issue-70.test.ts
// Fix pipeline #70 (owner, 2026-11-16): "The Minute Taker should have a chat panel in the assistants detail page like
// other assistants." The docked chat beside the main tabs comes from the role's `tabChat` in
// assistant-dashboard-registry.js (assistants.js _setupTabChat). Social, Blog, Lead Generator, Email and Shopkeeper had
// one; the Note Taker (meeting_note_taker) had none, so it only got the pop-up chat.
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const src = readFileSync(join(__dirname, '..', 'src/components/assistant-dashboard-registry.js'), 'utf8');
const ctx: any = { window: {}, document: { addEventListener() {}, querySelectorAll: () => [], getElementById: () => null }, console };
vm.createContext(ctx);
vm.runInContext(src, ctx);
const reg = ctx.window.AssistantDashboardRegistry;
const cfg = reg.REGISTRY.meeting_note_taker;
assert.ok(cfg, 'the Note Taker has a registry entry');
assert.ok(cfg.tabChat, 'the Note Taker has a docked chat');
assert.deepStrictEqual([...cfg.tabChat.tabs], ['review-queue', 'datahub'], 'beside the Inbox and Meeting Notes');
assert.ok(/transcript/i.test(cfg.tabChat.placeholder), 'the box says what it takes');

// Like the others.
for (const role of ['social_media_manager', 'blog_writer', 'lead_qualifier']) assert.ok(reg.REGISTRY[role]?.tabChat, `${role} has one too`);

console.log('repro-issue-70: the Note Taker has a docked chat ✓');
