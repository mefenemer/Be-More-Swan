// src/config/assistant-prompt-layers.ts
// What each assistant role's prompts are built from — for Admin ▸ Assistants ▸ Model & rules, so an
// admin can see how every assistant is configured (owner, 2026-10-24).
//
// The TEXT is never copied here: every layer is rendered from the export the drafting code itself
// uses, so this page cannot drift from what runs. What this file owns is only the map — which role's
// prompts include which block — and tests/assistant-config-view.test.ts checks each claim against
// the source of the path named. Per-workspace inputs (voice, business information, products, Brand
// Knowledge, Inspo) are listed by name only: their content is the customer's, and differs per
// workspace. Pure.

import { CONTENT_QUALITY_STANDARDS } from '../constants/content-quality';
import { SPECIAL_CATEGORY_RULE } from '../constants/special-category-rule';
import { emailCraftBlock } from '../constants/email-craft';
import { platformCraftBlock } from '../constants/platform-craft';
import { BLOG_CRAFT } from '../constants/blog-craft';
import { SITE_COPY_CRAFT } from '../constants/site-copy-craft';
import { BLOG_ARTICLE_TYPES, SOCIAL_POST_SHAPES } from '../utils/content-shapes';
import { EMAIL_SUBJECT_STYLES, LONG_FORM_OPENINGS, OUTREACH_OPENINGS, SOCIAL_HOOK_STYLES } from './hook-styles';
import { CTA_BINDING_RULE } from './call-to-action';
import { OUTREACH_FIRST_EMAIL_RULES } from './outreach-offer';
import { ACTIVE_TEAMMATES_RULE, NO_TEAMMATES_BLOCK } from '../utils/team-activity';

export interface PromptLayer {
    key: string;
    title: string;
    /** 'craft' = how an expert does the job; 'rule' = a must / must-not; 'rotation' = a list the
     *  code cycles through so drafts vary; 'workspace' = filled in per customer. */
    kind: 'craft' | 'rule' | 'rotation' | 'workspace';
    /** Which of the role's jobs uses it. */
    usedBy: string;
    /** The file that puts it in the prompt. */
    source: string;
    text: string;
}

const list = (items: readonly string[]) => items.map((x, i) => `${i + 1}. ${x}`).join('\n');

const CHAT_LAYERS: PromptLayer[] = [
    { key: 'team', title: 'Active teammates only', kind: 'rule', usedBy: 'Chat', source: 'src/utils/team-activity.ts',
      text: `${ACTIVE_TEAMMATES_RULE}\n\nWith no active teammates, the chat is told instead:\n${NO_TEAMMATES_BLOCK}` },
    { key: 'special', title: 'Special category data', kind: 'rule', usedBy: 'Chat', source: 'src/constants/special-category-rule.ts', text: SPECIAL_CATEGORY_RULE },
    { key: 'workspace_chat', title: 'Filled in per workspace', kind: 'workspace', usedBy: 'Chat', source: 'netlify/functions/chat-orchestrator.ts',
      text: 'The role prompt for this assistant (its base prompt is on the Prompt & versions tab), the business identity, Products & Services, Brand Knowledge documents, the assistant\'s own settings and goals, and recent team activity.' },
];

const SOCIAL: PromptLayer[] = [
    { key: 'standards', title: 'Content quality standards', kind: 'rule', usedBy: 'Drafting posts', source: 'src/constants/content-quality.ts', text: CONTENT_QUALITY_STANDARDS },
    { key: 'platform_craft', title: 'Platform craft', kind: 'craft', usedBy: 'Drafting posts', source: 'src/constants/platform-craft.ts',
      text: platformCraftBlock(['instagram', 'linkedin', 'facebook', 'x', 'threads']) },
    { key: 'shapes', title: `Post shapes (${SOCIAL_POST_SHAPES.length}, one per post in turn)`, kind: 'rotation', usedBy: 'Drafting posts', source: 'src/utils/content-shapes.ts',
      text: SOCIAL_POST_SHAPES.map((s) => `${s.label} — ${s.brief}`).join('\n\n') },
    { key: 'hooks', title: `Opening hooks (${SOCIAL_HOOK_STYLES.length}, one per post in turn)`, kind: 'rotation', usedBy: 'Drafting posts', source: 'src/config/hook-styles.ts', text: list(SOCIAL_HOOK_STYLES) },
    { key: 'special_social', title: 'Special category data', kind: 'rule', usedBy: 'Drafting posts', source: 'src/constants/special-category-rule.ts', text: SPECIAL_CATEGORY_RULE },
    { key: 'workspace_social', title: 'Filled in per workspace', kind: 'workspace', usedBy: 'Drafting posts', source: 'netlify/functions/process-content-jobs.ts',
      text: 'Voice, content pillars, the call-to-action setting, platform strategy (hashtag counts, formats), Products & Services, the intro offer, Inspo, Brand Knowledge, campaign directives, and the last posts drafted (so it does not repeat itself).' },
];

const EMAIL: PromptLayer[] = [
    { key: 'email_craft', title: 'Email craft', kind: 'craft', usedBy: 'Newsletters and welcome emails', source: 'src/constants/email-craft.ts', text: emailCraftBlock('{business name}') },
    { key: 'email_openings', title: `Subject lines (${EMAIL_SUBJECT_STYLES.length}) and openings (${LONG_FORM_OPENINGS.length}), in turn`, kind: 'rotation', usedBy: 'Newsletters and welcome emails', source: 'src/config/hook-styles.ts',
      text: `Subject line:\n${list(EMAIL_SUBJECT_STYLES)}\n\nFirst line:\n${list(LONG_FORM_OPENINGS)}` },
    { key: 'cta_email', title: 'Call to action is binding', kind: 'rule', usedBy: 'Newsletters and welcome emails', source: 'src/config/call-to-action.ts', text: CTA_BINDING_RULE },
    { key: 'special_email', title: 'Special category data', kind: 'rule', usedBy: 'Newsletters and welcome emails', source: 'src/constants/special-category-rule.ts', text: SPECIAL_CATEGORY_RULE },
    { key: 'workspace_email', title: 'Filled in per workspace', kind: 'workspace', usedBy: 'Newsletters and welcome emails', source: 'src/utils/newsletter-generate.ts',
      text: 'Voice, the brief or blog post it is written from, Products & Services, the call-to-action setting, blueprint guardrails, and personalisation tags. Links it writes that nobody supplied are removed in code before saving.' },
];

const BLOG: PromptLayer[] = [
    { key: 'blog_craft', title: 'Blog craft and accuracy', kind: 'craft', usedBy: 'Drafting articles', source: 'src/constants/blog-craft.ts', text: BLOG_CRAFT },
    { key: 'article_types', title: `Article types (${BLOG_ARTICLE_TYPES.length}, in turn)`, kind: 'rotation', usedBy: 'Drafting articles', source: 'src/utils/content-shapes.ts',
      text: BLOG_ARTICLE_TYPES.map((t) => `${t.label} — ${t.brief}`).join('\n\n') },
    { key: 'blog_openings', title: `Openings (${LONG_FORM_OPENINGS.length}, in turn)`, kind: 'rotation', usedBy: 'Drafting articles', source: 'src/config/hook-styles.ts', text: list(LONG_FORM_OPENINGS) },
    { key: 'cta_blog', title: 'Call to action is binding', kind: 'rule', usedBy: 'Drafting articles', source: 'src/config/call-to-action.ts', text: CTA_BINDING_RULE },
    { key: 'special_blog', title: 'Special category data', kind: 'rule', usedBy: 'Drafting articles', source: 'src/constants/special-category-rule.ts', text: SPECIAL_CATEGORY_RULE },
    { key: 'workspace_blog', title: 'Filled in per workspace', kind: 'workspace', usedBy: 'Drafting articles', source: 'src/utils/blog-generate.ts',
      text: 'Voice, the topic and keywords, Products & Services, the call-to-action setting, Inspo and blueprint guardrails.' },
];

const LEADS: PromptLayer[] = [
    { key: 'first_email', title: 'First-email rules', kind: 'craft', usedBy: 'Outreach emails', source: 'src/config/outreach-offer.ts', text: OUTREACH_FIRST_EMAIL_RULES },
    { key: 'outreach_openings', title: `Cold-email openings (${OUTREACH_OPENINGS.length}, in turn)`, kind: 'rotation', usedBy: 'Outreach emails', source: 'src/config/hook-styles.ts', text: list(OUTREACH_OPENINGS) },
    { key: 'workspace_leads', title: 'Filled in per workspace', kind: 'workspace', usedBy: 'Outreach emails', source: 'netlify/functions/lead-generation.ts',
      text: 'The sender identity, the outreach offer (gift, intro offer or a question), the lead\'s own details, and the ideal customer profile.' },
];

const WEBSITE: PromptLayer[] = [
    { key: 'site_copy', title: 'Website copy craft', kind: 'craft', usedBy: 'Writing the site (a new draft, a template\'s words, and chat edits)', source: 'src/constants/site-copy-craft.ts', text: SITE_COPY_CRAFT },
    { key: 'special_site', title: 'Special category data', kind: 'rule', usedBy: 'Writing the site', source: 'src/constants/special-category-rule.ts', text: SPECIAL_CATEGORY_RULE },
    { key: 'workspace_site', title: 'Filled in per workspace', kind: 'workspace', usedBy: 'Writing the site', source: 'src/utils/site-draft.ts',
      text: 'The business details, Products & Services (the only prices it may state), the set-up answers (what visitors should do, the pages wanted, how it should feel), the assistant\'s Rules, and the request. Colours, lettering and logo come from the brand kit, never the draft.' },
];

const BY_ROLE: Record<string, PromptLayer[]> = {
    social_media_manager: SOCIAL,
    newsletter_editor: EMAIL,
    blog_writer: BLOG,
    lead_qualifier: LEADS,
    website_assistant: WEBSITE,
};

/** Every layer that shapes this role's prompts: its own jobs first, then chat. Pure. */
export function promptLayersFor(roleKey: string): PromptLayer[] {
    return [...(BY_ROLE[roleKey] ?? []), ...CHAT_LAYERS];
}

/** The work of each role that reads the model setting (src/utils/assistant-model.ts), beyond its chat, which every role's does. */
export const ROLE_MODEL_PATHS: Record<string, { label: string; defaultModel: string }[]> = {
    social_media_manager: [{ label: 'Drafting posts', defaultModel: 'claude-sonnet-4-6' }],
    newsletter_editor: [
        { label: 'Newsletters and welcome emails', defaultModel: 'claude-haiku-4-5-20251001' },
        { label: 'Email Studio flow emails', defaultModel: 'claude-haiku-4-5-20251001' },
    ],
    blog_writer: [{ label: 'Drafting articles', defaultModel: 'claude-haiku-4-5-20251001' }],
    // Lead discovery (src/lib/discovery-scoring.ts — the classifier, bulk scoring and the deep
    // re-score) reads it too since 2026-10-25: it writes most of the outreach emails.
    lead_qualifier: [{ label: 'Scoring leads (in chat and in lead discovery), ideas and outreach emails', defaultModel: 'claude-haiku-4-5-20251001' }],
    // These three run through the AI gateway, whose own model (AI_GATEWAY_PRIMARY_MODEL) is the default.
    mystery_shopper: [{ label: 'Site audits', defaultModel: 'claude-sonnet-4-6' }],
    website_assistant: [
        { label: 'Drafting and importing sites', defaultModel: 'claude-sonnet-4-6' },
        { label: 'Rewriting the owner\'s own words (Low thinking at most)', defaultModel: 'claude-sonnet-4-6' },
    ],
    brand_designer: [{ label: 'Art direction for visual briefs', defaultModel: 'claude-sonnet-4-6' }],
};
/** Every role's chat. */
export const CHAT_DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
