// src/utils/assistant-chat-capabilities.ts
// Feature request #17: Admin ▸ Assistants ▸ Chat capabilities — what each assistant's chat knows, reads,
// can do, can't do and must follow, as ONE list in the same shape for every assistant (owner: "this needs
// to be a comprehensive list as otherwise we are at risk of assistants giving the wrong information").
//
// Two halves, so the list cannot quietly go stale:
//   1. FROM THE CODE — src/config/chat-capabilities.generated.ts, written by
//      scripts/chat-capabilities-manifest.ts from the chat orchestrator itself: every route, its switches,
//      every block joined into its prompt, every card its prompt names. The expertise level comes from the
//      craft layers in src/config/assistant-prompt-layers.ts; who gets a shared block comes from the same
//      role lists the chat code uses (imported below, never copied).
//   2. BY HAND, HERE — only the words: what each data source shows, what each card does, each role's field
//      and its role-specific "can't do"s and rules.
//
// tests/assistant-chat-capabilities.test.ts FAILS when: the generated file is out of date; a route, route
// switch, prompt block, per-message extra or card has no words here; words here name something the code no
// longer has; a card a shared block offers is not in that block's source file; or a role the platform has
// built (src/config/assistant-build-manifest.ts) has no profile. Pure — no database.

import { GENERATED_CHAT_MANIFEST } from '../config/chat-capabilities.generated';
import { promptLayersFor } from '../config/assistant-prompt-layers';
import { RULE_READING_ROLES } from './assistant-rules-prompt';
import { MY_CONTENT_ROLES } from './chat-my-content';
import { INSPO_ROLES, KB_ROLES } from './chat-library';
import { EMAIL_REVIEW_ROLES } from './chat-reviews';
import { SEARCH_QUERY_ROLES } from './chat-search-queries';
import { roleHasCta } from './chat-call-to-action';
import { hasPostingSchedule } from './chat-schedule';
import { pillarProfileFor } from './pillar-profiles';
import { isServiceAllowedForAssistant } from './connection-map';

export interface RouteManifest {
    flags: string[];
    contentSnapshot: string | null;
    offersOwnCards: boolean;
    maxTokens: number;
    cards: string[];
    craftInChat: string[];
}
export interface ChatManifest {
    routes: Record<string, RouteManifest>;
    routeFlags: string[];
    promptBlocks: string[];
    turnExtras: string[];
    targetCards: Record<string, string[]>;
    uiCards: string[];
}
export const CHAT_MANIFEST: ChatManifest = GENERATED_CHAT_MANIFEST;

/** Who a source reaches, decided from the route and the chat code's own role lists. */
interface RoleCtx { roleKey: string; route: RouteManifest | null }
const hasRoute = (c: RoleCtx) => c.route !== null;
const cards = (c: RoleCtx) => !!c.route?.offersOwnCards;
const isMentor = (c: RoleCtx) => c.roleKey === 'business_mentor';
const SOCIAL_SERVICES = ['facebook', 'instagram', 'linkedin', 'x', 'threads', 'tiktok', 'youtube'];

export type SourceKind = 'data' | 'rule' | 'actions';

export interface ChatSource {
    label: string;
    kind: SourceKind;
    /** What the chat sees or is told, in plain words. */
    sees: string;
    /** The file that builds it. */
    source: string;
    /** Whether this role's chat gets it. */
    applies: (c: RoleCtx) => boolean;
    /** When it is present only sometimes. */
    when?: string;
    /** Cards it lets the chat offer (checked against `source` by the test). */
    cards?: (c: RoleCtx) => string[];
}

const every = () => true;

/** Every block in `promptWithRules` (chat-orchestrator.ts), keyed by its variable name. */
export const PROMPT_BLOCK_SOURCES: Record<string, ChatSource> = {
    rolePrompt: { label: 'Its role instructions', kind: 'rule', sees: 'Who it is and works for, its job, the tabs on its page, the cards it may offer and how; with a route, also the switch-driven data below.', source: 'netlify/functions/chat-orchestrator.ts', applies: every },
    rulesBlock: { label: "The user's rules", kind: 'rule', sees: "Its Assistant Rules (Do's and don'ts), rules it learned from feedback, and workspace-wide rules. It must follow them.", source: 'src/utils/assistant-rules-prompt.ts', applies: (c) => RULE_READING_ROLES.has(c.roleKey) },
    productsBlock: { label: 'Products & Services', kind: 'data', sees: 'What the business sells, with real names and prices, and the intro offer or free trial, from Business Information.', source: 'src/utils/org-products.ts', applies: every },
    knowledgeBlock: { label: 'Brand files and links', kind: 'data', sees: "Business Information's documents and links (brand guide, about pages), capped.", source: 'src/utils/business-knowledge.ts', applies: every },
    siteDirectoryBlock: { label: 'Website page directory', kind: 'data', sees: 'Each page of their website: address, title, one line and what it offers, so it links the right page. At most 2,500 characters.', source: 'src/utils/site-directory-store.ts', applies: every },
    siteDirectoryCardBlock: { label: 'Website directory controls', kind: 'actions', sees: 'When the directory last read the site and what is left out; can re-read the site or leave a page out.', source: 'src/utils/chat-site-directory.ts', applies: cards, cards: () => ['site_directory'] },
    teamBlock: { label: 'Team activity', kind: 'data', sees: 'What it and its active teammates did in the last 14 days and what is booked to go out, and which teammates are active (it may only point to those).', source: 'src/utils/team-activity.ts', applies: every },
    teamThreadBlock: { label: 'Its Team thread', kind: 'data', sees: 'What the user told it on the Team page and what it replied.', source: 'src/utils/team-messages.ts', applies: every },
    settingsBlock: { label: 'Its own status and settings', kind: 'data', sees: 'Whether it is working or paused, and its settings (draft horizon, review alerts, media) as on its page.', source: 'src/utils/chat-assistant-settings.ts', applies: every },
    settingsCardBlock: { label: 'Change its settings', kind: 'actions', sees: 'Can propose pausing, resuming or changing a setting, which the user confirms.', source: 'src/utils/chat-assistant-settings.ts', applies: cards, cards: () => ['assistant_settings_proposal'] },
    rulesListBlock: { label: "Its Do's and don'ts, by id", kind: 'data', sees: "Every rule by id, so it can reword or switch one. The Business Mentor sees only the workspace-wide rules.", source: 'src/utils/chat-rules.ts', applies: (c) => cards(c) || isMentor(c) },
    rulesCardBlock: { label: 'Change its rules', kind: 'actions', sees: 'Can propose adding, rewording, switching off or deleting a rule (the Mentor: workspace-wide rules only).', source: 'src/utils/chat-rules.ts', applies: (c) => cards(c) || isMentor(c), cards: () => ['rule_proposal'] },
    planBlock: { label: 'Plan and task balance', kind: 'data', sees: "The workspace's plan and this month's task balance, the same figures as the usage bar.", source: 'src/utils/chat-plan-snapshot.ts', applies: every },
    goalsBlock: { label: 'Its goals', kind: 'data', sees: 'Its goals by id and the metrics on offer.', source: 'src/utils/chat-goals.ts', applies: every },
    goalsCardBlock: { label: 'Set a goal', kind: 'actions', sees: 'Can propose a new goal or a change to one.', source: 'src/utils/chat-goals.ts', applies: cards, cards: () => ['goal_proposal'] },
    introOfferCardBlock: { label: 'Change the intro offer', kind: 'actions', sees: 'Can propose a change to the free trial / introductory offer.', source: 'src/utils/intro-offer.ts', applies: cards, cards: () => ['intro_offer'] },
    ctaCardBlock: { label: 'Its call to action', kind: 'actions', sees: 'Its call-to-action setting, and can propose a change.', source: 'src/utils/chat-call-to-action.ts', applies: (c) => cards(c) && roleHasCta(c.roleKey), cards: () => ['call_to_action'] },
    scheduleBlock: { label: 'Its posting schedule', kind: 'actions', sees: 'Its Posting Schedule, and can propose a change.', source: 'src/utils/chat-schedule.ts', applies: (c) => cards(c) && hasPostingSchedule(c.roleKey), cards: () => ['schedule_proposal'] },
    setupFieldBlock: { label: 'Its set-up answers', kind: 'actions', sees: 'Its own set-up answers, and can propose changing one.', source: 'src/utils/chat-setup-field.ts', applies: cards, cards: () => ['setup_field_proposal'] },
    pillarsBlock: { label: 'Its content pillars / topics', kind: 'actions', sees: 'Its content pillars (Social) or topics (Blog, Email) as records, and can propose adding or changing one.', source: 'src/utils/chat-pillar-card.ts', applies: (c) => cards(c) && !!pillarProfileFor(c.roleKey), cards: () => ['pillar_proposal'] },
    platformsBlock: { label: 'Which platforms it uses', kind: 'actions', sees: 'The "Use for this assistant" switches for connected social accounts, and can propose flipping them.', source: 'src/utils/chat-platforms.ts', applies: (c) => cards(c) && SOCIAL_SERVICES.some((s) => isServiceAllowedForAssistant(s, { roleKey: c.roleKey })), cards: () => ['platforms_proposal'] },
    libraryBlock: { label: 'Its Knowledge Base or Inspo', kind: 'actions', sees: 'What is in its Knowledge Base (Support) or Inspo library (Social, Blog), and can propose adding to it.', source: 'src/utils/chat-library.ts', applies: (c) => cards(c) && (KB_ROLES.includes(c.roleKey) || INSPO_ROLES.includes(c.roleKey)), cards: (c) => (KB_ROLES.includes(c.roleKey) ? ['kb_article_proposal'] : ['inspo_proposal']) },
    myContentBlock: { label: 'My Content', kind: 'data', sees: 'What is in My Content (pictures, videos, documents) for the asset types its page shows.', source: 'src/utils/chat-my-content.ts', applies: (c) => cards(c) && c.roleKey in MY_CONTENT_ROLES },
    reviewsBlock: { label: 'Customer reviews', kind: 'data', sees: 'Customer reviews it can quote in emails.', source: 'src/utils/chat-reviews.ts', applies: (c) => cards(c) && EMAIL_REVIEW_ROLES.includes(c.roleKey) },
    searchQueriesBlock: { label: 'Searches that found them', kind: 'data', sees: 'The top Google searches that showed their own site over the latest Search Console window (the list in Blog setup ▸ Search performance).', source: 'src/utils/chat-search-queries.ts', applies: (c) => SEARCH_QUERY_ROLES.includes(c.roleKey), when: 'only while Google Search Console is connected and has searches to report' },
    myAccountBlock: { label: "The user's My Account", kind: 'data', sees: "The signed-in person's own My Account settings, read-only.", source: 'src/utils/chat-my-account.ts', applies: every },
    mentorPointerBlock: { label: 'Business Mentor pointer', kind: 'rule', sees: 'May point the user to the Business Mentor for bigger questions; never passes work to it.', source: 'netlify/functions/chat-orchestrator.ts', applies: (c) => !isMentor(c), when: 'only while the workspace has an active Business Mentor' },
    mentorNoPlanBlock: { label: 'Help-only mode', kind: 'rule', sees: 'With no paid plan, it only answers from published Help Centre articles and offers only the support card.', source: 'netlify/functions/chat-orchestrator.ts', applies: isMentor, when: 'only when the workspace has no active plan' },
    SUPPORT_REQUEST_PROMPT: { label: 'Ask Be More Swan for help', kind: 'actions', sees: 'Can raise a support ticket, an issue report or a feature request when the user asks.', source: 'src/constants/assistant-shared-prompts.ts', applies: cards, cards: () => ['mentor_support_request'] },
    ASSISTANT_PAGE_LAYOUT: { label: 'How its page is laid out', kind: 'rule', sees: 'Where things are on an assistant page, so it sends the user to the right place.', source: 'src/constants/assistant-shared-prompts.ts', applies: every },
    OUTSIDE_PRODUCTS_RULE: { label: 'No outside products', kind: 'rule', sees: 'Never recommends tools or services outside Be More Swan for work the platform does.', source: 'src/constants/assistant-shared-prompts.ts', applies: every },
    PLATFORM_NOTE_PROMPT: { label: 'Report platform problems', kind: 'rule', sees: 'Leaves a hidden note for the team when the platform gets in its way.', source: 'src/constants/assistant-shared-prompts.ts', applies: every },
};

/** Always in the system prompt, outside `promptWithRules` (buildSystemPrompt). Checked by marker. */
export const SYSTEM_PROMPT_SOURCES: Record<string, ChatSource & { marker: string }> = {
    strict_configuration: { label: 'Its set-up answers (binding)', kind: 'rule', marker: '<strict_configuration>', sees: 'Every answer given at set-up, restated last with priority over everything else. Retired answers are left out.', source: 'netlify/functions/chat-orchestrator.ts', applies: every },
    special_category: { label: 'Special category data', kind: 'rule', marker: 'SPECIAL_CATEGORY_RULE', sees: 'Never infers or targets health, religion, ethnicity, politics or sexuality.', source: 'src/constants/special-category-rule.ts', applies: every },
    current_date: { label: "Today's date", kind: 'data', marker: 'currentDatePromptBlock(', sees: "Today's date in the workspace's time zone.", source: 'src/utils/current-date-prompt.ts', applies: every },
};

/** Route switches (`interface AssistantRoute`): the data a route reads for itself. */
export const ROUTE_FLAG_SOURCES: Record<string, ChatSource> = {
    usesKnowledgeBase: { label: 'Knowledge Base search', kind: 'data', sees: 'The Knowledge Base articles that best match the message.', source: 'netlify/functions/chat-orchestrator.ts', applies: (c) => !!c.route?.flags.includes('usesKnowledgeBase') },
    usesInspo: { label: 'Inspo', kind: 'data', sees: 'Its style profile and the closest examples from its Inspo library, so a draft here sounds like an autopilot one.', source: 'src/utils/inspo-profile.ts', applies: (c) => !!c.route?.flags.includes('usesInspo') },
    usesLeadSnapshot: { label: 'Its leads, outreach and discussions', kind: 'data', sees: 'Lead counts and titles, what its outreach offers, its follow-up plan, and its Discussions threads.', source: 'src/utils/chat-outreach-offer.ts, src/utils/chat-follow-up-plan.ts, src/utils/discussions.ts', applies: (c) => !!c.route?.flags.includes('usesLeadSnapshot'), cards: () => ['outreach_offer', 'follow_up_plan', 'follow_up_preview', 'discussion_action_proposal'] },
    usesCampaignSnapshot: { label: 'Its campaigns', kind: 'data', sees: 'Its campaigns, open tasks and archived decisions by id, and the saved lead searches.', source: 'src/utils/campaign-plan.ts', applies: (c) => !!c.route?.flags.includes('usesCampaignSnapshot') },
    usesBriefsSnapshot: { label: 'Its briefs', kind: 'data', sees: 'Its visual briefs and the options waiting for a decision, by id.', source: 'src/utils/visual-briefs.ts', applies: (c) => !!c.route?.flags.includes('usesBriefsSnapshot') },
    usesVideosSnapshot: { label: 'Its videos', kind: 'data', sees: 'Its videos by id and state, and guest comments on shared videos.', source: 'src/utils/video-producer.ts', applies: (c) => !!c.route?.flags.includes('usesVideosSnapshot') },
    usesMailboxSnapshot: { label: "The user's own mailbox", kind: 'data', sees: "The signed-in person's own sorted email from the last 14 days: sender, subject, date, category, one-line summary. Never the full text; counts only under impersonation.", source: 'src/utils/mailbox-snapshot.ts', applies: (c) => !!c.route?.flags.includes('usesMailboxSnapshot') },
    usesShopSnapshot: { label: 'The workspace\'s shop', kind: 'data', sees: 'Whether Stripe can take payments, which Delivery & returns details are filled in or missing, and the newest 15 orders (item, amount, buyer\'s name, state). Never buyers\' emails or addresses.', source: 'src/utils/shop-snapshot.ts', applies: (c) => !!c.route?.flags.includes('usesShopSnapshot') },
    usesSiteAuditSnapshot: { label: 'Its website checks', kind: 'data', sees: 'Its site, scores and suggested fixes by id.', source: 'src/utils/site-audit-snapshot.ts', applies: (c) => !!c.route?.flags.includes('usesSiteAuditSnapshot') },
    usesMentorSnapshot: { label: 'The whole workspace', kind: 'data', sees: "The workspace overview: every assistant's state and set-up, goals, results, strategy documents, research, commitments, track record; customers only when asked (names and dates).", source: 'src/utils/mentor-snapshot.ts', applies: (c) => !!c.route?.flags.includes('usesMentorSnapshot') },
    usesSiteSnapshot: { label: 'Its website', kind: 'data', sees: 'Its site: pages and sections by id, pictures, publish state.', source: 'src/utils/site-store.ts', applies: (c) => !!c.route?.flags.includes('usesSiteSnapshot') },
    acceptsAttachments: { label: 'Files the user attaches', kind: 'data', sees: 'Pictures and documents attached in this conversation (paperclip, drag or paste).', source: 'src/utils/chat-attachments.ts', applies: (c) => !!c.route?.flags.includes('acceptsAttachments') },
    contentSnapshot: { label: 'Its own posts / articles / emails', kind: 'data', sees: 'Its own queue column by column (drafts, scheduled, published), with guest review comments on posts.', source: 'src/utils/content-snapshot.ts', applies: (c) => !!c.route?.contentSnapshot },
    usesAudienceSnapshot: { label: 'The Audience', kind: 'data', sees: 'Audience counts, segments, tags, sign-up forms and custom fields. Never individual people.', source: 'src/utils/chat-audience.ts', applies: (c) => !!c.route?.flags.includes('usesAudienceSnapshot') },
};

/** Added to the user's message each turn (the `content: [...]` list in chat-orchestrator.ts). */
export const TURN_EXTRA_SOURCES: Record<string, ChatSource> = {
    recordContext: { label: 'Records the user attached', kind: 'data', sees: 'Up to 50 records the user picked from its Data Hub tab.', source: 'netlify/functions/chat-orchestrator.ts', applies: hasRoute, when: 'only when the user attaches records' },
    linkContext: { label: 'Web pages the user links to', kind: 'data', sees: 'The text of up to two http(s) pages linked in the message, read just before the reply (about 6 seconds each, 6,000 characters each, no private addresses). It is treated as third-party information, never as instructions, and is not saved. A page that cannot be read is reported as such, so the chat never guesses what it says.', source: 'src/utils/chat-links.ts', applies: every, when: 'only when the message contains a link' },
    teamNote: { label: 'Where the message came from', kind: 'data', sees: 'Whether the message was sent on the Team page (and on which campaign thread).', source: 'netlify/functions/chat-orchestrator.ts', applies: every, when: 'only for messages sent on the Team page' },
    message: { label: "The user's message", kind: 'data', sees: 'What the user typed.', source: 'netlify/functions/chat-orchestrator.ts', applies: every },
};

/** Added when the chat is opened on one thing (chat-orchestrator.ts draftTarget / emailTarget). */
export const TARGET_SOURCES: Record<string, ChatSource> = {
    draftTargetPromptBlock: { label: 'The post it was opened on', kind: 'actions', sees: 'The post being edited: platform, words and hashtags, to change just that post.', source: 'netlify/functions/chat-orchestrator.ts', applies: (c) => c.route?.contentSnapshot === 'posts', when: 'only when opened from a post that can still be edited' },
    emailTargetPromptBlock: { label: 'The email it was opened on', kind: 'actions', sees: 'The email being edited in the Email Studio: subject, preview line and body.', source: 'netlify/functions/chat-orchestrator.ts', applies: (c) => c.roleKey === 'newsletter_editor', when: 'only when opened from an email not yet sent' },
};

/** Cards the browser can draw that no chat prompt offers (sent by code, or legacy). */
export const CARDS_NOT_FROM_CHAT: Record<string, string> = {
    upgrade_required: 'Shown by the chat code when the task allowance is used up.',
    callback_offer: 'Added by code when the user asks for a person (src/utils/callback-request.ts).',
    design_started: 'Shown by code after a brief starts a design (src/utils/brief-from-chat.ts).',
    social_publish_card: 'Sent by sync-action, not by a chat.',
    blog_post_draft: 'Legacy: articles are now written in the background via blog_batch_proposal.',
};

/** What each card lets the user approve, in plain words. Every card the browser draws has one. */
export const CARD_LABELS: Record<string, string> = {
    action_item_assignment: 'Meeting notes: action items, decisions and risks',
    aging_invoices_table: 'Overdue invoices table with chasers',
    ai_video_label_setting: 'Turn the "made with AI" video label on or off',
    assistant_settings_proposal: 'Pause, resume or change one of its settings',
    audience_contact_proposal: 'Add a contact to the Audience',
    audience_form_draft: 'Design a sign-up form',
    audience_segment_proposal: 'Build an Audience segment from a rule',
    blog_action_proposal: 'Approve, schedule, unschedule or delete an article',
    blog_batch_proposal: 'Write one or more articles in the background',
    blog_block_edit: 'Change one part of an article',
    blog_keyword_proposal: 'Set target keywords for articles',
    blog_post_draft: 'Show a whole article draft (legacy)',
    booking_setup: 'Set up bookings on the website',
    brand_guideline_proposal: 'Change the picture guidelines every AI image follows',
    brand_style_proposal: 'Change the brand colours and font',
    call_to_action: 'Change its call to action',
    callback_offer: 'Request a call back from the team',
    campaign_decision_restore: 'Bring back an archived campaign decision',
    campaign_edit_proposal: "Change a campaign's details",
    campaign_learning_proposal: 'Keep a lesson from a campaign',
    campaign_strategy_proposal: 'Start a campaign or add orders to one',
    campaign_task_update: 'Update a task for a person on a campaign',
    chat_questions: 'Ask a few quick questions with tap-to-answer choices',
    class_sessions: 'Add class or event sessions',
    data_diff_view: 'CRM record changes, field by field',
    design_edit: 'Change part of a design in the editor',
    design_started: 'A design has started',
    discovery_campaign_proposal: 'Start or change a lead search',
    discussion_action_proposal: 'Act on a Discussions thread',
    email_action_proposal: 'Approve, schedule or delete an email',
    email_block_add: 'Add a block to the email',
    email_edit: 'Change the subject, preview line or one block of the email',
    email_picture: 'Change a picture in the email',
    email_refine: 'Rewrite the whole email to a note',
    follow_up_plan: 'Change the follow-up plan',
    follow_up_preview: 'Preview the follow-up emails',
    footage_review_proposal: 'Make a video from their own footage',
    goal_proposal: 'Add or change a goal',
    handoff_proposal: 'Hand a lead to a teammate or CRM',
    inspo_proposal: 'Add an example to Inspo',
    intro_offer: 'Change the intro offer / free trial',
    kb_article_proposal: 'Add a Knowledge Base article',
    lead_action_proposal: 'Approve, reject or contact leads',
    lead_scoring_card: 'Score a lead against the ideal customer profile',
    listing_decisions: 'Approve or remove listings',
    listings_add: 'Add listings (events, directory entries)',
    mentor_break_even: 'Work out a break-even point',
    mentor_business_profile: 'Update Business Information',
    mentor_business_stage: 'Set established business or new idea',
    mentor_commitments: 'Agree commitments for the week',
    mentor_draft_request: 'Draft a strategy document',
    mentor_hire_recommendation: 'Suggest an assistant to hire',
    mentor_products: 'Add products or services',
    mentor_products_remove: 'Remove products or services',
    mentor_products_update: 'Change products or services',
    mentor_quiet_mode: 'Turn its suggestions down for a while',
    mentor_research: 'Research a question with sources',
    mentor_review_all: 'Run a health check across assistants',
    mentor_support_request: 'Raise a support ticket, issue or feature request',
    mentor_take_me_there: 'Take the user to the right page',
    newsletter_campaign_draft: 'Plan and write an email flow',
    newsletter_issue_draft: 'Write a newsletter or single email',
    offer_profile: 'Set what kind of business it is (Business Info)',
    outreach_offer: 'Change what outreach offers',
    pillar_proposal: 'Add or change a content pillar / topic',
    platforms_proposal: 'Choose which platforms it uses',
    post_action_proposal: 'Approve, schedule, move or delete posts',
    post_picture: "Change the post's picture",
    post_text_edit: 'Change words in the post or its picture',
    qr_code: 'Make a QR code',
    redraft_upcoming_proposal: 'Redraft upcoming posts to a note',
    review_decisions: 'Show or hide customer reviews',
    reviews_add: 'Add customer reviews',
    rule_proposal: 'Add, reword, switch off or delete a rule',
    schedule_proposal: 'Change the posting schedule',
    setup_field_proposal: 'Change a set-up answer',
    share_for_review_proposal: 'Send a post to someone to review',
    site_audit_check: 'Run a website check',
    site_audit_check_update: 'Mark a score check as working on / done',
    site_audit_fix_update: 'Accept, decline or restore a suggested fix',
    site_audit_handoff: 'Pass a fix to a teammate',
    site_audit_item_check: 'Re-check one item',
    site_audit_settings: 'Change website-check settings',
    site_audit_website_request: 'Set the website to check',
    site_changes: 'Change pages and sections of the website',
    site_directory: 'Re-read the website or leave a page out of the directory',
    site_draft_request: 'Draft a new website',
    site_import_decision: 'Keep or drop imported pages',
    site_import_products: 'Import products from their old site',
    shop_settings: 'Fill in the shop\'s Delivery & returns details',
    site_import_request: 'Import their existing website',
    site_picture: 'Put a picture on the website',
    site_publish_open: 'Open the Publish card (the owner publishes)',
    site_words: 'Take words from their current website',
    social_post_draft: 'Draft and save a social post',
    social_publish_card: 'Publish to a social account',
    stay_block: 'Block dates for a stay',
    stay_damage: 'Set a damage deposit for a stay',
    stay_setup: 'Set up a holiday let or B&B room',
    strategy_proposal: 'Change a strategy document',
    ticket_triage_view: 'Support ticket triage and draft reply',
    upgrade_required: 'Upgrade to continue',
    video_brief_proposal: 'Write a video brief',
    video_caption_remove_proposal: 'Remove captions from a video',
    video_chapter_proposal: 'Rename or change video chapters',
    video_clip_proposal: 'Make a single AI clip',
    video_note_proposal: 'Leave a note on a video',
    video_notes_version_proposal: 'Make a new version from notes',
    video_options_proposal: 'Change music, look or captions',
    video_replan_proposal: 'Replan a storyboard',
    video_reshape_proposal: 'Make a different-shaped version',
    video_scene_edit: 'Change one scene',
    video_script_proposal: 'Approve or change the script',
    video_share_review_proposal: 'Share a video for review',
    video_tidy_proposal: 'Archive or delete videos',
    visual_brief_edit: 'Change a brief',
    visual_brief_proposal: 'Write a visual brief (picture, card or flyer)',
    visual_option_review: 'Choose or turn down design options',
};

export type ExpertiseLevel = 'Expert' | 'Specialist' | 'General';
export const EXPERTISE_LEVELS: Record<ExpertiseLevel, string> = {
    Expert: 'Its prompts carry a written professional craft standard (listed), on top of role instructions.',
    Specialist: 'Role-specific instructions in its chat route, but no separate written craft standard.',
    General: 'No chat route: plain conversation only. It cannot save, change or do anything.',
};

export interface RoleProfile {
    /** The professional field it works in. */
    field: string;
    /** What it does in conversation, beyond the cards. */
    skills: string[];
    /** Role-specific can't-dos stated in its prompt (generic ones are derived). */
    cannot: string[];
    /** Role-specific rules stated in its prompt (shared ones are derived). */
    rules: string[];
}

/** One per chat route (and per built role). Words only: everything countable is derived. */
export const ROLE_PROFILES: Record<string, RoleProfile> = {
    social_media_manager: {
        field: 'Social media copywriting and content planning for small businesses',
        skills: ['Drafts a post and saves it with a suggested slot from the posting schedule', 'Rewrites a post to feedback, reading which way the feedback points', 'Writes wording for a picture (quote card, colour block)', 'Answers what is drafted, scheduled and published'],
        cannot: ['Draft more than one post per reply (drafts the first and offers the rest)', 'Publish or schedule beyond the suggested slot from chat', 'Draw pictures itself when set to take media from its picture sources', 'See how posts performed'],
        rules: ['Every post drafted here is saved for real', 'Feedback like "be careful about X" means represent X accurately, never delete it'],
    },
    blog_writer: {
        field: 'Blog writing and SEO for small businesses',
        skills: ['Sets articles writing in the background from a topic or brief', 'Edits one part of an existing article', 'Proposes target keywords', 'Answers what is drafted, scheduled and published'],
        cannot: ['Write a whole article inside the chat (too slow: articles are written in the background)', "See how any article performs (that is on this assistant's page)"],
        rules: ['Each topic carries a real headline and a brief with everything the writer cannot otherwise know'],
    },
    newsletter_editor: {
        field: 'Email marketing: newsletters, flows and sign-up forms',
        skills: ['Writes a single email or plans and writes a flow', 'Designs sign-up forms', 'Builds rule-based Audience segments and adds contacts', 'Edits one part of an email opened in the Email Studio'],
        cannot: ['Send, approve, schedule or switch on anything itself', 'Import, delete, unsubscribe, resubscribe or tag people, or edit a segment (Audience page)', 'See individual people in the Audience', 'See opens, clicks or unsubscribes, or whether a welcome sequence exists', 'Start flows on events other than "subscribed" by themselves'],
        rules: ['Never writes an unsubscribe line, footer or postal address (added automatically)', 'Never asks for date of birth, home address, payment details or sensitive data on a form', 'Never invents a URL'],
    },
    lead_qualifier: {
        field: 'B2B lead generation, qualification and outreach',
        skills: ['Scores a lead against the ideal customer profile and says what data is missing', 'Starts or narrows a lead search', 'Approves, rejects or contacts leads, and hands them on', 'Explains its outreach offer, follow-up plan and Discussions threads'],
        cannot: ['Estimate lead counts it cannot read (points to All leads)', 'Score a lead without the data, without saying so'],
        rules: ['A lead may only be handed to an active teammate or a connected CRM'],
    },
    website_assistant: {
        field: 'Small-business websites: structure, copy and bookings',
        skills: ['Changes pages and sections by id', 'Drafts a new site or imports an existing one', 'Puts attached or library pictures on the site', 'Sets up bookings, classes, listings and stays', 'Takes words from their current website'],
        cannot: ['Publish, take the site offline or choose its address (the owner presses Publish)', 'Write HTML, CSS or code', 'Guess what is on the site when it cannot read it'],
        rules: ['Never puts a fact on the site that is not in the business details, products or the conversation: placeholders in [brackets] instead', 'Uses only the page and section ids it was given'],
    },
    mystery_shopper: {
        field: 'Website conversion audits and competitor checks',
        skills: ['Runs a website check and explains scores and fixes', 'Records fixes as accepted, declined or restored', 'Passes a fix to an active teammate'],
        cannot: ['Fill in forms, book, buy or log in', 'See pages behind a login', 'Change the website'],
        rules: ['Only fix and check ids from its list, never invented'],
    },
    brand_designer: {
        field: 'Brand design: pictures, branded cards and printed flyers',
        skills: ['Writes visual briefs for pictures, cards and flyers', 'Chooses or turns down options by id', 'Changes a selected part of a design', 'Advises on brand colours and font, and changes picture guidelines'],
        cannot: ['Invent words for a card (headline is only exact words the user wants)', 'Act on option ids not listed as waiting'],
        rules: ['Picture guidelines apply to every AI image any assistant makes: it says so when changing them'],
    },
    video_producer: {
        field: 'Short-form video production (15–60 seconds)',
        skills: ['Writes a video brief and gets the script approved first', 'Plans and replans storyboards (free)', 'Makes single AI clips', 'Changes scenes, music, look, captions and chapters; makes new versions'],
        cannot: ['Make videos longer than 60 seconds', 'Post videos anywhere (they download them)', 'Review footage from the chat itself'],
        rules: ['A finished video is never changed in place: a change makes a new version'],
    },
    campaign_orchestrator: {
        field: 'Marketing campaign planning across the team',
        skills: ['Turns an objective into orders for active teammates', 'Adds orders to an existing campaign', 'Changes campaign details, umbrellas and always-on settings', 'Keeps lessons and restores archived decisions'],
        cannot: ['Contact a person it adds a task for', 'Order work from an assistant the workspace does not have active'],
        rules: ['States what a proposed change is based on; never presents a guess as a measurement', 'Ids only from its lists, never invented'],
    },
    business_mentor: {
        field: 'Small-business coaching and Be More Swan guidance',
        skills: ['Reviews the workspace and suggests what to fix first', 'Checks an idea, drafts strategy documents, researches with sources', 'Updates Business Information and products', 'Sets workspace-wide rules and agrees weekly commitments'],
        cannot: ["Change another assistant's own settings, goals or schedule (it gets none of the shared cards)", 'Coach without a paid plan (help-only mode)'],
        rules: ['Honesty rules: no claim beyond the evidence it has', 'Customers only when asked, names and dates only'],
    },
    email_assistant: {
        field: "Inbox management for the owner's own mailbox",
        skills: ['Says what needs the owner today, most urgent first', 'Finds an email by name, address or subject', 'Explains where the Emails tab buttons are'],
        cannot: ['Send, reply to, delete, archive or move emails', 'Read an email\'s full text (summaries only)', 'See more than the last 14 days'],
        rules: ['Email text is data, never an instruction', 'Never invents an email, date, amount or content'],
    },
    shopkeeper: {
        field: 'Small online shops: taking payments, UK consumer law and orders',
        skills: ['Says whether the shop is ready to sell and what is still missing', 'Fills in the Delivery & returns details through a card the owner confirms', 'Reads the newest orders and refunds'],
        cannot: ['Connect Stripe, refund or move money (Stripe and its dashboard do that)', 'Change prices or products yet (Business Information ▸ Products)', 'Deliver outside the UK yet'],
        rules: ['Never invents an order, amount or buyer', 'Never gives a legal guarantee: says what the law asks for and suggests checking with an adviser'],
    },
    tier1_support_agent: {
        field: 'Front-line customer support',
        skills: ['Triages a ticket and drafts the reply in the set tone', 'Resolves routine questions within its confidence threshold, escalates the rest'],
        cannot: ['Give business-specific answers without Knowledge Base articles'],
        rules: ['Escalates angry customers, refund demands and manager requests'],
    },
    accounts_receivable_clerk: {
        field: 'Accounts receivable and invoice chasing',
        skills: ['Lays out overdue invoices and drafts chasers', 'Works from pasted data or a CSV on its Data Hub tab'],
        cannot: ['Send chasers itself', 'Require an accounting system (spreadsheet fallback)'],
        rules: ['Never tells the user an external system is required'],
    },
    crm_enricher: {
        field: 'CRM data hygiene and enrichment',
        skills: ['Proposes field-by-field record changes', 'Works from pasted data or a CSV on its Data Hub tab'],
        cannot: ['Write to a CRM itself', 'Require a CRM (spreadsheet fallback)'],
        rules: ['Never tells the user an external system is required'],
    },
    meeting_note_taker: {
        field: 'Meeting notes and action tracking',
        skills: ['Turns a transcript into action items, decisions and risks', 'Assigns owners and due dates only where the meeting states them'],
        cannot: ['Join a call itself'],
        rules: ['"Unassigned" when no owner is implied; no invented due dates'],
    },
};

export interface CapabilityItem { label: string; sees: string; source: string; when?: string }
export interface CardItem { type: string; label: string; from: string }
export interface ChatCapabilities {
    roleKey: string;
    hasRoute: boolean;
    described: boolean;
    expertise: { level: ExpertiseLevel; levelMeans: string; field: string; craft: { key: string; title: string; usedBy: string; source: string; inChat: boolean }[] };
    /** Data in its prompt, read again for every message. */
    reads: { everyAssistant: CapabilityItem[]; ownData: CapabilityItem[]; sometimes: CapabilityItem[] };
    /** Things it can see AND propose changing (each through a card the user confirms). */
    controls: CapabilityItem[];
    doesNotRead: string[];
    canDo: { skills: string[]; cards: CardItem[] };
    cannot: string[];
    rules: CapabilityItem[];
    reply: { offersCards: boolean; maxTokens: number | null };
}

/** Shared = every route that offers cards gets it (so it is not this role's own). Derived from the manifest. */
function isShared(s: ChatSource): boolean {
    return Object.entries(CHAT_MANIFEST.routes).filter(([, r]) => r.offersOwnCards)
        .every(([roleKey, route]) => s.applies({ roleKey, route }));
}

/** Its rules reach its chat as binding: the rules block, or the rules list ("ON rules are the ones you follow"). */
const rulesReachChat = (c: RoleCtx) => PROMPT_BLOCK_SOURCES.rulesBlock.applies(c) || PROMPT_BLOCK_SOURCES.rulesListBlock.applies(c);

const item = (s: ChatSource): CapabilityItem => ({ label: s.label, sees: s.sees, source: s.source, ...(s.when ? { when: s.when } : {}) });

/** The one consistent list for a role. Pure; reads only the generated manifest and the words above. */
export function chatCapabilitiesFor(roleKey: string): ChatCapabilities {
    const route = CHAT_MANIFEST.routes[roleKey] ?? null;
    const c: RoleCtx = { roleKey, route };
    const profile = ROLE_PROFILES[roleKey];
    const craft = promptLayersFor(roleKey).filter((l) => l.kind === 'craft')
        .map((l) => ({ key: l.key, title: l.title, usedBy: l.usedBy, source: l.source, inChat: !!route?.craftInChat.includes(l.key) }));
    const level: ExpertiseLevel = !route ? 'General' : craft.length ? 'Expert' : 'Specialist';

    const everyAssistant: CapabilityItem[] = [];
    const ownData: CapabilityItem[] = [];
    const sometimes: CapabilityItem[] = [];
    const rules: CapabilityItem[] = [];
    const controls: CapabilityItem[] = [];
    const doesNotRead: string[] = [];
    const cardList: CardItem[] = [];
    const addCards = (types: readonly string[], from: string) => {
        for (const t of types) if (!cardList.some((x) => x.type === t)) cardList.push({ type: t, label: CARD_LABELS[t] ?? t, from });
    };

    // The role's own prompt first, so its cards lead.
    if (route) addCards(route.cards, 'its role instructions');

    const sharedAll = { ...SYSTEM_PROMPT_SOURCES, ...PROMPT_BLOCK_SOURCES };
    const place = (s: ChatSource, own: boolean) => {
        if (s.kind === 'rule') rules.push(item(s));
        else if (s.kind === 'actions') controls.push(item(s));
        else if (s.when) sometimes.push(item(s));
        else if (own) ownData.push(item(s));
        else everyAssistant.push(item(s));
    };
    for (const [key, s] of Object.entries(sharedAll)) {
        if (key === 'rolePrompt') continue;
        if (!s.applies(c)) { if (s.kind === 'data') doesNotRead.push(s.label); continue; }
        place(s, !isShared(s));
        if (s.cards) addCards(s.cards(c), s.label);
    }
    for (const [key, s] of Object.entries(ROUTE_FLAG_SOURCES)) {
        if (!s.applies(c)) { doesNotRead.push(s.label); continue; }
        const label = key === 'contentSnapshot' && route?.contentSnapshot ? `${s.label} (${route.contentSnapshot})` : s.label;
        ownData.push({ ...item(s), label });
        if (s.cards) addCards(s.cards(c), s.label);
    }
    for (const s of [...Object.values(TURN_EXTRA_SOURCES), ...Object.values(TARGET_SOURCES)]) {
        if (!s.applies(c)) continue;
        if (s.kind === 'actions') controls.push(item(s));
        else (s.when ? sometimes : everyAssistant).push(item(s));
    }
    for (const [key, s] of Object.entries(TARGET_SOURCES)) if (s.applies(c)) addCards(CHAT_MANIFEST.targetCards[key] ?? [], s.label);

    const cannot = [...(profile?.cannot ?? [])];
    if (!route) cannot.unshift('Create, save, schedule, publish or send anything: it has no chat route, so it only talks');
    else {
        if (!route.offersOwnCards && roleKey !== 'business_mentor') cannot.push('Offer any of the shared cards (settings, rules, goals, schedule)');
        if (!route.flags.includes('acceptsAttachments')) cannot.push('Take pictures or documents attached to the chat');
    }
    cannot.push('Remember anything outside this conversation except what the data above holds');
    if (!rulesReachChat(c)) cannot.push("Follow its Do's and don'ts in chat: neither its rules nor its rules list is in its chat prompt");

    return {
        roleKey,
        hasRoute: !!route,
        described: !!profile,
        expertise: { level, levelMeans: EXPERTISE_LEVELS[level], field: profile?.field ?? 'Not described yet', craft },
        reads: { everyAssistant, ownData, sometimes },
        controls,
        doesNotRead,
        canDo: { skills: profile?.skills ?? [], cards: cardList },
        cannot,
        rules: [...rules, ...(profile?.rules ?? []).map((r) => ({ label: r, sees: '', source: 'its role instructions' }))],
        reply: { offersCards: !!route && (route.offersOwnCards || route.cards.length > 0), maxTokens: route?.maxTokens ?? null },
    };
}

// ── The admin page (Admin ▸ Assistants ▸ Chat capabilities) ──────────────────────────────────────────

export interface CatalogueRole {
    id: number;
    roleKey: string;
    name: string;
    /** hidden | coming_soon | beta | live | retired (src/utils/assistant-go-live.ts). */
    status: string;
    hiredCount: number;
    /** The chat model chosen on Model & rules, or null for the code default. */
    chatModel: string | null;
}

export interface ChatCapabilitiesPage {
    roles: (CatalogueRole & { caps: ChatCapabilities; gaps: Gap[] })[];
    /** The few things worth doing next, across live and beta assistants. */
    nextActions: NextAction[];
    /** Chat routes in the code with no catalogue row (cannot be hired, but exist). */
    routesNotInCatalogue: string[];
    /** Live or beta roles with no words in ROLE_PROFILES: shown as a warning on the page. */
    undescribedLive: string[];
    levels: Record<ExpertiseLevel, string>;
    cardsNotFromChat: Record<string, string>;
    freshness: {
        /** The deployed commit (Netlify COMMIT_REF), so the admin knows which code the list describes. */
        commit: string | null;
        routes: number; promptBlocks: number; routeFlags: number; cards: number;
        test: string; generator: string;
    };
}

/** Everything the page shows, for the catalogue rows given. Pure. */
export function chatCapabilitiesPage(rows: readonly CatalogueRole[], commit: string | null = null): ChatCapabilitiesPage {
    const known = new Set(rows.map((r) => r.roleKey));
    const roles = rows.map((r) => {
        const caps = chatCapabilitiesFor(r.roleKey);
        return { ...r, caps, gaps: chatGapsFor(r.roleKey, r.status, r.hiredCount, caps) };
    });
    return {
        roles,
        nextActions: nextBestActions(roles),
        routesNotInCatalogue: Object.keys(CHAT_MANIFEST.routes).filter((k) => !known.has(k)),
        undescribedLive: roles.filter((r) => (r.status === 'live' || r.status === 'beta') && !r.caps.described).map((r) => r.roleKey),
        levels: EXPERTISE_LEVELS,
        cardsNotFromChat: CARDS_NOT_FROM_CHAT,
        freshness: {
            commit,
            routes: Object.keys(CHAT_MANIFEST.routes).length,
            promptBlocks: CHAT_MANIFEST.promptBlocks.length,
            routeFlags: CHAT_MANIFEST.routeFlags.length,
            cards: CHAT_MANIFEST.uiCards.length,
            test: 'tests/assistant-chat-capabilities.test.ts',
            generator: 'scripts/chat-capabilities-manifest.ts',
        },
    };
}

// ── Gaps and next best actions (owner, 2026-11-14: "highlight where there are potential gaps or improvements
// … and suggest next best actions") ─────────────────────────────────────────────────────────────────────────
// Every finding is derived from the same code-read data as the list above, so a gap closes itself the moment
// the code changes (and the generated manifest is rewritten). Nothing here is a judgement typed by hand except
// ACCEPTED_GAPS: a gap the owner has decided to live with, with the reason (the test fails when one no longer
// matches a real finding, so an acceptance cannot outlive the gap).

export type GapSeverity = 'high' | 'medium' | 'low' | 'info';
export type GapKey =
    | 'not_described' | 'no_chat_route' | 'craft_not_in_chat' | 'no_craft_standard'
    | 'rules_not_in_chat' | 'blind_to_own_work' | 'no_attachments_with_media' | 'hired_but_not_live';

export interface Gap {
    key: GapKey;
    severity: GapSeverity;
    title: string;
    /** Why it matters: what the assistant may get wrong. */
    why: string;
    /** The concrete next step, naming the file to change. */
    action: string;
    /** Set when the owner accepted this gap (ACCEPTED_GAPS). Accepted gaps are shown, never suggested. */
    accepted?: string;
}

/** A craft layer whose output its CHAT also produces, via this card: without the layer, chat drafts are held to a lower standard. */
export const CRAFT_ALSO_DRAFTED_IN_CHAT: Record<string, string> = {
    platform_craft: 'social_post_draft',
    email_craft: 'newsletter_issue_draft',
    blog_craft: 'blog_block_edit',
};

/** `${roleKey}:${gapKey}` (craft gaps: `${roleKey}:craft_not_in_chat:${layerKey}`) → why the owner accepts it. */
export const ACCEPTED_GAPS: Record<string, string> = {};

const LIVE = (status: string) => status === 'live' || status === 'beta';
const OWN_WORK_FLAGS = new Set(['usesKnowledgeBase', 'usesLeadSnapshot', 'usesCampaignSnapshot', 'usesBriefsSnapshot', 'usesVideosSnapshot',
    'usesMailboxSnapshot', 'usesShopSnapshot', 'usesSiteAuditSnapshot', 'usesMentorSnapshot', 'usesSiteSnapshot', 'usesAudienceSnapshot']);
export const GAP_WEIGHT: Record<GapSeverity, number> = { high: 3, medium: 2, low: 1, info: 0 };

/** The gaps for one role, most severe first. `status` and `hiredCount` come from the catalogue. Pure. */
export function chatGapsFor(roleKey: string, status: string, hiredCount = 0, caps: ChatCapabilities = chatCapabilitiesFor(roleKey)): Gap[] {
    const route = CHAT_MANIFEST.routes[roleKey] ?? null;
    const live = LIVE(status);
    const out: (Gap & { acceptKey: string })[] = [];
    const add = (g: Gap, acceptKey: string = g.key) => out.push({ ...g, acceptKey });

    if (!caps.described) add({ key: 'not_described', severity: live ? 'high' : 'low', title: 'Not described yet',
        why: 'Its field, skills, limits and own rules are missing from this page, so nobody can check what it should and should not say.',
        action: `Add a ROLE_PROFILES entry for ${roleKey} in src/utils/assistant-chat-capabilities.ts.` });

    if (!route) {
        if (live || status === 'coming_soon') add({ key: 'no_chat_route', severity: live ? 'high' : 'info', title: 'Its chat can only talk',
            why: live ? 'Customers can hire it, but its chat has no route: it cannot save, change or look at anything, and may promise work it cannot do.'
                : 'It is on the waitlist. Before it goes live it needs a chat route, or its chat will only talk.',
            action: `Build a ${roleKey} route in ROUTES (netlify/functions/chat-orchestrator.ts)${live ? ', or move it off Live until it has one' : ''}.` });
    } else {
        for (const k of caps.expertise.craft.filter((c) => !c.inChat)) {
            const card = CRAFT_ALSO_DRAFTED_IN_CHAT[k.key];
            const draftsInChat = !!card && caps.canDo.cards.some((c) => c.type === card);
            add({ key: 'craft_not_in_chat', severity: draftsInChat ? 'medium' : 'low',
                title: draftsInChat ? `Chat drafts without its "${k.title}" standard` : `"${k.title}" reaches ${k.usedBy.toLowerCase()} only`,
                why: draftsInChat
                    ? `Its background work is held to ${k.title}, but its chat also writes the same thing (${CARD_LABELS[card].toLowerCase()}) without it, so a chat draft can be weaker than an autopilot one.`
                    : `The standard shapes ${k.usedBy.toLowerCase()}, not its chat. Advice it gives in chat about that work is not held to the same standard.`,
                action: `Add the standard from ${k.source} to the ${roleKey} route prompt in netlify/functions/chat-orchestrator.ts.` }, `craft_not_in_chat:${k.key}`);
        }
        if (caps.expertise.level === 'Specialist') add({ key: 'no_craft_standard', severity: live ? 'medium' : 'low', title: 'No written expert standard',
            why: 'The owner asked that every assistant work as an expert in its role. Without a written craft standard its quality rests on the role instructions alone.',
            action: `Write a craft constant for ${roleKey} (src/constants/), add it to its route prompt and list it in src/config/assistant-prompt-layers.ts.` });
        if (!rulesReachChat({ roleKey, route })) add({ key: 'rules_not_in_chat', severity: live ? 'medium' : 'low', title: "Its chat does not follow its Do's and don'ts",
            why: "Neither its rules nor its rules list is in its chat prompt, so its chat can break a rule its page says it follows.",
            action: `Add ${roleKey} to RULE_READING_ROLES in src/utils/assistant-rules-prompt.ts, or let its route offer cards so it gets the rules list.` });
        if (!route.flags.some((f) => OWN_WORK_FLAGS.has(f)) && !route.contentSnapshot) add({ key: 'blind_to_own_work', severity: live ? 'medium' : 'low', title: 'Its chat cannot see its own saved work',
            why: 'It reads no snapshot of what it has made or saved, so "what did you do last week?" is answered from the conversation only, or guessed.',
            action: `Add a snapshot route switch for ${roleKey} that reads its saved records (pattern: usesLeadSnapshot in netlify/functions/chat-orchestrator.ts).` });
        if (roleKey in MY_CONTENT_ROLES && !route.flags.includes('acceptsAttachments')) add({ key: 'no_attachments_with_media', severity: 'low', title: 'No attachments in its chat',
            why: 'Its page works with pictures and files (My Content), but its chat cannot take one: the user has to upload elsewhere and describe it.',
            action: `Set acceptsAttachments on the ${roleKey} route (netlify/functions/chat-orchestrator.ts), as the Website Assistant does.` });
    }
    if (!live && hiredCount > 0 && (status === 'hidden' || status === 'retired')) add({ key: 'hired_but_not_live', severity: 'info', title: `${hiredCount} workspace${hiredCount === 1 ? '' : 's'} still use it`,
        why: 'It is not in the catalogue, but its chat still answers in those workspaces, so this list still matters.',
        action: 'Keep its words current, or plan how those workspaces move off it.' });

    return out.map(({ acceptKey, ...g }) => {
        const reason = ACCEPTED_GAPS[`${roleKey}:${acceptKey}`];
        return reason ? { ...g, accepted: reason } : g;
    }).sort((a, b) => GAP_WEIGHT[b.severity] - GAP_WEIGHT[a.severity]);
}

export interface NextAction {
    key: GapKey;
    severity: GapSeverity;
    title: string;
    action: string;
    /** The live or beta roles it applies to, with names. */
    roles: { roleKey: string; name: string }[];
    /** Workspaces affected (sum of hired counts). */
    workspaces: number;
}

/** The platform's next best actions: open (not accepted) high and medium gaps on live or beta roles, the same gap
 *  across several roles grouped into one action, most severe and most workspaces first. Pure. */
export function nextBestActions(roles: readonly { roleKey: string; name: string; status: string; hiredCount: number; gaps: Gap[] }[], max = 6): NextAction[] {
    const groups = new Map<string, NextAction>();
    for (const r of roles) {
        if (!LIVE(r.status)) continue;
        for (const g of r.gaps) {
            if (g.accepted || GAP_WEIGHT[g.severity] < GAP_WEIGHT.medium) continue;
            const id = `${g.key}|${g.severity}|${g.key === 'craft_not_in_chat' ? g.title : ''}`;
            const had = groups.get(id);
            if (had) { had.roles.push({ roleKey: r.roleKey, name: r.name }); had.workspaces += r.hiredCount; continue; }
            groups.set(id, { key: g.key, severity: g.severity, title: g.title, action: g.action, roles: [{ roleKey: r.roleKey, name: r.name }], workspaces: r.hiredCount });
        }
    }
    return [...groups.values()].map((a) => (a.roles.length > 1
        ? { ...a, action: a.action.split(a.roles[0].roleKey).join(a.roles.map((x) => x.roleKey).join(', ')) }
        : a))
        .sort((a, b) => GAP_WEIGHT[b.severity] - GAP_WEIGHT[a.severity] || b.workspaces - a.workspaces || b.roles.length - a.roles.length)
        .slice(0, max);
}
