// src/config/mentor-playbooks/index.ts
// Playbooks by kind of business (docs/business-mentor-plan.md §4.6, adopted §15.2 item 9): for each
// offer-profile kind in Business Information (src/utils/offer-profile.ts OFFER_KINDS), a short,
// human-reviewed, SOURCED playbook — what good looks like, the usual first 90 days, common mistakes and
// the measures that matter. The Mentor coaches from the playbook for the workspace's kind rather than
// from general knowledge.
//
// Reviewed content, like help articles: each playbook is a DATED file in this folder, and a change is a
// new dated file, never an edit in place. ⚠️ The Mentor uses a playbook ONLY once a person has reviewed
// it: `reviewed` stays null until the owner signs it off (name and date). An unreviewed playbook is never
// put in a prompt and never shown as "the playbook I'm using". The Mentor never writes or changes one.
//
// Shown on the Mentor's Plan tab ("The playbook I'm using") so the GUI rule holds (§14).

import type { OfferKind } from '../../utils/offer-profile';
import { SERVICES_PLAYBOOK_2026_10_25 } from './2026-10-25-services';
import { PRODUCTS_PLAYBOOK_2026_10_25 } from './2026-10-25-products';

export interface PlaybookSource { title: string; url: string }
/** One point, with the sources it rests on. A point with no source is the reviewer's own judgement and says so. */
export interface PlaybookPoint { text: string; sources: PlaybookSource[]; judgement?: boolean }

export interface Playbook {
    kind: OfferKind;
    title: string;
    /** The dated file's date (YYYY-MM-DD). The newest reviewed one for a kind is used. */
    dated: string;
    /** Null until a person has reviewed it. Until then the Mentor must not use it. */
    reviewed: { by: string; on: string } | null;
    whatGoodLooksLike: PlaybookPoint[];
    first90Days: PlaybookPoint[];
    commonMistakes: PlaybookPoint[];
    measures: PlaybookPoint[];
}

export const PLAYBOOKS: readonly Playbook[] = [SERVICES_PLAYBOOK_2026_10_25, PRODUCTS_PLAYBOOK_2026_10_25];

/** Pure: is this playbook usable? Reviewed by a named person on a date, and every point either sourced or marked as judgement. */
export function isUsablePlaybook(p: Playbook): boolean {
    if (!p.reviewed || !p.reviewed.by.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(p.reviewed.on)) return false;
    const points = [...p.whatGoodLooksLike, ...p.first90Days, ...p.commonMistakes, ...p.measures];
    return points.length > 0 && points.every((x) => x.judgement || x.sources.length > 0);
}

export interface PlaybookChoice {
    /** The reviewed playbook the Mentor coaches from, or null. */
    inUse: Playbook | null;
    /** The workspace's kinds that have a playbook still waiting for review (shown, never used). */
    awaitingReview: OfferKind[];
}

/** Pure: the playbook for this workspace — the first of its offer kinds with a reviewed one. */
export function playbookFor(offerKinds: readonly string[] | null | undefined, all: readonly Playbook[] = PLAYBOOKS): PlaybookChoice {
    const kinds = (offerKinds ?? []).filter((k): k is OfferKind => all.some((p) => p.kind === k));
    const newest = (k: OfferKind, usable: boolean) => all.filter((p) => p.kind === k && isUsablePlaybook(p) === usable).sort((a, b) => b.dated.localeCompare(a.dated))[0] ?? null;
    let inUse: Playbook | null = null;
    for (const k of kinds) { inUse = newest(k, true); if (inUse) break; }
    const awaitingReview = kinds.filter((k) => !newest(k, true) && newest(k, false));
    return { inUse, awaitingReview };
}

/** Pure: the prompt block. Only a reviewed playbook is ever rendered. */
export function renderPlaybookForMentor(choice: PlaybookChoice): string[] {
    if (!choice.inUse) {
        return ['PLAYBOOK: none reviewed for this kind of business yet. Coach from the workspace and label general advice as your own judgement. If asked which playbook you use, say there isn’t a reviewed one for their kind of business yet.'];
    }
    const p = choice.inUse;
    const pts = (xs: PlaybookPoint[]) => xs.map((x) => `  - ${x.text}${x.judgement ? ' (reviewer’s judgement)' : x.sources.length ? ` [${x.sources.map((s) => s.url).join(' ; ')}]` : ''}`);
    return [
        `PLAYBOOK IN USE: "${p.title}" (reviewed by ${p.reviewed!.by} on ${p.reviewed!.on}). Coach from it for this business; when you use a point, you may give its link. It is shown on your Plan tab as "The playbook I'm using".`,
        '- What good looks like:', ...pts(p.whatGoodLooksLike),
        '- The usual first 90 days:', ...pts(p.first90Days),
        '- Common mistakes:', ...pts(p.commonMistakes),
        '- The measures that matter:', ...pts(p.measures),
    ];
}
