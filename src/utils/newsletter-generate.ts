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
    CUSTOM_MERGE_PREFIX, CUSTOM_TAG_NEEDS_FALLBACK, GREETING_EXAMPLE, NEWSLETTER_MERGE_KEYS,
    NEWSLETTER_MERGE_VARS, applyDefaultFallbacks, customMergeKeys,
} from '../config/newsletter-merge-vars';
import { loadCustomFieldDefs } from './audience-custom-fields';
import { purposePromptBlock } from '../config/newsletter-purposes';

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
    /**
     * What this email is FOR — src/config/newsletter-purposes.ts. Overrides the issue's stored
     * purpose when given (the brief dialog can change it on the way in). A terms-change notice and
     * a monthly newsletter are different jobs, and this is the only thing that tells the model so.
     */
    purpose?: string;
    /**
     * A link this issue exists to point at — today, the blog post it was drafted from.
     *
     * ⚠️ APPENDED IN CODE, AND THE MODEL IS TOLD NOT TO WRITE IT. An issue about a post that does
     * not link to the post is the one outcome that makes the whole hand-off pointless, and a
     * drafting model will sometimes paraphrase a URL, truncate it, or invent a prettier one. The
     * same reasoning as the unsubscribe footer: anything that MUST be exactly right is not asked
     * for, it is added.
     */
    sourceLink?: { url: string; title: string } | null;
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
export function scrubMergeTags(text: string, customKeys: readonly string[] = []): { text: string; warnings: string[] } {
    if (!text) return { text: '', warnings: [] };
    const allowed = [...NEWSLETTER_MERGE_KEYS, ...customMergeKeys(customKeys)];
    const { unknown, malformed } = validateMergeVars(text, allowed);
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
    // ⚠️ A CUSTOM TAG WITHOUT A FALLBACK IS REMOVED, not defaulted. applyDefaultFallbacks can only
    // supply the fallbacks declared for the built-ins; there is no honest default for a field
    // called "City", and an empty render produces "our new shop in ." in every inbox where we hold
    // no value. Removing it and saying so is the same treatment an unknown tag gets, for the same
    // reason: the author can see the problem, the subscriber never does.
    let warnedCustom = false;
    for (const key of customMergeKeys(customKeys)) {
        const bare = new RegExp(`\\{\\{\\s*${key.replace(/\./g, '\\.')}\\s*\\}\\}`, 'g');
        // Compared rather than tested: `regex.test()` on a /g/ regex leaves lastIndex behind it,
        // and the next call would start mid-string. Cheap to sidestep, and invisible when wrong.
        const next = out.replace(bare, '');
        if (next === out) continue;
        out = next;
        if (!warnedCustom) { warnings.push(CUSTOM_TAG_NEEDS_FALLBACK); warnedCustom = true; }
    }

    // Whatever survives gets its declared fallback, so the editor shows what a nameless
    // subscriber will actually read.
    return { text: applyDefaultFallbacks(out), warnings };
}

/**
 * Append the "read the full post" line, once, at the end of the body.
 *
 * Refuses anything that is not an http(s) URL: a canonical_url is normally absolute, but a tenant
 * whose blog is served from a path would otherwise get a relative link in an email, where there is
 * no page to be relative to. Better a draft with no link — which a human sees — than one with a
 * link that goes nowhere.
 */
export function appendSourceLink(body: string, link?: { url: string; title: string } | null): string {
    if (!link?.url || !/^https?:\/\//i.test(link.url)) return body;
    if (body.includes(link.url)) return body.trimEnd() + '\n';   // the model wrote it anyway
    // Square brackets in a title would break out of the markdown link and leave visible syntax.
    const label = (link.title || 'Read the full post').replace(/[\[\]]/g, '').trim().slice(0, 120)
        || 'Read the full post';
    return `${body.trimEnd()}\n\n[${label}](${link.url})\n`;
}

/**
 * The authoring assistant's voice: its tone, its system prompt and its timezone.
 *
 * ⚠️ ONE lookup, used by drafting, revising and the welcome sequence. An assistant that sounds like
 * itself in an issue and like a stock model in a welcome email is the kind of inconsistency a
 * customer notices and cannot name.
 */
export async function loadAssistantVoice(
    db: Db,
    assistantId: number | null | undefined,
    organisationId: number,
    fallbackTone = '',
): Promise<{ tone: string; assistantPrompt: string; timezone: string }> {
    let tone = str(fallbackTone, 200);
    let assistantPrompt = '';
    let timezone = resolvePostingSchedule(null).timezone;
    if (assistantId) {
        const [assistant] = await db
            .select({ onboardingContext: aiAssistants.onboardingContext, systemPrompt: aiAssistants.systemPrompt })
            .from(aiAssistants)
            .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.organisationId, organisationId)))
            .limit(1);
        const actx = (assistant?.onboardingContext as Record<string, unknown> | null) ?? {};
        if (typeof actx.tone_of_voice === 'string' && actx.tone_of_voice.trim()) tone = actx.tone_of_voice.trim();
        if (assistant?.systemPrompt) assistantPrompt = assistant.systemPrompt.slice(0, 2000);
        timezone = resolvePostingSchedule(actx).timezone;
    }
    return { tone: tone || DEFAULT_TONE, assistantPrompt, timezone };
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
            purpose: newsletterIssues.purpose,
        })
        .from(newsletterIssues)
        .where(and(eq(newsletterIssues.id, issueId), eq(newsletterIssues.organisationId, organisationId)))
        .limit(1);
    if (!issue) throw new IssueNotFoundError(issueId);

    const { tone, assistantPrompt, timezone } = await loadAssistantVoice(db, issue.assistantId, organisationId, opts.tone);

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

    // The org's own columns, so a draft may personalise on them and the scrub below does not strip
    // what the model was invited to write.
    const customFields = await loadCustomFieldDefs(db, organisationId);
    const customKeys = customFields.map((f) => f.key);
    const varList = [
        ...NEWSLETTER_MERGE_VARS.map((v) => `{{${v.key}}} (${v.label})`),
        ...customFields.map((f) => `{{${CUSTOM_MERGE_PREFIX}${f.key} | "…"}} (${f.label}, and it MUST carry a fallback)`),
    ].join(', ');

    const purposeBlock = purposePromptBlock(opts.purpose ?? issue.purpose);

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
            (opts.sourceLink
                ? 'Do NOT write the link to the post or any "read more" line — the link is added ' +
                  'automatically as the closing line, and yours would be a second, probably wrong copy ' +
                  'of it. Write about what the post says; do not simply summarise it paragraph by ' +
                  'paragraph, because someone who reads both should not read the same thing twice.\n'
                : '') +
            'Do NOT invent statistics, customer numbers, testimonials, prices or dates. If the brief ' +
            'does not supply a fact, write around it.' +
            // ⚠️ AFTER the general rules and BEFORE the guardrails: a purpose narrows the job (a
            // terms notice is not written in newsletter voice), and the blueprint guardrails are
            // the tenant's own constraints, which outrank both.
            (purposeBlock ? `\n\n${purposeBlock}` : '') +
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

    const body = scrubMergeTags(bodyRaw, customKeys);
    // After the scrub, so the URL is never mistaken for a malformed merge tag and stripped.
    const bodyText = appendSourceLink(body.text, opts.sourceLink);
    const subject = scrubMergeTags(str(parsed?.subject, MAX_SUBJECT_CHARS) || issue.subject || 'Your newsletter', customKeys);
    const preheader = scrubMergeTags(str(parsed?.preheader, MAX_PREHEADER_CHARS), customKeys);

    const warnings = [...new Set([...subject.warnings, ...preheader.warnings, ...body.warnings])];

    await db.update(newsletterIssues)
        .set({
            subject: subject.text,
            preheader: preheader.text || null,
            bodyMarkdown: bodyText,
            // COALESCE, not a plain set: an autopilot run stamps its own, more specific reason
            // before calling this. First writer wins — same rule as blog-generate.ts.
            generationReason: sql`COALESCE(${newsletterIssues.generationReason}, ${NEWSLETTER_DRAFT_REASON})`,
            updatedAt: new Date(),
        })
        .where(and(eq(newsletterIssues.id, issueId), eq(newsletterIssues.organisationId, organisationId)));

    return { subject: subject.text, preheader: preheader.text, bodyMarkdown: bodyText, tone, warnings };
}

// ── Making an existing draft better ─────────────────────────────────────────────────────────────
//
// ⚠️ WHY THIS IS NOT `generate` WITH THE OLD COPY IN THE BRIEF. Because the two jobs have opposite
// failure modes. Drafting from a topic is allowed to invent structure; rewriting is not allowed to
// invent anything — the words on screen are words a human has read and, often, edited, and a
// "revision" that quietly drops a paragraph, changes a date or adds a claim is worse than no
// revision at all, because nobody re-reads a draft they have already read. So the prompt below is
// mostly a list of things the model may NOT do, and the result is returned for the author to accept
// rather than written straight over the top of their work.

/** The revisions offered as one-click buttons. Free text is always allowed alongside them. */
export const REFINE_MODES = [
    {
        key: 'shorter',
        label: 'Make it shorter',
        instruction:
            'Cut this to about two thirds of its length. Remove whole sentences rather than '
            + 'trimming words out of every one — the result must read as though it was written '
            + 'short, not as though it was squeezed. Keep every fact, every date and every link.',
    },
    {
        key: 'warmer',
        label: 'Make it warmer',
        instruction:
            'Rewrite this so it sounds like one person writing to another: shorter sentences, '
            + 'plainer words, contractions where they fall naturally. Do NOT add exclamation marks, '
            + 'emoji, or compliments to the reader.',
    },
    {
        key: 'sharper',
        label: 'Make it clearer',
        instruction:
            'Tighten this. Put the point of each section in its first sentence, cut hedging and '
            + 'throat-clearing, and replace vague phrases with the specific thing they are standing '
            + 'in for — but only where the specific thing is already somewhere in the draft.',
    },
    {
        key: 'subject',
        label: 'Better subject line',
        instruction:
            'Leave the body EXACTLY as it is, character for character. Write a better subject line '
            + 'and preview line: specific, under 60 characters, no clickbait, no emoji, and drawn '
            + 'from what the email actually says.',
    },
    {
        key: 'cta',
        label: 'Add a clear next step',
        instruction:
            'Keep the body as it is, and give it one clear closing call to action: a single '
            + 'sentence saying what the reader should do next. Do NOT invent a URL, an offer, a '
            + 'deadline or a price — if the draft contains no link, write the sentence without one.',
    },
] as const;

export type RefineModeKey = typeof REFINE_MODES[number]['key'];

export function refineInstructionFor(mode: unknown, custom?: unknown): string {
    const preset = REFINE_MODES.find((m) => m.key === mode);
    if (preset) return preset.instruction;
    return str(custom, 1000);
}

export interface RefineIssueOptions {
    issueId: number;
    organisationId: number;
    userId: number;
    /** One of REFINE_MODES, or 'custom' with `instruction` supplied. */
    mode?: string;
    /** The author's own words, when they did not pick a preset. */
    instruction?: string;
}

export interface RefineIssueResult {
    subject: string;
    preheader: string;
    bodyMarkdown: string;
    /** What the model says it changed, in one line. Shown above the accept/discard buttons. */
    summary: string;
    warnings: string[];
}

export class NothingToRefineError extends Error {
    constructor() {
        super('There is nothing written yet — draft the issue first, then ask for changes.');
        this.name = 'NothingToRefineError';
    }
}

/**
 * Rewrite an existing draft to an instruction, and return the result WITHOUT saving it.
 *
 * ⚠️ IT DOES NOT WRITE TO THE DATABASE. The caller shows the revision to the author, who accepts or
 * discards it — the same contract as the chat draft card, and for the same reason: a rewrite the
 * author has not read is a change they cannot undo, on copy that is about to be emailed to real
 * people. Accepting is an ordinary `update`, which is also what re-stamps the provenance marker.
 */
export async function refineIssueBody(db: Db, opts: RefineIssueOptions): Promise<RefineIssueResult> {
    const { issueId, organisationId, userId } = opts;

    const [issue] = await db
        .select({
            id: newsletterIssues.id,
            subject: newsletterIssues.subject,
            preheader: newsletterIssues.preheader,
            bodyMarkdown: newsletterIssues.bodyMarkdown,
            assistantId: newsletterIssues.assistantId,
            purpose: newsletterIssues.purpose,
        })
        .from(newsletterIssues)
        .where(and(eq(newsletterIssues.id, issueId), eq(newsletterIssues.organisationId, organisationId)))
        .limit(1);
    if (!issue) throw new IssueNotFoundError(issueId);
    if (!issue.bodyMarkdown.trim()) throw new NothingToRefineError();

    const instruction = refineInstructionFor(opts.mode, opts.instruction).trim();
    if (!instruction) throw new Error('Say what you would like changed.');

    return refineEmailCopy(db, {
        organisationId,
        userId,
        assistantId: issue.assistantId,
        purpose: issue.purpose,
        subject: issue.subject,
        preheader: issue.preheader,
        bodyMarkdown: issue.bodyMarkdown,
        instruction,
    });
}

/**
 * The revision itself, decoupled from newsletter_issues.
 *
 * Exists because a welcome-sequence step is an email too, and the day it got a Design Studio it
 * also had to get the assistant that everything else in the Studio has. One prompt, one set of
 * prohibitions — an "improve" that behaves differently in the sequence editor is a bug report
 * waiting to be written.
 */
export async function refineEmailCopy(db: Db, args: {
    organisationId: number;
    userId: number;
    assistantId?: number | null;
    purpose?: string | null;
    subject: string;
    preheader?: string | null;
    bodyMarkdown: string;
    instruction: string;
}): Promise<RefineIssueResult> {
    const { organisationId, userId } = args;
    const issue = { subject: args.subject, preheader: args.preheader, bodyMarkdown: args.bodyMarkdown, purpose: args.purpose };
    const instruction = args.instruction;
    const { tone, assistantPrompt } = await loadAssistantVoice(db, args.assistantId, organisationId);

    const customFields = await loadCustomFieldDefs(db, organisationId);
    const customKeys = customFields.map((f) => f.key);

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
        model: NEWSLETTER_MODEL,
        max_tokens: 2500,
        system:
            `You are revising an email newsletter that has already been written and read by the `
            + `person who owns it. Write in a ${tone} tone.\n`
            + (assistantPrompt ? `Voice guidance: ${assistantPrompt}\n` : '')
            + `\nTHE CHANGE THEY ASKED FOR: ${instruction}\n\n`
            // The whole point of the route. Everything below is a prohibition, deliberately.
            + 'WHAT YOU MUST NOT DO — this is a revision, not a new draft:\n'
            + '  · Do NOT add any fact that is not already in the draft: no statistics, prices, '
            + 'dates, names, testimonials, links or offers. If the change they asked for seems to '
            + 'need one, write around it and say so in "summary".\n'
            + '  · Do NOT remove a fact, a date, a name or a link that IS in the draft, unless they '
            + 'asked you to cut length — and then never a date, a price or a link.\n'
            + '  · Do NOT change what the email is about, or the order of its sections, unless that '
            + 'is what was asked for.\n'
            + '  · Do NOT write an unsubscribe line, a footer, a postal address or any "you are '
            + 'receiving this because…" text. Those are added automatically and yours would appear '
            + 'twice.\n'
            + `  · Keep every personalisation tag exactly as written, including its fallback. The `
            + `only ones that exist are: ${[...NEWSLETTER_MERGE_KEYS, ...customKeys.map((k) => `${CUSTOM_MERGE_PREFIX}${k}`)].join(', ')}.\n`
            + (purposePromptBlock(issue.purpose) ? `\n${purposePromptBlock(issue.purpose)}\n` : '')
            + '\nReturn ONLY a JSON object with exactly these keys:\n'
            + '  "subject"      — the subject line (unchanged if the change did not call for a new one)\n'
            + '  "preheader"    — the inbox preview line\n'
            + '  "bodyMarkdown" — the complete revised email in Markdown. The WHOLE email, not a diff '
            + 'and not just the parts you touched.\n'
            + '  "summary"      — one short sentence, addressed to the author, saying what you '
            + 'changed. If you could not do what they asked without inventing something, say that '
            + 'here instead of doing it.',
        messages: [{
            role: 'user',
            content: [
                `SUBJECT: ${issue.subject || ''}`,
                `PREVIEW LINE: ${issue.preheader || ''}`,
                '',
                'BODY:',
                issue.bodyMarkdown,
            ].join('\n'),
        }],
    });

    const raw = (response.content[0] as { text?: string })?.text?.trim() ?? '';
    if (!raw) throw new Error('The assistant returned nothing. Try again in a moment.');

    void logAiUsage({
        userId, workspaceId: organisationId, model: NEWSLETTER_MODEL,
        inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0,
    });

    const parsed = parseModelJson<{ subject?: string; preheader?: string; bodyMarkdown?: string; summary?: string }>(raw);
    const bodyRaw = str(parsed?.bodyMarkdown, 40000) || str(salvageStringField(raw, 'bodyMarkdown'), 40000);
    // ⚠️ An empty body is a FAILURE, not an empty revision. Returning it would let the accept button
    // wipe the author's draft with nothing, which is the single worst outcome this feature has.
    if (!bodyRaw.trim()) throw new Error('The revision came back in a form we could not read. Try again.');

    const body = scrubMergeTags(bodyRaw, customKeys);
    const subject = scrubMergeTags(str(parsed?.subject, MAX_SUBJECT_CHARS) || issue.subject, customKeys);
    const preheader = scrubMergeTags(str(parsed?.preheader, MAX_PREHEADER_CHARS) || issue.preheader || '', customKeys);

    return {
        subject: subject.text,
        preheader: preheader.text,
        bodyMarkdown: body.text,
        summary: str(parsed?.summary, 400) || 'Revised.',
        warnings: [...new Set([...subject.warnings, ...preheader.warnings, ...body.warnings])],
    };
}

// ── The welcome sequence ────────────────────────────────────────────────────────────────────────
//
// ⚠️ A WELCOME EMAIL IS NOT AN ISSUE, and briefing the model as though it were is how people end up
// with "This month at Acme" arriving four minutes after somebody subscribed. There is no news in a
// welcome email. The reader has just met the business, has not been sent anything before, and the
// only questions worth answering are: who are you, what will I get, and how often. So this has its
// own brief — and it is told which step it is, because email three of a series must not repeat the
// introduction email one already made.

export interface SequenceDraftOptions {
    organisationId: number;
    userId: number;
    assistantId?: number | null;
    /** 1-based. Step one introduces; later steps must not re-introduce. */
    stepNumber: number;
    /** Days after the previous email — the model is told, so "as promised last week" is honest. */
    delayDays: number;
    /** Anything the author wants in it. */
    notes?: string;
    /** The subjects already in the series, so this one does not repeat them. */
    existingSubjects?: string[];
}

export async function draftSequenceEmail(db: Db, opts: SequenceDraftOptions): Promise<GenerateIssueResult> {
    const { organisationId, userId } = opts;
    const { tone, assistantPrompt } = await loadAssistantVoice(db, opts.assistantId, organisationId);

    const [org] = await db
        .select({
            name: organisations.name,
            businessDescription: organisations.businessDescription,
            targetAudience: organisations.targetAudience,
        })
        .from(organisations)
        .where(eq(organisations.id, organisationId))
        .limit(1);

    const customFields = await loadCustomFieldDefs(db, organisationId);
    const customKeys = customFields.map((f) => f.key);
    const varList = [
        ...NEWSLETTER_MERGE_VARS.map((v) => `{{${v.key}}} (${v.label})`),
        ...customFields.map((f) => `{{${CUSTOM_MERGE_PREFIX}${f.key} | "…"}} (${f.label}, and it MUST carry a fallback)`),
    ].join(', ');

    const already = (opts.existingSubjects || []).filter(Boolean).slice(0, 8);

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
        model: NEWSLETTER_MODEL,
        max_tokens: 1600,
        system:
            `You are writing email ${opts.stepNumber} of a welcome series${org?.name ? ` for ${org.name}` : ''}, `
            + `sent automatically to somebody who has just confirmed they want to hear from them. `
            + `Write in a ${tone} tone.\n`
            + (assistantPrompt ? `Voice guidance: ${assistantPrompt}\n` : '')
            + (opts.stepNumber === 1
                ? 'This is the FIRST thing they will ever receive. Thank them once, say who the '
                  + 'business is in a sentence, say what they can expect to receive and roughly how '
                  + 'often, and give them one useful thing to read or do. Keep it short.\n'
                : `This arrives ${opts.delayDays === 0 ? 'straight after' : `${opts.delayDays} day${opts.delayDays === 1 ? '' : 's'} after`} `
                  + `the previous email. They have already been introduced — do NOT introduce the `
                  + `business again, do NOT thank them for subscribing again, and do NOT welcome `
                  + `them again. Pick up where the series left off with ONE useful thing.\n`)
            + (already.length ? `Emails already in this series, which you must not repeat: ${already.map((t) => `"${t}"`).join(', ')}.\n` : '')
            // The one thing a welcome email must never contain, and the one a model reliably adds.
            + '⚠️ This email is sent unattended, weeks or months from now, to somebody nobody has '
            + 'read it for. So it must contain NOTHING time-bound: no dates, no seasons, no "this '
            + 'week", no prices, no offers with an end, no current events. If it would read oddly '
            + 'in a year, do not write it.\n'
            + 'Do NOT invent statistics, customer numbers, testimonials or prices. Do NOT write an '
            + 'unsubscribe line, a footer or a postal address — those are added automatically.\n'
            + `You may personalise using these tags, written exactly as shown: ${varList}. Always `
            + `give a name tag a fallback, like ${GREETING_EXAMPLE}.\n\n`
            + 'Return ONLY a JSON object with exactly these keys: "subject", "preheader", '
            + '"bodyMarkdown" (Markdown: a greeting, one or two short sections with ## subheadings, '
            + 'a closing line — roughly 120–250 words, no H1).',
        messages: [{
            role: 'user',
            content: [
                org?.businessDescription ? `Business: ${org.businessDescription}` : '',
                org?.targetAudience ? `Audience: ${org.targetAudience}` : '',
                str(opts.notes, 4000) ? `The author wants this email to cover:\n${str(opts.notes, 4000)}` : '',
            ].filter(Boolean).join('\n') || 'Write the email from what you know about the business.',
        }],
    });

    const raw = (response.content[0] as { text?: string })?.text?.trim() ?? '';
    if (!raw) throw new Error('Empty draft.');

    void logAiUsage({
        userId, workspaceId: organisationId, model: NEWSLETTER_MODEL,
        inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0,
    });

    const parsed = parseModelJson<{ subject?: string; preheader?: string; bodyMarkdown?: string }>(raw);
    const bodyRaw = str(parsed?.bodyMarkdown, 20000) || str(salvageStringField(raw, 'bodyMarkdown'), 20000);
    if (!bodyRaw) throw new Error('The draft came back in a form we could not read. Try again.');

    const body = scrubMergeTags(bodyRaw, customKeys);
    const subject = scrubMergeTags(str(parsed?.subject, MAX_SUBJECT_CHARS) || 'Welcome', customKeys);
    const preheader = scrubMergeTags(str(parsed?.preheader, MAX_PREHEADER_CHARS), customKeys);

    return {
        subject: subject.text,
        preheader: preheader.text,
        bodyMarkdown: body.text,
        tone,
        warnings: [...new Set([...subject.warnings, ...preheader.warnings, ...body.warnings])],
    };
}
