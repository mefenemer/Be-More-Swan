import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  // `real`, not `numeric`: numeric comes back from postgres-js as a STRING, and every reader of a
  // duration wants to compare it against a limit. A seconds value is a number.
  real,
  numeric,
  decimal,
  jsonb,
  unique,
  uniqueIndex,
  varchar,
  index,
  check,
  uuid,
  date,
  vector,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Organisations table — companies or groups users belong to
export const organisations = pgTable('organisations', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  // US-AUD-5.3.1 SC1: opt-in agency attribution badge on exported deliverables
  agencyAttributionEnabled: boolean('agency_attribution_enabled').notNull().default(false),
  // US-LEGAL-1.6: explicit opt-in required before any inputs/outputs are used for model improvement.
  // Enterprise (Tier 4) accounts are locked to false and cannot opt in.
  dataTrainingOptIn: boolean('data_training_opt_in').notNull().default(false),
  // US-LEGAL-3.1: EU AI Act Art.50 — outbound AI content footer
  aiDisclosureFooterEnabled: boolean('ai_disclosure_footer_enabled').notNull().default(false),
  aiDisclosureFooterText: text('ai_disclosure_footer_text'),
  // US3 AC3.3: opt-in "Photo by … on Pexels" attribution line appended to drafts sourced from Pexels.
  pexelsAttributionEnabled: boolean('pexels_attribution_enabled').notNull().default(false),
  // Epic 3 US8: AI approvals email digest cadence — 'off' | 'daily' | 'weekly'. db/ai-digest.sql.
  aiDigestFrequency: text('ai_digest_frequency').notNull().default('off'),
  // Referral Program Expansion: extra assistant slots unlocked by redeeming referral tokens.
  // Stacks ON TOP of the Stripe tier's assistantLimit, so plan syncing is never touched (AC2.2/AC4.2).
  bonusAssistants: integer('bonus_assistants').notNull().default(0),
  // Business profile — assistant-facing context captured on the Business Information page.
  // (Legal/tax/registered-address details live in `billingInformation`, not here.)
  industry: text('industry'),
  businessDescription: text('business_description'),
  // Business-domain org grouping (#2). business_domain = the org owner's non-public email
  // host (null for public providers). allow_domain_join = owner opt-in: new signups with a
  // matching domain join this org instead of creating their own. domain_verified is reserved
  // for future DNS/email domain-ownership verification (owner opt-in is the gate for now).
  businessDomain: text('business_domain'),
  domainVerified: boolean('domain_verified').notNull().default(false),
  allowDomainJoin: boolean('allow_domain_join').notNull().default(false),
  websiteUrl: text('website_url'),
  // Visual brand identity — colours, wordmark, logo — used to render branded text cards
  // (src/lib/brand-card.ts). Prose brand context lives in businessDescription/targetAudience and
  // the assistant's onboardingContext; this is the half a renderer needs. Shape + defaults in
  // src/utils/brand-kit.ts, never read raw. db/brand-kit.sql.
  brandKit: jsonb('brand_kit'),
  socialLinks: text('social_links'),
  // Per-platform social handles/URLs captured on Business Information, keyed by
  // lowercase platform slug ({ instagram, facebook, linkedin, x, tiktok, ... }).
  // Single source of truth for handles; gates which Connections can be enabled.
  socialHandles: jsonb('social_handles').$type<Record<string, string>>(),
  targetAudience: text('target_audience'),
  // Gamification & Engagement:
  onboardingCompleted: boolean('onboarding_completed').notNull().default(false), // AC1.1.3 — 3-step widget done
  // Onboarding Wizard Step 5 (Compliance) — stamped when the AI-usage / data-processing
  // agreement is accepted (US6 AC2). NULL = not yet accepted. See get-wizard-state.ts.
  complianceAcceptedAt: timestamp('compliance_accepted_at'),
  betaAccess: boolean('beta_access').notNull().default(false),                    // AC3.1.2 — 50h-saved milestone
  bonusReferralTokens: integer('bonus_referral_tokens').notNull().default(0),     // AC3.1.3 — milestone token drops into the vault
  // Abuse Prevention US3: Stripe card fingerprint (hash of the physical card) for this workspace's
  // payment method, + the flag raised when the same fingerprint is seen on ≥2 workspaces.
  cardFingerprint: text('card_fingerprint'),
  billingReviewRequired: boolean('billing_review_required').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Core users table — the central entity all other tables reference
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  // DEPRECATED (US-DB-1.3.1): use userOrganisations junction table for all new queries.
  // Retained for zero-downtime migration; scheduled for removal in following sprint.
  organisationId: integer('organisation_id').references(() => organisations.id),
  email: text('email').notNull().unique(),

  // Authentication & Verification State
  status: text('status').notNull().default('pending_verification'),
  verificationToken: text('verification_token'),
  tokenExpiresAt: timestamp('token_expires_at'),
  // Rate-limit fence: set to NOW() each time a magic link is sent.
  // Concurrent requests check this with a DB-level conditional update to prevent race conditions.
  lastMagicLinkSentAt: timestamp('last_magic_link_sent_at'),

  // Platform role — 'user' (default) | 'admin' | 'super_admin'
  role: text('role').notNull().default('user'),

  // US-GAP-8.2: Referral programme — unique share code
  referralCode: text('referral_code').unique(),

  // US-GAP-2.1.1: Account deletion cooling-off period (24h)
  pendingDeletion: boolean('pending_deletion').default(false),
  pendingDeletionAt: timestamp('pending_deletion_at'),          // when deletion was requested
  deletionToken: text('deletion_token'),                         // hashed cancellation token

  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Junction table linking users to organisations with a role
export const userOrganisations = pgTable("user_organisations", {
  id: serial().primaryKey(),
  userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  joinedAt: timestamp("joined_at").defaultNow().notNull(),
}, (t) => [
  // US-DB-1.3.1: unique membership — prevents duplicate invite rows
  unique("user_organisations_user_org_unique").on(t.userId, t.organisationId),
]);

// Leads table — Interest capture for pending AI roles
export const leads = pgTable('leads', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
  opportunityReason: text('opportunity_reason').notNull(),
  action: text('action').notNull().default('notify user of AI Assistant readiness'),
  // Notification lifecycle: 'notification_pending' | 'notification_sent' | 'contacted' | 'converted' | 'lost'
  status: text('status').notNull().default('notification_pending'),
  // Lead enrichment fields (US-SALES-1.1 / US-SALES-1.2)
  leadType: text('lead_type'),            // 'role_request' | 'enterprise_inquiry' | 'waitlist' | 'referral'
  source: text('source'),                 // 'assistants_page' | 'website' | 'workspace' | 'api'
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  organisationId: integer('organisation_id').references(() => organisations.id, { onDelete: 'set null' }),
  name: text('name'),
  company: text('company'),
  teamSize: text('team_size'),
  useCase: text('use_case'),
  priority: text('priority'),             // 'high' | 'medium' | 'low'
  assignedTo: integer('assigned_to').references(() => users.id, { onDelete: 'set null' }),
  salesNotes: text('sales_notes'),
  lastContactedAt: timestamp('last_contacted_at'),
  resolvedAt: timestamp('resolved_at'),
  // CRM Contacts view fields (db/crm-contacts.sql)
  phone: text('phone'),
  contactType: text('contact_type').notNull().default('lead'), // 'lead' | 'registered' | 'client' | 'other'
  tags: jsonb('tags').$type<string[]>().notNull().default([]),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  emailRoleUnique: unique('email_role_unique').on(t.email, t.opportunityReason)
}));

// Contact Tasks — per-contact to-do items shown in the Contacts activity timeline (db/crm-contacts.sql).
export const contactTasks = pgTable('contact_tasks', {
  id: serial('id').primaryKey(),
  leadId: integer('lead_id').notNull().references(() => leads.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  done: boolean('done').notNull().default(false),
  dueDate: text('due_date'),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  completedAt: timestamp('completed_at'),
});

// Plans table — subscription or service plans associated with a user
export const plans = pgTable("plans", {
  id: serial().primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  masterPlanId: integer("master_plan_id").references(() => masterPlans.id),
  planName: text("plan_name").notNull(),
  planType: text("plan_type").notNull().default("subscription"),
  // status: 'active' | 'past_due' | 'cancelling' | 'cancelled' | 'downgrading' | 'expired'
  // past_due = payment failed; assistants still run during gracePeriodEndsAt window
  status: text("status").notNull().default("active"),
  maxSeats: integer("max_seats"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at"),
  // Grace period end: set to NOW()+7d on first payment failure; assistants pause after this date
  gracePeriodEndsAt: timestamp("grace_period_ends_at"),
  // Stripe references — stored at subscription creation; used for upgrade/downgrade/cancel
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  cancelledAt: timestamp("cancelled_at"),               // set when status transitions to 'cancelled' (US-GAP-4.2.1)
  // Plan Features: frozen limits/features snapshot for the "new subscribers only" cohort. When set,
  // enforcement prefers this over the live master_plans values, so an admin can change a plan for
  // NEW subscribers without moving existing ones. null (default) = read live from master_plans.
  // Shape: { assistantLimit, monthlyTaskLimit, monthlyTokenLimit, appConnectionLimit, seatLimit,
  //          storageLimitBytes, features: { ... } }
  featureOverrides: jsonb("feature_overrides"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  // US-DB-1.4.1: Enforces exactly one active/past_due plan per organisation at the DB level.
  // BUG-P0-4: Was plain index() — changed to uniqueIndex() so the DB actually enforces the constraint.
  uniqueIndex("plans_one_active_per_org_unique").on(t.organisationId).where(sql`status IN ('active', 'past_due')`),
  // US-DB-1.1.1: Hot-path indexes for plan lookups
  index("plans_user_status_idx").on(t.userId, t.status),
  index("plans_org_idx").on(t.organisationId),
  index("plans_stripe_sub_idx").on(t.stripeSubscriptionId),
]);

// US-DB-1.4.1: Atomic usage counters — one row per org per billing period.
// Cap checks are done as a single atomic UPDATE (not SELECT then INSERT) to eliminate
// the check-then-insert race condition where two concurrent requests both pass the cap check.
export const usageCounters = pgTable("usage_counters", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  // First day of the calendar month in UTC — e.g. 2026-06-01 00:00:00 UTC
  periodStart: timestamp("period_start").notNull(),
  taskCount:       integer("task_count").notNull().default(0),
  tokenCount:      integer("token_count").notNull().default(0),
  assistantCount:  integer("assistant_count").notNull().default(0),
  connectionCount: integer("connection_count").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  orgPeriodUnique: unique("usage_counters_org_period_unique").on(t.organisationId, t.periodStart),
}));

// Billing information table — stored billing address and contact details per user
export const billingInformation = pgTable("billing_information", {
  id: serial().primaryKey(),
  userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  fullName: text("full_name").notNull(),
  email: text("email"),
  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  city: text("city"),
  state: text("state"),
  country: text("country"),
  postalCode: text("postal_code"),
  vatNumber: text("vat_number"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Payments table — individual payment transactions made by a user
export const payments = pgTable("payments", {
  id: serial().primaryKey(),
  userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id")
      .references(() => organisations.id, { onDelete: "cascade" }),
  planId: integer("plan_id")
      .references(() => plans.id, { onDelete: "cascade" }),
  masterPlanId: integer("master_plan_id").references(() => masterPlans.id),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  // US-DB-1.2.1: default corrected from 'USD' to 'GBP' (platform bills in GBP)
  currency: text("currency").notNull().default("GBP"),
  status: text("status").notNull().default("pending"),
  paymentMethod: text("payment_method"),
  externalPaymentId: text("external_payment_id"),
  description: text("description"),
  // Card details — brand/last4/expiry/postcode stored at payment time; PAN and CVC never stored
  cardBrand: text("card_brand"),
  cardLast4: text("card_last4"),
  cardExpMonth: integer("card_exp_month"),
  cardExpYear: integer("card_exp_year"),
  cardPostalCode: text("card_postal_code"),
  metadata: jsonb("metadata"),
  paidAt: timestamp("paid_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  check("payments_currency_check", sql`${t.currency} IN ('GBP', 'EUR', 'USD')`),
  // US-DB-1.1.1: Org-level and user-level payment lookups
  index("payments_org_idx").on(t.organisationId),
  index("payments_user_idx").on(t.userId),
]);

// AI assistants table — AI agents configured by or assigned to a user
export const aiAssistants = pgTable("ai_assistants", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  masterAssistantId: integer("master_assistant_id").references(() => masterAssistants.id),
  name: text("name").notNull(),
  aiAssistantJobRole: text("ai_assistant_job_role"),
  model: text("model").notNull(),
  systemPrompt: text("system_prompt"),
  // US-GOV-3.1.1: EU AI Act Art. 52 disclosure — required before activation
  disclosureText: text("disclosure_text"),
  // US-GOV-1.2.1: Deployer acknowledgment that the system prompt has been reviewed against prohibited-use categories
  prohibitedUseAcknowledged: boolean("prohibited_use_acknowledged").notNull().default(false),
  // US-SMM-2.4.1: How many days ahead the assistant keeps the post queue filled (1–30, default 7)
  draftHorizonDays: integer("draft_horizon_days").notNull().default(7),
  // US-SMM-2.4.2: Review queue cut-off — hours before scheduled publish time; unapproved posts become 'missed' (1–24, default 2)
  reviewCutoffHours: integer("review_cutoff_hours").notNull().default(2),
  // US-SMM-2.4.2: Notification preference — 'immediate' | 'daily_digest' | 'red_urgency_only'
  reviewNotifPreference: text("review_notif_preference").notNull().default('immediate'),
  // US-SMM-2.4.2: Time for daily digest notifications in HH:MM UTC (only used when reviewNotifPreference='daily_digest')
  reviewDigestTime: text("review_digest_time").notNull().default('09:00'),
  isActive: boolean("is_active").notNull().default(true),
  configuration: jsonb("configuration"),

  // Flexible schema expansion for role-specific answers
  onboardingContext: jsonb("onboarding_context"),

  // US-GDPR-2.2.3: set when an org member leaves and their assets are tombstoned;
  // non-null signals that this assistant's knowledge base may be incomplete.
  knowledgeStaleAt: timestamp("knowledge_stale_at"),

  // Issue #191 — Safe Archiving grace period: when the assistant was archived, and the
  // deadline after which purge-archived-assistants hard-deletes it (archivedAt + 14 days).
  // Both null while not archived; cleared again on reinstate. db/assistant-archive-grace-period.sql.
  archivedAt: timestamp("archived_at"),
  scheduledDeletionAt: timestamp("scheduled_deletion_at"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  // provisioningStatus: 'pending' | 'complete' | 'failed' | 'cancelled' | 'paused_limit'
  //                   | 'paused_payment' | 'paused_quota' | 'blocked'
  // 'paused_limit'  = plan downgrade left more assistants than the tier allows (stripe-webhook.ts).
  // 'paused_quota'  = the org exhausted its monthly TASK allowance (task-volume-check.ts). Distinct
  // from paused_limit on purpose: it is self-clearing, and resume-quota-paused.ts reverses exactly
  // these rows. Do NOT record a system pause with is_active alone — that is the user's own on/off
  // switch, so a pause written only there can never be safely un-paused in bulk.
  // db/assistant-quota-pause.sql teaches assistant_lifecycle_from_legacy() about it.
  // 'blocked' = a compliance/readiness gate stopped provisioning (see provisioningBlockedReason).
  // It still derives lifecycle_status='provisioning', but is distinguishable + user-actionable +
  // re-triggerable (retry-provision-assistant / retryBlockedAssistants). db/assistant-provisioning-blocked.sql.
  provisioningStatus: text("provisioning_status").default("pending"),
  // When provisioningStatus='blocked', the machine reason code (ProvisioningBlockReason in
  // src/utils/assistant-lifecycle.ts): disclosure_missing | tos_required | prohibited_use_ack
  // | dpa_required | high_risk_eu. Cleared (null) once provisioning succeeds or is retried.
  provisioningBlockedReason: text("provisioning_blocked_reason"),
  // Canonical lifecycle state machine (assistant-lifecycle-epic):
  //   provisioning | ready_for_work | working | paused | system_paused | archived
  // Kept in sync with the legacy (provisioningStatus, isActive) pair by a DB trigger; the
  // transitionAssistantStatus() helper writes forward-only states (e.g. ready_for_work).
  // Schema + trigger live in db/assistant-lifecycle-status.sql (apply manually).
  lifecycleStatus: text("lifecycle_status").notNull().default("provisioning"),
  // SMART Goals US3.3 — Autonomous Goal Seeking: when on, the optimizer cron may rewrite allowed
  // brief params (tone/frequency) if a goal goes off_track. Premium-tier gated. db/goal-autonomous.sql.
  autonomousGoalSeeking: boolean("autonomous_goal_seeking").notNull().default(false),

  // Epic 2 US5 — Autonomous AI media suggestions: when on, a daily cron drafts posts (copy +
  // AI-generated media) into the AI review queue, never auto-published. The monthly cap limits
  // autonomous credit spend. db/autonomous-media.sql.
  autonomousMediaEnabled: boolean("autonomous_media_enabled").notNull().default(false),
  autonomousMediaMonthlyCap: integer("autonomous_media_monthly_cap").notNull().default(20),

  // Media Source Selection — an ORDERED array of the media sources this assistant may use,
  // where position encodes priority and membership encodes enabled. Values: 'manual' | 'stock' | 'ai'
  // (see src/utils/media-sources.ts). null/empty ⇒ default matrix ['manual','stock','ai']
  // (Manual Library → AI Stock Search (Pexels) → AI Generation). The resolver (media-resolver.ts)
  // walks this list with fallback. db/media-source-preferences.sql.
  mediaSources: jsonb("media_sources"),
}, (t) => [
  // US-DB-1.3.1: assistants are org-owned & member-shared — names are unique per organisation.
  // (userId is retained as creator/attribution only.)
  unique("ai_assistants_org_name_unique").on(t.organisationId, t.name),
  // US-DB-1.1.1: Hot-path indexes for assistant lookups
  index("ai_assistants_org_active_idx").on(t.organisationId, t.isActive),
  index("ai_assistants_user_active_idx").on(t.userId, t.isActive),
  check("ai_assistants_review_notif_pref_check", sql`${t.reviewNotifPreference} IN ('immediate', 'daily_digest', 'red_urgency_only')`),
]);

// User profiles table — extended profile details for a user
export const userProfiles = pgTable("user_profiles", {
  id: serial().primaryKey(),
  userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" })
      .unique(),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  bio: text("bio"),
  timezone: text("timezone"),
  notifyWins: boolean('notify_wins').default(true).notNull(),
  notifyBilling: boolean('notify_billing').default(true).notNull(),
  notifyAvailability: boolean('notify_availability').default(false).notNull(),
  // Email delivery preferences — one key per notification category.
  // Shape: Record<string, boolean>. Missing key = use category default.
  // Transactional keys (payment_confirmation, account_creation,
  // account_cancellation) are always true in the application layer
  // and cannot be opted out by the user.
  emailPreferences: jsonb("email_preferences"),
  // In-app (notification bell) delivery preferences — one key per preference
  // category (see src/utils/notification-prefs.ts). Shape: Record<string, boolean>.
  // Missing key = category default. Locked categories (account_security,
  // payment_confirmation) are forced true in the application layer regardless of
  // stored value. Supersedes the legacy notify_wins/billing/availability columns.
  inAppPreferences: jsonb("in_app_preferences"),
  // Per-assistant overrides of the notification matrix (assistant-scoped categories only).
  // Shape: { [assistantId]: { [categoryKey]: { inApp?: bool, email?: bool } } }. Missing key
  // at any level = use the workspace-wide preference above. Resolution in
  // src/utils/notification-prefs.ts. Requires db/notifications-assistant-scope.sql.
  assistantNotifPrefs: jsonb("assistant_notif_prefs"),
  language: text("language").default("en"),
  // Onboarding Wizard Step 3 (User Profile). Shape: { preset?, start?, end?, days?[] }.
  // A non-null value marks the working-hours step complete (see get-wizard-state.ts).
  workingHours: jsonb("working_hours"),
  preferences: jsonb("preferences"),
  legalConsents: jsonb("legal_consents"),
  // US-ONB-2.2.1: tracks whether the first-login welcome modal has been shown
  firstLoginWelcomeSeen: boolean("first_login_welcome_seen").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Notifications table — in-app notifications delivered to a user
// ADR-001 (US-DB-1.2.1): This is the CANONICAL notifications table. Use this for all new code.
// See userNotifications below — that table is deprecated and retained only for legacy reads.
export const notifications = pgTable("notifications", {
  id: serial().primaryKey(),
  userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  title: text("title").notNull(),
  message: text("message"),
  isRead: boolean("is_read").notNull().default(false),
  readAt: timestamp("read_at"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  // Dynamic Communications Engine — Intelligent Notification Routing & Categorization.
  // category/priority/is_dismissible are derived from `type` and stamped by a DB trigger
  // (db/notifications-categorization.sql); the code map in src/utils/notification-actions.ts
  // is the canonical reference. resolvedAt is the true "closed" signal — set only when an
  // action item's completion criteria are met (distinct from isRead = "seen"). NOTE: these
  // columns require db/notifications-categorization.sql applied to the DB before deploy.
  category: text("category"),
  priority: integer("priority"),
  isDismissible: boolean("is_dismissible"),
  resolvedAt: timestamp("resolved_at"),
  // US3: user manually dismissed (swiped/closed) the notification. Distinct from resolvedAt
  // (criteria met) and isRead (seen). Dismissed rows are hidden from the feed. The server
  // refuses to dismiss non-dismissible (critical_action) items. Requires db/notifications-dismissal.sql.
  dismissedAt: timestamp("dismissed_at"),
  // US4 — Omni-channel routing. deliveredAt: when the notification was generated (AC4.1, set by
  // DB default). fallbackEmailSentAt: guard so the email-fallback worker sends at most one email
  // per notification. Requires db/notifications-email-fallback.sql.
  deliveredAt: timestamp("delivered_at"),
  fallbackEmailSentAt: timestamp("fallback_email_sent_at"),
  // Which assistant produced this notification (NULL = account-level). Stamped by a
  // BEFORE INSERT trigger from metadata->>'assistantId' — insert sites carry the id in
  // metadata rather than setting this column. Drives per-assistant preference gating
  // (user_profiles.assistant_notif_prefs). Requires db/notifications-assistant-scope.sql.
  assistantId: integer("assistant_id"),
}, (t) => [
  // US-DB-1.1.1: Notification inbox query — userId + isRead + createdAt
  index("notifications_user_read_idx").on(t.userId, t.isRead, t.createdAt),
]);

// US-ONB-2.1.2: Notification log — deduplicates timed onboarding emails
// Prevents sending the same email type (e.g. '24h_reminder') more than once per user.
export const notificationLog = pgTable("notification_log", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  sentAt: timestamp("sent_at").defaultNow().notNull(),
}, (t) => [
  index("notification_log_user_type_idx").on(t.userId, t.type),
]);

// US-COMMS-1: Admin-editable transactional email templates.
// Platform-global (NOT org-scoped) — one row per system trigger. The inner bodyHtml is
// admin-edited via the WYSIWYG editor; the immutable brand shell lives in code
// (renderMasterTemplate). triggerKey is hardcoded to a system event and never created or
// deleted by admins (AC3.2.1) — they edit the payload only. Defaults & the in-code
// fallback live in src/utils/email-templates-catalog.ts (TEMPLATE_DEFAULTS).
export const emailTemplates = pgTable("email_templates", {
  id: serial().primaryKey(),
  triggerKey: text("trigger_key").notNull().unique(), // e.g. 'welcome' | 'payment_failed' | 'assistant_ready'
  name: text("name").notNull(),                       // display name in the admin list
  category: text("category").notNull().default("General"), // Onboarding | Billing | Security | …
  subject: text("subject").notNull(),                 // supports {{merge}} tags
  bodyHtml: text("body_html").notNull(),              // inner body only — wrapped at send time
  // Plain-text alternative part. NULL = derive from bodyHtml at send time (htmlToPlainText);
  // a non-NULL value is an admin-authored override. Requires db/notification-templates.sql.
  bodyText: text("body_text"),
  preheader: text("preheader"),                       // inbox preview text
  // Governance (full UI is Feature 3; columns ship now so the send path can respect them).
  isActive: boolean("is_active").notNull().default(true),
  locked: boolean("locked").notNull().default(false), // critical triggers can't be deactivated
  transactional: boolean("transactional").notNull().default(false), // omit unsubscribe link
  updatedByAdminId: integer("updated_by_admin_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ── US-COMMS-2: Admin-editable in-app notification templates ────────────────
// One row per piece of in-app copy, created lazily on first admin edit. Defaults & the
// render-time fallback live in src/utils/notification-templates-catalog.ts.
//
// Keyed on templateKey, NOT on notifications.type: `type` is reused across call sites
// ('system' backs 10 distinct notifications) and drives category/priority routing, so it
// can't identify one piece of copy. The type a template stamps stays code-owned in the
// catalog. Requires db/notification-templates.sql applied before deploy.
export const notificationTemplates = pgTable("notification_templates", {
  id: serial().primaryKey(),
  templateKey: text("template_key").notNull().unique(), // e.g. 'assistant_hired' | 'org_invite_accepted'
  title: text("title").notNull(),                       // supports {{merge}} tags
  message: text("message"),                             // supports {{merge}} tags + inline HTML
  isActive: boolean("is_active").notNull().default(true),
  updatedByAdminId: integer("updated_by_admin_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ── UI translation cache (#1 runtime auto-translation) ──────────────────────
// Shared, source-of-truth cache for machine-translated UI microcopy. Each unique
// (lang, source_hash) is translated once via the AI gateway and reused for every user,
// keeping cost + latency bounded. source_hash = sha256(source_text). Applied via
// db/ui-translations.sql (no drizzle-kit push).
export const uiTranslations = pgTable("ui_translations", {
  id: serial().primaryKey(),
  lang: text("lang").notNull(),                 // target language code, e.g. 'fr'
  sourceHash: text("source_hash").notNull(),    // sha256 hex of source_text
  sourceText: text("source_text").notNull(),    // original English string
  translatedText: text("translated_text").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("ui_translations_lang_hash_unique").on(t.lang, t.sourceHash),
]);

// ── Vault Secrets — US-AUD-4.2.1 SC1/SC2 ────────────────────────────────────
// Stores AES-256-GCM encrypted credential payloads. DB never holds plaintext.
// refKey format: 'aura/user-<id>/<service>-<type>' e.g. 'aura/user-42/google-oauth-access'
export const vaultSecrets = pgTable("vault_secrets", {
  id: serial().primaryKey(),
  refKey: text("ref_key").notNull().unique(), // logical path — stored in systemConnections.vaultRefKey
  encryptedPayload: text("encrypted_payload").notNull(), // AES-256-GCM ciphertext (base64)
  iv: text("iv").notNull(),                              // GCM nonce (base64, 12 bytes)
  authTag: text("auth_tag").notNull(),                   // GCM auth tag (base64, 16 bytes)
  // US-GDPR-3.1.1: KEK/DEK hierarchy — per-user DEK encrypted with master KEK
  // Null on legacy rows (pre-migration); vault.ts handles both cases during migration window.
  encryptedDek: text("encrypted_dek"),                  // DEK wrapped by KEK (format: iv:authTag:ciphertext, all base64)
  // US-DB-1.3.1: relational ownership for GDPR erasure and breach response enumeration.
  // Backfilled by parsing refKey convention 'aura/user-{id}/...' on existing rows.
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "cascade" }),
  keyVersion: integer("key_version").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// System connections table — OAuth tokens and credentials for third-party service integrations
export const systemConnections = pgTable("system_connections", {
  id: serial().primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  // US-DB-1.3.1: org tenancy — mandatory for multi-tenant isolation.
  // NOT NULL; backfilled from users.organisationId on existing rows before constraint applied.
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  // US-DB-1.3.1: per-assistant connection scoping — enables appConnectionLimit cap by assistantId.
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "cascade" }),
  serviceName: text("service_name").notNull(),
  connectionType: text("connection_type").notNull().default("oauth"), // 'oauth', 'api_key', 'legacy'

  // US-AUD-4.2.1 SC1: vault reference key replaces plaintext tokens
  // Format: 'aura/user-<id>/<serviceName>-<connectionType>'
  vaultRefKey: text("vault_ref_key"),

  // US-DB-1.6.1: plaintext accessToken and refreshToken columns dropped.
  // All credentials are now stored exclusively in vault_secrets (KEK/DEK encrypted).
  // Pre-migration assertion: ensure zero non-null rows exist before applying db:push.
  tokenExpiresAt: timestamp("token_expires_at"),

  // SC3: documented minimum scopes per integration (comma-separated)
  scopes: text("scopes"),

  // Public identifier (e.g., Legacy Username or connected email)
  externalUserId: text("external_user_id"),

  // Connection Health Status
  status: text("status").notNull().default("active"), // 'active', 'expired', 'failed', 'revoked'
  isActive: boolean("is_active").notNull().default(true),

  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  // US-DB-1.3.1: indexes for org-scoped and assistant-scoped connection queries
  index("system_connections_org_active_idx").on(t.organisationId, t.isActive),
  index("system_connections_assistant_active_idx").on(t.assistantId, t.isActive),
  // US-DB-1.1.1: User-level connection lookups
  index("system_connections_user_active_idx").on(t.userId, t.isActive),
]);

// ── Workspace Integrations — Phase 1 external integrations (HubSpot, Xero, Slack) ──
// One row per (organisation, provider) OAuth grant, powering integrations.html and the
// /api/actions/sync endpoint. Access/refresh tokens are NOT stored here in plaintext —
// US-DB-1.6.1 dropped plaintext token columns platform-wide; token material lives
// AES-256-GCM encrypted in vault_secrets under vaultRefKey
// ('aura/org-<orgId>/integration-<provider>'). Read/write only via
// src/utils/workspace-integrations.ts (which also handles expiry-driven refresh).
// DDL: db/workspace-integrations.sql (apply manually — no db:push).
export const workspaceIntegrations = pgTable("workspace_integrations", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),                 // 'hubspot' | 'xero' | 'slack'
  vaultRefKey: text("vault_ref_key").notNull(),         // vault_secrets.ref_key holding { accessToken, refreshToken }
  tenantId: text("tenant_id"),                          // Xero tenant id; Slack team id; HubSpot hub id
  externalAccountName: text("external_account_name"),   // human label: Xero org name, Slack workspace, HubSpot domain
  scopes: text("scopes"),                               // granted scopes (comma/space separated, provider format)
  status: text("status").notNull().default("active"),   // 'active' | 'expired' | 'revoked' | 'error'
  connectedBy: integer("connected_by").references(() => users.id, { onDelete: "set null" }),
  expiresAt: timestamp("expires_at"),                   // access-token expiry; null = non-expiring (Slack bot tokens)
  metadata: jsonb("metadata"),                          // provider-specific cache, e.g. followerCount/followerCountAt (get-follower-counts.ts)
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  unique("workspace_integrations_org_provider_unique").on(t.organisationId, t.provider),
  index("workspace_integrations_org_idx").on(t.organisationId),
]);

// Manually-entered, date-stamped follower counts. LinkedIn's member API does not expose a
// personal-profile follower count, so the user types it in periodically; each entry is a new dated
// row (history preserved), the latest is the current count. See save-follower-count.ts /
// get-follower-counts.ts. LinkedIn is the only manual platform today.
export const manualFollowerCounts = pgTable("manual_follower_counts", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),
  count: integer("count").notNull(),
  recordedAt: timestamp("recorded_at").defaultNow().notNull(),
  enteredBy: integer("entered_by").references(() => users.id, { onDelete: "set null" }),
}, (t) => [
  index("manual_follower_counts_org_platform_idx").on(t.organisationId, t.platform, t.recordedAt),
]);

// Abuse Prevention (US1/US2): a record of a rejected OAuth connection because the third-party
// tenant was already live in another workspace. Lets the requester ask to join the existing
// workspace WITHOUT us ever revealing that workspace's owner. Owner-db accessed (oauth callbacks
// + request-workspace-access). Schema in db/connection-collision-attempts.sql (apply manually).
export const connectionCollisionAttempts = pgTable("connection_collision_attempts", {
  id: serial().primaryKey(),
  requestingOrgId: integer("requesting_org_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  existingOrgId: integer("existing_org_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  serviceName: text("service_name").notNull(),
  externalUserId: text("external_user_id").notNull(),
  // pending → (request access) → requested → (admin invites) → resolved
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("cca_requesting_service_idx").on(t.requestingOrgId, t.serviceName, t.status),
]);

// ── Webhook intake — trigger-style connectors (Slack, Zendesk, …) ────────────
// Inbound events land here verified + deduped (webhook-intake.ts), then a downstream
// processor consumes status='received' rows. Org/connection are best-effort at intake;
// dedupKey enforces idempotency against provider retries.
export const webhookEvents = pgTable("webhook_events", {
  id: serial().primaryKey(),
  provider: text("provider").notNull(),                       // 'slack' | 'zendesk' | …
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "cascade" }),
  connectionId: integer("connection_id").references(() => systemConnections.id, { onDelete: "set null" }),
  eventType: text("event_type"),
  dedupKey: text("dedup_key").notNull().unique(),             // provider + external event id
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("received"),       // received|processing|processed|failed|ignored
  error: text("error"),
  receivedAt: timestamp("received_at").defaultNow().notNull(),
  processedAt: timestamp("processed_at"),
}, (t) => [
  index("webhook_events_status_idx").on(t.status, t.receivedAt),
  index("webhook_events_org_idx").on(t.organisationId),
]);

// ── Integration API Call Audit Log — US-AUD-4.2.1 SC6 ───────────────────────
// Records every API call made on behalf of a user using a stored credential.
// Retained 90 days (enforced by a scheduled cleanup job).
export const integrationApiCalls = pgTable("integration_api_calls", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  integrationId: integer("integration_id").references(() => systemConnections.id, { onDelete: "set null" }),
  endpoint: text("endpoint").notNull(), // redacted URL — path only, no query params (SC6)
  httpStatus: integer("http_status"),
  // Integration Scenario Library: correlates a log line to the recipe that produced it
  // (null for legacy disruptive-ui action calls). Powers the per-scenario log filter.
  activeScenarioId: integer("active_scenario_id").references((): any => activeScenarios.id, { onDelete: "set null" }),
  calledAt: timestamp("called_at").defaultNow().notNull(),
}, (t) => [
  // US-DB-1.1.1: 90-day pruning job and per-user API call history
  index("integration_api_calls_user_called_idx").on(t.userId, t.calledAt),
  index("integration_api_calls_scenario_idx").on(t.activeScenarioId, t.calledAt),
]);

// ── Webhook idempotency log — prevents double-processing Stripe events ────────
// One row per Stripe event ID; inserted before handling, acts as a distributed lock.
export const processedWebhookEvents = pgTable("processed_webhook_events", {
  id: serial().primaryKey(),
  stripeEventId: text("stripe_event_id").notNull().unique(),
  eventType: text("event_type").notNull(),
  processedAt: timestamp("processed_at").defaultNow().notNull(),
});

// ══════════════════════════════════════════════════════════════════════════════
// Integration Scenario Library — the Zapier-style recipe layer over the Phase-1
// integration primitives: workspaceIntegrations (the OAuth grant), webhookEvents
// (inbound intake) and the sync-action ACTION_HANDLERS registry (outbound execution).
// Design: docs/integration-scenario-library-plan.md.
// DDL: db/integration-scenarios.sql + db/scenario-jobs.sql (apply manually — no db:push).
// ══════════════════════════════════════════════════════════════════════════════

// Catalog of connectable providers. SEED table (db/seed-catalog.ts), not tenant data —
// providerKey mirrors the IntegrationProvider union in src/utils/workspace-integrations.ts
// (+ 'custom_webhook' for the Tier-2 universal recipe).
export const integrationProviders = pgTable("integration_providers", {
  id: serial().primaryKey(),
  providerKey: text("provider_key").notNull().unique(),   // 'hubspot' | 'salesforce' | 'custom_webhook'
  displayName: text("display_name").notNull(),
  category: text("category").notNull(),                    // 'crm' | 'accounting' | 'comms' | 'generic'
  authType: text("auth_type").notNull(),                   // 'oauth2' | 'api_key' | 'webhook_url'
  logoKey: text("logo_key"),                               // icon key reused by the UI scenario card
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// The library of recipe definitions users browse in the Integrations Hub. SEED table.
// tier: 1 native (deep prebuilt) | 2 universal webhook | 3 roadmap (greyed + upvotable).
export const integrationScenarios = pgTable("integration_scenarios", {
  id: serial().primaryKey(),
  scenarioKey: text("scenario_key").notNull().unique(),     // 'hubspot_handoff_push'
  providerKey: text("provider_key").notNull(),              // → integration_providers.provider_key
  tier: integer("tier").notNull().default(1),
  direction: text("direction").notNull(),                   // 'outbound' | 'inbound' | 'two_way'
  scenarioType: text("scenario_type").notNull(),            // 'handoff_push' | 'meeting_handoff' | 'feedback_loop' | 'suppression_sync'
  title: text("title").notNull(),
  description: text("description"),
  // Recipe trigger contract, e.g. { on: 'lead.status_changed', when: ['QUALIFIED','MEETING_BOOKED'] }.
  triggerConfig: jsonb("trigger_config").notNull().default({}),
  // Outbound path only: the ACTION_HANDLERS key invoked in sync-action.ts
  // (null for inbound feedback-loop / suppression-sync scenarios).
  actionType: text("action_type"),
  // Field-mapping schema the UI FieldMapper renders:
  // [{ bmsField, label, required, defaultTarget }]
  fieldSchema: jsonb("field_schema").notNull().default([]),
  // Tier 3 only — link a greyed scenario to the existing upvote system (featureRequests).
  roadmapFeatureId: integer("roadmap_feature_id").references((): any => featureRequests.id, { onDelete: "set null" }),
  status: text("status").notNull().default("available"),    // 'available' | 'coming_soon' | 'deprecated'
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("integration_scenarios_provider_idx").on(t.providerKey, t.status),
]);

// A recipe a tenant has turned on — scoped PER ASSISTANT (product decision).
// fieldMappings is the user's custom map; connection = the workspace OAuth grant.
export const activeScenarios = pgTable("active_scenarios", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  assistantId: integer("assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }),
  scenarioId: integer("scenario_id").notNull().references(() => integrationScenarios.id, { onDelete: "cascade" }),
  // The workspace OAuth grant powering it. Null for Tier-2 pure webhook-URL recipes.
  integrationId: integer("integration_id").references(() => workspaceIntegrations.id, { onDelete: "cascade" }),
  // User's custom field map: { bmsField: 'externalPropertyName', ... }.
  fieldMappings: jsonb("field_mappings").notNull().default({}),
  // Tier-2 universal webhook target (Zapier/Make catch URL).
  webhookUrl: text("webhook_url"),
  isEnabled: boolean("is_enabled").notNull().default(true),
  lastFiredAt: timestamp("last_fired_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  // One activation of a given recipe per assistant.
  unique("active_scenarios_assistant_scenario_unique").on(t.assistantId, t.scenarioId),
  index("active_scenarios_org_enabled_idx").on(t.organisationId, t.isEnabled),
  // Hot dispatcher lookup: "which enabled recipes fire on this scenario?"
  index("active_scenarios_scenario_enabled_idx").on(t.scenarioId, t.isEnabled),
]);

// Suppression list — Scenario Type C target. Domains the autonomous discovery AI must
// never prospect (existing customers pulled from the CRM, or manual entries). Domain is
// normalised the same way as discovered_leads (lowercase, no www) so the guard is a join.
export const suppressionList = pgTable("suppression_list", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  domain: text("domain").notNull(),
  reason: text("reason").notNull().default("existing_customer"),
  source: text("source").notNull().default("crm_sync"),     // 'crm_sync' | 'manual'
  sourceScenarioId: integer("source_scenario_id").references((): any => activeScenarios.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  unique("suppression_list_org_domain_unique").on(t.organisationId, t.domain),
  index("suppression_list_org_idx").on(t.organisationId),
]);

// Per-ADDRESS opt-out from tenant outreach — "stop emailing me", from a prospect's reply.
// Deliberately NOT suppression_list above: that is domain-grained and means "this company is
// already a customer", so putting an individual's opt-out there would suppress their whole
// employer. See db/lead-opt-outs.sql. Not the win-back opt-out table either — these are the
// TENANT's prospects, not Be More Swan's own users.
export const leadOptOuts = pgTable("lead_opt_outs", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  email: text("email").notNull(),                            // normalised lowercase, address grain
  reason: text("reason").notNull().default("reply_opt_out"),
  source: text("source").notNull().default("reply"),         // 'reply' | 'manual' | 'bounce'
  // SET NULL, not CASCADE: deleting a thread must not delete the evidence someone asked us to stop.
  leadThreadId: integer("lead_thread_id").references((): any => leadThreads.id, { onDelete: "set null" }),
  matchedRule: text("matched_rule"),
  evidence: text("evidence"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  unique("lead_opt_outs_org_email_unique").on(t.organisationId, t.email),
  index("lead_opt_outs_org_email_idx").on(t.organisationId, t.email),
  check("lead_opt_outs_source_check", sql`${t.source} IN ('reply','manual','bounce')`),
]);

// Outbound scenario job queue — mirrors discovery_jobs. A BMS trigger fires, one row is
// enqueued, and process-scenario-jobs drains it (FOR UPDATE SKIP LOCKED), expanding it
// into one execution per matching active_scenarios row. Retries with backoff.
export const scenarioJobs = pgTable("scenario_jobs", {
  id: serial().primaryKey(),
  jobId: text("job_id").notNull().unique(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "cascade" }),
  triggerEvent: text("trigger_event").notNull(),           // 'lead.status_changed'
  // Trigger subject — the BMS record + values recipes map from, e.g.
  // { recordType:'lead', recordId:123, newStatus:'QUALIFIED', fields:{ aiSummary, company, ... } }
  subject: jsonb("subject").notNull(),
  status: text("status").notNull().default("queued"),      // queued | processing | completed | failed
  attempt: integer("attempt").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  nextRetryAt: timestamp("next_retry_at"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("scenario_jobs_status_idx").on(t.status, t.nextRetryAt),
  index("scenario_jobs_org_idx").on(t.organisationId, t.status),
]);

// MASTER CATALOG TABLES
export const masterPlans = pgTable("master_plans", {
  id: serial().primaryKey(),
  tierKey: text("tier_key").notNull().unique(),
  name: text("name").notNull(),
  // Pricing-card marketing copy — DB-driven so the Super Admin (Master Data → Plans) controls
  // every visible plan-card field, and pricing.html / the comparison table render from here.
  // tierDescription = the eyebrow line ("Tier 2 · Best for Scaling Founders").
  // description = the italic sub-heading blurb. isMostPopular = the "Most Popular" pill (at most
  // one plan; the admin API clears the flag on every other plan when one is set true).
  tierDescription: text("tier_description"),
  description: text("description"),
  isMostPopular: boolean("is_most_popular").notNull().default(false),
  // Contact-sales tier (Enterprise): displayed on pricing.html but NOT purchasable — excluded from
  // get-plans' plan picker (like 'trial') so it never fires a self-serve Stripe checkout.
  isContactSales: boolean("is_contact_sales").notNull().default(false),
  monthlyPriceGbp: numeric("monthly_price_gbp", { precision: 10, scale: 2 }).notNull(),
  // Capacity limits — enforced at runtime; null = unlimited
  assistantLimit: integer("assistant_limit"),           // max active AI assistants (total per account)
  monthlyTaskLimit: integer("monthly_task_limit"),      // max task runs per calendar month
  monthlyTokenLimit: integer("monthly_token_limit"),    // max LLM tokens per calendar month; null = unlimited
  appConnectionLimit: integer("app_connection_limit"),  // max OAuth/API integrations per assistant; null = unlimited
  seatLimit: integer("seat_limit"),                     // max workspace members (users in the same org); null = solo only (1 seat)
  storageLimitBytes: integer("storage_limit_bytes"),    // US-STOR-1.1.2: max object storage per org; null = unlimited
  // Dynamic Product Catalog: Stripe Product id (created when the admin saves a plan) +
  // freeform feature flags beyond the numeric limits, e.g. { unlock_trending_audio: true }.
  stripeProductId: text("stripe_product_id"),
  features: jsonb("features").notNull().default({}),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Plan prices — per-currency pricing for each master plan (US-I18N-2.1 SC1)
// Source of truth for multi-currency checkout; GBP row mirrors masterPlans.monthlyPriceGbp.
export const planPrices = pgTable("plan_prices", {
  id: serial("id").primaryKey(),
  masterPlanId: integer("master_plan_id").notNull().references(() => masterPlans.id, { onDelete: "cascade" }),
  currency: text("currency").notNull(),                     // ISO 4217: 'GBP' | 'USD' | 'EUR' | 'AUD' | 'CAD'
  monthlyPriceMajorUnit: numeric("monthly_price_major_unit", { precision: 10, scale: 2 }).notNull(),
  stripePriceId: text("stripe_price_id"),                  // Stripe Price object ID for this plan+currency combo
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  planCurrencyUnique: unique("plan_currency_unique").on(t.masterPlanId, t.currency),
}));

// Plan feature catalog — the DB-driven definition of every row in the pricing.html comparison table.
// (SQL: db/plan-features.sql; seed: db/seed-plan-features.ts). This is a metadata + rendering layer:
// the VALUES live in master_plans (capacity as typed columns, everything else in the features jsonb);
// each row here records WHERE a feature's value is stored (storageTarget/columnName) and HOW to render it
// (valueType, unlimitedLabel). Admins edit these via Admin → Master Data → Plan Features, and pricing.html
// renders the comparison table dynamically from this catalog.
export const planFeatures = pgTable("plan_features", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),                    // e.g. 'assistant_limit', 'monthly_ai_credits', 'ai_video_generation'
  label: text("label").notNull(),                         // pricing-table row title
  description: text("description"),                        // pricing-table row sub-caption
  category: text("category").notNull(),                   // section header: 'Capacity' | 'AI Media Generation' | ...
  valueType: text("value_type").notNull().default("boolean"), // 'number' | 'boolean' | 'text'
  storageTarget: text("storage_target").notNull().default("feature"), // 'column' | 'feature'
  columnName: text("column_name"),                        // master_plans column (camelCase key) when storageTarget='column'
  unlimitedLabel: text("unlimited_label"),                // how to render a null value, e.g. 'Custom' | 'Unlimited'
  // The pricing table's 4th column ("Custom Enterprise") is contact-sales — not a purchasable
  // master_plan (excluded from get-plans so it never appears in the plan picker). Its per-feature
  // display value is stored here so the whole comparison table stays DB-driven + admin-editable.
  // Rendering: boolean → truthy ('true'/'✓'/'yes') = check, else dash; number/text → the text.
  enterpriseValue: text("enterprise_value"),
  displayOrder: integer("display_order").notNull().default(0),
  isEnabled: boolean("is_enabled").notNull().default(true), // false = globally disabled (hidden from pricing, treated as off)
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Plan price history — dated audit trail of every subscription price change (SQL: db/plan-price-history.sql).
// master_plans.monthlyPriceGbp + the GBP planPrices row hold the CURRENT live price; this table records
// how it changed over time (start/end dates) and holds scheduled future prices until the activation worker
// (activate-scheduled-prices.ts) flips them live. One 'active' row per plan+currency at a time.
export const planPriceHistory = pgTable("plan_price_history", {
  id: serial("id").primaryKey(),
  masterPlanId: integer("master_plan_id").notNull().references(() => masterPlans.id, { onDelete: "cascade" }),
  currency: text("currency").notNull().default("GBP"),               // ISO 4217; GBP is canonical
  monthlyPriceMajorUnit: numeric("monthly_price_major_unit", { precision: 10, scale: 2 }).notNull(),
  stripePriceId: text("stripe_price_id"),                            // Stripe price minted for this point; null until active
  effectiveFrom: timestamp("effective_from").notNull(),             // when this price becomes / became live
  effectiveTo: timestamp("effective_to"),                           // null = live or still pending; set when superseded
  status: text("status").notNull().default("active"),               // 'scheduled' | 'active' | 'superseded'
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("plan_price_history_plan_idx").on(t.masterPlanId, t.currency),
  index("plan_price_history_due_idx").on(t.status, t.effectiveFrom),
]);

// Task runs — one row per automated task execution; used for monthly volume tracking (SC3)
export const taskRuns = pgTable("task_runs", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "set null" }),
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "set null" }),
  taskType: text("task_type").notNull().default("automated"),  // 'automated' | 'manual' | 'scheduled'
  // US-DB-1.5.1: Full state machine — pending|running|reviewing|suspended|completed|failed|skipped|terminated
  status: text("status").notNull().default("pending"),
  anomalyCount: integer("anomaly_count").notNull().default(0), // US-GOV-4.2.1: incremented on each kill-switch trigger; ≥2 → permanent termination
  tokensUsed: integer("tokens_used").default(0),               // LLM tokens consumed by this run
  // US-GOV-4.1.1: Hard execution budget tracking
  llmCallCount: integer("llm_call_count").notNull().default(0),
  toolCallCount: integer("tool_call_count").notNull().default(0),
  costGbp: numeric("cost_gbp", { precision: 10, scale: 6 }).notNull().default('0'),
  wallClockStartedAt: timestamp("wall_clock_started_at"),
  suspendReason: text("suspend_reason"),
  budgetSnapshot: jsonb("budget_snapshot"),
  // US-DB-1.5.1: Worker lease columns — FOR UPDATE SKIP LOCKED queue
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  attemptCount: integer("attempt_count").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  lockedBy: text("locked_by"),           // worker/function instance identifier
  lockedAt: timestamp("locked_at"),
  leaseExpiresAt: timestamp("lease_expires_at"),
  // US-DB-1.5.1: Quality-reviewer loop columns
  reviewerAssistantId: integer("reviewer_assistant_id").references(() => aiAssistants.id, { onDelete: "set null" }),
  reviewVerdict: text("review_verdict"),  // 'approved' | 'revise' | 'escalated'
  reviewCycleCount: integer("review_cycle_count").notNull().default(0),
  // metadata JSONB shape (US-AUD-2.1.1):
  //   { confidenceLevel: 'green' | 'amber' | 'red',
  //     verifyHint: string | null,
  //     model: string,
  //     promptTokens: number, completionTokens: number }
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  // US-DB-1.5.1: Partial index for O(claimable) queue polling — scans only pending/expired-lease rows
  index("task_runs_claimable_idx").on(t.createdAt).where(sql`status = 'pending' OR status = 'running'`),
  // US-DB-1.1.1: Monthly usage aggregation and per-assistant run history
  index("task_runs_user_created_idx").on(t.userId, t.createdAt),
  index("task_runs_org_created_idx").on(t.organisationId, t.createdAt),
  index("task_runs_assistant_idx").on(t.assistantId),
  check("task_runs_status_check", sql`${t.status} IN ('pending', 'running', 'reviewing', 'suspended', 'completed', 'failed', 'skipped', 'terminated')`),
]);

export const masterAssistants = pgTable("master_assistants", {
  id: serial().primaryKey(),
  roleKey: text("role_key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category").notNull().default("Administration"),
  iconKey: text("icon_key").notNull().default("document"),
  iconColor: text("icon_color").notNull().default("blue"),
  // Detail-page marketing copy (SQL: db/assistant-content.sql; seed: db/seed-assistant-content.ts).
  // These replaced src/config/assistant-role-content.js, which used to re-declare name/description/
  // icons here AND own these four — two sources of truth that had already drifted apart. Admin-edited
  // via Master Data → Assistants; served publicly by netlify/functions/master-assistants.ts.
  tagline: text("tagline"),                                        // one-line hook under the name
  keyFeatures: jsonb("key_features").notNull().default([]),        // string[] — the bullet list
  integrations: jsonb("integrations").notNull().default([]),       // string[] — the external tools this role connects to ("Connects with")
  // string[] — assistant-to-assistant fit ("Works with"). Elements are the reserved key 'standalone'
  // or another master_assistants.role_key, which renders as that assistant's current name. Editorial
  // and admin-owned, not derived from code. SQL: db/assistant-works-with.sql.
  worksWith: jsonb("works_with").notNull().default([]),
  video: jsonb("video"),                                           // {url, title, poster} | null; null url = placeholder slot
  comingSoon: boolean("coming_soon").notNull().default(false),
  // US-AUD-2.3.1 SC2: task completions required to unlock early access (null = no milestone gate)
  milestoneTasksRequired: integer("milestone_tasks_required").default(25),
  isActive: boolean("is_active").notNull().default(true),
  // US-ADM-4.1.1: Lifecycle state machine — draft|review|beta|live|deprecated|archived
  lifecycleState: text("lifecycle_state").notNull().default("draft"),
  // Points to the current active assistant_versions row
  // US-DB-1.2.1: AnyPgColumn callback required — assistantVersions is defined after masterAssistants (circular reference)
  currentVersionId: integer("current_version_id").references((): AnyPgColumn => assistantVersions.id, { onDelete: "set null" }),
  // For deprecated assistants — ID of the recommended replacement (self-reference)
  replacementAssistantId: integer("replacement_assistant_id").references((): AnyPgColumn => masterAssistants.id, { onDelete: "set null" }),
  // US-GDPR-1.2.1: Confirms the Article 52 special-category refusal clause is present
  // in this assistant's current system prompt version. Set true by admin on version create.
  specialCategoryClauseEnabled: boolean("special_category_clause_enabled").notNull().default(false),
  // US-GOV-1.1.1: EU AI Act risk classification — minimal | limited | high_risk_borderline | high_risk
  riskClassification: text("risk_classification").notNull().default("limited"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  check("master_assistants_lifecycle_check", sql`${t.lifecycleState} IN ('draft', 'review', 'beta', 'live', 'deprecated', 'archived')`),
]);

// Assistant capability catalog — which capability keys exist, how they're labelled and grouped.
// (SQL: db/assistant-content.sql; seed: db/seed-assistant-content.ts). Metadata only: the VALUES live
// in assistant_features (one row per master_assistant × key). Mirrors the plan_features pattern, and
// replaces the hardcoded ASSISTANT_FEATURES list that used to live in src/config/assistant-features.ts,
// so adding a capability no longer needs a deploy. Admins edit these via Master Data → Assistant
// Features. No analogue of plans.feature_overrides: capability changes have no subscriber cohort.
export const assistantFeatureDefs = pgTable("assistant_feature_defs", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),                    // e.g. 'ai_image_generation'
  label: text("label").notNull(),                         // matrix column header
  description: text("description"),                       // column tooltip / admin help text
  category: text("category").notNull(),                   // matrix section header: 'Media' | 'Engagement' | ...
  displayOrder: integer("display_order").notNull().default(0),
  isEnabled: boolean("is_enabled").notNull().default(true), // false = globally disabled (hidden, treated as off)
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Per-assistant feature capabilities — admin-managed, keyed by assistant TYPE.
// One row per (master_assistant, feature_key); absent row = disabled. Feature keys are the
// enabled rows of assistant_feature_defs. Gates user-facing capabilities
// (e.g. AI image/video generation) via src/utils/assistant-capabilities.ts.
// DDL + SMM seed: db/assistant-features.sql (apply manually — no db:push).
export const assistantFeatures = pgTable("assistant_features", {
  id: serial().primaryKey(),
  masterAssistantId: integer("master_assistant_id").notNull().references(() => masterAssistants.id, { onDelete: "cascade" }),
  featureKey: text("feature_key").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  unique("assistant_features_master_feature_key").on(t.masterAssistantId, t.featureKey),
]);

// US-ADM-4.1.1: Immutable version history for master assistant prompts/config
export const assistantVersions = pgTable("assistant_versions", {
  id: serial().primaryKey(),
  assistantId: integer("assistant_id").notNull().references(() => masterAssistants.id, { onDelete: "cascade" }),
  versionNumber: integer("version_number").notNull(),
  systemPrompt: text("system_prompt"),
  config: jsonb("config"),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  changeNote: text("change_note").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  unique("assistant_versions_assistant_id_version_number_key").on(t.assistantId, t.versionNumber),
]);

// US-GOV-1.1.1: Risk assessments for high-risk EU AI Act assistants
export const riskAssessments = pgTable("risk_assessments", {
  id: serial().primaryKey(),
  masterAssistantId: integer("master_assistant_id").notNull().references(() => masterAssistants.id, { onDelete: "cascade" }),
  // Workspace org that submitted the assessment (null = global/platform-level)
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "cascade" }),
  assessmentVersion: text("assessment_version").notNull().default("1.0"),
  assessorId: integer("assessor_id").references(() => users.id, { onDelete: "set null" }),
  assessedAt: timestamp("assessed_at").defaultNow().notNull(),
  findings: text("findings"),
  approvalStatus: text("approval_status").notNull().default("pending"), // pending | approved | rejected
  approvedById: integer("approved_by_id").references(() => users.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Waitlist table — interest signups for coming-soon assistant roles
export const waitlist = pgTable("waitlist", {
  id: serial().primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  masterAssistantId: integer("master_assistant_id").notNull().references(() => masterAssistants.id, { onDelete: "cascade" }),
  source: text("source").notNull().default("public"), // 'public' | 'registered'
  notified: boolean("notified").notNull().default(false),
  // US-AUD-5.1.1 SC1/SC2: referral programme fields
  referralCode: text("referral_code").unique(),           // 8-char alphanumeric, generated on signup
  queuePositionBonus: integer("queue_position_bonus").notNull().default(0), // negative = moves forward; deducted from raw position
  day1AccessGranted: boolean("day1_access_granted").notNull().default(false), // SC3: 3 referrals
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  emailRoleUnique: unique("waitlist_email_role_unique").on(t.email, t.masterAssistantId),
}));

// ── Waitlist Referrals — US-AUD-5.1.1 SC2/SC5 ────────────────────────────────
// Tracks each referral event: who referred whom for which assistant.
export const waitlistReferrals = pgTable("waitlist_referrals", {
  id: serial().primaryKey(),
  referralCode: text("referral_code").notNull(),           // code that was used
  referrerId: integer("referrer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  referredEmail: text("referred_email").notNull(),          // email of the person who used the link
  masterAssistantId: integer("master_assistant_id").notNull().references(() => masterAssistants.id, { onDelete: "cascade" }),
  convertedAt: timestamp("converted_at"),                   // null = pending; set when referred user joins
  referrerIpHash: text("referrer_ip_hash"),                 // SC5: hashed IP for self-referral detection
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── User Referrals — US-GAP-8.2 ──────────────────────────────────────────────
// Tracks referral relationships: who referred whom, status, and reward.
export const userReferrals = pgTable("user_referrals", {
  id: serial().primaryKey(),
  referrerId: integer("referrer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  referredUserId: integer("referred_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  referralCode: text("referral_code").notNull(),          // the code that was used
  status: text("status").notNull().default("pending"),    // 'pending' | 'qualified' | 'rewarded'
  qualifiedAt: timestamp("qualified_at"),                 // when referred user made first paid invoice
  rewardedAt: timestamp("rewarded_at"),                   // when £10 credit was applied
  stripeBalanceTxId: text("stripe_balance_tx_id"),        // Stripe customer balance transaction id
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  uniqueReferred: unique("user_referrals_referred_unique").on(t.referredUserId),
}));

// ── Referral Invites — sent-invite lifecycle tracking ────────────────────────
// Records each referral link emailed to a friend so the sender can see "invited —
// awaiting sign-up" in their Referral Activity BEFORE the friend registers (a
// user_referrals row, which requires referred_user_id, can only exist post-signup).
// On registration via the link, the matching invite is marked 'accepted' and linked.
export const referralInvites = pgTable("referral_invites", {
  id: serial().primaryKey(),
  referrerId: integer("referrer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  email: text("email").notNull(),                          // invited friend's email (stored lowercased)
  referralCode: text("referral_code").notNull(),           // the code that was shared
  status: text("status").notNull().default("invited"),     // 'invited' | 'accepted'
  acceptedUserId: integer("accepted_user_id").references(() => users.id, { onDelete: "set null" }),
  sentAt: timestamp("sent_at").defaultNow().notNull(),
  acceptedAt: timestamp("accepted_at"),
}, (t) => [
  unique("referral_invites_referrer_email_unique").on(t.referrerId, t.email),
  index("referral_invites_referrer_idx").on(t.referrerId),
]);

// ── Relationship-Building Checklist (AC6, SMM) ───────────────────────────────
// Per-assistant daily engagement actions, generated from the blueprint and ticked
// off by the user. Lazily generated on first view of a new day. See
// db/relationship-building-tasks.sql and netlify/functions/relationship-checklist.ts.
export const relationshipBuildingTasks = pgTable("relationship_building_tasks", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  assistantId: integer("assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }),
  taskDate: date("task_date").notNull(),                 // the day this item belongs to (UTC)
  title: text("title").notNull(),                        // short imperative action
  description: text("description"),                      // one-line guidance / why it matters
  category: text("category"),                            // 'engagement' | 'outreach' | 'community' | 'follow_up'
  sortOrder: integer("sort_order").notNull().default(0),
  completed: boolean("completed").notNull().default(false),
  completedAt: timestamp("completed_at"),
  completedBy: integer("completed_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("relationship_building_tasks_assistant_date_idx").on(t.assistantId, t.taskDate),
  index("relationship_building_tasks_org_idx").on(t.organisationId),
  uniqueIndex("relationship_building_tasks_unique").on(t.assistantId, t.taskDate, t.title),
]);

// ── Multi-Agent Orchestration (Epic 4) — cross-assistant workflow links ──
// One directed hand-off rule: when source_assistant fires source_event, hand off to
// target_assistant to do target_action. Definition + visualisation only for now (no runtime
// consumer yet). Owner-path + manual org filter (no RLS) — same as content_rules. See db/orchestrations.sql.
export const orchestrationLinks = pgTable("orchestration_links", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  sourceAssistantId: integer("source_assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }),
  sourceEvent: text("source_event").notNull(),           // 'drafts_a_post' | 'publishes_a_post' | 'completes_a_task'
  targetAssistantId: integer("target_assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }),
  targetAction: text("target_action").notNull(),         // freeform, e.g. "design the visual"
  isActive: boolean("is_active").notNull().default(true),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("orchestration_links_org_idx").on(t.organisationId),
  index("orchestration_links_source_idx").on(t.sourceAssistantId),
  index("orchestration_links_target_idx").on(t.targetAssistantId),
  uniqueIndex("orchestration_links_unique").on(t.sourceAssistantId, t.sourceEvent, t.targetAssistantId, t.targetAction),
]);

// ── Orchestration runtime (Phase 5) — audit log of fired hand-offs ──
// One row per firing. UNIQUE(link_id, source_post_id) makes hand-off firing idempotent.
// See db/orchestration-runs.sql.
export const orchestrationRuns = pgTable("orchestration_runs", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  linkId: integer("link_id").references(() => orchestrationLinks.id, { onDelete: "set null" }),
  sourceAssistantId: integer("source_assistant_id"),
  targetAssistantId: integer("target_assistant_id"),
  sourceEvent: text("source_event").notNull(),
  sourcePostId: integer("source_post_id"),               // the post whose draft/publish triggered the hand-off
  targetJobId: text("target_job_id"),                    // content_generation_jobs.job_id enqueued for the target
  status: text("status").notNull().default("handed_off"), // 'handed_off' | 'skipped'
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("orchestration_runs_org_idx").on(t.organisationId),
  index("orchestration_runs_link_idx").on(t.linkId, t.createdAt),
  uniqueIndex("orchestration_runs_unique").on(t.linkId, t.sourcePostId),
]);

// ── Reward Redemptions — Referral Program Expansion ──────────────────────────
// Audit trail + double-spend guard for the referral token vault. Each row records
// a redemption: 'credit_10' (1 token → £10 Stripe credit) or 'free_assistant'
// (5 tokens → +1 bonus_assistants). availableTokens = matured qualified referrals
// minus SUM(tokensSpent) here. Written only by owner-role backend functions, so it
// stays out of the RLS crown-jewels set (like user_referrals).
export const rewardRedemptions = pgTable("reward_redemptions", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "cascade" }),
  type: text("type").notNull(),                  // 'credit_10' | 'free_assistant'
  tokensSpent: integer("tokens_spent").notNull(),
  stripeBalanceTxId: text("stripe_balance_tx_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("reward_redemptions_user_idx").on(t.userId),
]);

// ── Reward Audits — Gamification & Engagement (AC4.2.1) ──────────────────────
// Every milestone reward grant is logged here. The unique (organisation_id,
// trigger_event) constraint doubles as the milestone dedup: a milestone fires
// once per workspace, which also prevents double token/beta grants.
export const rewardAudits = pgTable("reward_audits", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  rewardType: text("reward_type").notNull(),       // 'referral_token' | 'beta_access'
  triggerEvent: text("trigger_event").notNull(),   // e.g. 'milestone:100_leads' | 'milestone:50_hours'
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  unique("reward_audits_org_trigger_unique").on(t.organisationId, t.triggerEvent),
  index("reward_audits_created_idx").on(t.createdAt),
]);

// ── Security Audits — Explicit AI Refusal & Moderation (US2 AC2.3) ───────────
// Records prompts hard-blocked by the OpenAI Moderation pre-check, so admins can
// review accounts repeatedly attempting severe-violation content. Owner-role access
// only (written by backend functions) → not in the RLS crown-jewels set.
export const securityAudits = pgTable("security_audits", {
  id: serial().primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "set null" }),
  source: text("source").notNull(),                      // entry point, e.g. 'quality-review' | 'generate-post'
  flaggedCategories: jsonb("flagged_categories").notNull(), // string[] of moderation categories
  promptExcerpt: text("prompt_excerpt"),                 // first ~200 chars for review context
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("security_audits_user_idx").on(t.userId),
  index("security_audits_created_idx").on(t.createdAt),
]);

// US-HELP-1.3.1: Help articles for the public Help Center
export const helpArticles = pgTable('help_articles', {
  id: uuid('id').defaultRandom().primaryKey(),
  category: text('category').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  title: text('title').notNull().unique(),
  contentMd: text('content_md').notNull(),
  isPublished: boolean('is_published').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_help_articles_category').on(t.category, t.sortOrder),
]);
// Audit logs table — immutable ledger for system compliance and tracking
export const auditLogs = pgTable("audit_logs", {
  id: serial().primaryKey(),
  userId: integer("user_id").references(() => users.id), // Can be null for system-level events
  actionType: text("action_type").notNull(), // e.g., 'CREATE', 'UPDATE', 'DELETE'
  resourceType: text("resource_type").notNull(), // e.g., 'users', 'user_profiles'
  resourceId: text("resource_id").notNull(), // The ID of the affected row (stored as text for flexibility)
  previousState: jsonb("previous_state"),
  newState: jsonb("new_state"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
// Brandassets

// Workspace Assets table — Centralized knowledge base for AI Assistant RAG pipeline
export const workspaceAssets = pgTable("workspace_assets", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
  uploaderId: integer("uploader_id")
      .references(() => users.id, { onDelete: "set null" }),

  name: text("name").notNull(),
  // Written verbatim from the client's `assetType` in storage-request-upload.ts, validated only
  // against that file's MIME_ALLOWLIST keys: brand_logo | brand_document | social_image |
  // voice_recording | generated_content | other. (Some older rows hold 'file' | 'url' | 'text'.)
  // No CHECK constraint, so this list lives in code — do not assume a value cannot occur here.
  // ⚠️ These ids are NOT content_assets ids; see src/utils/release-post-media.ts.
  assetType: text("asset_type").notNull(),
  category: text("category").notNull(),

  // NEW COLUMNS FOR TEXT RULES ENGINE
  isActive: boolean("is_active").default(true).notNull(),
  priority: integer("priority").default(0).notNull(),

  storageUrl: text("storage_url"),
  externalUrl: text("external_url"),
  extractedText: text("extracted_text"),
  // US-STOR-1.1.1 AC14: R2 object-storage lifecycle is `pending` → `confirmed` → `deleted`
  // (default `pending`). This table is dual-purpose: the RAG knowledge-base pipeline also uses
  // `processing` → `ready` for text/URL assets that never touch R2. The CHECK constraint below
  // enforces the full set of valid states for both lifecycles.
  status: text("status").notNull().default("pending"),

  // US-STOR-1.1.1 AC14: R2 object storage fields
  r2Key: text("r2_key"),                               // full R2 object key — never returned in API responses (AC15)
  mimeType: text("mime_type"),
  fileSizeBytes: integer("file_size_bytes"),
  originalFilename: text("original_filename"),
  deletedAt: timestamp("deleted_at"),                  // soft-delete timestamp; null = not deleted

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  // US-DB-1.1.1: Org-level and uploader-level asset lookups
  index("workspace_assets_org_idx").on(t.organisationId),
  index("workspace_assets_uploader_idx").on(t.uploaderId),
  // US-STOR-1.1.1 AC14: enforce valid status values. R2 object lifecycle: pending|confirmed|deleted;
  // RAG knowledge-base lifecycle (text/URL assets): processing|ready|failed (set in process-asset-background.ts).
  check("workspace_assets_status_check", sql`${t.status} IN ('pending', 'confirmed', 'deleted', 'processing', 'ready', 'failed')`),
]);

// US-STOR-1.1.2 AC1: Storage usage tracker — one row per org, updated atomically on upload/delete
export const storageUsage = pgTable("storage_usage", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().unique()
      .references(() => organisations.id, { onDelete: "cascade" }),
  usedBytes: integer("used_bytes").notNull().default(0),
  // AC4: tracks last time an 80% quota warning email was sent (one per 7-day window)
  quotaWarningLastSentAt: timestamp("quota_warning_last_sent_at"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
// Support Tickets Table — For user help requests and issue tracking
export const supportTickets = pgTable("support_tickets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id")
      .references(() => organisations.id, { onDelete: "cascade" }),

  subject: text("subject").notNull(),
  category: text("category").notNull(),
  description: text("description").notNull(),

  // Status lifecycle: 'new' | 'open' | 'pending_customer' | 'resolved' | 'closed'
  status: text("status").notNull().default("open"),

  // Helpdesk fields (US7)
  priority: text("priority").notNull().default("normal"), // 'low' | 'normal' | 'high' | 'urgent'
  assignedTo: integer("assigned_to").references(() => users.id, { onDelete: "set null" }),
  firstResponseAt: timestamp("first_response_at"),
  resolvedAt: timestamp("resolved_at"),
  closedAt: timestamp("closed_at"),
  slaBreachedAt: timestamp("sla_breached_at"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Ticket Replies Table — threaded conversation history for each support ticket (US7)
export const ticketReplies = pgTable("ticket_replies", {
  id: serial("id").primaryKey(),
  ticketId: integer("ticket_id")
      .notNull()
      .references(() => supportTickets.id, { onDelete: "cascade" }),
  authorId: integer("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  // isInternal: true = private note (yellow, not emailed to customer)
  isInternal: boolean("is_internal").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Lead Replies Table — threaded correspondence for a CRM lead / contact request (db/lead-replies.sql).
// Mirrors ticketReplies but for the leads pipeline, where the "customer" may be an anonymous
// prospect (contact form / inbound email) with no users row — so authorId is nullable and
// direction records who sent it. Inbound emails land here via the inbound-email webhook;
// admin replies are emailed out (Sales Pipeline reply box). Internal notes never leave the CRM.
export const leadReplies = pgTable("lead_replies", {
  id: serial("id").primaryKey(),
  leadId: integer("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
  // 'inbound'  = from the prospect (contact form / received email)
  // 'outbound' = admin reply emailed to the prospect
  // 'internal' = private admin note (never emailed)
  direction: text("direction").notNull().default("inbound"),
  // Admin author for outbound/internal; null for inbound (anonymous prospect).
  authorId: integer("author_id").references(() => users.id, { onDelete: "set null" }),
  body: text("body").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Issue Reports Table — testing-phase "Report an Issue" submissions (db/issue-reports.sql).
// Captures the user's description, WHERE they were when they reported (sourceLocation/
// sourceUrl) and an optional screenshot stored inline as a base64 data URL. Stored against
// the user so they can track progress; the admin owner is emailed on every new report.
export const issueReports = pgTable("issue_reports", {
  id: serial("id").primaryKey(),
  organisationId: integer("organisation_id")
      .references(() => organisations.id, { onDelete: "cascade" }),
  userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

  description: text("description").notNull(),
  sourceLocation: text("source_location"),   // in-app view/route the user came from
  sourceUrl: text("source_url"),             // full URL at time of report
  userAgent: text("user_agent"),

  // Optional screenshot — data URL (data:image/png;base64,…), no object-storage dependency.
  imageData: text("image_data"),
  imageMime: text("image_mime"),

  // 'reported' | 'backlog' | 'on_hold' | 'fix_in_progress' | 'merge' | 'fixed_ready_to_test' | 'more_info_required' | 'closed' | 'roadmap'
  status: text("status").notNull().default("reported"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  resolvedAt: timestamp("resolved_at"),      // set when the user confirms the fix (status=closed)

  // "Pass to Developer" AI auto-fix handoff (see db/issue-reports.sql).
  // null | 'queued' | 'in_progress' | 'completed' | 'failed'
  devHandoffStatus: text("dev_handoff_status"),
  devHandoffAt: timestamp("dev_handoff_at"),
  devBranch: text("dev_branch"),             // branch the runner pushed the fix to
  devPrUrl: text("dev_pr_url"),              // PR opened by the runner
  devResult: text("dev_result"),             // AI summary of the fix (or failure reason)

  // Which runner currently holds this issue (fix or merge claim), and when it claimed it.
  // Multiple runners drain the queue concurrently; these let the admin portal show who is
  // working what, and flag a claim that's outlived a normal fix as a possibly-dead runner.
  devRunnerId: text("dev_runner_id"),
  devRunnerHeartbeat: timestamp("dev_runner_heartbeat"),

  // DB migration the fix needs, run from the ticket against staging Neon (see SQL file).
  devSql: text("dev_sql"),                   // idempotent SQL the AI proposed
  devSqlStatus: text("dev_sql_status"),      // null | 'pending' | 'applied' | 'failed'
  devSqlResult: text("dev_sql_result"),      // DB feedback from the run
  devSqlRanAt: timestamp("dev_sql_ran_at"),

  // Merge of the fix PR to staging — requested from the ticket (super-admin) and performed
  // by the local watcher (gh pr merge). The issue only reaches 'fixed_ready_to_test' once
  // merged (and any migration applied). null | 'ready' | 'queued' | 'merging' | 'merged' | 'failed'
  // | 'conflict_queued' | 'conflict_resolving' — the last two are a failed merge sent back to
  // the AI developer to resolve conflicts and retry (see admin-issue-handoff's claim-conflict-fix).
  devMergeStatus: text("dev_merge_status"),
  devMergedAt: timestamp("dev_merged_at"),
  devMergeResult: text("dev_merge_result"),  // gh output / error from the merge attempt

  // Promotion of the staging-verified fix to production — requested from the ticket
  // (super-admin "Push to prod") and performed by the local watcher, which pushes
  // staging → main (prod deploys from main). null | 'queued' | 'promoting' | 'promoted' | 'failed'
  devProdStatus: text("dev_prod_status"),
  devProdAt: timestamp("dev_prod_at"),
  devProdResult: text("dev_prod_result"),    // git/gh output or error from the promotion
}, (t) => [
  index("issue_reports_user_idx").on(t.userId, t.createdAt),
  index("issue_reports_org_idx").on(t.organisationId),
  index("issue_reports_status_idx").on(t.status, t.createdAt),
  index("issue_reports_handoff_idx").on(t.devHandoffStatus, t.devHandoffAt),
  index("issue_reports_merge_idx").on(t.devMergeStatus, t.devHandoffAt),
  index("issue_reports_prod_idx").on(t.devProdStatus, t.devHandoffAt),
]);

// Issue Report Messages Table — threaded admin status updates + user replies.
export const issueReportMessages = pgTable("issue_report_messages", {
  id: serial("id").primaryKey(),
  issueId: integer("issue_id")
      .notNull()
      .references(() => issueReports.id, { onDelete: "cascade" }),
  authorType: text("author_type").notNull(),   // 'admin' | 'user'
  authorId: integer("author_id").references(() => users.id, { onDelete: "set null" }),
  body: text("body").notNull(),
  // The status the issue was moved to alongside this message (null = plain message/reply).
  status: text("status"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("issue_report_messages_issue_idx").on(t.issueId, t.createdAt),
]);

// Feature Roadmap Table — admin-only delivery backlog (see db/feature-roadmap.sql).
// Items are created when a feature-request issue is promoted (source='issue', issue_id set)
// or added directly by an admin (source='manual'). Prioritised by `priority` + manual drag
// `sortOrder` (lower = higher on the board).
export const featureRoadmap = pgTable("feature_roadmap", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  // 'critical' | 'high' | 'medium' | 'low'
  priority: text("priority").notNull().default("medium"),
  // 'planned' | 'in_progress' | 'shipped' | 'declined'
  status: text("status").notNull().default("planned"),
  // Manual drag-rank within the board; lower sorts higher.
  sortOrder: integer("sort_order").notNull().default(0),
  // 'manual' | 'issue'
  source: text("source").notNull().default("manual"),
  issueId: integer("issue_id").references(() => issueReports.id, { onDelete: "set null" }),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("feature_roadmap_order_idx").on(t.status, t.sortOrder),
  index("feature_roadmap_issue_idx").on(t.issueId),
]);

// Feature Requests & Roadmap — unified, user-facing feature voting + admin roadmap.
// See db/feature-requests.sql. Supersedes feature_roadmap (which it migrates in): adds
// public submission, a moderation queue, voting, LLM-enhanced admin workflow and a
// Year/Quarter Gantt. Status/category/priority/source are mirrored by SQL CHECK constraints
// and the SoT in src/utils/feature-requests.ts.
export const featureRequests = pgTable("feature_requests", {
  id: serial("id").primaryKey(),
  // Who raised it. The original reporter for issue-promoted items (so status-change
  // notifications reach them); NULL only for purely admin/manual-originated items.
  submittedBy: integer("submitted_by").references(() => users.id, { onDelete: "set null" }),
  // Submitter's org for context (the board is global/cross-tenant).
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "set null" }),
  // Live (admin-editable) text shown on the public board.
  title: text("title").notNull(),
  description: text("description"),
  // The submitter's raw original text, preserved so "Enhance with AI" works from their words.
  submitterDescription: text("submitter_description"),
  // 'app_core' | 'existing_assistant' | 'new_assistant'
  category: text("category").notNull().default("app_core"),
  // CATALOGUE ROLE slug when category='existing_assistant' (not a tenant instance).
  assistantRef: text("assistant_ref"),
  // Work-item breakdown: 'epic' | 'feature' | 'user_story' | 'acceptance_criteria'.
  itemType: text("item_type").notNull().default("feature"),
  // Optional parent for the Epic → Feature → User Story → Acceptance Criteria hierarchy.
  parentId: integer("parent_id").references((): AnyPgColumn => featureRequests.id, { onDelete: "set null" }),
  // pending_review | under_review | open | planned | brief_ready | in_progress | released | declined | duplicate
  status: text("status").notNull().default("pending_review"),
  // 'critical' | 'high' | 'medium' | 'low'
  priority: text("priority").notNull().default("medium"),
  // Gantt placement, e.g. '2026-Q3'.
  targetQuarter: text("target_quarter"),
  // The execution brief for Claude to build from (status='brief_ready' and later). Optionally
  // AI-drafted from title/description via ?action=draft-brief.
  brief: text("brief"),
  // Manual drag-rank within the admin board; lower sorts higher.
  sortOrder: integer("sort_order").notNull().default(0),
  // Denormalised vote tally (feature_request_votes is the source of truth).
  voteCount: integer("vote_count").notNull().default(0),
  // 'user' (moderated) | 'manual' (admin) | 'issue' (promoted bug report)
  source: text("source").notNull().default("user"),
  issueId: integer("issue_id").references(() => issueReports.id, { onDelete: "set null" }),
  // Duplicate handling: the request this one was merged into (status='duplicate').
  mergedIntoId: integer("merged_into_id").references((): AnyPgColumn => featureRequests.id, { onDelete: "set null" }),
  reviewedBy: integer("reviewed_by").references(() => users.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at"),
  // Set when status first becomes 'released'; powers the avg-wait metric.
  releasedAt: timestamp("released_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("feature_requests_status_idx").on(t.status, t.voteCount),
  index("feature_requests_board_idx").on(t.status, t.sortOrder),
  index("feature_requests_submitter_idx").on(t.submittedBy, t.createdAt),
  index("feature_requests_quarter_idx").on(t.targetQuarter),
  index("feature_requests_issue_idx").on(t.issueId),
  index("feature_requests_parent_idx").on(t.parentId),
]);

// One row per (feature, user). UNIQUE enforces "one upvote per user"; toggling deletes the row.
export const featureRequestVotes = pgTable("feature_request_votes", {
  id: serial("id").primaryKey(),
  featureId: integer("feature_id").notNull().references(() => featureRequests.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  unique("feature_request_votes_unique").on(t.featureId, t.userId),
  index("feature_request_votes_user_idx").on(t.userId),
  index("feature_request_votes_feature_idx").on(t.featureId),
]);

// AI Model Config Table — runtime routing rules; admin-editable without deploys (US13)
export const aiModelConfig = pgTable("ai_model_config", {
  id: serial("id").primaryKey(),
  // Logical slot: 'primary' | 'fallback' | 'moderation'
  slot: text("slot").notNull().unique(),
  provider: text("provider").notNull().default("openai"), // 'openai' | 'anthropic' | 'google'
  model: text("model").notNull(),                         // e.g. 'gpt-4o' | 'claude-3-5-sonnet-20241022'
  isActive: boolean("is_active").notNull().default(true),
  // Optional per-slot spend cap (USD cents per month); null = unlimited
  monthlyBudgetCents: integer("monthly_budget_cents"),
  updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  check("ai_model_config_provider_check", sql`${t.provider} IN ('openai', 'anthropic', 'google')`),
]);
// User Notifications Table — Global feed for alerts, tickets, and billing
// DEPRECATED (US-DB-1.2.1 ADR-001): userNotifications duplicates the notifications table.
// Canonical table is notifications (above). All new writes/reads must use notifications.
// Remove this table after all legacy callers are migrated.
export const userNotifications = pgTable("user_notifications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

  title: text("title").notNull(),
  message: text("message").notNull(),
  type: text("type").notNull(), // e.g., 'ticket_created', 'billing_alert'
  referenceId: text("reference_id"), // e.g., The specific Ticket ID

  isRead: boolean("is_read").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  // US-DB-1.1.1: Notification inbox query — userId + isRead + createdAt
  index("user_notifications_user_read_idx").on(t.userId, t.isRead, t.createdAt),
]);
// Onboarding Drafts Table — Stores auto-save progress for incomplete setups.
// Multi-row: a user (and org) may have several in-progress assistant drafts at once,
// each rendered as an "Onboarding" card. (Previously keyed by user_id = one draft/user.)
export const onboardingDrafts = pgTable("onboarding_drafts", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // Org that owns the draft — lets the My Team view list drafts org-wide. Nullable so legacy
  // rows survive the migration; populated on create going forward.
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "cascade" }),
  currentStep: integer("current_step").default(2).notNull(),
  onboardingPath: text("onboarding_path").notNull(),
  // Card metadata: role icon key + chosen name (null → "Unnamed {Role}").
  roleKey: text("role_key"),
  displayName: text("display_name"),
  draftData: jsonb("draft_data").default({}).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  // Tracks when the last abandoned-onboarding reminder was sent to avoid duplicate emails
  reminderSentAt: timestamp("reminder_sent_at"),
}, (t) => [
  index("onboarding_drafts_user_idx").on(t.userId),
  index("onboarding_drafts_org_idx").on(t.organisationId),
]);

// Content Assets Table — Media Hub (My Content)
// Stores user-uploaded images, videos, and external links for assistant use
export const contentAssets = pgTable("content_assets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id")
      .references(() => organisations.id, { onDelete: "cascade" }),

  // Asset identity
  name: text("name").notNull(),
  // 'audio' is blog-body only and upload-only (plan §4 Phase 2). Text column by design — adding a
  // type is a validation change in content-assets.ts, never a migration.
  assetType: text("asset_type").notNull(), // 'image' | 'video' | 'audio' | 'link'
  mimeType: text("mime_type"),
  fileSize: integer("file_size"),
  // Pixel dimensions. Nullable — legacy rows and links have none. Without these the platform
  // preview's aspect-ratio check could NEVER compare anything, so it always fell through to the
  // generic "Recommended aspect ratio for this slot… verify your asset" nag, on every post with
  // media, forever. Populated on upload, on AI generation, and from the stock provider.
  // db/content-asset-dimensions.sql.
  width: integer("width"),
  height: integer("height"),
  // Playable length in seconds. NULL for images, links and legacy rows — and NULL must be read as
  // "unknown", never as zero: a router treating it as 0 would call a 40-minute film a YouTube
  // Short. Together with width/height this is what lets a format be DERIVED from the asset instead
  // of chosen by hand, including on the server, where the autonomous drafters run with no <video>
  // element to measure. db/content-asset-duration.sql.
  durationS: real("duration_s"),

  // Storage — one of these will be populated
  storageKey: text("storage_key"),
  storageUrl: text("storage_url"),
  externalUrl: text("external_url"),

  // Stock-provider sourcing (US3 AC3.2). null provider = user-uploaded asset.
  // For Pexels: externalUrl holds the CDN URL (hotlinked, never permanently hosted — AC3.1).
  provider: text("provider"),                 // 'pexels' | null
  providerAssetId: text("provider_asset_id"), // unique stock-provider asset ID (string)
  attributionName: text("attribution_name"),  // photographer name
  attributionUrl: text("attribution_url"),    // photographer profile URL

  // Lifecycle status: pending → scheduled | rejected; scheduled → posted
  status: text("status").notNull().default("pending"), // pending|scheduled|posted|rejected
  rejectionReason: text("rejection_reason"),

  // Scheduling / publication
  // DEPRECATED (US-DB-1.2.1): use scheduledPostAssets junction table. Retained for migration window.
  scheduledPostId: integer("scheduled_post_id"),
  postedAt: timestamp("posted_at"),
  rejectedAt: timestamp("rejected_at"),

  // Data retention — populated when status changes to posted/rejected
  retentionDeleteAfter: timestamp("retention_delete_after"),
  purgedAt: timestamp("purged_at"),
  // "A human touched this, so it lives in the library for good." Stamped when the user saves a
  // brand card in the review-time editor (edit-brand-card.ts) or presses Keep in My Content, and
  // read ONLY as an exemption from the unused-brand-card expiry — see
  // src/utils/brand-card-lifecycle.ts for the rule and why the exemption has to exist. NULL means
  // "never touched", which for a generated card is what puts it on the 30-day clock; for every
  // other kind of asset NULL means nothing at all, because nothing else expires this way.
  // Apply db/brand-card-lifecycle.sql by hand BEFORE deploying the code that reads this.
  libraryKeptAt: timestamp("library_kept_at"),

  // Epic 1 (AI Media Generation): provider 'fal' rows are AI-generated. These columns power
  // the "My AI Uploads" library (US3) — prompt memory + the originating generation job.
  prompt: text("prompt"),                                   // original generation prompt (US3 AC: prompt memory)
  aspectRatio: text("aspect_ratio"),                        // '1:1' | '16:9' | '9:16' | '4:5'
  // Everything needed to re-render this asset from scratch. Only branded text cards use it today:
  // { kind:'brand_card', headline, variant, kit } — the flattened PNG records none of that, so
  // without it the review-time card editor could not reopen a user's own edits. db/brand-card-render-params.sql.
  renderParams: jsonb("render_params"),
  generationJobId: integer("generation_job_id"),            // FK to media_generation_jobs.id (nullable)

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  // US-DB-1.1.1: Org-level and user-level content asset lookups
  index("content_assets_org_idx").on(t.organisationId),
  index("content_assets_user_idx").on(t.userId),
]);

// US2 (Image Deduplication): append-only ledger of every stock-provider asset ID that has
// been committed (scheduled or published) to a post, scoped per workspace/organisation.
// The unique (organisation, provider, providerAssetId) constraint enforces the HARD "never
// reuse" rule and makes recordPostedAssets() idempotent across the schedule + publish hooks.
export const postedAssets = pgTable("posted_assets", {
  id: serial("id").primaryKey(),
  organisationId: integer("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
  userId: integer("user_id")
      .references(() => users.id, { onDelete: "set null" }),   // audit: who used it
  provider: text("provider").notNull().default("pexels"),
  providerAssetId: text("provider_asset_id").notNull(),
  scheduledPostId: integer("scheduled_post_id"),               // FK to scheduledPosts.id (set null on delete)
  contentAssetId: integer("content_asset_id"),                 // FK to contentAssets.id (set null on delete)
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  unique("posted_assets_org_provider_asset_unique").on(t.organisationId, t.provider, t.providerAssetId),
  index("posted_assets_org_idx").on(t.organisationId),
]);

// Transient cache of raw Pexels search responses, keyed by normalized "query|type|page".
// Caching runs BEFORE per-org dedup (filterUnique), so it never breaks the never-reuse rule.
// Short TTL (PEXELS_CACHE_TTL_MS in src/utils/pexels.ts). db/pexels-search-cache.sql.
export const pexelsSearchCache = pgTable("pexels_search_cache", {
  queryKey: text("query_key").primaryKey(),
  candidates: jsonb("candidates").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index("pexels_search_cache_created_idx").on(t.createdAt),
]);

// Guided tour voice narration cache (issue #161) — static TOUR_STEPS copy synthesized once via
// OpenAI TTS and reused for every user, keyed by a hash of text + voice. db/tour-narration-cache.sql.
export const tourNarrationCache = pgTable("tour_narration_cache", {
  textHash: text("text_hash").primaryKey(),
  voice: text("voice").notNull(),
  audioBase64: text("audio_base64").notNull(),
  mimeType: text("mime_type").notNull().default("audio/mpeg"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

// Invoices table — one row per generated invoice, created on every successful payment
export const invoices = pgTable("invoices", {
  id: serial().primaryKey(),
  userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id")
      .references(() => organisations.id, { onDelete: "cascade" }),
  planId: integer("plan_id")
      .references(() => plans.id, { onDelete: "set null" }),
  invoiceNumber: text("invoice_number").notNull().unique(),
  issueDate: timestamp("issue_date").notNull().defaultNow(),
  billingPeriodStart: timestamp("billing_period_start"),
  billingPeriodEnd: timestamp("billing_period_end"),
  planName: text("plan_name").notNull(),
  subtotal: numeric("subtotal", { precision: 12, scale: 2 }).notNull(),
  taxRate: numeric("tax_rate", { precision: 5, scale: 4 }).notNull().default('0'),
  taxAmount: numeric("tax_amount", { precision: 12, scale: 2 }).notNull().default('0'),
  total: numeric("total", { precision: 12, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("GBP"),
  status: text("status").notNull().default("paid"),   // 'paid' | 'void' | 'refunded'
  stripeInvoiceId: text("stripe_invoice_id"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  check("invoices_currency_check", sql`${t.currency} IN ('GBP', 'EUR', 'USD')`),
  // US-DB-1.1.1: Org-level and user-level invoice lookups
  index("invoices_org_idx").on(t.organisationId),
  index("invoices_user_idx").on(t.userId),
]);

// Scheduled Posts Table — Content Calendar & Post Governance
export const scheduledPosts = pgTable("scheduled_posts", {
  id: serial("id").primaryKey(),
  assistantId: integer("assistant_id")
      .references(() => aiAssistants.id, { onDelete: "set null" }),
  userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id")
      .references(() => organisations.id, { onDelete: "cascade" }),

  // Publishing logistics
  platform: text("platform").notNull(),         // facebook|instagram|linkedin|x
  postFormat: text("post_format").notNull(),     // text|image|carousel|reel|story|thread|video
  // The chosen POST FORMAT from src/config/post-formats.ts — 'ig_reel', 'li_document', 'x_poll'…
  // Deliberately a NEW column rather than reusing post_format above: that one is a loose media
  // descriptor several publishers already branch on (publish-instagram tests it for 'reel'|'video'),
  // so overloading it with 29 new values would change behaviour everywhere it is read. NULL means a
  // legacy post from before the catalogue — those stay schedulable and publish exactly as they did.
  // See db/post-format-key.sql.
  formatKey: text("format_key"),
  publishDate: timestamp("publish_date").notNull(),
  publishedAt: timestamp("published_at"),
  platformPostId: text("platform_post_id"),      // external ID after publish
  platformPostUrl: text("platform_post_url"),    // live URL after publish

  // Content & creative
  caption: text("caption"),
  // DEPRECATED (US-DB-1.2.1): use scheduledPostAssets junction table for all new queries.
  // Retained until one-time migration script populates scheduledPostAssets from existing rows; drop after migration.
  contentAssetIds: jsonb("content_asset_ids").default([]),
  // User-authored text overlays composited onto the post image (see db/post-image-overlays.sql).
  // image_overlays is the editable design; overlay_base_asset_id is the clean pre-bake image so a
  // re-edit composites onto the original, not an already-flattened one.
  imageOverlays: jsonb("image_overlays"),
  overlayBaseAssetId: integer("overlay_base_asset_id").references(() => contentAssets.id, { onDelete: "set null" }),
  // Timed audio on the post — voice notes and sound, modelled exactly like imageOverlays above:
  // [{ id, assetId, startS?, endS?, volume, fadeInS, fadeOutS }], absent bounds meaning the whole
  // post. Any audio at all forces a server-side render (a still with sound is not a post any
  // platform accepts, so an image + audio has to become an mp4). See src/lib/audio-overlays.ts and
  // db/post-audio-overlays.sql.
  audioOverlays: jsonb("audio_overlays"),
  // Phase 4 video overlays: gates publishing while a video's timed text is being rendered by Remotion
  // Lambda. null = nothing to render (photo, or video with no overlays); 'pending'|'rendering' = a
  // render is in flight (publish must wait); 'done' = the overlaid video is attached; 'failed' = the
  // render errored (surfaced to the reviewer). See db/post-render-jobs.sql.
  renderStatus: text("render_status"),
  // Per-post opt-out for the EU AI Act Art. 50 disclosure footer. The footer is on by default (org
  // setting); a reviewer can strip it from this single post. See db/post-disclosure-footer-optout.sql
  // + toggle-post-disclosure.ts.
  disclosureFooterDisabled: boolean("disclosure_footer_disabled").notNull().default(false),
  linkUrl: text("link_url"),
  ctaText: text("cta_text"),
  hashtags: text("hashtags"),                    // space-separated or newline-separated
  mentions: text("mentions"),
  utmParams: text("utm_params"),

  // Workflow & governance
  // Status: draft | pending_approval | in_review | approved | scheduled | publishing | published | paused | failed | rejected | cancelled | missed | admin_test
  // (see scheduled_posts_status_check below / db/scheduled-posts-status-check.sql)
  status: text("status").notNull().default("draft"),
  ownerId: integer("owner_id")
      .references(() => users.id, { onDelete: "set null" }),
  ownerLabel: text("owner_label"),               // e.g. "AI: Marketing Mike" or "Jane Smith"
  isAutonomous: boolean("is_autonomous").default(false).notNull(),
  campaign: text("campaign"),
  pillar: text("pillar"),

  rejectedAt: timestamp("rejected_at"),
  rejectionReason: text("rejection_reason"),
  cancelledAt: timestamp("cancelled_at"),
  // US-SMM-2.4.2: Timestamp when post transitioned to 'missed' status
  missedAt: timestamp("missed_at"),
  // US-SMM-2.4.2: Whether a red-urgency push notification has already been sent (prevents duplicate alerts)
  redAlertSentAt: timestamp("red_alert_sent_at"),

  // US-SMM-2.2.2: structured rejection — revised post chain
  revisedFromPostId: integer("revised_from_post_id"),    // FK to scheduledPosts.id (self-ref)
  isRevised: boolean("is_revised").notNull().default(false),

  // Cross-post fan-out identity (db/crosspost-group-id.sql). A post the user asks to cross-post is
  // fanned out into one row per platform; every sibling of the SAME logical post carries the SAME
  // uuid here, stamped at fan-out time (create-manual-post / chat-orchestrator / schedule-gap-fill →
  // process-content-jobs). The Review Queue groups siblings by this id. NULL for legacy rows and any
  // standalone post — those never collapse together (each shows as its own card).
  crosspostGroupId: text("crosspost_group_id"),

  // US-GOV-2.2.1: Confidence scoring & factual claim detection
  confidenceScore: text("confidence_score"),             // 'green' | 'amber' | 'red' | null (not yet scored)
  factualClaimsCount: integer("factual_claims_count"),   // number of factual claims detected
  factualClaims: jsonb("factual_claims"),                // array of { claim, claimType, sourceAvailable }
  confidenceAssessedAt: timestamp("confidence_assessed_at"),
  confidenceAssessmentMs: integer("confidence_assessment_ms"), // duration of scoring call

  // Autopilot "publish" mode: set when a draft skipped human review (src/utils/publish-policy.ts).
  // Null for every post a human approved, and for every draft still awaiting review. Doubles as the
  // counter for the rolling-7-day unattended-publish ceiling and as the audit marker for "this went
  // out without anyone looking at it".
  autoPublishedAt: timestamp("auto_published_at"),

  // In-flight YouTube resumable-upload session { uploadUrl, total, offset } (db/youtube-upload-resume.sql).
  // A long video does not fit in one function invocation, so publish-youtube-background parks the
  // session here and the next invocation resumes from it rather than re-uploading from zero.
  // NULL = nothing in flight; cleared on success AND on terminal failure.
  youtubeUploadState: jsonb("youtube_upload_state"),

  // US-GOV-3.2.1: C2PA provenance — FK set at publish time
  provenanceContentId: text("provenance_content_id"),      // references contentProvenance.contentId

  // US-SMM-3.1.1: LLM generation job linkage
  jobId: text("job_id"),                                   // FK to contentGenerationJobs.jobId
  blueprintId: integer("blueprint_id").references(() => aiBlueprints.id, { onDelete: "set null" }),
  suggestedMediaDescription: text("suggested_media_description"),
  // Epic 3 US6: human-readable note explaining why an autonomous draft was created
  // (e.g. "Drafted to fill a 3-day gap in your Instagram schedule").
  generationReason: text("generation_reason"),
  conflictNotice: text("conflict_notice"),              // set when context prompt conflicted with a strict rule
  // Issue #55: set when a content asset attached to this post was deleted from My Content
  // (contentAssetIds is a plain jsonb array with no FK, so deletion can't cascade — this flags
  // the Review Queue instead so the user/assistant can source replacement media).
  mediaMissing: boolean("media_missing").notNull().default(false),
  mediaMissingNote: text("media_missing_note"),
  generatedAt: timestamp("generated_at"),
  // US-SMM-3.4.1: On-demand generation trigger type
  triggerType: text("trigger_type"),                       // 'on_demand' | 'scheduled' | null

  // US-SMM-3.2.1: Instagram connection
  connectionId: integer("connection_id").references(() => systemConnections.id, { onDelete: "set null" }),

  // US-CAL-5.1: AI content quality review result (cached)
  qualityReview: jsonb("quality_review"),

  // US-SMM-3.3.1/3.3.2: Publishing pipeline
  // Status extensions: 'publishing' | 'paused' | 'failed' in addition to existing statuses
  containerId: text("container_id"),                       // Instagram step-1 media container ID
  attemptCount: integer("attempt_count").notNull().default(0),
  retryAt: timestamp("retry_at"),
  failureReason: jsonb("failure_reason"),                  // { errorCode, errorMessage, errorSubcode, isRetryable }

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  // US-DB-1.1.1: Org-level and user-level scheduled post lookups
  index("scheduled_posts_org_idx").on(t.organisationId),
  index("scheduled_posts_user_idx").on(t.userId),
  // US-SMM-3.3.1: Partial index for publish queue polling
  index("scheduled_posts_publish_queue_idx").on(t.publishDate).where(sql`status = 'scheduled' AND platform = 'instagram'`),
  // 'paused_credits' is NOT a synonym for 'paused': it is the X quota park, written by
  // pauseForXCredits and selected back out by the monthly reset sweep and stripe-webhook's
  // credit-pack top-up. It was missing here and from the live constraint, which made every pause
  // a constraint violation — see db/scheduled-posts-paused-credits-status.sql.
  check("scheduled_posts_status_check", sql`${t.status} IN ('draft', 'pending_approval', 'in_review', 'approved', 'scheduled', 'publishing', 'published', 'paused', 'paused_credits', 'failed', 'rejected', 'cancelled', 'missed', 'admin_test')`),
]);

// US-SMM-PERF: Per-post social performance snapshot.
// One upserted row per published post, refreshed by ingest-instagram-insights.ts.
// Source of truth for the assistant-detail "Performance Metrics" cards
// (engagement rate, organic reach growth, click-through rate), aggregated by
// get-assistant-performance.ts. Platform-agnostic so LinkedIn/X ingesters can reuse it.
export const postInsights = pgTable("post_insights", {
  id: serial().primaryKey(),
  scheduledPostId: integer("scheduled_post_id")
      .notNull()
      .references(() => scheduledPosts.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
  assistantId: integer("assistant_id")
      .references(() => aiAssistants.id, { onDelete: "set null" }),
  connectionId: integer("connection_id")
      .references(() => systemConnections.id, { onDelete: "set null" }),
  platform: text("platform").notNull(),              // instagram | facebook | linkedin | x
  platformPostId: text("platform_post_id").notNull(), // external media/post id
  publishedAt: timestamp("published_at"),

  // Raw counters as returned by the platform (nulls where unsupported).
  reach: integer("reach"),
  impressions: integer("impressions"),               // deprecated on newer IG media — may be null
  likes: integer("likes"),
  comments: integer("comments"),
  shares: integer("shares"),
  saves: integer("saves"),
  totalInteractions: integer("total_interactions"),  // engagement numerator
  videoViews: integer("video_views"),
  linkClicks: integer("link_clicks"),                // null for IG organic feed — reserved for platforms that expose it

  raw: jsonb("raw"),                                 // full insights payload for debugging / future metrics
  fetchedAt: timestamp("fetched_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  // One snapshot per post — ingester upserts on this key.
  uniqueIndex("post_insights_post_uidx").on(t.scheduledPostId),
  // Per-assistant aggregation over a time window (get-assistant-performance.ts).
  index("post_insights_assistant_published_idx").on(t.assistantId, t.publishedAt),
  // Org-scoped + platform reporting.
  index("post_insights_org_platform_idx").on(t.organisationId, t.platform),
]);

// US-DB-1.2.1: Junction table replacing scheduledPosts.contentAssetIds JSONB array.
// Provides referential integrity: GDPR purge of a contentAsset now cascades correctly.
// Migration: one-time script reads scheduledPosts.contentAssetIds[] and inserts rows here;
// scheduledPosts.contentAssetIds is deprecated and will be dropped after migration.
export const scheduledPostAssets = pgTable("scheduled_post_assets", {
  scheduledPostId: integer("scheduled_post_id").notNull().references(() => scheduledPosts.id, { onDelete: "cascade" }),
  contentAssetId: integer("content_asset_id").notNull().references(() => contentAssets.id, { onDelete: "cascade" }),
  position: integer("position").notNull().default(0),
}, (t) => [
  unique("scheduled_post_assets_pk").on(t.scheduledPostId, t.contentAssetId),
]);

// "Create Post" → Suggest an idea mode. A user-submitted post idea that the assistant should fold
// into a FUTURE scheduled/conversion draft (it is NOT drafted immediately). Consumed once, FIFO:
// process-content-jobs.ts picks the oldest 'pending' idea for an assistant when a scheduled job
// carries no context_prompt, uses it as the generation context, then marks the row 'used' with the
// resulting post id. Canonical column definitions; apply db/post-idea-suggestions.sql by hand.
export const postIdeaSuggestions = pgTable("post_idea_suggestions", {
  id: serial("id").primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  assistantId: integer("assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  idea: text("idea").notNull(),
  platform: text("platform"),                       // target platforms, comma-separated (facebook|instagram|linkedin|x); null === all
  // Idea lifecycle: 'pending' (awaiting use) → 'in_review' (woven into a draft now awaiting human
  // review) → 'delivered' (that draft was approved). 'discarded' = dropped by the user. 'used' is a
  // legacy synonym for 'in_review' kept for older rows.
  status: text("status").notNull().default("pending"),
  usedPostId: integer("used_post_id").references(() => scheduledPosts.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  usedAt: timestamp("used_at"),
  deliveredAt: timestamp("delivered_at"),           // set when usedPostId was approved
}, (t) => [
  index("post_idea_suggestions_assistant_status_idx").on(t.assistantId, t.status),
  index("post_idea_suggestions_used_post_idx").on(t.usedPostId),
  check("post_idea_suggestions_status_check", sql`${t.status} IN ('pending', 'in_review', 'delivered', 'used', 'discarded')`),
]);

// ── DPA Requests — US-AUD-4.1.1 SC3 ──────────────────────────────────────────
// Stores Data Processing Agreement request submissions from the /trust.html page.
// On insert: (a) email sent to platform legal contact, (b) auto-acknowledgement sent to requester.
// ── DPA Acceptances — US-GDPR-1.1.1 ─────────────────────────────────────────
// Append-only evidence of Article 28 DPA consent per organisation.
// Each row is legally admissible proof per Article 28(9).
// No application-level DELETE or UPDATE should ever touch this table.
export const dpaAcceptances = pgTable("dpa_acceptances", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  acceptedAt: timestamp("accepted_at").defaultNow().notNull(),
  version: text("version").notNull(),          // DPA version string, e.g. '1.0'
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  email: text("email").notNull(),              // email of accepting user (captured before any anonymisation)
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const dpaRequests = pgTable("dpa_requests", {
  id: serial().primaryKey(),
  name: text("name").notNull(),
  company: text("company").notNull(),
  email: text("email").notNull(),
  requestedAt: timestamp("requested_at").defaultNow().notNull(),
});

// ── Rate Limit Attempts — US-GAP-7.1.1 ───────────────────────────────────────
// Tracks request attempts per key (IP address or userId) and endpoint.
// Old rows are pruned automatically by the rate-limit utility (keep last 24h).
// key: IP address (for public endpoints) or `user:<userId>` (for auth'd endpoints)
export const rateLimitAttempts = pgTable("rate_limit_attempts", {
  id: serial().primaryKey(),
  key: text("key").notNull(),          // IP or 'user:<id>'
  endpoint: text("endpoint").notNull(), // e.g. 'register', 'login', 'onboarding', 'support'
  attemptedAt: timestamp("attempted_at").defaultNow().notNull(),
}, (t) => [
  // US-DB-1.1.1: checkRateLimit called on every public endpoint — must use index scan
  index("rate_limit_key_endpoint_idx").on(t.key, t.endpoint, t.attemptedAt),
]);

// ── Referral Attribution — US-AUD-5.3.1 SC5 ──────────────────────────────────
// Records new signups that originated from an agency attribution badge link.
export const referralAttribution = pgTable("referral_attribution", {
  id: serial().primaryKey(),
  referrerOrgId: integer("referrer_org_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  newUserId: integer("new_user_id").references(() => users.id, { onDelete: "set null" }),
  sourceType: text("source_type").notNull().default("agency_badge"), // 'agency_badge'
  convertedAt: timestamp("converted_at").defaultNow().notNull(),
});

// ── User Churn Signals — US-AUD-3.1.1 SC1 ────────────────────────────────────
// One row per unique signal event per user. interventionSentAt null = not yet sent.
export const userChurnSignals = pgTable("user_churn_signals", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // SC2–SC6 signal types
  signalType: text("signal_type").notNull(), // 'no_tasks_7d' | 'repeated_task_failure' | 'integration_disconnected_48h' | 'upgrade_intent_not_converted' | 'early_support_ticket'
  detectedAt: timestamp("detected_at").defaultNow().notNull(),
  interventionSentAt: timestamp("intervention_sent_at"),
  metadata: jsonb("metadata"),
});

// ── Page Events — US-AUD-3.1.1 SC5 ──────────────────────────────────────────
// Tracks significant page views for churn signal detection (Signal 4: pricing page view).
export const pageEvents = pgTable("page_events", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  pagePath: text("page_path").notNull(), // e.g. '/pricing.html'
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Win-Back Email Opt-Outs — US-GAP-4.2.1 SC5 ──────────────────────────────
// Records users who have unsubscribed from win-back email sequences.
export const winBackOptOuts = pgTable("win_back_opt_outs", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().unique().references(() => users.id, { onDelete: "cascade" }),
  optedOutAt: timestamp("opted_out_at").defaultNow().notNull(),
});

// ── GDPR Erasure Log — US-GAP-2.1.2 SC3 / US-GAP-2.1.1 SC5 ─────────────────
// Anonymised record retained after account deletion for compliance audit.
export const gdprErasureLog = pgTable("gdpr_erasure_log", {
  id: serial().primaryKey(),
  emailHash: text("email_hash").notNull(),                      // SHA-256 of the deleted email
  requesterType: text("requester_type").notNull(),              // 'user' | 'admin'
  requestedBy: integer("requested_by"),                         // admin userId if requester='admin'
  erasedAt: timestamp("erased_at").defaultNow().notNull(),
  metadata: jsonb("metadata"),                                  // US-GDPR-2.2.1: asset purge counts, partial failures
});

// ── Vector Embeddings Deletion Map — US-GDPR-2.2.2 ─────────────────────────
// Tracks every chunk embedded into a vector store so erasure can delete them.
// Populated by RAG pipeline work; the erasure paths already query this table.
// Any future RAG work MUST insert a row here before writing to the vector store.
export const vectorEmbeddings = pgTable("vector_embeddings", {
  id: serial().primaryKey(),
  sourceType: text("source_type").notNull(), // 'workspace_asset' | 'conversation'
  sourceId: integer("source_id").notNull(),  // FK to workspace_assets.id or task_runs.id
  vectorStoreId: text("vector_store_id").notNull(), // external record ID (pgvector rowid or Pinecone ID)
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  // US-DB-1.1.1: Org-level and user-level embedding lookups + GDPR erasure queries
  index("vector_embeddings_org_idx").on(t.organisationId),
  index("vector_embeddings_user_idx").on(t.userId),
]);

// ── Knowledge Base Articles — Tier 1 Support Agent KB phase ─────────────────
// User-managed support knowledge for an assistant (netlify/functions/kb-articles.ts,
// Knowledge Base tab on assistant-detail.html). Articles are chunked + embedded into
// kb_chunks; tier1_support_agent retrieval grounds Resolved answers in these rows.
// Migration: db/kb-articles.sql (manual apply — pgvector column + tsvector fallback).
export const kbArticles = pgTable("kb_articles", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  aiAssistantId: integer("ai_assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }),
  title: text().notNull(),
  content: text().notNull(),
  source: text().notNull().default("manual"),            // 'manual' | 'file_upload'
  // 'pending' → not yet chunked; 'embedded' → vectors written; 'keyword_only' →
  // no embedding provider configured, full-text fallback only; 'failed' → provider error.
  embeddingStatus: text("embedding_status").notNull().default("pending"),
  chunkCount: integer("chunk_count").notNull().default(0),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("kb_articles_org_idx").on(t.organisationId),
  index("kb_articles_assistant_idx").on(t.aiAssistantId),
]);

// One retrieval unit per article chunk. `embedding` is NULL when no embedding
// provider is configured — retrieval then falls back to Postgres full-text search
// over `content` (content_tsv generated column lives in the SQL migration only).
// GDPR: every embedded chunk gets a vectorEmbeddings map row (sourceType 'kb_article').
export const kbChunks = pgTable("kb_chunks", {
  id: serial().primaryKey(),
  kbArticleId: integer("kb_article_id").notNull().references(() => kbArticles.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  aiAssistantId: integer("ai_assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }),
  chunkIndex: integer("chunk_index").notNull(),
  content: text().notNull(),
  embedding: vector("embedding", { dimensions: 1024 }),  // voyage-3.5-lite output dim
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("kb_chunks_article_idx").on(t.kbArticleId),
  index("kb_chunks_assistant_idx").on(t.aiAssistantId, t.organisationId),
]);

// ── Inspo Items — Inspo tab (social_media_manager, blog_writer) ─────────────
// The inspiration material a user parks so their assistant keeps applying the
// styles/tones they like. `userNote` (what they like about it) is the strongest
// signal — often stronger than the material itself.
// Migration: db/inspo-items.sql (manual apply). Plan: docs/inspo-tab-plan.md.
//
// Raw inspo is NEVER injected wholesale — prompt cost must not scale with library
// size. It reaches the model only via inspoStyleProfiles (distilled, capped) and
// top-K retrieval over inspoChunks. Both are O(1) in item count.
export const inspoItems = pgTable("inspo_items", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  aiAssistantId: integer("ai_assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }),
  kind: text().notNull(),                                // 'url' | 'file' | 'text' | 'voice'
  title: text().notNull(),
  sourceUrl: text("source_url"),                         // kind='url'
  workspaceAssetId: integer("workspace_asset_id").references(() => workspaceAssets.id, { onDelete: "set null" }),
  userNote: text("user_note"),                           // "what I like about this" (AC2/AC3)
  body: text(),                                          // extracted/transcribed/typed text
  // AC6: deactivating must stop influence as immediately as deleting.
  isActive: boolean("is_active").notNull().default(true),
  // 'pending' → awaiting extraction; 'ready' → body usable; 'unsupported' → we
  // deliberately don't extract it (video: userNote is the only signal); 'failed'.
  ingestStatus: text("ingest_status").notNull().default("pending"),
  embeddingStatus: text("embedding_status").notNull().default("pending"),
  chunkCount: integer("chunk_count").notNull().default(0),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("inspo_items_org_idx").on(t.organisationId),
  index("inspo_items_assistant_idx").on(t.aiAssistantId),
  index("inspo_items_active_idx").on(t.aiAssistantId, t.organisationId, t.isActive),
]);

// Retrieval units for channel B. Exact mirror of kbChunks (content_tsv generated
// column lives in the SQL migration only).
// GDPR: every embedded chunk gets a vectorEmbeddings map row (sourceType 'inspo_item').
export const inspoChunks = pgTable("inspo_chunks", {
  id: serial().primaryKey(),
  inspoItemId: integer("inspo_item_id").notNull().references(() => inspoItems.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  aiAssistantId: integer("ai_assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }),
  chunkIndex: integer("chunk_index").notNull(),
  content: text().notNull(),
  embedding: vector("embedding", { dimensions: 1024 }),  // voyage-3.5-lite output dim
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("inspo_chunks_item_idx").on(t.inspoItemId),
  index("inspo_chunks_assistant_idx").on(t.aiAssistantId, t.organisationId),
]);

// Channel A cache — the distilled, token-capped style directive injected on every
// generation. `sourceItemIds` exists for AC6: the profile is a cache, so generation
// must verify a removed item isn't baked into it and fall back to retrieval-only if
// it is. `itemFingerprint` is the cheap staleness check (mirrors the blueprint hash).
export const inspoStyleProfiles = pgTable("inspo_style_profiles", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  aiAssistantId: integer("ai_assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }).unique(),
  profileText: text("profile_text").notNull(),
  sourceItemIds: integer("source_item_ids").array().notNull().default([]),
  itemFingerprint: text("item_fingerprint").notNull(),
  tokenEstimate: integer("token_estimate").notNull().default(0),
  compiledAt: timestamp("compiled_at").defaultNow().notNull(),
}, (t) => [
  index("inspo_style_profiles_org_idx").on(t.organisationId),
]);

// ── Data Export Requests — US-GAP-2.2.1 SC5 ─────────────────────────────────
// Tracks data export requests to enforce 24-hour rate limit.
export const dataExportRequests = pgTable("data_export_requests", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  requestedAt: timestamp("requested_at").defaultNow().notNull(),
  downloadToken: text("download_token"),            // signed token for the download link
  downloadUrl: text("download_url"),                // signed S3/storage URL (if generated)
  expiresAt: timestamp("expires_at"),               // 24h from generation
  status: text("status").notNull().default("pending"), // 'pending' | 'ready' | 'expired'
});

// ── Cancellation Reasons — US-GAP-4.1.1 SC2 ─────────────────────────────────
// Stores exit survey responses for product analytics.
export const cancellationReasons = pgTable("cancellation_reasons", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(), // 'too_expensive' | 'not_using' | 'missing_feature' | 'competitor' | 'technical' | 'business_closed' | 'other'
  freeText: text("free_text"),      // optional additional context
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── User Milestones — US-AUD-1.1.1 SC4 ───────────────────────────────────────
// Records one-time achievement events per user (e.g. first task complete).
export const userMilestones = pgTable("user_milestones", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  milestone: text("milestone").notNull(), // e.g. 'first_task_complete'
  completedAt: timestamp("completed_at").defaultNow().notNull(),
  metadata: jsonb("metadata"),
}, (t) => ({
  userMilestoneUnique: unique("user_milestone_unique").on(t.userId, t.milestone),
}));

// ── Admin Audit Log — US-ADM-5.1.1 ───────────────────────────────────────────
// Append-only ledger of every privileged admin action.
// Application layer enforces no UPDATE/DELETE on this table.
export const adminAuditLog = pgTable("admin_audit_log", {
  id: serial().primaryKey(),
  adminId: integer("admin_id").references(() => users.id),    // who performed the action
  action: text("action").notNull(),                             // one of the 13 defined action types
  targetType: text("target_type"),                              // e.g. 'user', 'subscription', 'assistant'
  targetId: text("target_id"),                                  // affected record id
  previousState: jsonb("previous_state"),
  newState: jsonb("new_state"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  reason: text("reason"),                                       // mandatory for destructive actions
  metadata: jsonb("metadata"),                                  // extra context (sessionId, extensionDays, etc.)
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  // US-DB-1.1.1: Admin audit log viewer filter queries
  index("admin_audit_log_admin_created_idx").on(t.adminId, t.createdAt),
  index("admin_audit_log_target_idx").on(t.targetType, t.targetId),
]);

// ── Platform Config — US-ADM-3.2.1 kill switches ─────────────────────────────
export const platformConfig = pgTable("platform_config", {
  key: varchar("key", { length: 255 }).primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: integer("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  reason: text("reason"),
});

// ── Feature Flags — US-ADM-4.2.1 ─────────────────────────────────────────────
export const featureFlags = pgTable("feature_flags", {
  key: varchar("key", { length: 255 }).primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  rolloutPercentage: integer("rollout_percentage").notNull().default(0),
  allowedWorkspaceIds: integer("allowed_workspace_ids").array(),
  allowedTiers: text("allowed_tiers").array(),
  description: text("description"),
  updatedBy: integer("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ── Supported Languages — US-ADM-1.7.2: platform-level i18n reference data ───
export const supportedLanguages = pgTable("supported_languages", {
  code: varchar("code", { length: 10 }).primaryKey(),  // BCP-47 tag, e.g. 'en-GB', 'fr'
  name: text("name").notNull(),                         // display name, e.g. 'English (UK)'
  nativeName: text("native_name"),                      // e.g. 'Français'
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

// ── AI Usage Log — US-ADM-3.1.1 COGS Dashboard ───────────────────────────────
export const aiUsageLog = pgTable("ai_usage_log", {
  id: serial().primaryKey(),
  workspaceId: integer("workspace_id").references(() => organisations.id, { onDelete: "set null" }),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  // US-DB-1.2.1: added FK references (previously bare integers)
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "set null" }),
  model: text("model").notNull(),                              // e.g. 'gpt-4o-mini'
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costUsd: decimal("cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
  taskRunId: integer("task_run_id").references(() => taskRuns.id, { onDelete: "set null" }),
  sessionId: text("session_id"),
  // US-GDPR-4.2.2: Article 30 RoPA — data categories present in the prompt.
  // Valid values: 'general' | 'business_context' | 'pii_redacted' | 'special_category_suspected' | 'financial' | 'health'
  dataCategories: text("data_categories").array().notNull().default(sql`'{general}'`),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── AI Model Pricing — per-model token cost rates for COGS calculation (US-ADM-3.1.1) ──
// Distinct from aiModelConfig (routing slots, US13). Uses a different DB table name.
export const aiModelPricing = pgTable("ai_model_pricing", {
  id: serial().primaryKey(),
  modelKey: varchar("model_key", { length: 100 }).unique().notNull(),  // must match the 'model' string logged in aiUsageLog
  displayName: text("display_name").notNull(),
  inputCostPer1kTokens: decimal("input_cost_per_1k_tokens", { precision: 10, scale: 6 }).notNull(),
  outputCostPer1kTokens: decimal("output_cost_per_1k_tokens", { precision: 10, scale: 6 }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ── Billing Reconciliation Log — US-ADM-2.3.1 ────────────────────────────────
export const billingReconciliationLog = pgTable("billing_reconciliation_log", {
  id: serial().primaryKey(),
  runAt: timestamp("run_at").defaultNow().notNull(),
  totalChecked: integer("total_checked").notNull().default(0),
  mismatchCount: integer("mismatch_count").notNull().default(0),
  results: jsonb("results"),
  status: text("status").notNull().default("success"), // 'success' | 'failed'
  errorMessage: text("error_message"),
});

// ── Lead Analysis Runs — US-SALES-1.1 Part 4 ────────────────────────────────
export const leadAnalysisRuns = pgTable("lead_analysis_runs", {
  id: serial("id").primaryKey(),
  runAt: timestamp("run_at").defaultNow().notNull(),
  leadsCreated: integer("leads_created").notNull().default(0),
  leadsUpdated: integer("leads_updated").notNull().default(0),
  patternCounts: jsonb("pattern_counts"),  // { never_onboarded, cancellation_approaching, upgrade_candidates }
  status: text("status").notNull().default("success"), // 'success' | 'failed'
  errorMessage: text("error_message"),
});

// ── Agent Run Events — US-GOV-4.2.2: Per-run full audit trail (6-month retention) ──
export const agentRunEvents = pgTable("agent_run_events", {
  id: serial().primaryKey(),
  taskRunId: integer("task_run_id").notNull().references(() => taskRuns.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(), // 'llm_call' | 'tool_call' | 'human_intervention' | 'suspension' | 'termination'
  eventIndex: integer("event_index").notNull(),
  toolName: text("tool_name"),             // present for tool_call events
  inputPayload: jsonb("input_payload"),    // sanitised — PII pseudonymised before storage
  outputPayload: jsonb("output_payload"),  // sanitised
  durationMs: integer("duration_ms"),
  costGbp: decimal("cost_gbp", { precision: 10, scale: 6 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Agent Run Summaries — retained 2 years for billing/compliance ──────────────
export const agentRunSummaries = pgTable("agent_run_summaries", {
  id: serial().primaryKey(),
  taskRunId: integer("task_run_id").notNull().references(() => taskRuns.id, { onDelete: "cascade" }).unique(),
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "set null" }),
  totalLlmCalls: integer("total_llm_calls").notNull().default(0),
  totalToolCalls: integer("total_tool_calls").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  totalCostGbp: decimal("total_cost_gbp", { precision: 10, scale: 6 }).notNull().default("0"),
  wallClockMinutes: decimal("wall_clock_minutes", { precision: 8, scale: 2 }),
  terminationReason: text("termination_reason"), // 'completed' | 'anomaly_suspended' | 'anomaly_terminated' | 'user_cancelled' | 'error'
  humanInterventionCount: integer("human_intervention_count").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Legal Holds — US-GOV-4.2.2: pause retention deletion for a workspace ───────
export const legalHolds = pgTable("legal_holds", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(),
  placedBy: integer("placed_by").references(() => users.id, { onDelete: "set null" }),
  liftedBy: integer("lifted_by").references(() => users.id, { onDelete: "set null" }),
  placedAt: timestamp("placed_at").defaultNow().notNull(),
  liftedAt: timestamp("lifted_at"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Pending Actions — US-GOV-4.1.2: HITL approval queue for Tier 3/4 agent actions ──
export const pendingActions = pgTable("pending_actions", {
  id: serial().primaryKey(),
  taskRunId: integer("task_run_id").references(() => taskRuns.id, { onDelete: "cascade" }),
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "set null" }),
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }), // deployer who must approve
  actionType: text("action_type").notNull(),       // e.g. 'send_email', 'delete_record', 'bulk_charge'
  reversibilityTier: integer("reversibility_tier").notNull(), // 0-4
  actionPayload: jsonb("action_payload").notNull(), // sanitised proposed action details
  affectedRecordCount: integer("affected_record_count"),
  status: text("status").notNull().default("pending"), // 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled'
  approvedBy: integer("approved_by").references(() => users.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at"),
  rejectedAt: timestamp("rejected_at"),
  rejectionReason: text("rejection_reason"),
  expiresAt: timestamp("expires_at").notNull(), // auto-cancelled after 24h
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Action Policies — US-GOV-4.1.2: Per-assistant HITL tier overrides ────────
export const actionPolicies = pgTable("action_policies", {
  id: serial().primaryKey(),
  // null assistantId = platform-wide default; non-null = assistant-level override
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "cascade" }),
  // Minimum tier that requires HITL — assistants can raise this, never lower below platform min
  hitlMinimumTier: integer("hitl_minimum_tier").notNull().default(3), // default: Tier 3+ requires approval
  // Per-integration type overrides (jsonb map: { send_email: 2, delete_record: 3 })
  integrationTypeMinTiers: jsonb("integration_type_min_tiers"),
  // Tier 2 rate limit: max Tier 2 actions per run before queuing kicks in
  tier2RateLimit: integer("tier2_rate_limit").notNull().default(10),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Agent Anomaly Thresholds — US-GOV-4.2.1: Platform-wide and workspace-level kill-switch config ──
export const agentAnomalyThresholds = pgTable("agent_anomaly_thresholds", {
  id: serial().primaryKey(),
  // null organisationId = platform-wide default; non-null = workspace override
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "cascade" }),
  loopDetectionLimit: integer("loop_detection_limit").notNull().default(5),   // consecutive identical calls
  toolRateMultiplier: integer("tool_rate_multiplier").notNull().default(2),   // 2x 7-day rolling average
  errorRatePercent: integer("error_rate_percent").notNull().default(20),      // % within 5-min window
  consecutiveRateLimitHits: integer("consecutive_rate_limit_hits").notNull().default(3),
  justification: text("justification"),  // required for workspace overrides
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Agent Anomaly Events — US-GOV-4.2.1: Full audit trail of kill-switch activations ──
export const agentAnomalies = pgTable("agent_anomalies", {
  id: serial().primaryKey(),
  taskRunId: integer("task_run_id").references(() => taskRuns.id, { onDelete: "cascade" }),
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "set null" }),
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "set null" }),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  // Anomaly type: 'loop' | 'rate_spike' | 'error_rate' | 'consecutive_429'
  anomalyType: text("anomaly_type").notNull(),
  // Snapshot of tool call sequence that triggered the anomaly
  toolCallExcerpt: jsonb("tool_call_excerpt"),
  detectedAt: timestamp("detected_at").defaultNow().notNull(),
  // Manual resume tracking
  resumedAt: timestamp("resumed_at"),
  resumedBy: integer("resumed_by").references(() => users.id, { onDelete: "set null" }),
  resumeAcknowledgement: text("resume_acknowledgement"),
  // If same anomaly fires again in same run → permanently terminated
  terminatedAt: timestamp("terminated_at"),
  status: text("status").notNull().default("suspended"), // 'suspended' | 'resumed' | 'terminated'
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Security Incidents — US-GDPR-3.2.1: Article 33/34 breach response state machine ──
// States: detected → contained → notified_controller → notified_regulator → closed
export const securityIncidents = pgTable("security_incidents", {
  id: serial().primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  severity: text("severity").notNull(), // 'low' | 'medium' | 'high' | 'critical'
  status: text("status").notNull().default("detected"), // 'detected' | 'contained' | 'notified_controller' | 'notified_regulator' | 'closed'
  dataTypesAffected: jsonb("data_types_affected"), // string[] e.g. ['oauth_tokens','email']
  affectedUserCount: integer("affected_user_count"),
  affectedUserIds: jsonb("affected_user_ids"), // number[] — for targeted revocation/notification
  discoveredAt: timestamp("discovered_at").defaultNow().notNull(),
  containedAt: timestamp("contained_at"),
  controllerNotifiedAt: timestamp("controller_notified_at"),
  regulatorNotifiedAt: timestamp("regulator_notified_at"),
  closedAt: timestamp("closed_at"),
  // ICO notification form fields (pre-populated by admin, logged on submission)
  regulatorNotificationBody: jsonb("regulator_notification_body"),
  reportedBy: integer("reported_by").references(() => users.id, { onDelete: "set null" }),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ── JWT Blocklist — US-ADM-1.3.2: immediately invalidate tokens on GDPR erasure ──
// Stores the JTI (or userId+iat pair) of revoked tokens so auth-guard and all
// functions can reject them before natural expiry.
export const jwtBlocklist = pgTable("jwt_blocklist", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull(),
  // 'jti' when JWT has an explicit ID; 'userId' when we block all tokens for a user
  blockType: text("block_type").notNull().default("userId"), // 'userId' | 'jti'
  jti: text("jti"),
  reason: text("reason").notNull(), // 'gdpr_erasure' | 'account_delete' | 'admin_revoke'
  expiresAt: timestamp("expires_at"),  // can be NULL meaning indefinite
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  // US-DB-1.1.1: Blocklist check on every authenticated request — must use index scan
  index("jwt_blocklist_user_type_idx").on(t.userId, t.blockType),
  index("jwt_blocklist_jti_idx").on(t.jti),
]);

// ── Billing Overrides — US-ADM-2.1.1 ─────────────────────────────────────────
// US-LEGAL-1.1: Signed per-integration consent record — user authorises the assistant
// to act on a connected service. Required before the assistant can send outbound actions.
export const integrationAuthorizations = pgTable("integration_authorizations", {
  id: serial().primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  authorizedByUserId: integer("authorized_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  integrationType: text("integration_type").notNull(), // 'gmail' | 'google_calendar' | 'twitter' | 'linkedin' | etc.
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "set null" }),
  humanApprovalRequired: boolean("human_approval_required").notNull().default(true),
  // US-GOV-3.1.2: Custom AI disclosure footer text for outbound emails. Must contain 'AI'.
  disclosureText: text("disclosure_text"),
  // US-GOV-4.2.3: OAuth scope minimisation — scopes actually granted at consent time
  grantedScopes: text("granted_scopes").array(),
  lastUsedAt: timestamp("last_used_at"),
  lastScopeChangedAt: timestamp("last_scope_changed_at"),
  authorizedAt: timestamp("authorized_at").defaultNow().notNull(),
  revokedAt: timestamp("revoked_at"),
  revokedByUserId: integer("revoked_by_user_id").references(() => users.id, { onDelete: "set null" }),
}, (t) => ({
  workspaceIntegrationUnique: unique("integration_auth_workspace_type_unique").on(t.workspaceId, t.integrationType, t.assistantId),
}));

// US-LEGAL-1.7: IP audit log — tracks every contractor/founder contribution and
// whether a valid present-tense IP assignment deed is on file.
export const ipAuditLog = pgTable("ip_audit_log", {
  id: serial().primaryKey(),
  contributorName: text("contributor_name").notNull(),
  contributorType: text("contributor_type").notNull(), // 'founder' | 'contractor' | 'employee'
  contributionScope: text("contribution_scope").notNull(), // brief description of what was contributed
  engagementStart: timestamp("engagement_start"),
  engagementEnd: timestamp("engagement_end"),
  assignmentLanguage: text("assignment_language").notNull().default("unknown"), // 'hereby_assigns' | 'agrees_to_assign' | 'none' | 'unknown'
  deedOnFile: boolean("deed_on_file").notNull().default(false),
  deedSignedAt: timestamp("deed_signed_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ── Content Rules Library — US-SMM-2.2.2 ─────────────────────────────────────
// Per-assistant rules saved when a reviewer rejects a post with "apply as rule".
// Injected into generation instructions for all future drafts by that assistant.
export const contentRules = pgTable("content_rules", {
  id: serial().primaryKey(),
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "cascade" }),
  workspaceId: integer("workspace_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  ruleText: text("rule_text").notNull(),
  category: text("category"),                              // null = uncategorised; UI groups: tone_of_voice | response_formatting | core_knowledge | target_audience
  platform: text("platform"),                              // null = all platforms
  createdByUserId: integer("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  isActive: boolean("is_active").notNull().default(true),
  note: text("note"),                                      // optional note explaining the reason
  origin: text("origin").notNull().default('manual'),      // 'manual' | 'rejection_feedback'
  originPostId: integer("origin_post_id"),                 // FK to scheduledPosts.id (set null on delete)
  updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at"),
  previousText: text("previous_text"),                     // text before last edit
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── SMART Goals — Feature 1 (AI-Driven SMART Goals & Performance Optimization) ──
// A measurable business goal tied to one assistant (US1.1). metric_key references the
// catalog in src/config/goal-metrics.ts. Owner-path + manual org filter (no RLS) — same
// pattern as content_rules / post_insights; see db/goals.sql.
export const goals = pgTable("goals", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  assistantId: integer("assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }),
  metricKey: text("metric_key").notNull(),                 // → goal-metrics.ts catalog (e.g. 'instagram_followers')
  // SMART "Specific" (db/goal-smart-fields.sql). Nullable — legacy goals predate them.
  title: text(),                                           // short user-authored name, e.g. "Reach wholesale buyers"
  rationale: text(),                                       // the "why"; steers generation via blueprint section 12
  targetValue: numeric("target_value").notNull(),          // AC1.1.2 — desired value
  startValue: numeric("start_value"),                      // baseline captured at creation, for run-rate math
  targetDate: timestamp("target_date").notNull(),          // AC1.1.2 — deadline
  // AC1.2.3 status enum (+ pending before first telemetry, data_disconnected on stale data AC4.3.2)
  status: text("status").notNull().default("pending"),     // pending|on_track|at_risk|off_track|data_disconnected
  statusUpdatedAt: timestamp("status_updated_at"),
  latestValue: numeric("latest_value"),                    // most recent telemetry value (denormalised for fast UI)
  isPrimary: boolean("is_primary").notNull().default(false),// AC2.1.2 — drives the detail-page progress bar
  isActive: boolean("is_active").notNull().default(true),  // soft archive
  createdByUserId: integer("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("goals_org_idx").on(t.organisationId),
  index("goals_assistant_idx").on(t.assistantId),
]);

// Time-series telemetry for goal progress (AC4.2.1). One row per data pull; the Phase-2
// poller writes here, get-goal-telemetry reads it for the Review Progress chart (AC4.2.3).
export const goalTelemetry = pgTable("goal_telemetry", {
  id: serial().primaryKey(),
  goalId: integer("goal_id").notNull().references(() => goals.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  metricValue: numeric("metric_value").notNull(),
  source: text("source").notNull().default("poll"),        // poll | webhook | rollup | internal | manual
  // db/goal-manual-entry.sql — who typed a source='manual' figure in. NULL for every polled row.
  enteredByUserId: integer("entered_by_user_id").references(() => users.id, { onDelete: "set null" }),
  recordedAt: timestamp("recorded_at").defaultNow().notNull(),
}, (t) => [
  index("goal_telemetry_goal_idx").on(t.goalId, t.recordedAt),
]);

// ── Stripe Disputes — US-ADM-2.2.1 ──────────────────────────────────────────
export const stripeDisputes = pgTable("stripe_disputes", {
  id: serial().primaryKey(),
  stripeDisputeId: text("stripe_dispute_id").notNull().unique(),
  stripeChargeId: text("stripe_charge_id"),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "set null" }),
  amount: integer("amount"),           // in pence
  currency: text("currency").default("gbp"),
  reason: text("reason"),              // e.g. 'fraudulent', 'product_not_received'
  status: text("status").notNull(),    // 'warning_needs_response' | 'needs_response' | 'under_review' | 'won' | 'lost'
  evidenceDeadline: timestamp("evidence_deadline"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ── ToS Acceptances — US-GOV-1.2.1 ──────────────────────────────────────────
export const tosAcceptances = pgTable("tos_acceptances", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  version: text("version").notNull(),
  acceptedAt: timestamp("accepted_at").defaultNow().notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
});

// ── Prompt Probe Attempts — US-LEGAL-2.3 ────────────────────────────────────
export const promptProbeAttempts = pgTable("prompt_probe_attempts", {
  id: serial().primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "set null" }),
  queryContent: text("query_content"),
  responseFragment: text("response_fragment"),
  detectedAt: timestamp("detected_at").defaultNow().notNull(),
});

export const billingOverrides = pgTable("billing_overrides", {
  id: serial().primaryKey(),
  workspaceId: integer("workspace_id").references(() => organisations.id, { onDelete: "cascade" }),
  adminId: integer("admin_id").references(() => users.id),
  action: text("action").notNull(), // 'comp_month' | 'upgrade_tier' | 'downgrade_tier' | 'extend_trial' | 'pause_subscription'
  amount: decimal("amount", { precision: 10, scale: 2 }),
  reason: text("reason").notNull(),
  stripeRef: text("stripe_ref"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Bias Audit — US-GOV-3.3.1 ────────────────────────────────────────────────
// Quarterly prompt review records
export const biasAuditReviews = pgTable("bias_audit_reviews", {
  id: serial().primaryKey(),
  reviewerId: integer("reviewer_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  reviewDate: timestamp("review_date").defaultNow().notNull(),
  promptsReviewed: integer("prompts_reviewed").notNull().default(0),
  findingsCount: integer("findings_count").notNull().default(0),
  actionsRequired: text("actions_required"), // free-text summary
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Bias incidents — raised by statistical sampling or manual review
// Retained minimum 3 years (regulatory evidence)
export const biasIncidents = pgTable("bias_incidents", {
  id: serial().primaryKey(),
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "set null" }),
  detectionMethod: text("detection_method").notNull(), // 'statistical_sampling' | 'manual_review' | 'user_report'
  findingsSummary: text("findings_summary").notNull(),
  investigatorId: integer("investigator_id").references(() => users.id, { onDelete: "set null" }),
  resolution: text("resolution"),
  resolvedAt: timestamp("resolved_at"),
  // Reactivation gate: deployer must acknowledge corrective actions before assistant resumes
  deployerAckAt: timestamp("deployer_ack_at"),
  deployerAckUserId: integer("deployer_ack_user_id").references(() => users.id, { onDelete: "set null" }),
  deployerAckNote: text("deployer_ack_note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  // Retention: must not be deleted before 3 years
  retainUntil: timestamp("retain_until").notNull(),
});

// Monthly statistical sampling reports (one row per run)
export const biasSamplingReports = pgTable("bias_sampling_reports", {
  id: serial().primaryKey(),
  runAt: timestamp("run_at").defaultNow().notNull(),
  sampledCount: integer("sampled_count").notNull().default(0),
  flaggedAnomalies: integer("flagged_anomalies").notNull().default(0),
  // Full JSON report stored here; downloadable as CSV via admin endpoint
  reportData: jsonb("report_data"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── OAuth Scope Minimisation — US-GOV-4.2.3 ──────────────────────────────────
// Platform-level registry: capability → minimum required scopes per integration type
// ── Content Provenance — US-GOV-3.2.1: C2PA-compatible metadata for AI-generated content ─────
export const contentProvenance = pgTable("content_provenance", {
  id: serial("id").primaryKey(),
  contentId: text("content_id").notNull().unique(),      // stable UUID assigned at generation time
  creatorSystem: text("creator_system").notNull().default("Be More Swan"),
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "set null" }),
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "cascade" }),
  workspaceIdHash: text("workspace_id_hash").notNull(), // pseudonymised org identifier (HMAC)
  modelUsedHash: text("model_used_hash").notNull(),      // SHA-256 of model name — not exposed directly
  hitlReviewed: boolean("hitl_reviewed").notNull().default(false),
  hitlReviewedAt: timestamp("hitl_reviewed_at"),
  generatedAt: timestamp("generated_at").notNull().defaultNow(),
  publishedAt: timestamp("published_at"),
  c2paSchemaVersion: text("c2pa_schema_version").notNull().default("1.0"),
  // US 6.1 — C2PA image-byte signing (scaffold; NULL until a signing cert is provisioned and
  // C2PA_SIGN_CERT/C2PA_SIGN_KEY are set — see src/utils/c2pa-sign.ts + db/c2pa-image-signing.sql).
  imageManifest: jsonb("image_manifest"),   // ManifestSummary: signer, urn, algorithm, claims
  imageSigner: text("image_signer"),        // signer identity (cert subject / configured label)
  imageSignedAt: timestamp("image_signed_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("content_provenance_org_idx").on(t.organisationId),
  index("content_provenance_assistant_idx").on(t.assistantId),
]);

export const oauthScopeRegistry = pgTable("oauth_scope_registry", {
  id: serial().primaryKey(),
  integrationType: text("integration_type").notNull(), // 'gmail' | 'google_calendar' | 'slack' etc.
  capability: text("capability").notNull(),             // 'send_email' | 'read_calendar' etc.
  requiredScopes: text("required_scopes").array().notNull(), // e.g. ['https://www.googleapis.com/auth/gmail.send']
  scopeJustification: text("scope_justification").notNull(), // shown to deployer at consent
  maximumAllowedScopes: text("maximum_allowed_scopes").array(), // SuperAdmin enforced ceiling
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  capabilityUnique: unique("oauth_scope_capability_unique").on(t.integrationType, t.capability),
}));

// US-ADM-4.2.1: Compiled assistant blueprints — one row per compile run.
// blueprintVersion is a hash of all contributing source record IDs + updatedAt values;
// any source change produces a new hash, automatically marking the cached blueprint stale.
export const aiBlueprints = pgTable("ai_blueprints", {
  id: serial().primaryKey(),
  assistantId: integer("assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  blueprintVersion: text("blueprint_version").notNull(),   // SHA-256 hex of contributing record IDs+timestamps
  compiledAt: timestamp("compiled_at").defaultNow().notNull(),
  compiledBy: text("compiled_by").notNull().default("system"), // 'system' | admin userId as string
  triggerType: text("trigger_type").notNull().default("admin-manual"), // 'admin-manual' | 'system-auto' | 'dry-run'
  sections: jsonb("sections").notNull(),      // Record<sectionKey, { content, sources, status }>
  missingFields: jsonb("missing_fields").notNull().default('[]'), // MissingField[]
  completenessPercent: integer("completeness_percent").notNull().default(0),
  sentAt: timestamp("sent_at"),
  sentByAdminId: integer("sent_by_admin_id").references(() => users.id, { onDelete: "set null" }),
}, (t) => [
  index("ai_blueprints_assistant_idx").on(t.assistantId, t.compiledAt),
  index("ai_blueprints_version_idx").on(t.blueprintVersion),
]);

// US-SMM-3.1.1: Async content generation job queue
export const contentGenerationJobs = pgTable("content_generation_jobs", {
  id: serial().primaryKey(),
  jobId: text("job_id").notNull().unique(),                // UUID assigned at request time
  blueprintId: integer("blueprint_id").references(() => aiBlueprints.id, { onDelete: "set null" }),
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("queued"),      // queued | processing | completed | failed
  attempt: integer("attempt").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  nextRetryAt: timestamp("next_retry_at"),
  errorMessage: text("error_message"),
  resultPostId: integer("result_post_id"),                 // scheduledPosts.id once created
  // Blog Autopilot (db/blog-autopilot.sql): which engine owns this job. 'social' is the default so
  // every pre-existing row and every enqueuer that doesn't set it keeps its original meaning.
  contentType: text("content_type").notNull().default("social"), // 'social' | 'blog'
  resultBlogPostId: integer("result_blog_post_id"),        // blogPosts.id once created (blog jobs)
  // US-SMM-3.4.1: On-demand generation fields
  contextPrompt: text("context_prompt"),                   // optional user-supplied context (≤500 chars)
  triggerType: text("trigger_type").default("scheduled"),  // 'on_demand' | 'scheduled' | 'admin_test'
  platform: text("platform"),                              // overrides blueprint default platform
  // Posting Schedule: the exact calendar slot this job should fill. When set, process-content-jobs
  // stamps the resulting scheduled_post with this publish_date; null ⇒ legacy "now + 24h".
  // Populated by the draft-horizon scheduler from the assistant's frequency/days/times. db/posting-schedule.sql.
  targetPublishDate: timestamp("target_publish_date"),
  // Cross-post fan-out identity (db/crosspost-group-id.sql). Autopilot enqueues ONE job per slot; the
  // job carries the SAME uuid it will stamp on every sibling post so process-content-jobs marks the
  // resulting scheduled_posts rows as one logical cross-post. NULL ⇒ standalone (single platform).
  crosspostGroupId: text("crosspost_group_id"),
  // Rejection → regeneration (db/reject-regeneration.sql). The rejected scheduled_posts.id this job
  // is a revision of. Set by reject-post.ts; process-content-jobs stamps is_revised /
  // revised_from_post_id on the draft it produces so the Review Queue badges it "Revised".
  // NULL ⇒ an ordinary generation job.
  revisedFromPostId: integer("revised_from_post_id"),
  // One-idea cross-post fan-out (db/crosspost-fanout-platforms.sql). When set, process-content-jobs
  // generates ONE caption/media for this job and creates a scheduled_posts row for EACH platform in
  // this list (sharing crosspost_group_id). NULL/empty ⇒ legacy single-platform job (uses `platform`).
  platforms: jsonb("platforms").$type<string[]>(),
  // Campaign order tracing (db/campaign-order-tracing.sql). The campaign_orders row that
  // commissioned this job, or NULL for ordinary drafting. This is the ONLY link from an order to
  // the work it produced — artefact_id on the order is a single integer and one order fans out to
  // as many as 20 jobs — so src/utils/campaign-reconciler.ts reads it to decide when an order has
  // actually been delivered. Without it every campaign order sat at 'issued' forever.
  campaignOrderId: integer("campaign_order_id"),
  // US-ADM-4.3.3: Admin test generation fields
  adminId: integer("admin_id").references(() => users.id, { onDelete: "set null" }),
  tokensInput: integer("tokens_input"),                    // Anthropic input token count
  tokensOutput: integer("tokens_output"),                  // Anthropic output token count
  savedAsReference: boolean("saved_as_reference").default(false), // admin pinned this run as a reference snapshot
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("content_jobs_status_idx").on(t.status, t.createdAt),
  index("content_jobs_org_idx").on(t.organisationId, t.status),
  index("content_jobs_type_status_idx").on(t.contentType, t.status, t.assistantId),
  check("content_jobs_content_type_check", sql`${t.contentType} IN ('social','blog')`),
]);

// US-SMM-3.3.1: Per-tick cron execution log
export const publishCronLog = pgTable("publish_cron_log", {
  id: serial().primaryKey(),
  tickAt: timestamp("tick_at").defaultNow().notNull(),
  postsProcessed: integer("posts_processed").notNull().default(0),
  postsSucceeded: integer("posts_succeeded").notNull().default(0),
  postsFailed: integer("posts_failed").notNull().default(0),
  durationMs: integer("duration_ms"),
  overrunAlert: boolean("overrun_alert").notNull().default(false),
});

// US-SMM-3.3.2: Per-org/platform rate limit state
export const rateLimitStates = pgTable("rate_limit_states", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),                    // 'instagram' | 'facebook' etc.
  rateLimitedUntil: timestamp("rate_limited_until").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  unique("rate_limit_states_org_platform_unique").on(t.organisationId, t.platform),
]);

// ── AI Media Generation (Epic 1 & 2) ─────────────────────────────────────────
// See db/ai-credits.sql and db/media-generation.sql for the canonical DDL (hand-written,
// applied manually as owner). These declarations mirror those tables for type-safe queries.

// Epic 2, US4: per-org AI generation credit balance (spendable + held by in-flight jobs).
export const aiCreditBalance = pgTable("ai_credit_balance", {
  organisationId: integer("organisation_id").primaryKey().references(() => organisations.id, { onDelete: "cascade" }),
  balance: integer("balance").notNull().default(0),                // spendable credits
  held: integer("held").notNull().default(0),                      // reserved by in-flight jobs
  lastGrantedPeriod: date("last_granted_period"),                  // first-of-month (UTC) monthly grant last applied
  autonomousPeriodStart: date("autonomous_period_start"),          // US5 autonomous-cap window
  autonomousUsed: integer("autonomous_used").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Epic 2, US4: append-only audit of credit economic events (grants +, successful debits -).
export const aiCreditLedger = pgTable("ai_credit_ledger", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  delta: integer("delta").notNull(),                               // +grant/+adjustment, -debit
  reason: text("reason").notNull(),                                // monthly_grant|image_generation|video_generation|x_post_text|x_post_link|admin_adjustment
  jobId: integer("job_id"),                                        // FK to mediaGenerationJobs.id (nullable)
  // Per-assistant attribution (Billing "Usage & Credits"). Set on X-post debits, which carry no
  // job_id; media debits are attributed via job_id → mediaGenerationJobs.assistantId instead.
  // Nullable — genuinely manual (user-initiated) spend has no assistant.
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "set null" }),
  balanceAfter: integer("balance_after"),
  isAutonomous: boolean("is_autonomous").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("ai_credit_ledger_org_created_idx").on(t.organisationId, t.createdAt),
  index("ai_credit_ledger_assistant_idx").on(t.organisationId, t.assistantId, t.createdAt),
]);

// Epic 1, US1/US2: one row per media generation request (image or video). Images complete
// quickly (synchronous poll); video is async (submit → background poll → download to R2).
export const mediaGenerationJobs = pgTable("media_generation_jobs", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "set null" }),  // set for autonomous (US5)

  mediaType: text("media_type").notNull(),                         // 'image' | 'video'
  prompt: text("prompt").notNull(),
  aspectRatio: text("aspect_ratio").notNull(),                     // '1:1' | '16:9' | '9:16' | '4:5'
  durationSeconds: integer("duration_seconds"),                    // video only
  model: text("model").notNull(),                                  // resolved Fal model id
  creditCost: integer("credit_cost").notNull(),                    // credits held/charged for this job
  isAutonomous: boolean("is_autonomous").notNull().default(false),

  // Lifecycle: queued → processing → completed | failed | flagged (content policy)
  status: text("status").notNull().default("queued"),
  falRequestId: text("fal_request_id"),                            // Fal queue request id
  falStatusUrl: text("fal_status_url"),
  falResponseUrl: text("fal_response_url"),
  candidates: jsonb("candidates").default([]),                     // ephemeral Fal result URLs (image grid) pending selection
  resultAssetIds: jsonb("result_asset_ids").default([]),           // content_assets.id[] persisted to R2
  errorMessage: text("error_message"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("media_generation_jobs_org_idx").on(t.organisationId),
  index("media_generation_jobs_status_idx").on(t.status),
]);

// Phase 4: one row per Remotion Lambda render of a video post's timed text overlays.
// Canonical DDL: db/post-render-jobs.sql (apply manually as owner — no db:push).
// Rendering is asynchronous (distributed across Lambda), so it is a job: trigger renderMediaOnLambda
// → poll getRenderProgress → download the S3 output to R2 → attach to the post → publish gate clears.
export const postRenderJobs = pgTable("post_render_jobs", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  postId: integer("post_id").notNull().references(() => scheduledPosts.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  status: text("status").notNull().default("queued"),              // 'queued' | 'rendering' | 'completed' | 'failed'
  // { width, height, fps, durationInFrames } — the frame metadata for the composition. Snapshotted at
  // trigger time because the video's duration isn't stored on content_assets (the client reads it off
  // the <video>); overlays + the presigned videoSrc are re-derived fresh on each render attempt.
  renderInput: jsonb("render_input"),
  renderId: text("render_id"),                                     // Remotion Lambda render id (with bucket, identifies the render)
  bucketName: text("bucket_name"),                                 // Remotion's S3 bucket for this render's output/progress
  region: text("region"),                                          // AWS region the render ran in
  outputAssetId: integer("output_asset_id").references(() => contentAssets.id, { onDelete: "set null" }),  // the rendered video, persisted to R2
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("post_render_jobs_org_idx").on(t.organisationId),
  index("post_render_jobs_post_idx").on(t.postId),
  index("post_render_jobs_status_idx").on(t.status),
]);

// Canva connector, US3: one row per design being imported into the Content Library.
// Canonical DDL: db/canva-import.sql (apply manually as owner — no db:push).
// Canva's export API is asynchronous, so import is a job: export → poll → download → R2.
// A multi-page design exports one image per page, so one job can yield several assets.
export const canvaImportJobs = pgTable("canva_import_jobs", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),

  designId: text("design_id").notNull(),                           // Canva design id being exported
  designTitle: text("design_title"),                               // title at selection time (names the assets)
  designType: text("design_type"),                                 // Canva design_type, decides mp4 vs png export
  exportJobId: text("export_job_id"),                              // Canva export job id, set once created

  // Lifecycle: queued → processing → completed | failed
  status: text("status").notNull().default("queued"),
  resultAssetIds: jsonb("result_asset_ids").default([]),           // content_assets.id[] persisted to R2
  errorMessage: text("error_message"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("canva_import_jobs_org_idx").on(t.organisationId),
  index("canva_import_jobs_status_idx").on(t.status),
]);

// ── Chat Persistence (Digital Assistant Orchestrator) ────────────────────────
// Canonical DDL: db/chat-sessions.sql (apply manually as owner — no db:push).
// One session = one conversation thread between a user and a per-org assistant
// instance, routed through netlify/functions/chat-orchestrator.ts.

export const chatSessions = pgTable("chat_sessions", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // The per-org assistant INSTANCE (not the master template) this conversation belongs to.
  aiAssistantId: integer("ai_assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }),
  // 'active' | 'archived'
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  // Hot path: "my open conversations in this workspace" (tenant-scoped list).
  index("chat_sessions_org_user_status_idx").on(t.organisationId, t.userId, t.status),
  index("chat_sessions_assistant_idx").on(t.aiAssistantId),
  check("chat_sessions_status_check", sql`${t.status} IN ('active', 'archived')`),
]);

// Individual turns within a chat session. uiElementJson carries the serialised state of
// "Disruptive UI" blocks rendered inline with an assistant reply (e.g. a Lead Scoring
// Card or an Action Item table) so conversations re-hydrate exactly as first rendered.
export const chatMessages = pgTable("chat_messages", {
  id: serial().primaryKey(),
  chatSessionId: integer("chat_session_id").notNull().references(() => chatSessions.id, { onDelete: "cascade" }),
  // 'user' | 'assistant' | 'system'
  role: text("role").notNull(),
  content: text("content").notNull(),
  uiElementJson: jsonb("ui_element_json"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  // Hot path: replaying a session's transcript in order.
  index("chat_messages_session_created_idx").on(t.chatSessionId, t.createdAt),
  check("chat_messages_role_check", sql`${t.role} IN ('user', 'assistant', 'system')`),
]);

// ── Internal Data Hub (Golden Rule 2) ─────────────────────────────────────────
// Tenant work products produced by the Tier 1 assistants — processed leads,
// enrichment diffs, meeting notes, ledger invoices, triaged tickets. One table for
// all five roles: `data` holds the exact uiElement wire shape the chat orchestrator
// emitted (or a CSV-imported row mapped into that shape), so the Data Hub tab on
// assistant-detail.html re-renders records with the same DisruptiveUIRegistry
// renderers the chat transcript uses. NOT Be More Swan's own sales pipeline — that
// is the `leads` table above.
export const assistantRecords = pgTable("assistant_records", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  // The per-org assistant INSTANCE that produced/owns this record.
  aiAssistantId: integer("ai_assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }),
  // 'lead' | 'enrichment' | 'meeting' | 'invoice' | 'ticket' | 'lead_idea'
  // | 'campaign_order' | 'campaign_decision'  (Campaign Assistant — db/campaign-records.sql)
  recordType: text("record_type").notNull(),
  // Display name + dedupe key within (assistant, recordType): lead/company name,
  // enriched record name, meeting title, invoice client, ticket subject.
  title: text("title").notNull(),
  // Freeform per-type lifecycle label ('hot', 'open', 'chased', 'Escalated', …) —
  // rendered as a chip and filterable, not enum-constrained so roles can evolve.
  status: text("status"),
  // Human-in-the-loop approval gate (separate from the freeform domain `status` above):
  // every AI-produced record enters 'pending_approval' and surfaces in the assistant's Review
  // Queue; the user approves/rejects, and 'approved' → 'scheduled' (with scheduled_for) puts it
  // on the Calendar. Nothing should execute against a record until it is approved/scheduled.
  // 'pending_approval' | 'approved' | 'scheduled' | 'rejected'. CSV-imported rows (user-supplied,
  // not AI-generated) are created 'approved'.
  approvalStatus: text("approval_status").notNull().default("pending_approval"),
  // When approvalStatus='scheduled', the moment the work is due — read by the assistant Calendar.
  scheduledFor: timestamp("scheduled_for"),
  // 'chat' | 'csv_import' | 'integration' | 'manual' (Data Hub "Add Lead") | 'agent' (AI-proposed)
  source: text("source").notNull().default("chat"),
  // The serialised uiElement payload (see disruptive-ui-registry.js wire shapes).
  data: jsonb("data").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  // Hot path: the Data Hub tab listing one assistant's records of one type.
  index("assistant_records_org_assistant_type_idx").on(t.organisationId, t.aiAssistantId, t.recordType),
  // Hot path for the Review Queue tab: one assistant's records of one type filtered by approval gate.
  index("assistant_records_approval_idx").on(t.organisationId, t.aiAssistantId, t.recordType, t.approvalStatus),
  check("assistant_records_type_check", sql`${t.recordType} IN ('lead', 'enrichment', 'meeting', 'invoice', 'ticket', 'lead_idea', 'campaign_order', 'campaign_decision')`),
  check("assistant_records_source_check", sql`${t.source} IN ('chat', 'csv_import', 'integration', 'manual', 'agent')`),
  check("assistant_records_approval_check", sql`${t.approvalStatus} IN ('pending_approval', 'approved', 'scheduled', 'rejected')`),
]);

// Meeting Note Taker Phase 3 — normalized action_items (per-task PM sync ledger).
// SQL: db/action-items.sql (apply manually — no drizzle-kit push).
// Design: docs/meeting-note-taker-phase3-plan.md. One row per approved meeting action item,
// child of the meeting assistant_records row. Materialized at approval time from
// data.tasks; the create_tasks handlers sync each into Jira/Asana and stamp per-row state so
// partial syncs + retries are idempotent ("5 of 8 synced"). The data JSON blob stays the
// render/edit source of truth; this table is the sync ledger only.
export const actionItems = pgTable("action_items", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  aiAssistantId: integer("ai_assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }),
  meetingRecordId: integer("meeting_record_id").notNull().references(() => assistantRecords.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  assignee: text("assignee"),                              // free-text owner, may be 'Unassigned'
  dueDate: text("due_date"),                               // echoed as the LLM produced it ('by Friday')
  syncStatus: text("sync_status").notNull().default("pending"), // pending | synced | failed | skipped
  provider: text("provider"),                              // 'jira' | 'asana' | null until first sync
  externalTicketId: text("external_ticket_id"),
  externalUrl: text("external_url"),
  errorMessage: text("error_message"),
  syncedAt: timestamp("synced_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("action_items_meeting_idx").on(t.meetingRecordId),
  index("action_items_org_status_idx").on(t.organisationId, t.syncStatus),
  // Idempotent materialization: re-approving/editing a meeting upserts rather than duplicating.
  uniqueIndex("action_items_meeting_desc_uidx").on(t.meetingRecordId, t.description),
  check("action_items_sync_status_check", sql`${t.syncStatus} IN ('pending','synced','failed','skipped')`),
]);

// ────────────────────────────────────────────────────────────────────────────
// Autonomous Content Engine — Phase 0 blog content model.
// SQL: db/blog-posts.sql, db/widget-configs.sql (apply manually — no drizzle-kit push).
// Design: docs/content-engine-epic-plan.md §8–§11.
// blog_posts is the long-form Markdown counterpart to scheduledPosts (which stays social-only);
// it reuses contentAssets, contentProvenance, contentGenerationJobs, aiBlueprints, pendingActions.
// ────────────────────────────────────────────────────────────────────────────
export const blogPosts = pgTable("blog_posts", {
  id: serial("id").primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "set null" }), // set for autonomous drafts
  ownerId: integer("owner_id").references(() => users.id, { onDelete: "set null" }),
  ownerLabel: text("owner_label"),                          // "AI: Marketing Mike" | "Jane Smith"

  // Body
  title: text("title").notNull(),
  bodyMarkdown: text("body_markdown").notNull().default(""), // editable source of truth (US 1.2)
  publishedPayload: jsonb("published_payload"),              // sanitised HTML + meta snapshot served by the widget (US 3.1)

  // SEO metadata (US 1.3)
  slug: text("slug"),                                        // unique per org (partial unique index, slug not null)
  metaTitle: text("meta_title"),
  metaDescription: text("meta_description"),
  tags: jsonb("tags").notNull().default([]),
  canonicalUrl: text("canonical_url"),
  robots: text("robots").notNull().default("index,follow"), // <meta name="robots"> for the hosted page (US 1.3)

  // Hero / feature graphic
  featureAssetId: integer("feature_asset_id").references(() => contentAssets.id, { onDelete: "set null" }),

  // A/B hook testing (US 5.2) — hookVariants: [{ id:'A', h1, intro }, ...]
  hookVariants: jsonb("hook_variants").notNull().default([]),
  winningVariant: text("winning_variant"),                  // null until resolve-ab-tests decides
  abState: text("ab_state").notNull().default("off"),       // off|testing|decided

  // Distribution (per-target status): { widget, substack, medium, rss }
  destinations: jsonb("destinations").notNull().default({}),

  // Workflow & governance
  status: text("status").notNull().default("draft"),
  publishDate: timestamp("publish_date"),
  publishedAt: timestamp("published_at"),
  isAutonomous: boolean("is_autonomous").notNull().default(false),
  generationReason: text("generation_reason"),

  // Provenance & AI linkage (reused infra)
  provenanceContentId: text("provenance_content_id"),       // → contentProvenance.contentId
  confidenceScore: text("confidence_score"),                // 'green' | 'amber' | 'red' | null
  factualClaims: jsonb("factual_claims"),
  jobId: text("job_id"),                                    // → contentGenerationJobs.jobId
  blueprintId: integer("blueprint_id").references(() => aiBlueprints.id, { onDelete: "set null" }),

  // Content-decay detection (US 5.1)
  trafficBaseline: integer("traffic_baseline"),
  lastMetricsAt: timestamp("last_metrics_at"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("blog_posts_org_status_idx").on(t.organisationId, t.status),
  index("blog_posts_assistant_idx").on(t.assistantId),
  index("blog_posts_publish_date_idx").on(t.publishDate),
  uniqueIndex("blog_posts_org_slug_unique").on(t.organisationId, t.slug).where(sql`${t.slug} IS NOT NULL`),
  check("blog_posts_status_check", sql`${t.status} IN ('draft','pending_approval','in_review','approved','scheduled','publishing','published','paused','failed','rejected','archived')`),
  check("blog_posts_ab_state_check", sql`${t.abState} IN ('off','testing','decided')`),
  check("blog_posts_robots_check", sql`${t.robots} IN ('index,follow','index,nofollow','noindex,follow','noindex,nofollow')`),
]);

// Ordered media junction — mirrors scheduledPostAssets.
export const blogPostAssets = pgTable("blog_post_assets", {
  blogPostId: integer("blog_post_id").notNull().references(() => blogPosts.id, { onDelete: "cascade" }),
  contentAssetId: integer("content_asset_id").notNull().references(() => contentAssets.id, { onDelete: "cascade" }),
  position: integer("position").notNull().default(0),
}, (t) => [
  unique("blog_post_assets_pk").on(t.blogPostId, t.contentAssetId),
  index("blog_post_assets_post_idx").on(t.blogPostId),
]);

// Native BMS widget config (US 3.1). public_key is baked into the embed <script data-bms-key>.
export const widgetConfigs = pgTable("widget_configs", {
  id: serial("id").primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  publicKey: text("public_key").notNull().unique(),         // 'wgt_<nanoid>' — rotatable
  name: text("name").notNull().default("Default"),
  theme: jsonb("theme").notNull().default({}),              // { accent, fontFamily, layout, customCss, badge }
  allowedOrigins: text("allowed_origins").array(),          // optional origin allowlist; null = any (public read)
  // Where the customer actually publishes — reconstructs the public per-post URL on THEIR domain so
  // canonical can credit them: (siteBaseUrl,'/blog/{slug}') → https://acme.com/blog/my-post. BOTH
  // required before we canonicalise to the customer; site_post_path alone collapses the blog (see
  // blog-seo-metadata.sql). CHECK enforces a rooted path containing the {slug} placeholder.
  siteBaseUrl: text("site_base_url"),                       // e.g. 'https://acme.com'
  sitePostPath: text("site_post_path"),                     // e.g. '/blog/{slug}'
  badgeEnabled: boolean("badge_enabled").notNull().default(true), // AI Transparency Badge (US 6.1 AC2)
  status: text("status").notNull().default("active"),       // active | disabled
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("widget_configs_org_idx").on(t.organisationId),
  check("widget_configs_status_check", sql`${t.status} IN ('active','disabled')`),
  check("widget_configs_site_post_path_check", sql`${t.sitePostPath} IS NULL OR (${t.sitePostPath} LIKE '/%' AND ${t.sitePostPath} LIKE '%{slug}%')`),
]);

// A/B engagement aggregates per (blog_post, variant) — upserted by widget-ab-beacon (US 5.2).
export const blogAbStats = pgTable("blog_ab_stats", {
  blogPostId: integer("blog_post_id").notNull().references(() => blogPosts.id, { onDelete: "cascade" }),
  variantId: text("variant_id").notNull(),                  // 'A' | 'B' | 'C'
  impressions: integer("impressions").notNull().default(0),
  engagedCount: integer("engaged_count").notNull().default(0),
  sumDwellMs: bigint("sum_dwell_ms", { mode: "number" }).notNull().default(0),
  sumScrollPct: bigint("sum_scroll_pct", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  unique("blog_ab_stats_pk").on(t.blogPostId, t.variantId),
  index("blog_ab_stats_post_idx").on(t.blogPostId),
]);

// ────────────────────────────────────────────────────────────────────────────
// Lead Generator — Outbound Discovery Layer
// Design: docs/lead-generator-discovery-plan.md. SQL: db/lead-discovery.sql
// (apply manually — no drizzle-kit push). Turns the inbound Lead Generator
// (roleKey `lead_qualifier`) into a proactive outbound discovery engine.
//
// NOTE: distinct from the `leads` table above (that is Be More Swan's OWN
// trial/upgrade sales pipeline). Qualified `discovered_leads` are mirrored into
// `assistant_records` (recordType 'lead', approvalStatus 'pending_approval') so
// the existing Data Hub / Review Queue / Calendar UI renders them unchanged.
// ────────────────────────────────────────────────────────────────────────────

// The user-authored "Idea / Campaign Blueprint" — the Phase-1 hypothesis that
// drives a discovery run. Supersedes the LLM-generated `lead_idea` records.
export const discoveryCampaigns = pgTable("discovery_campaigns", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  aiAssistantId: integer("ai_assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  // Short human label for the saved search, e.g. "UK retreat venues". Nullable: every campaign
  // predating db/signal-inbox-1a.sql has none, and readers fall back to a truncated `idea`.
  // Exists because `idea` is a paragraph — the Signal Inbox needs something chip-sized to filter by.
  name: text("name"),
  // The user's business hypothesis, e.g. "Boutique hotels in Southern Europe with no booking app".
  idea: text("idea").notNull(),
  // { demographics, industries: string[], painSignals: string[], sizeBand }.
  targetPersona: jsonb("target_persona"),
  // draft → active (runs on schedule) → paused → archived.
  status: text("status").notNull().default("draft"),
  // ICP snapshot taken at activation so a run is reproducible if onboarding changes later.
  icpSnapshot: jsonb("icp_snapshot"),
  // The search plan a human read and approved before the run was allowed to spend anything —
  // { queries, persona, exclusions, approvedAt, approvedBy }. NULL means no brief was ever
  // approved, which is how every campaign predating db/discovery-approved-brief.sql reads.
  // ⚠️ Deliberately NOT nested inside icpSnapshot: that column is the attribution key stamped
  // onto every revenue-ledger event, and overloading it would change what those rows mean.
  // ⚠️ The stored queries are the FIRST run's instance, not a script to replay — identical
  // queries re-find identical domains and the (campaign_id, domain) dedupe then discards them all.
  approvedBrief: jsonb("approved_brief"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("discovery_campaigns_assistant_idx").on(t.organisationId, t.aiAssistantId, t.status),
  check("discovery_campaigns_status_check", sql`${t.status} IN ('draft','active','paused','archived')`),
]);

// Declarative cadence per campaign. The dispatcher reads these — we never register
// per-campaign Netlify crons.
export const discoverySchedules = pgTable("discovery_schedules", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").notNull().references(() => discoveryCampaigns.id, { onDelete: "cascade" }),
  cadence: text("cadence").notNull().default("weekly"),          // 'one_off' | 'daily' | 'weekly'
  daysOfWeek: jsonb("days_of_week"),                             // [1] = Monday, for weekly cadence
  runAtHourUtc: integer("run_at_hour_utc").notNull().default(8), // 08:00 batch
  timezone: text("timezone").notNull().default("UTC"),
  isEnabled: boolean("is_enabled").notNull().default(true),
  lastRunAt: timestamp("last_run_at"),
  nextRunAt: timestamp("next_run_at"),                           // the dispatcher's claim key
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("discovery_schedules_due_idx").on(t.isEnabled, t.nextRunAt),
  uniqueIndex("discovery_schedules_campaign_uidx").on(t.campaignId),
  check("discovery_schedules_cadence_check", sql`${t.cadence} IN ('one_off','daily','weekly')`),
]);

// Per-campaign cost ceilings + brand-safety lists. Counters are enforced inside the
// worker before each search/scrape/LLM call.
export const discoveryGuardrails = pgTable("discovery_guardrails", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").notNull().references(() => discoveryCampaigns.id, { onDelete: "cascade" }),
  maxLeadsPerRun: integer("max_leads_per_run").notNull().default(50),
  maxLeadsPerMonth: integer("max_leads_per_month").notNull().default(500),
  maxSearchCallsPerRun: integer("max_search_calls_per_run").notNull().default(100),
  maxTokensPerRun: integer("max_tokens_per_run").notNull().default(200000),
  maxCostGbpPerRun: decimal("max_cost_gbp_per_run", { precision: 10, scale: 2 }).notNull().default("2.00"),
  negativeKeywords: jsonb("negative_keywords"),                  // hard-exclude terms (competitors, sensitive)
  excludedDomains: jsonb("excluded_domains"),                    // hard-exclude domains
  requireHumanApproval: boolean("require_human_approval").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("discovery_guardrails_campaign_uidx").on(t.campaignId),
]);

// The job queue — drained by process-discovery-jobs.ts using FOR UPDATE SKIP LOCKED,
// mirroring content_generation_jobs. `cursor` makes a run resumable across the
// per-tick wall-clock budget so a logical run survives function timeouts.
export const discoveryJobs = pgTable("discovery_jobs", {
  id: serial().primaryKey(),
  jobId: text("job_id").notNull().unique(),                      // UUID assigned at enqueue time
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").notNull().references(() => discoveryCampaigns.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("queued"),            // queued | processing | completed | failed
  stage: text("stage"),                                          // query_gen | searching | scoring | promoting
  attempt: integer("attempt").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  nextRetryAt: timestamp("next_retry_at"),
  errorMessage: text("error_message"),
  triggerType: text("trigger_type").notNull().default("scheduled"), // 'scheduled' | 'on_demand'
  // Resumable cursor: { queries, queryIndex, leadsFound, tokensUsed, costGbp }.
  cursor: jsonb("cursor"),
  // Signal Inbox (db/signal-inbox-1a.sql): when this run's results were published to the inbox and
  // the user notified. The IDEMPOTENCY key for that notification — a run is resumable across ticks
  // and can be retried, so without this a single logical run could notify several times.
  signalsPublishedAt: timestamp("signals_published_at"),
  leadsFound: integer("leads_found").notNull().default(0),
  searchCallsMade: integer("search_calls_made").notNull().default(0),
  tokensUsed: integer("tokens_used").notNull().default(0),
  costGbp: decimal("cost_gbp", { precision: 10, scale: 4 }).notNull().default("0"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("discovery_jobs_status_idx").on(t.status, t.nextRetryAt),
  index("discovery_jobs_campaign_idx").on(t.campaignId, t.status),
  check("discovery_jobs_status_values_check", sql`${t.status} IN ('queued','processing','completed','failed')`),
]);

// Raw discovery output with provenance. Dedupe key is (campaign, normalised domain).
// Qualified rows are mirrored into assistant_records via assistantRecordId.
export const discoveredLeads = pgTable("discovered_leads", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").notNull().references(() => discoveryCampaigns.id, { onDelete: "cascade" }),
  jobId: integer("job_id").references(() => discoveryJobs.id, { onDelete: "set null" }), // run that found it
  companyName: text("company_name").notNull(),
  domain: text("domain"),                                        // normalised (lowercased, no www) — dedupe key
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  // Provenance — why/where this was surfaced.
  sourceUrl: text("source_url"),
  discoveredVia: text("discovered_via"),                         // 'niche_scrape' | 'intent_signal' | 'footprint'
  matchedQuery: text("matched_query"),                           // the exact query that surfaced it
  signals: jsonb("signals"),                                     // { hiring, techStack: string[], pressMentions: string[] }
  // Qualification (reuses the lead_scoring_card shape).
  score: integer("score"),
  rating: text("rating"),                                        // 'hot' | 'warm' | 'cold'
  scoringCard: jsonb("scoring_card"),
  // Discovery-side lifecycle, distinct from the assistant_records approval gate.
  status: text("status").notNull().default("discovered"),        // discovered → qualified → promoted → discarded
  assistantRecordId: integer("assistant_record_id").references(() => assistantRecords.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("discovered_leads_campaign_domain_uidx").on(t.campaignId, t.domain).where(sql`domain IS NOT NULL`),
  index("discovered_leads_campaign_status_idx").on(t.campaignId, t.status),
  check("discovered_leads_status_check", sql`${t.status} IN ('discovered','qualified','promoted','discarded')`),
]);

// ────────────────────────────────────────────────────────────────────────────
// REVENUE LEDGER — Phase 0 of docs/lead-generator-revenue-engine-plan.md
// ────────────────────────────────────────────────────────────────────────────
// The append-only fact stream behind the whole revenue engine. Every lifecycle transition a lead
// goes through lands here, and the Strategy Agent (Phase 5) reads ONLY from this table.
//
// Append-only is load-bearing, not stylistic: the strategy loop must be re-runnable over history
// after a prompt change without corrupting state, which is what lets a proposed ICP pivot be
// evaluated against past outcomes before it is applied.
//
// Written exclusively through src/utils/revenue-ledger.ts `recordEvent()` — the notify.ts pattern.
// Do not insert here directly; the vocabularies in src/config/revenue-events.ts and the CHECK
// constraints below are only enforceable if there is one writer.
//
// Migration: db/revenue-events.sql (MANUAL APPLY — no drizzle-kit push). The check() calls here
// MUST stay in sync with the SQL, or a later push silently reverts the DDL.
export const revenueEvents = pgTable("revenue_events", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  // Nullable: a backfilled or org-level event may have no surviving assistant instance.
  aiAssistantId: integer("ai_assistant_id").references(() => aiAssistants.id, { onDelete: "set null" }),

  // Subject of the event. discoveredLeadId is the common case; assistantRecordId links to the
  // human-facing record (Review Queue row) when one exists. Both nullable — a signal can arrive
  // before either exists.
  discoveredLeadId: integer("discovered_lead_id").references(() => discoveredLeads.id, { onDelete: "cascade" }),
  assistantRecordId: integer("assistant_record_id").references(() => assistantRecords.id, { onDelete: "set null" }),

  eventType: text("event_type").notNull(),
  // 'system' | 'agent' | 'user' — makes "how much of this pipeline is genuinely autonomous?"
  // answerable, and is the join key for judging whether raising an autonomy level helped.
  actor: text("actor").notNull().default("system"),
  actorUserId: integer("actor_user_id").references(() => users.id, { onDelete: "set null" }),

  // Terminal-event fields. NULL on every non-terminal event — the partial index below depends on it.
  outcome: text("outcome"),                                 // 'won' | 'lost' | 'disqualified'
  lossReason: text("loss_reason"),                          // closed vocabulary; see LOSS_REASONS
  valueGbp: decimal("value_gbp", { precision: 12, scale: 2 }),
  cycleDays: integer("cycle_days"),                         // first touch → terminal, denormalised

  // THE ATTRIBUTION JOIN KEY. Without these you can measure that win rate moved but not WHICH
  // strategy version moved it, and the Phase 5 loop degenerates into correlating noise.
  // NULL on backfilled rows — they predate strategy versioning and are unattributable by design.
  icpSnapshot: jsonb("icp_snapshot"),
  blueprintVersion: text("blueprint_version"),              // ai_blueprints.blueprintVersion

  payload: jsonb("payload").notNull().default(sql`'{}'::jsonb`),
  occurredAt: timestamp("occurred_at").defaultNow().notNull(),
}, (t) => [
  index("revenue_events_org_type_idx").on(t.organisationId, t.eventType, t.occurredAt),
  index("revenue_events_lead_idx").on(t.discoveredLeadId, t.occurredAt),
  // The Strategy Agent's hot path: terminal outcomes for one org over a trailing window. Partial,
  // because non-terminal rows are the overwhelming majority and never match this predicate.
  index("revenue_events_outcome_idx").on(t.organisationId, t.outcome, t.occurredAt).where(sql`outcome IS NOT NULL`),
  check("revenue_events_actor_check", sql`${t.actor} IN ('system','agent','user')`),
  check("revenue_events_outcome_check", sql`${t.outcome} IS NULL OR ${t.outcome} IN ('won','lost','disqualified')`),
  check("revenue_events_loss_reason_check", sql`${t.lossReason} IS NULL OR ${t.lossReason} IN ('price','timing','no_budget','competitor','no_response','wrong_contact','not_icp','feature_gap','went_silent','other')`),
]);

// ────────────────────────────────────────────────────────────────────────────
// LEAD CONVERSATIONS — Phase 2a of docs/lead-generator-revenue-engine-plan.md
// ────────────────────────────────────────────────────────────────────────────
// Outreach today is fire-and-forget: send_outreach sends one email, sets a calendar reminder, and
// that is the end of it. There is no record of the exchange and NO REPLY DETECTION, so the system
// cannot tell a lead that answered from one that ignored us. These two tables make it stateful.
//
// ⚠️ NOT the same as `leads` / `lead_replies` near the top of this file — those are Be More Swan's
// OWN trial/upgrade pipeline (Admin → Contacts). These are the TENANT's conversations with THEIR
// prospects. Overloading one for the other has been a recurring mistake; keep them apart.
//
// Migration: db/lead-threads.sql (MANUAL APPLY).
export const leadThreads = pgTable("lead_threads", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  aiAssistantId: integer("ai_assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }),
  discoveredLeadId: integer("discovered_lead_id").references(() => discoveredLeads.id, { onDelete: "cascade" }),
  // The Review Queue row this conversation belongs to. Always set — a thread starts from an
  // approved lead record, and a manually-added lead has a record but no discovery row.
  assistantRecordId: integer("assistant_record_id").references(() => assistantRecords.id, { onDelete: "set null" }),
  channel: text("channel").notNull().default("email"),      // 'email' | 'dm' (dm is Phase 2b/§5.4)

  // Per-thread inbound alias: reply+<token>@parse.bemoreswan.com. This is what makes a reply
  // attributable to ONE conversation without parsing quoted text or guessing from the sender —
  // the same person can be a prospect of two different assistants in the same org.
  replyToken: text("reply_token").notNull().unique(),
  // The address we actually wrote to, so a reply from a DIFFERENT address on the same thread
  // (a colleague, an assistant) is still recognisable as belonging here.
  contactEmail: text("contact_email"),

  state: text("state").notNull().default("open"),           // open | replied | stalled | closed
  lastOutboundAt: timestamp("last_outbound_at"),
  lastInboundAt: timestamp("last_inbound_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("lead_threads_org_state_idx").on(t.organisationId, t.state, t.lastOutboundAt),
  index("lead_threads_record_idx").on(t.assistantRecordId),
  check("lead_threads_state_check", sql`${t.state} IN ('open','replied','stalled','closed')`),
  check("lead_threads_channel_check", sql`${t.channel} IN ('email','dm')`),
]);

// One row per message, in or out.
export const leadMessages = pgTable("lead_messages", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  leadThreadId: integer("lead_thread_id").notNull().references(() => leadThreads.id, { onDelete: "cascade" }),
  direction: text("direction").notNull(),                   // 'outbound' | 'inbound'
  fromEmail: text("from_email"),
  subject: text("subject"),

  // What actually went out / came in.
  body: text("body").notNull(),
  // OUTBOUND ONLY: the agent's draft, kept verbatim even when a human edited it before sending.
  // Without this you cannot tell an edited message from an unedited one, and the whole
  // template-feedback loop in §2.6 has no input. Keep both.
  generatedBody: text("generated_body"),
  editedBy: integer("edited_by").references(() => users.id, { onDelete: "set null" }),
  // ai_blueprints.blueprintVersion the draft came from — attribution for template performance.
  templateVersion: text("template_version"),

  // INBOUND ONLY: what the reply meant. Populated by the classifier; NULL until then.
  classification: text("classification"),                   // 'interested'|'not_now'|'not_interested'|'objection'|'ooo'|'unsubscribe'|'other'
  sentiment: text("sentiment"),                             // 'positive' | 'neutral' | 'negative'
  objections: jsonb("objections"),                          // string[] of matched objection categories

  occurredAt: timestamp("occurred_at").defaultNow().notNull(),
}, (t) => [
  index("lead_messages_thread_idx").on(t.leadThreadId, t.occurredAt),
  check("lead_messages_direction_check", sql`${t.direction} IN ('outbound','inbound')`),
]);

// Human edits as EVIDENCE (plan §2.6, the ⭐ option). A reviewer who rewrites a draft is telling us
// something about the template; capturing why turns that into training signal instead of throwing
// it away. Accumulates until the Strategy Agent has MIN_SAMPLE similar edits, then proposes the
// template change through the normal proposal flow — with a sample size behind it, unlike a
// "save as default" click which generalises from n=1.
export const templateFeedback = pgTable("template_feedback", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  leadMessageId: integer("lead_message_id").references(() => leadMessages.id, { onDelete: "cascade" }),
  // The assistant whose playbook this edit is about — the edit-pattern proposer's grouping key.
  // ⚠️ NOT derivable from leadMessageId: the ⭐ review-time path writes that as NULL by design (the
  // edit precedes the send, so no lead_messages row exists yet), and that is the only writer today.
  // Joining through lead_messages to find the assistant matches nothing. db/template-feedback-assistant.sql.
  aiAssistantId: integer("ai_assistant_id").references(() => aiAssistants.id, { onDelete: "cascade" }),
  templateVersion: text("template_version"),
  // CLOSED vocabulary — src/config/template-feedback.ts EDIT_REASONS. It is the GROUP BY key for
  // the edit-pattern proposer, and free text cannot be clustered.
  editReason: text("edit_reason"),
  diffSummary: text("diff_summary"),                        // one line, computed from the before/after
  appliedToTemplate: boolean("applied_to_template").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("template_feedback_org_reason_idx").on(t.organisationId, t.editReason, t.createdAt),
  index("template_feedback_assistant_reason_idx").on(t.aiAssistantId, t.editReason, t.createdAt)
    .where(sql`ai_assistant_id IS NOT NULL`),
  check("template_feedback_edit_reason_check", sql`${t.editReason} IS NULL OR ${t.editReason} IN (
    'too_formal','too_casual','wrong_value_prop','wrong_pain_point',
    'too_long','factually_wrong','bad_subject','personalisation_missing','other')`),
]);

// Human REJECTIONS as evidence — db/lead-reject-feedback.sql. The mirror of templateFeedback above:
// that one captures what was wrong with the message, this one what was wrong with the TARGETING
// that surfaced the lead at all. Rejecting used to write only approval_status plus a lead_rejected
// ledger event nothing reads, so a reviewer could reject twenty leads for one reason and the next
// discovery run was built from identical inputs.
export const leadRejectFeedback = pgTable("lead_reject_feedback", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  aiAssistantId: integer("ai_assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }),
  // SET NULL, not CASCADE — the evidence outlives the lead. Clearing out old records must not
  // delete the reasons the searches exist to learn from.
  assistantRecordId: integer("assistant_record_id").references(() => assistantRecords.id, { onDelete: "set null" }),
  discoveredLeadId: integer("discovered_lead_id").references(() => discoveredLeads.id, { onDelete: "set null" }),
  // Denormalised so a cluster can be required to span more than one campaign — a question that
  // cannot be asked through a SET NULL link that may already be gone.
  campaignId: integer("campaign_id").references(() => discoveryCampaigns.id, { onDelete: "set null" }),
  // CLOSED vocabulary — src/config/lead-reject-reasons.ts LEAD_REJECT_REASONS.
  reason: text("reason").notNull(),
  appliedToTarget: boolean("applied_to_target").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("lead_reject_feedback_assistant_reason_idx").on(t.aiAssistantId, t.reason, t.createdAt)
    .where(sql`applied_to_target = false`),
  index("lead_reject_feedback_org_idx").on(t.organisationId, t.createdAt),
  check("lead_reject_feedback_reason_check", sql`${t.reason} IN (
    'competitor','not_a_business','wrong_industry','too_small','too_large',
    'wrong_geography','existing_customer','no_buying_signal','bad_contact','other')`),
]);

// ────────────────────────────────────────────────────────────────────────────
// OUTREACH SEQUENCES — Phase 2b of docs/lead-generator-revenue-engine-plan.md
// ────────────────────────────────────────────────────────────────────────────
// Phase 2a made a conversation observable; 2b makes it PERSISTENT. One email and a calendar
// reminder is not a cadence — the reminder asks a human to remember, which is exactly the manual
// step the assistant exists to remove.
//
// The stop condition is Phase 2a's reply detection: `lead_threads.state` flipping to 'replied' is
// what halts a sequence. That ordering is why 2b could not be built first. A sequence engine that
// does not reliably notice replies sends follow-ups to people who already answered, which is the
// single most damaging thing this system can do to a tenant's reputation.
//
// Migration: db/outreach-sequences.sql (MANUAL APPLY — no drizzle-kit push). The check() calls
// here MUST stay in sync with the SQL, or a later push silently reverts the DDL.

// A named cadence. Auto-provisioned per assistant on first enrolment (see
// src/utils/outreach-sequences.ts ensureDefaultSequence) so the engine works with no admin UI —
// there is no "configure a sequence" screen yet and a table nobody can populate does nothing.
export const outreachSequences = pgTable("outreach_sequences", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  aiAssistantId: integer("ai_assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }),
  name: text("name").notNull().default("Default follow-up"),
  isEnabled: boolean("is_enabled").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  // One enabled sequence per assistant. Choosing BETWEEN sequences by ICP segment is Phase 5
  // territory; until something can make that choice, a second sequence would just be ambiguity
  // about which one enrolment picks.
  uniqueIndex("outreach_sequences_assistant_uidx").on(t.aiAssistantId),
]);

// The steps, in order. `delayDays` is measured from the PREVIOUS send, not from enrolment, so
// editing one step's delay shifts everything after it the way a human reading the cadence expects.
export const sequenceSteps = pgTable("sequence_steps", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  sequenceId: integer("sequence_id").notNull().references(() => outreachSequences.id, { onDelete: "cascade" }),
  stepNumber: integer("step_number").notNull(),             // 1-based; step 1 is the FIRST follow-up
  delayDays: integer("delay_days").notNull().default(3),    // wait after the previous send
  // An instruction to the drafting model, NOT a static template. A fixed body sent three times is
  // recognisably a mail-merge; the whole point of drafting per-send is that the follow-up can
  // reference what was already said in this specific thread.
  bodyPrompt: text("body_prompt").notNull(),
  isEnabled: boolean("is_enabled").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("sequence_steps_seq_step_uidx").on(t.sequenceId, t.stepNumber),
  check("sequence_steps_step_number_check", sql`${t.stepNumber} > 0`),
  check("sequence_steps_delay_days_check", sql`${t.delayDays} >= 0`),
]);

// One lead's progress through one sequence. `nextSendAt` is the worker's claim key.
export const sequenceEnrolments = pgTable("sequence_enrolments", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  aiAssistantId: integer("ai_assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }),
  sequenceId: integer("sequence_id").notNull().references(() => outreachSequences.id, { onDelete: "cascade" }),
  // THE HALT KEY. Every send re-reads this thread's state and refuses unless it is still 'open'.
  leadThreadId: integer("lead_thread_id").notNull().references(() => leadThreads.id, { onDelete: "cascade" }),
  assistantRecordId: integer("assistant_record_id").references(() => assistantRecords.id, { onDelete: "set null" }),
  discoveredLeadId: integer("discovered_lead_id").references(() => discoveredLeads.id, { onDelete: "set null" }),
  contactEmail: text("contact_email"),

  state: text("state").notNull().default("active"),         // active | completed | halted | cancelled
  // Why it stopped. Closed vocabulary (SEQUENCE_HALT_REASONS) for the same reason LOSS_REASONS is
  // closed: "why do sequences stop early?" must be a GROUP BY, not a prose summary.
  haltReason: text("halt_reason"),
  lastStepSent: integer("last_step_sent").notNull().default(0),   // 0 = only the opening email has gone
  nextSendAt: timestamp("next_send_at"),                    // NULL once terminal
  lastError: text("last_error"),
  attempt: integer("attempt").notNull().default(0),         // consecutive failures at the current step
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  // One enrolment per thread. A lead enrolled twice gets two overlapping cadences and receives
  // double the follow-ups — the unique index is the only thing that makes double-enrolment
  // impossible rather than merely unlikely.
  uniqueIndex("sequence_enrolments_thread_uidx").on(t.leadThreadId),
  // The worker's claim: active rows whose next_send_at has passed.
  index("sequence_enrolments_due_idx").on(t.state, t.nextSendAt),
  index("sequence_enrolments_org_idx").on(t.organisationId, t.createdAt),
  check("sequence_enrolments_state_check", sql`${t.state} IN ('active','completed','halted','cancelled')`),
  check("sequence_enrolments_halt_reason_check", sql`${t.haltReason} IS NULL OR ${t.haltReason} IN ('replied','suppressed','no_recipient','not_connected','send_failed','max_steps','record_closed','do_not_contact','manual')`),
]);

// ────────────────────────────────────────────────────────────────────────────
// ACCOUNT GRAPH + MEMORY (the "Anti-CRM") — Phase 3, plan §5.3
// ────────────────────────────────────────────────────────────────────────────
// A CRM makes a human type what happened. This makes the system remember it. Three stores, chosen
// by ACCESS PATTERN rather than by fashion (plan §5.3's memory tiering):
//
//   working memory      lead_threads + lead_messages   direct FK read, no embedding — small, bounded
//   long-term semantic  account_memory + pgvector      cosine kNN, voyage-3.5-lite
//   structural          account_nodes + account_edges  recursive CTE, depth-capped at 4
//   strategy state      revenue_events + ai_blueprints aggregate SQL
//
// No Redis. Working memory is a bounded set of rows keyed by thread id and Postgres serves it in
// one indexed read; a cache goes in when a measured query proves it necessary, not before.
//
// Migration: db/account-graph.sql (MANUAL APPLY — pgvector column + HNSW index, which drizzle-kit
// push cannot express). The check() calls here MUST stay in sync with the SQL.

// The durable entities memory is ABOUT. Identity resolution is by normalised domain: it is the one
// key that survives a contact changing name, job title or email address.
export const accountNodes = pgTable("account_nodes", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  nodeType: text("node_type").notNull(),                    // 'account' | 'contact' | 'deal'
  label: text("label").notNull(),
  domain: text("domain"),                                   // normalised — the identity resolution key
  attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  // PARTIAL unique index: one account per domain per org. Contacts and deals are deliberately
  // excluded — several contacts share one company domain, and collapsing them would merge distinct
  // people into one node. The `domain IS NOT NULL` half matters just as much: Postgres treats NULLs
  // as distinct, but stating it keeps the index small and the intent legible.
  uniqueIndex("account_nodes_org_domain_uidx").on(t.organisationId, t.domain)
    .where(sql`node_type = 'account' AND domain IS NOT NULL`),
  index("account_nodes_org_type_idx").on(t.organisationId, t.nodeType),
  check("account_nodes_type_check", sql`${t.nodeType} IN ('account','contact','deal')`),
]);

// Typed, directed edges. Traversed with a recursive CTE, depth-capped at 4.
export const accountEdges = pgTable("account_edges", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  fromNodeId: integer("from_node_id").notNull().references(() => accountNodes.id, { onDelete: "cascade" }),
  toNodeId: integer("to_node_id").notNull().references(() => accountNodes.id, { onDelete: "cascade" }),
  edgeType: text("edge_type").notNull(),                    // 'works_at' | 'engaged_with' | 'competitor_of' | 'referred_by'
  weight: integer("weight").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("account_edges_uidx").on(t.fromNodeId, t.toNodeId, t.edgeType),
  index("account_edges_from_idx").on(t.fromNodeId, t.edgeType),
  index("account_edges_org_idx").on(t.organisationId),
  check("account_edges_type_check", sql`${t.edgeType} IN ('works_at','engaged_with','competitor_of','referred_by')`),
  // A self-edge is never meaningful here and makes cycle handling in the traversal harder to reason
  // about. Reject it at the boundary rather than filtering it on every read.
  check("account_edges_no_self_check", sql`${t.fromNodeId} <> ${t.toNodeId}`),
]);

// Long-term semantic memory. IDENTICAL model and dimensions to kb_chunks so ONE embed path
// (src/utils/kb-embeddings.ts) serves everything — a second provider or dimension here would mean
// two embedding budgets, two failure modes and vectors that cannot be compared.
//
// ⚠️ GDPR: every insert here MUST be paired with a vector_embeddings row
// (sourceType 'account_memory'). See src/utils/account-memory.ts — that pairing is the only
// registration of these vectors, and src/config/vector-sources.ts explains why the source_type
// half of the key is load-bearing.
export const accountMemory = pgTable("account_memory", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  accountNodeId: integer("account_node_id").references(() => accountNodes.id, { onDelete: "cascade" }),
  sourceType: text("source_type").notNull(),                // 'message' | 'engagement' | 'note' | 'outcome'
  sourceId: integer("source_id"),
  content: text("content").notNull(),
  // NULL when no embedding provider is configured — retrieval then falls back to Postgres
  // full-text search over `content`, exactly as kb_chunks does. The content_tsv generated column
  // lives in the SQL migration only (drizzle cannot express GENERATED ALWAYS).
  embedding: vector("embedding", { dimensions: 1024 }),     // voyage-3.5-lite, matches kb_chunks
  occurredAt: timestamp("occurred_at").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("account_memory_node_idx").on(t.accountNodeId, t.occurredAt),
  index("account_memory_org_idx").on(t.organisationId, t.occurredAt),
  // The ingestion worker's idempotency key: one memory per source row. Without it, re-running the
  // backfill re-embeds every message — paying the provider twice for duplicate rows that then
  // double-count in retrieval.
  uniqueIndex("account_memory_source_uidx").on(t.organisationId, t.sourceType, t.sourceId)
    .where(sql`source_id IS NOT NULL`),
  check("account_memory_source_type_check", sql`${t.sourceType} IN ('message','engagement','note','outcome')`),
]);

// ────────────────────────────────────────────────────────────────────────────
// STRATEGY PROPOSALS — Phase 5a of docs/lead-generator-revenue-engine-plan.md §7
// ────────────────────────────────────────────────────────────────────────────
// One proposed change to one tunable field, awaiting a human decision.
//
// A row here changes NOTHING until a human clicks Apply having read the diff. `status='pending'`
// is inert by construction, and that inertness IS the safety argument for the phase: the proposer
// is LLM-driven over text that includes third-party email arriving through a public webhook, so
// the guarantee cannot come from the prompt — it comes from the only thing the function can write
// being a row that does nothing (docs/strategy-agent-plan.md §5.2).
//
// Written exclusively through src/utils/strategy-proposals.ts — the recordEvent()/notify.ts
// pattern. Do not insert here directly; the vocabularies in src/config/strategy-proposals.ts and
// the CHECK constraints below only hold if there is one writer.
//
// ⚠️ Mirrors db/strategy-proposals.sql (MANUAL apply). The check()s and the partial unique index
// must stay declared here too, or a later `drizzle-kit push` reverts them.
export const strategyProposals = pgTable("strategy_proposals", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  aiAssistantId: integer("ai_assistant_id").references(() => aiAssistants.id, { onDelete: "cascade" }),

  // 'win_loss' | 'edit_pattern' | 'lead_rejection' | 'human'. MIN_SAMPLE means a different thing per source and the
  // evidence blob has a different shape, so the UI cannot honestly label a sample size without it.
  // 'human' is the synthetic source for §2.6's "Save as the new default", which routes a human's
  // own edit through the SAME apply path rather than building a second mechanism (§5.4).
  source: text("source").notNull(),

  // A key of STRATEGY_TUNABLE_FIELDS — never a free string from the model.
  targetField: text("target_field").notNull(),
  previousValue: jsonb("previous_value"),                   // makes Apply reversible
  proposedValue: jsonb("proposed_value").notNull(),
  // { sampleSize, segments[], metrics{}, eventIds[] } — computed in SQL, never taken from the model.
  evidence: jsonb("evidence").notNull(),

  status: text("status").notNull().default("pending"),

  // CLOSED vocabulary: a reject reason is an INPUT to the next run, not a record of this one.
  rejectReason: text("reject_reason"),
  rejectNote: text("reject_note"),                          // free text, for humans not the model
  decidedBy: integer("decided_by").references(() => users.id, { onDelete: "set null" }),
  decidedAt: timestamp("decided_at"),

  // Rollback restores previousValue and stamps rolledBackAt; the row STAYS 'applied' so history
  // shows it happened. A separate status would make "was this ever applied?" a two-value question.
  appliedAt: timestamp("applied_at"),
  rolledBackAt: timestamp("rolled_back_at"),

  expiresAt: timestamp("expires_at").notNull(),             // never auto-applies; lapses instead
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("strategy_proposals_org_status_idx").on(t.organisationId, t.status, t.createdAt),
  // ⚠️ LOAD-BEARING. §7 says "one change per run" but not "one PENDING proposal per field", and the
  // run is weekly. Without this a confident field accumulates a proposal a week, each with a
  // previousValue snapshotted against a different world; applying the oldest LAST silently reverts
  // the others. The proposer must catch the conflict and SKIP — a run that dies on a duplicate
  // stops proposing for every other org in the batch.
  uniqueIndex("strategy_proposals_pending_field_uidx")
    .on(t.organisationId, t.targetField)
    .where(sql`status = 'pending'`),
  check("strategy_proposals_status_check", sql`${t.status} IN ('pending','applied','rejected','expired')`),
  check("strategy_proposals_source_check", sql`${t.source} IN ('win_loss','edit_pattern','human')`),
  check("strategy_proposals_reject_reason_check", sql`${t.rejectReason} IS NULL OR ${t.rejectReason} IN ('sample_unrepresentative','already_tried','wrong_causation','off_brand','bad_timing','too_narrow','too_broad','other')`),
  check("strategy_proposals_rejected_has_reason_check", sql`${t.status} <> 'rejected' OR ${t.rejectReason} IS NOT NULL`),
  check("strategy_proposals_rollback_requires_apply_check", sql`${t.rolledBackAt} IS NULL OR ${t.appliedAt} IS NOT NULL`),
]);

// ── Campaign Assistant (roleKey `campaign_orchestrator`) ─────────────────────────────────────
// SQL: db/campaigns.sql + db/campaign-records.sql (apply manually — no drizzle-kit push).
// Design: docs/campaign-orchestrator-plan.md.
//
// A campaign allocates TWO budgets against one objective: `work` (pieces of work commissioned from
// other assistants — posts, articles, searches; one work item == one artefact) and `money` (the
// customer's own ad account — Phase 3, blocked on platform approvals; pinned to zero for organic).
//
// ⚠️ A work item is NOT a billing task. usage_counters.task_count is moved by chat turns and a few
// on-demand buttons only — process-content-jobs.ts / generate-post.ts / process-discovery-jobs.ts
// never call consumeTaskCredit. Denominating this budget in "tasks" would show the user a number
// that measures nothing. The plan cap is read separately, as a gate. See db/campaigns.sql.
//
// The orchestrator produces nothing itself: its artefacts are ORDERS to other assistants and
// DECISIONS a human approves. Both mirror into assistantRecords so the existing Data Hub and
// Review Queue render them unchanged — the tables here stay the source of truth.
export const campaigns = pgTable("campaigns", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  aiAssistantId: integer("ai_assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  // The objective in the founder's own words — quoted verbatim into the generation directive.
  objective: text().notNull(),
  outcomeMetric: text("outcome_metric").notNull().default("leads"),
  targetValue: integer("target_value"),
  // 'organic' | 'paid' | 'blended'. Phase 1 creates only 'organic'; the others are refused at the
  // HTTP boundary until the ad rails exist.
  mode: text().notNull().default("organic"),
  // 'draft' | 'active' | 'throttled' | 'paused' | 'finished' | 'archived'.
  // 'throttled' (agent optimising, still running) and 'paused' (stopped) are deliberately
  // distinct — a shared label hides which one happened.
  status: text().notNull().default("draft"),
  startsAt: timestamp("starts_at"),
  endsAt: timestamp("ends_at"),
  // What the human has already turned down, as counts per reason (CampaignConstraints).
  // Written by the reject flow, read by the next proposal — src/config/campaign-reject-reasons.ts.
  // This column is the reason the Reject button is a feedback loop and not a status flip.
  constraints: jsonb().notNull().default({ rejections: {}, notes: [] }),
  // A stopped campaign must say why (CHECK below). A pause with no recorded reason is a pause
  // nobody can safely undo.
  haltReason: text("halt_reason"),
  haltedAt: timestamp("halted_at"),
  haltedBy: integer("halted_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("campaigns_assistant_idx").on(t.organisationId, t.aiAssistantId, t.status),
  index("campaigns_active_idx").on(t.status, t.endsAt).where(sql`status IN ('active','throttled')`),
  check("campaigns_mode_check", sql`${t.mode} IN ('organic','paid','blended')`),
  check("campaigns_status_check", sql`${t.status} IN ('draft','active','throttled','paused','finished','archived')`),
  check("campaigns_halt_reason_check", sql`${t.status} <> 'paused' OR ${t.haltReason} IS NOT NULL`),
]);

// The two ceilings + the autonomy dial, one row per campaign.
export const campaignBudgets = pgTable("campaign_budgets", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  maxWorkItems: integer("max_work_items").notNull().default(100),
  // ⚠️ Also guarded by a BEFORE trigger in db/campaigns.sql: an organic campaign cannot carry a
  // non-zero money ceiling. The trigger is invisible to Drizzle — do not "clean it up".
  maxSpendGbp: numeric("max_spend_gbp", { precision: 10, scale: 2 }).notNull().default("0.00"),
  // A reallocation at or below this many work items happens on its own; larger ones become a
  // decision. 0 (the default) means nothing is automatic.
  autonomyThresholdWork: integer("autonomy_threshold_work").notNull().default(0),
  // Runaway guards. Optimisation is divergent: a loop that reallocates every tick burns the whole
  // allowance on churn. Enforced in the reallocation path, not by the database.
  maxReallocationsPerDay: integer("max_reallocations_per_day").notNull().default(3),
  minReallocationWork: integer("min_reallocation_work").notNull().default(3),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  uniqueIndex("campaign_budgets_campaign_uidx").on(t.campaignId),
  check("campaign_budgets_max_work_check", sql`${t.maxWorkItems} > 0`),
  check("campaign_budgets_spend_nonneg_check", sql`${t.maxSpendGbp} >= 0`),
  check("campaign_budgets_autonomy_check", sql`${t.autonomyThresholdWork} >= 0`),
]);

// One instruction to one colleague. The orchestrator's only output.
export const campaignOrders = pgTable("campaign_orders", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  // Nullable instance id (it can be deleted) but the role key is kept, so a delivered order still
  // reads correctly after the assistant is gone.
  targetAssistantId: integer("target_assistant_id").references(() => aiAssistants.id, { onDelete: "set null" }),
  targetRoleKey: text("target_role_key").notNull(),
  // Closed vocabulary — src/config/campaign-vocab.ts, asserted by tests/campaign-vocab.test.ts.
  action: text().notNull(),
  brief: jsonb().notNull().default({}),
  costWorkItems: integer("cost_work_items").notNull().default(0),
  costGbp: numeric("cost_gbp", { precision: 10, scale: 2 }).notNull().default("0.00"),
  status: text().notNull().default("queued"),
  blockedOnOrderId: integer("blocked_on_order_id"),
  // artefactKind names the table so the client builds the right link without a polymorphic guess.
  artefactKind: text("artefact_kind"),
  artefactId: integer("artefact_id"),
  resultSummary: text("result_summary"),
  // Best-effort Data Hub mirror. Nullable: a failed mirror must never fail the order.
  assistantRecordId: integer("assistant_record_id").references(() => assistantRecords.id, { onDelete: "set null" }),
  issuedAt: timestamp("issued_at"),
  deliveredAt: timestamp("delivered_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("campaign_orders_campaign_idx").on(t.campaignId, t.status),
  index("campaign_orders_org_idx").on(t.organisationId, t.createdAt),
  index("campaign_orders_target_idx").on(t.targetAssistantId, t.status),
  check("campaign_orders_status_check", sql`${t.status} IN ('queued','issued','in_review','delivered','blocked','cancelled','rejected')`),
  check("campaign_orders_cost_check", sql`${t.costWorkItems} >= 0 AND ${t.costGbp} >= 0`),
  check("campaign_orders_artefact_check", sql`${t.artefactKind} IS NULL OR ${t.artefactKind} IN ('scheduled_post','blog_post','discovery_campaign','assistant_record')`),
  check("campaign_orders_no_self_block_check", sql`${t.blockedOnOrderId} IS NULL OR ${t.blockedOnOrderId} <> ${t.id}`),
]);

// APPEND-ONLY ledger of budget actually consumed. A correction is a new compensating row with a
// negative amount, never an edit — history that can be rewritten cannot be audited.
export const campaignSpendEvents = pgTable("campaign_spend_events", {
  id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  orderId: integer("order_id").references(() => campaignOrders.id, { onDelete: "set null" }),
  // 'work' | 'money'. Separate rows rather than two columns, so no query has to decide which of
  // two amounts is the meaningful one.
  currency: text().notNull(),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  reason: text().notNull(),
  occurredAt: timestamp("occurred_at").defaultNow().notNull(),
}, (t) => [
  index("campaign_spend_campaign_idx").on(t.campaignId, t.currency, t.occurredAt),
  check("campaign_spend_currency_check", sql`${t.currency} IN ('work','money')`),
]);

// What the human is asked to approve. Anything above the campaign's autonomy threshold lands
// here INSTEAD of happening.
export const campaignDecisions = pgTable("campaign_decisions", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  campaignId: integer("campaign_id").notNull().references(() => campaigns.id, { onDelete: "cascade" }),
  // 'strategy' | 'reallocation' | 'escalation' | 'halt'
  kind: text().notNull(),
  title: text().notNull(),
  // Structured so the numbers stay checkable instead of being prose a model can drift.
  evidence: jsonb().notNull().default([]),
  // The orders it would place. Applied verbatim — the model gets no second turn between the
  // human's approval and execution.
  proposed: jsonb().notNull().default({}),
  // What happens if the user does nothing. A card without this is a demand, not a choice.
  costOfInaction: text("cost_of_inaction"),
  costWorkItems: integer("cost_work_items").notNull().default(0),
  costGbp: numeric("cost_gbp", { precision: 10, scale: 2 }).notNull().default("0.00"),
  status: text().notNull().default("pending"),
  // Closed vocabulary — src/config/campaign-reject-reasons.ts. This column is a GROUP BY key, so
  // free text is not allowed: "four people rejected this for the same reason" has to survive as a
  // count, not as prose for a model to re-summarise.
  rejectReason: text("reject_reason"),
  rejectNote: text("reject_note"),
  // Every decision expires. An eight-week-old proposal built on eight-week-old evidence is not
  // something a user should be able to approve by scrolling far enough down.
  expiresAt: timestamp("expires_at").notNull(),
  decidedAt: timestamp("decided_at"),
  decidedBy: integer("decided_by").references(() => users.id, { onDelete: "set null" }),
  assistantRecordId: integer("assistant_record_id").references(() => assistantRecords.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("campaign_decisions_campaign_idx").on(t.campaignId, t.status),
  index("campaign_decisions_pending_idx").on(t.organisationId, t.status, t.expiresAt).where(sql`status = 'pending'`),
  check("campaign_decisions_kind_check", sql`${t.kind} IN ('strategy','reallocation','escalation','halt')`),
  check("campaign_decisions_status_check", sql`${t.status} IN ('pending','approved','rejected','expired','superseded')`),
  // The constraint that makes the feedback loop real rather than optional. Without it "reject"
  // degrades into a status flip that teaches nothing — exactly what happened to lead rejection.
  check("campaign_decisions_reject_reason_check", sql`${t.status} <> 'rejected' OR ${t.rejectReason} IS NOT NULL`),
]);

// Relational-query definitions for the chat tables live in db/relations.ts
// (drizzle-orm v2 `defineRelations` API — this drizzle version has no per-table
// `relations()` export).
