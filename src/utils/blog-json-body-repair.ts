// src/utils/blog-json-body-repair.ts
// Turn a blog post body that was saved as the Blog Writer's raw layout JSON back into Markdown.
//
// Before d1fd5db4 (2026-09-30), a layout reply that failed to parse whole was saved verbatim as
// body_markdown, so the post read `{"kind": "prose", "markdown": …}` top to bottom. That fix stops
// new ones; this converts the ones already saved. Used by scripts/repair-json-blog-bodies.ts.
//
// Pure — no database. Same parse → salvage → compile path blog-generate now uses, so a repaired
// post reads exactly as it would have had the draft parsed first time, minus two things it cannot
// get back:
//   · PICTURES. The drafter asked for images by description; the original run never sourced them
//     (it never reached the layout branch), so there is no asset to point at and image nodes are
//     dropped — the same rule blog-generate applies to an unresolved picture.
//   · LINKS. blog-generate keeps a link only if its URL appeared in the brief, and the brief is not
//     stored. With nothing to ground against, every link keeps its words and loses its address:
//     an invented URL on a customer's domain is a published 404, a missing link is not.

import { parseModelJson, salvageArrayElements } from './model-json';
import { groundLinks, irToBlogMarkdown, mediaIntents, normaliseLayoutIr, type LayoutIr } from './layout-ir';

/** Same shape test blog-generate uses: opens with `{` (maybe fenced) or carries layout `"kind"` keys. */
export function looksLikeLayoutJson(body: string): boolean {
    const text = String(body ?? '');
    return /^\s*(```[a-z]*\s*)?\{/i.test(text) || /"kind"\s*:\s*"(prose|heading|image)"/.test(text);
}

export interface RepairResult {
    markdown: string;
    /** True when the JSON would not parse whole and only its complete sections were kept. */
    salvaged: boolean;
    droppedImages: number;
    unlinkedLinks: number;
}

export function repairJsonBody(body: string): RepairResult | null {
    if (!looksLikeLayoutJson(body)) return null;

    const parsed = parseModelJson<{ layout?: unknown }>(body);
    let ir: LayoutIr | null = normaliseLayoutIr(parsed?.layout);
    let salvaged = false;
    if (!ir) {
        ir = normaliseLayoutIr(salvageArrayElements(body, 'layout'));
        salvaged = !!ir;
    }
    if (!ir) return null;

    const droppedImages = mediaIntents(ir).length;   // columns included
    const grounded = groundLinks(ir, '');
    const markdown = irToBlogMarkdown(grounded.ir, { assetFor: () => null }).trim();
    if (!markdown || looksLikeLayoutJson(markdown)) return null;

    return { markdown, salvaged, droppedImages, unlinkedLinks: grounded.unlinked + grounded.stripped.length };
}
