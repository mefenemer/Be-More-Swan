// src/utils/chat-email-parts.ts — the cards behind the Email Studio's docked chat (owner 2026-11-05):
//
//   email_edit      — one part (the subject, the preview line, or one block's words), before and after.
//   email_block_add — a new button, paragraph or heading, after the part they selected.
//   email_picture   — opens the Studio's own picture chooser for the picture they selected.
//   email_refine    — the whole email, through the Studio's "Ask for the change": a suggestion on screen
//                     that they read and press "Use it" on, exactly as if they had asked there.
//
// Every card acts through the Studio, on a click, and only while that email is open (newsletter.js). Checked
// and rebuilt here because uiElementJson is stored and re-rendered on every reload. A button is added with NO
// link on purpose: models invent URLs, and the canvas already says "No link yet" until the owner gives one.
// tests/email-chat-pane.test.ts.

export const EMAIL_EDIT_TYPE = 'email_edit';
export const EMAIL_BLOCK_ADD_TYPE = 'email_block_add';
export const EMAIL_PICTURE_TYPE = 'email_picture';
export const EMAIL_REFINE_TYPE = 'email_refine';

const MAX_PART_CHARS = 6000;

export interface EmailEditCard { type: typeof EMAIL_EDIT_TYPE; issueId: number; part: 'subject' | 'preheader' | 'block'; find: string; replace: string; summary: string | null }
export interface EmailBlockAddCard { type: typeof EMAIL_BLOCK_ADD_TYPE; issueId: number; kind: 'button' | 'text' | 'heading'; text: string; summary: string | null }
export interface EmailPictureCard { type: typeof EMAIL_PICTURE_TYPE; issueId: number }
export interface EmailRefineCard { type: typeof EMAIL_REFINE_TYPE; issueId: number; instruction: string; summary: string | null }
export type EmailPartCard = EmailEditCard | EmailBlockAddCard | EmailPictureCard | EmailRefineCard;

const TYPES: readonly string[] = [EMAIL_EDIT_TYPE, EMAIL_BLOCK_ADD_TYPE, EMAIL_PICTURE_TYPE, EMAIL_REFINE_TYPE];
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** One of this module's card types, well-formed or not: a half-formed one must not be stored. */
export const isEmailPartType = (t: unknown) => TYPES.includes(String(t));

export function emailPartCardFromUiElement(uiElement: unknown): EmailPartCard | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (!isEmailPartType(ui.type)) return null;
    const issueId = Number(String(ui.issueId ?? '').replace(/^#/, ''));
    if (!Number.isInteger(issueId) || issueId <= 0) return null;
    const summary = str(ui.summary, 300) || null;
    if (ui.type === EMAIL_PICTURE_TYPE) return { type: EMAIL_PICTURE_TYPE, issueId };
    if (ui.type === EMAIL_REFINE_TYPE) {
        const instruction = str(ui.instruction, 500);
        return instruction ? { type: EMAIL_REFINE_TYPE, issueId, instruction, summary } : null;
    }
    if (ui.type === EMAIL_BLOCK_ADD_TYPE) {
        const kind = ui.kind === 'button' || ui.kind === 'heading' ? ui.kind : ui.kind === 'text' ? 'text' : null;
        const text = str(ui.text, kind === 'button' ? 60 : MAX_PART_CHARS);
        return kind && text ? { type: EMAIL_BLOCK_ADD_TYPE, issueId, kind, text, summary } : null;
    }
    const part = ui.part === 'subject' || ui.part === 'preheader' ? ui.part : 'block';
    const limit = part === 'block' ? MAX_PART_CHARS : 200;
    const find = str(ui.find, MAX_PART_CHARS);
    const replace = str(ui.replace, limit);
    return find && replace ? { type: EMAIL_EDIT_TYPE, issueId, part, find, replace, summary } : null;
}
