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
import {
    designToMarkdown, normaliseDesign,
    type DesignBlock, type DesignTheme, type NewsletterDesign,
} from './newsletter-design';
import { loadBrandNewsletterTheme, themedButtonColours } from './brand-theme';
import {
    groundLinks, groundMarkdownLinks, irToDesignBlocks, layoutIrPromptBlock, normaliseLayoutIr,
    type IrNode, type LayoutIr,
} from './layout-ir';

type Db = ReturnType<typeof getDb>;

/**
 * Same tier as the blog drafter (BLOG_MODEL) on purpose — an issue is long-form copy in the
 * workspace's voice, and two content surfaces drafting at different quality levels is a difference
 * a customer would see and could not explain. Raise both together or neither.
 */
export const NEWSLETTER_MODEL = 'claude-haiku-4-5-20251001';

/** Marks a draft as machine-written, for the AI transparency badge and the review queue. */
export const NEWSLETTER_DRAFT_REASON = 'assistant_draft';

/**
 * Shown when a link was removed because nobody supplied it.
 *
 * ⚠️ Said out loud rather than swallowed: the words survive and the sentence still reads, so an
 * author re-reading their draft has no way to notice that "our pricing page" stopped being a link.
 */
export const UNGROUNDED_LINK_WARNING =
    'A link the assistant wrote pointed at a page nobody gave it, so the words are there without the link. Add the address before you send.';

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
    /**
     * The layout the assistant designed, when it produced one AND the issue had none of its own.
     *
     * ⚠️ Null is the normal case for an issue that ALREADY has a design: re-flowing the new copy
     * into the layout the author built (applyProseToDesign, in the handler) keeps their pictures
     * and buttons where they put them, and a freshly generated layout would throw that away.
     */
    design?: NewsletterDesign | null;
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
/**
 * Run the merge-tag scrub over every word in a layout.
 *
 * ⚠️ Merge tags are a NEWSLETTER concept, so this lives here rather than in layout-ir.ts — the IR
 * is shared with the blog, which has no subscribers and no tags. But it has to happen: a layout
 * carries the same prose the body used to, and an unscrubbed `{{first name}}` reaching an inbox is
 * exactly the failure scrubMergeTags exists to prevent. Same function, same warnings, every field
 * a human will read.
 */
function scrubLayoutIr(ir: LayoutIr, customKeys: readonly string[]): { ir: LayoutIr; warnings: string[] } {
    const warnings: string[] = [];
    const clean = (v: string) => {
        const out = scrubMergeTags(v, customKeys);
        warnings.push(...out.warnings);
        return out.text;
    };
    const node = (n: IrNode): IrNode => {
        switch (n.kind) {
            case 'heading': return { ...n, text: clean(n.text) };
            case 'prose': return { ...n, markdown: clean(n.markdown) };
            case 'quote': return { ...n, text: clean(n.text), attribution: clean(n.attribution) };
            case 'image': return { ...n, alt: clean(n.alt), caption: clean(n.caption) };
            case 'button': return { ...n, label: clean(n.label) };
            case 'columns': return {
                ...n,
                columns: [n.columns[0].map(node), n.columns[1].map(node)] as typeof n.columns,
            };
            default: return n;
        }
    };
    return { ir: { ...ir, nodes: ir.nodes.map(node) }, warnings: [...new Set(warnings)] };
}

/**
 * The "read the full post" link, as a block rather than a line of Markdown.
 *
 * ⚠️ appendSourceLink writes into body_markdown, and in a designed issue body_markdown is DERIVED
 * from the design — so a link appended there is erased by the next designToMarkdown. It has to be
 * a block or it does not exist. A button rather than a text link because that is what the design
 * surface has, and because this link is the entire reason a blog hand-off issue was written.
 */
function withSourceLinkBlock(
    blocks: DesignBlock[],
    theme: DesignTheme,
    link: { url: string; title: string } | null | undefined,
    prose: string,
): DesignBlock[] {
    if (!link?.url || !/^https?:\/\//i.test(link.url)) return blocks;
    // The model was told not to write the link, but if it did anyway a second copy is worse than
    // none — same rule as appendSourceLink's.
    if (prose.includes(link.url)) return blocks;
    const label = (link.title || 'Read the full post').replace(/[\[\]]/g, '').trim().slice(0, 60)
        || 'Read the full post';
    return [...blocks, {
        id: `src_${Date.now().toString(36)}`,
        type: 'button',
        label,
        href: link.url,
        align: 'center',
        ...themedButtonColours(theme.accent),
    }];
}

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
            // Read, never written here: its presence is what decides whether a generated layout is
            // allowed to become this issue's design at all. See GenerateIssueResult.design.
            design: newsletterIssues.design,
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
        // Raised from 2000 with the layout: the same 200–400 words now arrive wrapped in JSON
        // nodes. A truncated reply loses the whole object rather than its tail, so the headroom is
        // the difference between a draft and a retry.
        max_tokens: 3000,
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
            '  "layout"     — the email itself, SET OUT as described under LAYOUT below: a short ' +
            'greeting, 2–4 short sections with headings, and a clear closing. No level-1 heading — ' +
            'the subject line is the title. Keep it to what someone will actually read in an inbox: ' +
            'roughly 200–400 words of copy in total.\n' +
            // ⚠️ The escape hatch, and it is load-bearing: a model that cannot produce the layout
            // schema must still be able to hand back a usable draft rather than nothing. The
            // fallback below reads this key and the issue stays plain Markdown, exactly as before
            // layouts existed. Never remove it to "force" the structured path.
            '  "bodyMarkdown" — ONLY if you cannot produce a layout: the same email as plain ' +
            'Markdown. Send one or the other, never both.\n\n' +
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
            `\n\n${layoutIrPromptBlock()}` +
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

    const parsed = parseModelJson<{
        subject?: string; preheader?: string; bodyMarkdown?: string; layout?: unknown;
    }>(raw);

    // ── The layout, if there is a usable one ────────────────────────────────────────────────────
    //
    // ⚠️ THREE conditions, and all three are deliberate:
    //   · the reply parsed at all — a design built from a half-read object is a broken email;
    //   · the layout survived normalisation — bad nodes are dropped, and what is left may be
    //     nothing, which is a null and NOT an error;
    //   · the issue has no design of its own — see GenerateIssueResult.design. Overwriting a
    //     layout the author built would throw away the pictures they chose, and the handler's
    //     applyProseToDesign path exists precisely so it does not have to.
    const layout = issue.design ? null : normaliseLayoutIr(parsed?.layout);

    // Everywhere a real URL could legitimately have come from. The brief is what the human typed;
    // the source link is what a blog hand-off supplied. Anything else the model writes is invented.
    const suppliedLinks = [brief, opts.sourceLink?.url ?? ''].join('\n');

    let design: NewsletterDesign | null = null;
    let designWarnings: string[] = [];
    if (layout) {
        const scrubbed = scrubLayoutIr(layout, customKeys);
        designWarnings = scrubbed.warnings;

        // ⚠️ A button may only point somewhere the HUMAN named. Left alone, the model invents
        // plausible URLs — a real draft came back with a "Book your free first session" button
        // pointing at a page that does not exist — and a dead call to action reaches every
        // subscriber before anybody notices. The button survives with no link and the reviewer is
        // told, which is the same bargain as the "do not invent statistics" rule above.
        const grounded = groundLinks(scrubbed.ir, suppliedLinks);
        if (grounded.stripped.length) {
            designWarnings = [...designWarnings, `The assistant suggested ${grounded.stripped.length === 1
                ? `a button ("${grounded.stripped[0]}")`
                : `${grounded.stripped.length} buttons`} but had no link to point at, so they have no address yet. Add one before you send.`];
        }
        // The organisation's own colours — the same resolver every other creation seam uses, so an
        // assistant-designed issue and a template-started one are the same brand.
        const theme = await loadBrandNewsletterTheme(db, organisationId);
        const blocks = irToDesignBlocks(grounded.ir, theme);
        const withLink = withSourceLinkBlock(blocks, theme, opts.sourceLink, JSON.stringify(grounded.ir));
        // ⚠️ Through normaliseDesign like everything else. This compiler is not exempt from the
        // gate just because its input was validated once already — that check is what stops an
        // unvalidated colour or href reaching an inbox, whoever authored the blocks.
        design = normaliseDesign({ version: 1, template: 'assistant', theme, blocks: withLink });
    }

    // A model that wrapped the JSON badly still wrote a usable body; salvage it rather than
    // charging the customer for a run they cannot use. Skipped entirely when a design was built:
    // the design IS the copy, and body_markdown is derived from it below.
    const bodyRaw = design
        ? ''
        : str(parsed?.bodyMarkdown, 20000) || str(salvageStringField(raw, 'bodyMarkdown'), 20000);
    if (!design && !bodyRaw) throw new Error('The draft came back in a form we could not read. Try again.');

    // ⚠️ The fallback prose gets grounded too. A designed issue's links went through groundLinks
    // above; without this the SAME invented link is fine to send the moment the model returns
    // Markdown instead of a layout — which is exactly when it is struggling.
    const groundedBody = groundMarkdownLinks(bodyRaw, suppliedLinks);
    const body = scrubMergeTags(groundedBody.markdown, customKeys);
    // ⚠️ When a design exists it is authoritative and body_markdown is DERIVED from it — the same
    // one-directional rule the Studio's save path follows (src/utils/newsletter-design.ts). The
    // source link is already a block by this point, because a line appended here would be erased
    // by the next designToMarkdown.
    const bodyText = design
        ? designToMarkdown(design)
        // After the scrub, so the URL is never mistaken for a malformed merge tag and stripped.
        : appendSourceLink(body.text, opts.sourceLink);
    const subject = scrubMergeTags(str(parsed?.subject, MAX_SUBJECT_CHARS) || issue.subject || 'Your newsletter', customKeys);
    const preheader = scrubMergeTags(str(parsed?.preheader, MAX_PREHEADER_CHARS), customKeys);

    const warnings = [...new Set([...subject.warnings, ...preheader.warnings, ...body.warnings, ...designWarnings,
        ...(groundedBody.removed ? [UNGROUNDED_LINK_WARNING] : []),
    ])];

    await db.update(newsletterIssues)
        .set({
            subject: subject.text,
            preheader: preheader.text || null,
            bodyMarkdown: bodyText,
            // Written in the SAME statement as the body it mirrors. Two writes would leave a window
            // where the design and its prose disagree, and the send worker reads whichever it finds.
            ...(design ? { design } : {}),
            // COALESCE, not a plain set: an autopilot run stamps its own, more specific reason
            // before calling this. First writer wins — same rule as blog-generate.ts.
            generationReason: sql`COALESCE(${newsletterIssues.generationReason}, ${NEWSLETTER_DRAFT_REASON})`,
            updatedAt: new Date(),
        })
        .where(and(eq(newsletterIssues.id, issueId), eq(newsletterIssues.organisationId, organisationId)));

    return { subject: subject.text, preheader: preheader.text, bodyMarkdown: bodyText, tone, warnings, design };
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

    // ⚠️ The copy being revised is itself the allow-list. A rewrite is entitled to keep every link
    // the author already had — they put them there — and entitled to invent none, which is the same
    // rule as "do not add a claim that was not in the original".
    const groundedBody = groundMarkdownLinks(bodyRaw, issue.bodyMarkdown || '');
    const body = scrubMergeTags(groundedBody.markdown, customKeys);
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
    /**
     * May this drafter design the email, or only write it?
     *
     * ⚠️ False when the step ALREADY has a layout. Same rule as an issue (see
     * GenerateIssueResult.design): the author's pictures and buttons are choices, and the caller
     * re-flows the new copy into them instead. When it is false the model is asked for plain
     * Markdown exactly as it was before layouts existed — there is no point paying for structure
     * that is going to be thrown away.
     */
    allowLayout?: boolean;
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

    const seqBrief = [
        org?.businessDescription ? `Business: ${org.businessDescription}` : '',
        org?.targetAudience ? `Audience: ${org.targetAudience}` : '',
        str(opts.notes, 4000) ? `The author wants this email to cover:\n${str(opts.notes, 4000)}` : '',
    ].filter(Boolean).join('\n') || 'Write the email from what you know about the business.';

    // A welcome email is an email: it gets the same layout treatment an issue does, unless the step
    // already has one of its own (see allowLayout).
    const wantsLayout = opts.allowLayout !== false;

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
        model: NEWSLETTER_MODEL,
        // Structure costs tokens; asking for it inside a 1600 ceiling is how a reply gets truncated
        // into an unparseable object. Only raised for the run that actually wants a layout.
        max_tokens: wantsLayout ? 2400 : 1600,
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
            + (wantsLayout
                ? 'Return ONLY a JSON object with exactly these keys: "subject", "preheader", and '
                  + '"layout" — the email itself, SET OUT as described under LAYOUT below: a '
                  + 'greeting, one or two short sections with headings, a closing line — roughly '
                  + '120–250 words of copy in total, and no level-1 heading. '
                  // ⚠️ The escape hatch, as on the issue path: a model that cannot produce the
                  // schema must still hand back a usable draft rather than nothing.
                  + 'Add "bodyMarkdown" INSTEAD of "layout" only if you cannot produce a layout.'
                  + `\n\n${layoutIrPromptBlock()}`
                : 'Return ONLY a JSON object with exactly these keys: "subject", "preheader", '
                  + '"bodyMarkdown" (Markdown: a greeting, one or two short sections with ## subheadings, '
                  + 'a closing line — roughly 120–250 words, no H1).'),
        messages: [{ role: 'user', content: seqBrief }],
    });

    const raw = (response.content[0] as { text?: string })?.text?.trim() ?? '';
    if (!raw) throw new Error('Empty draft.');

    void logAiUsage({
        userId, workspaceId: organisationId, model: NEWSLETTER_MODEL,
        inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0,
    });

    const parsed = parseModelJson<{
        subject?: string; preheader?: string; bodyMarkdown?: string; layout?: unknown;
    }>(raw);

    // The same three-step compile the issue path runs — scrub the words, refuse invented links,
    // build in the organisation's colours — and the same gate at the end of it.
    const layout = wantsLayout ? normaliseLayoutIr(parsed?.layout) : null;
    let design: NewsletterDesign | null = null;
    let designWarnings: string[] = [];
    if (layout) {
        const scrubbed = scrubLayoutIr(layout, customKeys);
        const grounded = groundLinks(scrubbed.ir, seqBrief);
        designWarnings = [...scrubbed.warnings];
        if (grounded.stripped.length) {
            designWarnings.push(`The assistant suggested ${grounded.stripped.length === 1
                ? `a button ("${grounded.stripped[0]}")`
                : `${grounded.stripped.length} buttons`} but had no link to point at, so they have no address yet. Add one before you switch the sequence on.`);
        }
        const theme = await loadBrandNewsletterTheme(db, organisationId);
        design = normaliseDesign({
            version: 1, template: 'assistant', theme, blocks: irToDesignBlocks(grounded.ir, theme),
        });
    }

    const bodyRaw = design
        ? ''
        : str(parsed?.bodyMarkdown, 20000) || str(salvageStringField(raw, 'bodyMarkdown'), 20000);
    if (!design && !bodyRaw) throw new Error('The draft came back in a form we could not read. Try again.');

    // As on the issue path: the Markdown fallback is grounded too, or a welcome email that goes out
    // unattended for months carries a link to a page that never existed.
    const groundedBody = groundMarkdownLinks(bodyRaw, seqBrief);
    if (groundedBody.removed) designWarnings.push(UNGROUNDED_LINK_WARNING);
    const body = scrubMergeTags(groundedBody.markdown, customKeys);
    const subject = scrubMergeTags(str(parsed?.subject, MAX_SUBJECT_CHARS) || 'Welcome', customKeys);
    const preheader = scrubMergeTags(str(parsed?.preheader, MAX_PREHEADER_CHARS), customKeys);

    return {
        subject: subject.text,
        preheader: preheader.text,
        // ⚠️ Derived from the design when there is one, exactly as an issue's is. saveStep writes
        // whichever of the two it is given and derives the other; handing it a design and separate
        // prose would be handing it two answers.
        bodyMarkdown: design ? designToMarkdown(design) : body.text,
        tone,
        warnings: [...new Set([...subject.warnings, ...preheader.warnings, ...body.warnings, ...designWarnings])],
        design,
    };
}
