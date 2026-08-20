// src/utils/newsletter-generate.ts
// Drafting core for the Newsletter Assistant — the mirror of src/utils/blog-generate.ts, and
// deliberately so: same blueprint guardrails, same inspo styling, same date block, same usage
// logging, same "stamp the provenance marker in the write that stamps the body" rule.
//
// Session-decoupled like blog-generate: the caller passes an organisationId it has already
// established, so both the interactive handler and (later) the autopilot cron can use it.
//
// ── What is DIFFERENT from a blog post ──────────────────────────────────────────────────────────
//  • Three fields, not one. A newsletter needs a subject line and a preheader as much as a body,
//    and asking a second time for them costs another model call and lets them drift from the copy.
//  • Merge tags. The model writes {{contact.first_name | "there"}}; the send worker resolves it per
//    recipient. The vocabulary is closed (src/config/newsletter-merge-vars.ts) and anything outside
//    it is stripped before a human ever sees the draft — a literal "{{first name}}" reaching an
//    inbox is the failure this prevents.
//  • No footer, ever. The unsubscribe line and the postal address are appended IN CODE at the send
//    site. Same rule as src/config/outreach-footer.ts, for the same two reasons: a model paraphrases
//    or drops it, and a reviewer editing the draft deletes it without knowing what it is.

import Anthropic from '@anthropic-ai/sdk';
import { and, eq, sql } from 'drizzle-orm';
import type { getDb } from '../../db/client';
import { aiAssistants, newsletterIssues, organisations } from '../../db/schema';
import { logAiUsage } from './ai-usage';
import { buildInspoBlock } from './inspo-profile';
import { currentDatePromptBlock } from './current-date-prompt';
import { resolvePostingSchedule } from '../config/posting-cadence';
import { buildBlueprintGuardrailsBlock, DEFAULT_TONE, str } from './blog-generate';
import { parseModelJson, salvageStringField } from './model-json';
import { validateMergeVars } from './email-template';
import {
    GREETING_EXAMPLE, NEWSLETTER_MERGE_KEYS, NEWSLETTER_MERGE_VARS, applyDefaultFallbacks,
} from '../config/newsletter-merge-vars';

type Db = ReturnType<typeof getDb>;

/**
 * Same tier as the blog drafter (BLOG_MODEL) on purpose — an issue is long-form copy in the
 * workspace's voice, and two content surfaces drafting at different quality levels is a difference
 * a customer would see and could not explain. Raise both together or neither.
 */
export const NEWSLETTER_MODEL = 'claude-haiku-4-5-20251001';

/** Marks a draft as machine-written, for the AI transparency badge and the review queue. */
export const NEWSLETTER_DRAFT_REASON = 'assistant_draft';

export const MAX_SUBJECT_CHARS = 120;
export const MAX_PREHEADER_CHARS = 160;

export interface GenerateIssueOptions {
    issueId: number;
    organisationId: number;
    /** Whose AI usage this run is billed to. */
    userId: number;
    topic?: string;
    notes?: string;
    /** Fallback voice, used only when the authoring assistant has no tone_of_voice of its own. */
    tone?: string;
}

export interface GenerateIssueResult {
    subject: string;
    preheader: string;
    bodyMarkdown: string;
    tone: string;
    /** Problems worth showing the human reviewer. Never fatal — a draft is still a draft. */
    warnings: string[];
}

export class IssueNotFoundError extends Error {
    constructor(id: number) {
        super(`Newsletter issue ${id} not found in this organisation.`);
        this.name = 'IssueNotFoundError';
    }
}

/**
 * Strip merge tags the send worker cannot resolve, and report them.
 *
 * Two failures, both silent: an unknown-but-well-formed tag renders as an empty string and the
 * sentence quietly loses a word; a malformed one ships the literal braces to the inbox. Neither is
 * worth failing a draft over — but neither may reach a recipient, so they are removed here and
 * surfaced to the reviewer instead.
 */
export function scrubMergeTags(text: string): { text: string; warnings: string[] } {
    if (!text) return { text: '', warnings: [] };
    const { unknown, malformed } = validateMergeVars(text, NEWSLETTER_MERGE_KEYS);
    let out = text;
    const warnings: string[] = [];

    for (const key of unknown) {
        out = out.replace(new RegExp(`\\{\\{\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(\\|[^}]*)?\\}\\}`, 'g'), '');
        warnings.push(`Removed an unsupported personalisation tag: {{${key}}}`);
    }
    for (const bad of malformed) {
        if (bad === '{{') {
            out = out.replace(/\{\{(?![^{}]*\}\})/g, '');
            warnings.push('Removed an unfinished personalisation tag.');
            continue;
        }
        out = out.split(bad).join('');
        warnings.push(`Removed a personalisation tag we could not read: ${bad}`);
    }
    // Whatever survives gets its declared fallback, so the editor shows what a nameless
    // subscriber will actually read.
    return { text: applyDefaultFallbacks(out), warnings };
}

/**
 * Draft one issue and save it to newsletter_issues.
 *
 * Throws IssueNotFoundError when the issue doesn't exist in `organisationId`, and a plain Error
 * when the model returns nothing usable. Callers translate those into their own failure shape.
 */
export async function generateIssueBody(db: Db, opts: GenerateIssueOptions): Promise<GenerateIssueResult> {
    const { issueId, organisationId, userId } = opts;
    const topic = str(opts.topic, 300);
    const notes = str(opts.notes, 4000);

    const [issue] = await db
        .select({
            id: newsletterIssues.id,
            subject: newsletterIssues.subject,
            assistantId: newsletterIssues.assistantId,
            scheduledFor: newsletterIssues.scheduledFor,
        })
        .from(newsletterIssues)
        .where(and(eq(newsletterIssues.id, issueId), eq(newsletterIssues.organisationId, organisationId)))
        .limit(1);
    if (!issue) throw new IssueNotFoundError(issueId);

    let tone = str(opts.tone, 200);
    let assistantPrompt = '';
    let timezone = resolvePostingSchedule(null).timezone;
    if (issue.assistantId) {
        const [assistant] = await db
            .select({ onboardingContext: aiAssistants.onboardingContext, systemPrompt: aiAssistants.systemPrompt })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, issue.assistantId), eq(aiAssistants.organisationId, organisationId)))
            .limit(1);
        const actx = (assistant?.onboardingContext as Record<string, unknown> | null) ?? {};
        if (typeof actx.tone_of_voice === 'string' && actx.tone_of_voice.trim()) tone = actx.tone_of_voice.trim();
        if (assistant?.systemPrompt) assistantPrompt = assistant.systemPrompt.slice(0, 2000);
        timezone = resolvePostingSchedule(actx).timezone;
    }
    if (!tone) tone = DEFAULT_TONE;

    const [org] = await db
        .select({
            name: organisations.name,
            businessDescription: organisations.businessDescription,
            targetAudience: organisations.targetAudience,
        })
        .from(organisations)
        .where(eq(organisations.id, organisationId))
        .limit(1);

    const brief = [
        issue.subject ? `Working title: ${issue.subject}` : '',
        topic ? `This issue is about: ${topic}` : '',
        org?.targetAudience ? `Audience: ${org.targetAudience}` : '',
        org?.businessDescription ? `Business context: ${org.businessDescription}` : '',
        notes ? `Source material / author notes:\n${notes}` : '',
    ].filter(Boolean).join('\n');

    const inspoBlock = issue.assistantId
        ? await buildInspoBlock(db, {
            assistantId: issue.assistantId,
            organisationId,
            topic: [issue.subject, topic].filter(Boolean).join(' — '),
        })
        : null;

    const guardrailsBlock = issue.assistantId
        ? await buildBlueprintGuardrailsBlock(db, {
            assistantId: issue.assistantId,
            organisationId,
            compiledBy: String(userId),
        })
        : null;

    const varList = NEWSLETTER_MERGE_VARS.map((v) => `{{${v.key}}} (${v.label})`).join(', ');

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
        model: NEWSLETTER_MODEL,
        max_tokens: 2000,
        system:
            // Leads the prompt, exactly as on the blog and social paths: an email that opens
            // "as we head into 2025" is visible in every inbox and dates the whole product.
            `${currentDatePromptBlock({ publishDate: issue.scheduledFor, timezone })}\n\n` +
            `You are writing an email newsletter${org?.name ? ` for ${org.name}` : ''}, sent to people who ` +
            `subscribed to hear from them. Write in a ${tone} tone.\n` +
            (assistantPrompt ? `Voice guidance: ${assistantPrompt}\n` : '') +
            'Return ONLY a JSON object with exactly these keys:\n' +
            '  "subject"    — the subject line. Under 60 characters, specific, no clickbait, no emoji spam.\n' +
            '  "preheader"  — the inbox preview line. One sentence that ADDS to the subject rather than repeating it.\n' +
            '  "bodyMarkdown" — the email body in Markdown: a short greeting, 2–4 short sections with ' +
            '## subheadings, and a clear closing line. No H1 — the subject line is the title. ' +
            'Keep it to what someone will actually read in an inbox: roughly 200–400 words.\n\n' +
            `You may personalise using these tags, written exactly as shown: ${varList}. ` +
            `Always give a name tag a fallback, like ${GREETING_EXAMPLE}, so a subscriber whose name ` +
            'we do not hold still reads a natural sentence. Use no other tags.\n' +
            // The two things a drafting model reliably adds unasked, both of which are wrong here.
            'Do NOT write an unsubscribe line, a footer, a postal address, or any "you are receiving ' +
            'this because…" text — those are added automatically and would appear twice.\n' +
            'Do NOT invent statistics, customer numbers, testimonials, prices or dates. If the brief ' +
            'does not supply a fact, write around it.' +
            (guardrailsBlock ? `\n\n${guardrailsBlock}` : '') +
            (inspoBlock ? `\n\n${inspoBlock}` : ''),
        messages: [{ role: 'user', content: brief }],
    });

    const raw = (response.content[0] as { text?: string })?.text?.trim() ?? '';
    if (!raw) throw new Error('Empty draft.');

    void logAiUsage({
        userId, workspaceId: organisationId, model: NEWSLETTER_MODEL,
        inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0,
    });

    const parsed = parseModelJson<{ subject?: string; preheader?: string; bodyMarkdown?: string }>(raw);
    // A model that wrapped the JSON badly still wrote a usable body; salvage it rather than
    // charging the customer for a run they cannot use.
    const bodyRaw = str(parsed?.bodyMarkdown, 20000) || str(salvageStringField(raw, 'bodyMarkdown'), 20000);
    if (!bodyRaw) throw new Error('The draft came back in a form we could not read. Try again.');

    const body = scrubMergeTags(bodyRaw);
    const subject = scrubMergeTags(str(parsed?.subject, MAX_SUBJECT_CHARS) || issue.subject || 'Your newsletter');
    const preheader = scrubMergeTags(str(parsed?.preheader, MAX_PREHEADER_CHARS));

    const warnings = [...new Set([...subject.warnings, ...preheader.warnings, ...body.warnings])];

    await db.update(newsletterIssues)
        .set({
            subject: subject.text,
            preheader: preheader.text || null,
            bodyMarkdown: body.text,
            // COALESCE, not a plain set: an autopilot run stamps its own, more specific reason
            // before calling this. First writer wins — same rule as blog-generate.ts.
            generationReason: sql`COALESCE(${newsletterIssues.generationReason}, ${NEWSLETTER_DRAFT_REASON})`,
            updatedAt: new Date(),
        })
        .where(and(eq(newsletterIssues.id, issueId), eq(newsletterIssues.organisationId, organisationId)));

    return { subject: subject.text, preheader: preheader.text, bodyMarkdown: body.text, tone, warnings };
}
