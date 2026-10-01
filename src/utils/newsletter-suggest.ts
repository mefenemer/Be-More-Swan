// src/utils/newsletter-suggest.ts
// "Ask your assistant to suggest" for an email's SUBJECT LINE and PREVIEW LINE — the Swan icon beside
// each field in the Email Studio. Returns three options for the person to choose from; nothing is
// written to the email until they pick one (the editor's autosave does that).
//
// Written from the email's own words: a subject that promises what the body does not deliver is the
// fastest way to an unsubscribe, so the body is the brief — and the other field is passed too, so a
// preview line ADDS to the subject rather than repeating it.

import Anthropic from '@anthropic-ai/sdk';
import { and, eq } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { newsletterIssues, organisations } from '../../db/schema';
import { logAiUsage } from './ai-usage';
import { parseModelJson } from './model-json';
import { loadAssistantVoice, MAX_PREHEADER_CHARS, MAX_SUBJECT_CHARS, NEWSLETTER_MODEL, scrubMergeTags } from './newsletter-generate';
import { purposePromptBlock } from '../config/newsletter-purposes';

type Db = ReturnType<typeof getDb>;

export type SuggestField = 'subject' | 'preheader';

export async function suggestEmailLine(
    db: Db,
    opts: { issueId: number; organisationId: number; userId: number; field: SuggestField; current?: { subject?: string; preheader?: string; body?: string } },
): Promise<string[]> {
    const [issue] = await db.select({
        subject: newsletterIssues.subject, preheader: newsletterIssues.preheader, bodyMarkdown: newsletterIssues.bodyMarkdown,
        purpose: newsletterIssues.purpose, assistantId: newsletterIssues.assistantId,
    }).from(newsletterIssues)
        .where(and(eq(newsletterIssues.id, opts.issueId), eq(newsletterIssues.organisationId, opts.organisationId))).limit(1);
    if (!issue) throw new Error('Email not found.');

    // What is on screen wins over what was last saved — the person may have typed in the last second.
    const subject = (opts.current?.subject ?? issue.subject ?? '').slice(0, 200);
    const preheader = (opts.current?.preheader ?? issue.preheader ?? '').slice(0, 200);
    const body = (opts.current?.body ?? issue.bodyMarkdown ?? '').slice(0, 6000);
    if (!body.trim()) throw new Error('Write the email first — the suggestions are based on what it says.');

    const { tone, assistantPrompt } = await loadAssistantVoice(db, issue.assistantId, opts.organisationId);
    const [org] = await db.select({ name: organisations.name }).from(organisations).where(eq(organisations.id, opts.organisationId)).limit(1);
    const purpose = purposePromptBlock(issue.purpose);

    const ask = opts.field === 'subject'
        ? `Suggest 3 SUBJECT LINES for this email. Each under 60 characters, specific to what the email actually says, in a ${tone} tone. No clickbait, no ALL CAPS, no "Re:" or "Fwd:", at most one emoji and only if it suits the tone. Make the three genuinely different: one plain and direct, one that leads with the benefit to the reader, one that sparks curiosity without misleading.${preheader ? ` The preview line is: "${preheader}" — do not repeat it.` : ''}`
        : `Suggest 3 PREVIEW LINES (the grey text inboxes show beside the subject) for this email. Each one sentence, under ${Math.min(110, MAX_PREHEADER_CHARS)} characters, in a ${tone} tone, that ADDS to the subject rather than repeating it — a detail, a reason to open, or what is inside.${subject ? ` The subject is: "${subject}".` : ''}`;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const res = await anthropic.messages.create({
        model: NEWSLETTER_MODEL,
        max_tokens: 400,
        system: [
            `You write email ${opts.field === 'subject' ? 'subject lines' : 'preview lines'} for ${org?.name || 'a small business'}.`,
            assistantPrompt ? `Voice guidance: ${assistantPrompt}` : '',
            purpose,
            'Never invent facts, numbers, prices, dates or offers that the email does not contain.',
            'Return ONLY JSON: {"suggestions": ["…", "…", "…"]}',
        ].filter(Boolean).join('\n\n'),
        messages: [{ role: 'user', content: `${ask}\n\nTHE EMAIL:\n${body}` }],
    });
    void logAiUsage({
        userId: opts.userId, workspaceId: opts.organisationId, model: NEWSLETTER_MODEL,
        inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0,
    });
    const raw = (res.content[0] as { text?: string })?.text ?? '';
    const parsed = parseModelJson<{ suggestions?: unknown }>(raw);
    const max = opts.field === 'subject' ? MAX_SUBJECT_CHARS : MAX_PREHEADER_CHARS;
    const list = (Array.isArray(parsed?.suggestions) ? parsed!.suggestions : [])
        .map((x) => scrubMergeTags(String(x ?? '').replace(/[\r\n]+/g, ' ').trim()).text.slice(0, max))
        .filter(Boolean);
    if (!list.length) throw new Error('The assistant did not come back with suggestions — try again.');
    return [...new Set(list)].slice(0, 3);
}
