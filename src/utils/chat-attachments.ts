// src/utils/chat-attachments.ts — files attached to an assistant chat turn (db/z-chat-attachments.sql).
// First user: the Website Assistant (route flag `acceptsAttachments` in chat-orchestrator.ts).
// tests/site-owner-content.test.ts.
//
//   picture  — already uploaded into the media library by the browser (media-picker.js upload), so
//              it arrives as an assetId. Checked here: this workspace's, a picture, not refused by
//              moderation. The assistant can then put it on the site by that id.
//   document — arrives as the file (base64); its WORDS are read (site-words.ts readWordsFile) and
//              kept, not the file. A later site_words card places exactly those words.
//
// ⚠️ The model never carries the owner's words onto the site itself. It names the attachment (or
// quotes the owner's own chat message, which quoteFromChat checks is really theirs) and the server
// places the words — so "your wording, unchanged" holds in chat as it does in the editor.

import { and, desc, eq, inArray } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { chatAttachments, chatMessages, chatSessions, contentAssets } from '../../db/schema';
import { MAX_WORDS_CHARS, readWordsFile, tidyWords } from './site-words';

type Db = ReturnType<typeof getDb>;

export const ATTACHMENT_LIMITS = { perTurn: 5, documentBytes: 4 * 1024 * 1024, listed: 12, documentPreviewChars: 3000 };

export type RawAttachment =
    | { kind: 'image'; assetId: number; name?: string }
    | { kind: 'document'; name: string; type?: string; data: string };

export interface AcceptedAttachment { kind: 'image' | 'document'; name: string; assetId: number | null; text: string | null; }

/** Read and check what the browser sent. Throws a plain-words Error the owner can act on. */
export async function readAttachments(db: Db, orgId: number, raw: unknown): Promise<AcceptedAttachment[]> {
    const list = Array.isArray(raw) ? raw : [];
    if (list.length > ATTACHMENT_LIMITS.perTurn) throw new Error(`Attach up to ${ATTACHMENT_LIMITS.perTurn} files at a time.`);
    const out: AcceptedAttachment[] = [];
    const imageIds = list.filter((a) => a && a.kind === 'image').map((a) => Number(a.assetId)).filter((n) => Number.isInteger(n) && n > 0);
    const owned = imageIds.length
        ? new Map((await db.select({ id: contentAssets.id, name: contentAssets.name, assetType: contentAssets.assetType, status: contentAssets.status })
            .from(contentAssets).where(and(inArray(contentAssets.id, imageIds), eq(contentAssets.organisationId, orgId)))).map((r) => [r.id, r]))
        : new Map();
    for (const a of list) {
        if (!a || typeof a !== 'object') continue;
        if (a.kind === 'image') {
            const row = owned.get(Number(a.assetId));
            if (!row || row.assetType !== 'image') throw new Error('One of those pictures isn\'t in your library. Attach it again.');
            if (row.status === 'rejected') throw new Error('One of those pictures was flagged and can\'t be used.');
            out.push({ kind: 'image', name: String(row.name || a.name || 'picture').slice(0, 120), assetId: row.id, text: null });
        } else if (a.kind === 'document') {
            const name = String(a.name || 'document').slice(0, 120);
            const data = typeof a.data === 'string' ? Buffer.from(a.data, 'base64') : Buffer.alloc(0);
            if (data.length > ATTACHMENT_LIMITS.documentBytes) throw new Error(`"${name}" is too large (the limit is 4 MB).`);
            const text = tidyWords(await readWordsFile(name, String(a.type || ''), data));
            if (!text) throw new Error(`No words could be read from "${name}". If it's a scanned PDF, paste the words in instead.`);
            if (text.length > MAX_WORDS_CHARS) throw new Error(`"${name}" is longer than one page can hold. Split it, or attach one part at a time.`);
            out.push({ kind: 'document', name, assetId: null, text });
        }
    }
    return out;
}

export async function saveAttachments(db: Db, orgId: number, sessionId: number, messageId: number, items: AcceptedAttachment[]): Promise<void> {
    if (!items.length) return;
    await db.insert(chatAttachments).values(items.map((a) => ({
        organisationId: orgId, chatSessionId: sessionId, chatMessageId: messageId, kind: a.kind, assetId: a.assetId, name: a.name, text: a.text,
    })));
}

/** The line the owner's message carries in the transcript, so history shows what was attached. */
export function attachmentLine(items: AcceptedAttachment[]): string {
    return items.length ? `📎 Attached: ${items.map((a) => a.name).join(', ')}` : '';
}

/** What the assistant sees each turn: this conversation's attachments, newest first. */
export async function buildAttachmentsBlock(db: Db, orgId: number, sessionId: number): Promise<string | null> {
    const rows = await db.select().from(chatAttachments)
        .where(and(eq(chatAttachments.chatSessionId, sessionId), eq(chatAttachments.organisationId, orgId)))
        .orderBy(desc(chatAttachments.createdAt), desc(chatAttachments.id)).limit(ATTACHMENT_LIMITS.listed);
    if (!rows.length) return null;
    const lines = ['FILES THEY HAVE ATTACHED IN THIS CONVERSATION (newest first):'];
    for (const r of rows) {
        if (r.kind === 'image' && r.assetId) lines.push(`- Picture "${r.name}" — assetId ${r.assetId}`);
        else if (r.kind === 'document' && r.text) {
            const words = r.text.split(/\s+/).length;
            const preview = r.text.length > ATTACHMENT_LIMITS.documentPreviewChars ? `${r.text.slice(0, ATTACHMENT_LIMITS.documentPreviewChars)}…` : r.text;
            lines.push(`- Document "${r.name}" — attachmentId ${r.id}, ${words} words. It reads:\n<<<\n${preview}\n>>>`);
        }
    }
    return lines.join('\n');
}

/** An attached document's words, for placing on a page. Only this organisation's. */
export async function attachmentText(db: Db, orgId: number, attachmentId: number): Promise<string | null> {
    const [row] = await db.select({ text: chatAttachments.text }).from(chatAttachments)
        .where(and(eq(chatAttachments.id, attachmentId), eq(chatAttachments.organisationId, orgId), eq(chatAttachments.kind, 'document'))).limit(1);
    return row?.text ?? null;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * Words the assistant quoted from the owner's own chat message — accepted only if they really are
 * in one of the owner's messages in that conversation (whitespace aside). Returns the owner's text.
 */
export async function quoteFromChat(db: Db, orgId: number, sessionId: number, quote: string): Promise<string | null> {
    const q = squash(quote);
    if (q.length < 3) return null;
    const [session] = await db.select({ id: chatSessions.id }).from(chatSessions)
        .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.organisationId, orgId))).limit(1);
    if (!session) return null;
    const mine = await db.select({ content: chatMessages.content }).from(chatMessages)
        .where(and(eq(chatMessages.chatSessionId, sessionId), eq(chatMessages.role, 'user')));
    return mine.some((m) => squash(m.content).includes(q)) ? quote.trim() : null;
}
