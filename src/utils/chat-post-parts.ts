// src/utils/chat-post-parts.ts — the two cards behind "Select" in the social post editor's docked chat
// (owner 2026-11-05). A selected caption needs no card of its own: it comes back as the ordinary
// suggested caption. These cover the other two parts:
//
//   post_text_edit — one text box on the picture, shown before and after; "Use this" swaps its words.
//   post_picture   — a new picture or video for the post. The chat cannot make or place one, so the card
//                    opens the editor's own picture step with the description filled in: the same search,
//                    the same Generate button and the same task charge as doing it by hand.
//
// Both act through the editor, on a click, and only while that post is open (workspace.html). Checked and
// rebuilt here because uiElementJson is stored and re-rendered on every reload. tests/post-chat-pane.test.ts.

export const POST_TEXT_EDIT_TYPE = 'post_text_edit';
export const POST_PICTURE_TYPE = 'post_picture';

const MAX_TEXT_CHARS = 500;
const MAX_DESCRIPTION_CHARS = 300;

export interface PostTextEditCard { type: typeof POST_TEXT_EDIT_TYPE; postId: number; find: string; replace: string; summary: string | null }
export interface PostPictureCard { type: typeof POST_PICTURE_TYPE; postId: number; kind: 'image' | 'video'; description: string }
export type PostPartCard = PostTextEditCard | PostPictureCard;

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function postPartCardFromUiElement(uiElement: unknown): PostPartCard | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== POST_TEXT_EDIT_TYPE && ui.type !== POST_PICTURE_TYPE) return null;
    const postId = Number(String(ui.postId ?? '').replace(/^#/, ''));
    if (!Number.isInteger(postId) || postId <= 0) return null;
    if (ui.type === POST_PICTURE_TYPE) {
        return { type: POST_PICTURE_TYPE, postId, kind: ui.kind === 'video' ? 'video' : 'image', description: str(ui.description, MAX_DESCRIPTION_CHARS) };
    }
    const find = str(ui.find, MAX_TEXT_CHARS);
    const replace = str(ui.replace, MAX_TEXT_CHARS);
    if (!find || !replace) return null;
    return { type: POST_TEXT_EDIT_TYPE, postId, find, replace, summary: str(ui.summary, 300) || null };
}
