// src/utils/chat-audience.ts
// The Email Marketing chat's view of, and hands on, the shared Audience: what is in it (read per
// turn), a rule-based segment built from the user's words, and one contact added by hand.
//
// ── Why ──────────────────────────────────────────────────────────────────────────────────────────
// Every capability is meant to be reachable from the GUI and from chat, through the same server
// action. The Audience page could add contacts and build segments; the chat was told it could not
// even see how many subscribers there were, so "how many people are on my list?" and "make me a
// segment of people who joined this month" both ended at "go to the Audience page".
//
// ── How ──────────────────────────────────────────────────────────────────────────────────────────
// Same contract as chat-email-action.ts: the model never acts. It proposes an
// `audience_segment_proposal` or an `audience_contact_proposal`; this module checks the proposal
// against the organisation's own rows and rebuilds the card from them. The click calls the Audience
// page's own endpoints (audience-segments `create`, audience-contacts `create`), so their gates —
// write role, rule validation, the never-resurrect status rule — apply unchanged.
//
//   • A segment card shows the rule in plain English and how many SUBSCRIBED people it matches
//     right now — the same compiler as the page's rule builder (audience-segment-preview.ts).
//   • A contact card is refused outright for anyone already in the audience, anyone who has
//     unsubscribed, bounced, complained or been suppressed, and any address whose opt-out was kept
//     when they were deleted (THE DELETE RULE, audience-contacts.ts). Otherwise it asks the user to
//     confirm the person agreed to hear from them before the button works.
//
// CSV import stays on the Audience page, deliberately: it needs a file and a recorded declaration.
//
// ⚠️ Never throws.

import { and, asc, eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import {
    audienceContactSegments, audienceContacts, audienceCustomFields, audienceForms, audienceSegments, leadOptOuts,
} from '../../db/schema';
import { looksLikeEmail, normaliseEmail } from './audience-contacts';
import { describeRules, parseRules, type SegmentRules } from './audience-segment-rules';
import { previewSegmentRules } from './audience-segment-preview';

type Db = ReturnType<typeof getDb>;

export const AUDIENCE_SEGMENT_PROPOSAL_TYPE = 'audience_segment_proposal';
export const AUDIENCE_CONTACT_PROPOSAL_TYPE = 'audience_contact_proposal';

/** Listed items per section. Counts are never capped. */
const LIST_LIMIT = 30;
const NAME_MAX = 80;
const PERSON_MAX = 120;

// ── The snapshot ─────────────────────────────────────────────────────────────────────────────────

const TERMINAL = ['unsubscribed', 'bounced', 'complained', 'suppressed'] as const;

/**
 * The audience as the chat may describe it: counts by status, segments and tags (with #ids, so a
 * proposal can name one), sign-up forms and custom fields (so a rule can refer to them). Null on
 * failure — the prompt then says it cannot see the audience rather than guessing.
 */
export async function buildAudienceSnapshot(db: Db, organisationId: number): Promise<string | null> {
    try {
        const statusRows = await db.select({ status: audienceContacts.status, n: sql<number>`count(*)::int` })
            .from(audienceContacts).where(eq(audienceContacts.organisationId, organisationId))
            .groupBy(audienceContacts.status);
        const by = new Map(statusRows.map((r) => [r.status, Number(r.n) || 0]));
        const total = [...by.values()].reduce((a, b) => a + b, 0);
        const blocked = TERMINAL.reduce((a, s) => a + (by.get(s) ?? 0), 0) - (by.get('unsubscribed') ?? 0);

        const segs = await db.select({
            id: audienceSegments.id, name: audienceSegments.name, kind: audienceSegments.kind, rules: audienceSegments.rules,
            subscribed: sql<number>`(SELECT count(*)::int FROM ${audienceContactSegments} cs
                JOIN ${audienceContacts} c ON c.id = cs.contact_id
                WHERE cs.segment_id = ${audienceSegments.id} AND c.status = 'subscribed')`,
        }).from(audienceSegments).where(eq(audienceSegments.organisationId, organisationId)).orderBy(asc(audienceSegments.name));

        const forms = await db.select({ id: audienceForms.id, name: audienceForms.name })
            .from(audienceForms).where(eq(audienceForms.organisationId, organisationId)).orderBy(asc(audienceForms.name));
        const fields = await db.select({ key: audienceCustomFields.key, label: audienceCustomFields.label })
            .from(audienceCustomFields).where(eq(audienceCustomFields.organisationId, organisationId)).orderBy(asc(audienceCustomFields.label));

        const formNames = new Map(forms.map((f) => [f.id, f.name]));
        const tagNames = new Map(segs.map((s) => [s.id, s.name]));
        const fieldLabels = new Map(fields.map((f) => [f.key, f.label]));
        const list = <T>(rows: T[], line: (r: T) => string, none: string) => rows.length
            ? rows.slice(0, LIST_LIMIT).map((r) => `- ${line(r)}`).join('\n') + (rows.length > LIST_LIMIT ? `\n- …and ${rows.length - LIST_LIMIT} more` : '')
            : none;

        const segments = segs.filter((s) => s.kind !== 'tag');
        const tags = segs.filter((s) => s.kind === 'tag');
        return `YOUR AUDIENCE — the business's subscribers on the Audience page, shared by every assistant. Read just now.
Contacts: ${by.get('subscribed') ?? 0} subscribed (can be emailed), ${by.get('pending') ?? 0} awaiting confirmation, ${by.get('unsubscribed') ?? 0} unsubscribed, ${blocked} bounced, marked as spam or suppressed — ${total} in total.

Segments (each with its #id):
${list(segments, (s) => s.kind === 'dynamic'
        ? `#${s.id} "${s.name}" — rule-based: ${describeRules(s.rules, formNames, tagNames, fieldLabels)}`
        : `#${s.id} "${s.name}" — hand-picked, ${Number(s.subscribed) || 0} subscribed`, 'None yet.')}

Tags (each with its #id):
${list(tags, (t) => `#${t.id} "${t.name}" — ${Number(t.subscribed) || 0} subscribed`, 'None yet.')}

Sign-up forms (each with its #id):
${list(forms, (f) => `#${f.id} "${f.name}"`, 'None yet.')}

Custom fields (label, then the key a rule uses):
${list(fields, (f) => `${f.label} — key "${f.key}"`, 'None yet.')}`;
    } catch (err) {
        console.error('[chat-audience] could not read the audience (non-fatal)', err);
        return null;
    }
}

// ── Segment proposal ─────────────────────────────────────────────────────────────────────────────

export interface SegmentProposalRequest { name: string; rules: unknown }

/** Shape check on the model's output. Pure. Null when it is not a usable proposal. */
export function segmentProposalFromUiElement(uiElement: unknown): SegmentProposalRequest | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== AUDIENCE_SEGMENT_PROPOSAL_TYPE) return null;
    const name = typeof ui.name === 'string' ? ui.name.replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) : '';
    if (!name || !ui.rules || typeof ui.rules !== 'object') return null;
    return { name, rules: ui.rules };
}

export interface SegmentProposalCard {
    type: typeof AUDIENCE_SEGMENT_PROPOSAL_TYPE;
    name: string;
    /** The validated rule set the click saves — never the model's raw object. */
    rules: SegmentRules | null;
    description: string | null;
    /** Subscribed people the rule matches right now. */
    matches: number | null;
    blocked: string | null;
    settled?: boolean;
}

async function segmentNameTaken(db: Db, organisationId: number, name: string): Promise<boolean> {
    const [row] = await db.select({ id: audienceSegments.id }).from(audienceSegments)
        .where(and(eq(audienceSegments.organisationId, organisationId), sql`lower(${audienceSegments.name}) = lower(${name})`))
        .limit(1);
    return !!row;
}

/** Validate the rule against this organisation's data and count who it matches. Null on a DB failure. */
export async function resolveSegmentProposal(db: Db, organisationId: number, req: SegmentProposalRequest): Promise<SegmentProposalCard | null> {
    try {
        const card: SegmentProposalCard = {
            type: AUDIENCE_SEGMENT_PROPOSAL_TYPE, name: req.name, rules: null, description: null, matches: null, blocked: null,
        };
        const preview = await previewSegmentRules(db, organisationId, req.rules);
        if (!preview.ok) { card.blocked = preview.error; return card; }
        const parsed = parseRules(req.rules);
        card.rules = parsed.ok ? parsed.rules : null;
        card.description = preview.description;
        card.matches = preview.matches;
        if (await segmentNameTaken(db, organisationId, req.name)) {
            card.blocked = `You already have a segment called “${req.name}”. Ask again with a different name.`;
        }
        return card;
    } catch (err) {
        console.error('[chat-audience] could not resolve the segment proposal (non-fatal)', err);
        return null;
    }
}

// ── Contact proposal ─────────────────────────────────────────────────────────────────────────────

export interface ContactProposalRequest {
    email: string;
    firstName: string | null;
    lastName: string | null;
    company: string | null;
    segmentId: number | null;
}

/** Shape check on the model's output. Pure. Null when it is not a usable proposal. */
export function contactProposalFromUiElement(uiElement: unknown): ContactProposalRequest | null {
    if (!uiElement || typeof uiElement !== 'object') return null;
    const ui = uiElement as Record<string, unknown>;
    if (ui.type !== AUDIENCE_CONTACT_PROPOSAL_TYPE) return null;
    const email = normaliseEmail(typeof ui.email === 'string' ? ui.email : '');
    if (!email) return null;
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, PERSON_MAX) : null);
    const seg = Number(String(ui.segmentId ?? '').replace(/^#/, ''));
    return {
        email,
        firstName: text(ui.firstName),
        lastName: text(ui.lastName),
        company: text(ui.company),
        segmentId: Number.isInteger(seg) && seg > 0 ? seg : null,
    };
}

export interface ContactProposalCard {
    type: typeof AUDIENCE_CONTACT_PROPOSAL_TYPE;
    email: string;
    firstName: string | null;
    lastName: string | null;
    company: string | null;
    segmentId: number | null;
    segmentName: string | null;
    blocked: string | null;
    settled?: boolean;
}

const ALREADY: Record<string, string> = {
    subscribed: 'is already in your audience, subscribed.',
    pending: 'is already in your audience, waiting to confirm their sign-up.',
    unsubscribed: 'unsubscribed. Only they can choose to hear from you again, so they can’t be added back from here.',
    bounced: 'is an address emails bounce from, so it can’t be added back.',
    complained: 'marked one of your emails as spam, so they can’t be added back.',
    suppressed: 'is on your suppression list, so they can’t be added back.',
};

/** Why this address can't be added, or null when it can. Throws on a DB failure. */
async function contactBlock(db: Db, organisationId: number, email: string): Promise<string | null> {
    const [existing] = await db.select({ status: audienceContacts.status }).from(audienceContacts)
        .where(and(eq(audienceContacts.organisationId, organisationId), eq(audienceContacts.email, email))).limit(1);
    if (existing) return `${email} ${ALREADY[existing.status] ?? 'is already in your audience.'}`;
    // THE DELETE RULE keeps an opt-out after the contact row is gone.
    const [optOut] = await db.select({ id: leadOptOuts.id }).from(leadOptOuts)
        .where(and(eq(leadOptOuts.organisationId, organisationId), eq(leadOptOuts.email, email))).limit(1);
    if (optOut) return `${email} asked not to be contacted, so they can’t be added from here.`;
    return null;
}

/** Check the person against the audience and the opt-out list. Null on a DB failure. */
export async function resolveContactProposal(db: Db, organisationId: number, req: ContactProposalRequest): Promise<ContactProposalCard | null> {
    try {
        const card: ContactProposalCard = {
            type: AUDIENCE_CONTACT_PROPOSAL_TYPE, email: req.email, firstName: req.firstName, lastName: req.lastName,
            company: req.company, segmentId: null, segmentName: null, blocked: null,
        };
        if (!looksLikeEmail(req.email)) { card.blocked = `“${req.email}” isn’t a valid email address.`; return card; }
        if (req.segmentId) {
            // Hand-picked segments and tags only: a rule-based segment has no members to add to.
            const [seg] = await db.select({ id: audienceSegments.id, name: audienceSegments.name, kind: audienceSegments.kind })
                .from(audienceSegments)
                .where(and(eq(audienceSegments.id, req.segmentId), eq(audienceSegments.organisationId, organisationId))).limit(1);
            if (seg && seg.kind !== 'dynamic') { card.segmentId = seg.id; card.segmentName = seg.name; }
        }
        card.blocked = await contactBlock(db, organisationId, req.email);
        return card;
    } catch (err) {
        console.error('[chat-audience] could not resolve the contact proposal (non-fatal)', err);
        return null;
    }
}

// ── Stored cards ─────────────────────────────────────────────────────────────────────────────────

/** Re-check every stored audience card in a transcript. Mutates nothing it is given. */
export async function refreshAudienceCards<M extends { uiElement: unknown }>(db: Db, organisationId: number, messages: M[]): Promise<M[]> {
    return Promise.all(messages.map(async (m) => {
        const ui = m.uiElement as Record<string, unknown> | null;
        if (!ui || (ui.type !== AUDIENCE_SEGMENT_PROPOSAL_TYPE && ui.type !== AUDIENCE_CONTACT_PROPOSAL_TYPE)) return m;
        try {
            if (ui.type === AUDIENCE_SEGMENT_PROPOSAL_TYPE) {
                const name = String(ui.name || '');
                if (name && await segmentNameTaken(db, organisationId, name)) {
                    return { ...m, uiElement: { ...ui, settled: true, blocked: `A segment called “${name}” now exists — it’s on the Audience page.` } };
                }
                if (ui.rules && !ui.blocked) {
                    const preview = await previewSegmentRules(db, organisationId, ui.rules);
                    return { ...m, uiElement: preview.ok ? { ...ui, matches: preview.matches, description: preview.description } : { ...ui, settled: true, blocked: preview.error } };
                }
                return m;
            }
            const email = normaliseEmail(String(ui.email || ''));
            const block = email ? await contactBlock(db, organisationId, email) : null;
            return block ? { ...m, uiElement: { ...ui, settled: true, blocked: block } } : m;
        } catch (err) {
            console.error('[chat-audience] could not refresh a stored card (non-fatal)', err);
            return m;
        }
    }));
}
