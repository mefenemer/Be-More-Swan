/**
 * db/seed-demo-tenant.ts
 *
 * Seeds a self-contained demo workspace — "Willowbrook Coffee Roasters" — used to
 * record the Social Media Manager capability videos. Everything a muted-autoplay
 * screen recording needs from ONE login: a full calendar, a live review queue, a
 * green-vs-amber confidence contrast, learned brand rules (incl. one born from
 * voice feedback), 4 connected + preflight-green platforms, and enough drafted
 * posts this month that the "Hours Saved" tile shows a believable headline.
 *
 * SAFETY
 *   Run ONLY against an isolated demo / sandbox database — never live staging or
 *   prod. It sets a PLATFORM-WIDE config row (gamification.time_multipliers) that
 *   would affect every org on a shared DB. See [[admin-sandbox-toggle-silent-fallback]].
 *
 * Idempotent: keyed on the org slug 'willowbrook-demo'. Re-running wipes and
 * rebuilds this org's assistant/connections/posts/rules, leaving other orgs alone.
 *
 * Dates are stamped RELATIVE to run time, so run it the morning of the shoot.
 *
 * Run with:
 *   npx tsx db/seed-demo-tenant.ts
 * (Requires NETLIFY_DATABASE_URL / DATABASE_URL pointing at the DEMO db.)
 */

import { config } from 'dotenv';
import * as path from 'path';
config({ path: path.resolve(process.cwd(), '.env') });

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
    organisations, users, userOrganisations, plans, masterPlans, masterAssistants,
    aiAssistants, systemConnections, scheduledPosts, contentAssets, scheduledPostAssets,
    contentRules, platformConfig,
} from './schema';

const connectionString = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
if (!connectionString) throw new Error('NETLIFY_DATABASE_URL / DATABASE_URL is not set.');

// Guard-rail: refuse obviously-live hosts unless the operator opts in.
if (/neon\.tech/.test(connectionString) && !process.env.ALLOW_DEMO_SEED_ON_NEON) {
    console.warn(
        '\n⚠  Target looks like a Neon host. This seed sets platform-wide config and mass-inserts posts.\n' +
        '   Confirm this is your ISOLATED demo/sandbox DB, then re-run with ALLOW_DEMO_SEED_ON_NEON=1.\n',
    );
    process.exit(1);
}

const client = postgres(connectionString, { max: 1 });
const db = drizzle({ client });

// ── Brand fiction ───────────────────────────────────────────────────────────
const ORG_SLUG = 'willowbrook-demo';
const ORG_NAME = 'Willowbrook Coffee Roasters';
const OWNER_EMAIL = 'sam@willowbrook-demo.test';   // obviously fictional
const ASSISTANT_NAME = 'Marketing Mabel';
const PLATFORMS = ['instagram', 'facebook', 'linkedin', 'x'] as const;
const TIER_KEY = 'saver';   // saver|employee unlock the quality-review panel (review-post-quality.ts)

// Content pillars + brand voice — mirrored into the assistant's onboardingContext,
// which is what the workspace recap screens read.
const PILLARS = ['Bean origins', 'Behind the counter', 'Brewing tips', 'Community & events'];
const ONBOARDING_CONTEXT = {
    brandVoice: 'Warm, unpretentious, a little playful. First-person "we". Never corporate. UK spelling.',
    contentPillars: PILLARS,
    platforms: PLATFORMS,
    cadence: { frequency: 'daily', times: ['09:00'] },
    guardrails: [
        'No competitor mentions.',
        'No health claims (e.g. "boosts metabolism").',
        'Emoji sparingly.',
        'Always UK spelling.',
    ],
    audience: 'Local coffee lovers, remote workers, weekend brunch crowd.',
};

// A believable single-origin image library (AI-generated look). Uses stable Unsplash
// source URLs via externalUrl so the cards render on camera without file hosting.
const IMAGE_LIBRARY = [
    { name: 'Ethiopian beans, morning light', prompt: 'flat-lay of single-origin Ethiopian beans in a terracotta bowl, soft morning light', url: 'https://images.unsplash.com/photo-1447933601403-0c6688de566e?w=1080&q=80', ar: '1:1' },
    { name: 'Latte art pour', prompt: 'close-up of a barista pouring latte art into a ceramic cup, warm neutral tones', url: 'https://images.unsplash.com/photo-1509042239860-f550ce710b93?w=1080&q=80', ar: '4:5' },
    { name: 'Roastery interior', prompt: 'cosy artisan coffee roastery interior, terracotta and wood, hanging plants', url: 'https://images.unsplash.com/photo-1442512595331-e89e73853f31?w=1080&q=80', ar: '4:5' },
    { name: 'Pour-over setup', prompt: 'v60 pour-over brewing setup on a wooden counter, steam rising, morning light', url: 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=1080&q=80', ar: '1:1' },
    { name: 'Beans in hand', prompt: 'roasted coffee beans cupped in two hands, warm terracotta palette', url: 'https://images.unsplash.com/photo-1524350876685-274059332603?w=1080&q=80', ar: '1:1' },
    { name: 'Café community table', prompt: 'friends laughing around a communal café table with coffee, candid, warm light', url: 'https://images.unsplash.com/photo-1521017432531-fbd92d768814?w=1080&q=80', ar: '4:5' },
];

// ── Post copy, in brand voice (these show at 100% zoom on camera) ─────────────
type Seed = {
    caption: string; pillar: string; hashtags: string; platform: typeof PLATFORMS[number];
    img: number;   // index into IMAGE_LIBRARY
};

// Captions reused across the three buckets below.
const PUBLISHED_COPY: Seed[] = [
    { caption: "This week's single origin is a washed Ethiopian from Yirgacheffe — all jasmine and stone fruit. We're a little obsessed. Pop in for a cup? ☕", pillar: 'Bean origins', hashtags: '#singleorigin #speciltycoffee #yirgacheffe', platform: 'instagram', img: 0 },
    { caption: 'Rainy morning? Sorted. The counter is warm, the pour-overs are slow, and there is a window seat with your name on it.', pillar: 'Behind the counter', hashtags: '#slowcoffee #coffeeshop', platform: 'instagram', img: 3 },
    { caption: 'Brewing tip: let your beans rest 48 hours after roast before you grind. Fresher is not always better — patience makes a sweeter cup.', pillar: 'Brewing tips', hashtags: '#brewingtips #coffeeathome', platform: 'linkedin', img: 4 },
    { caption: 'We roast in small batches every Tuesday and Friday so what lands in your cup is never more than a few days old. Come smell the morning roast.', pillar: 'Behind the counter', hashtags: '#smallbatch #freshroast', platform: 'facebook', img: 2 },
    { caption: 'Thank you to everyone who came to our latte-art throwdown on Saturday — the community here genuinely makes the work worth it. 💛', pillar: 'Community & events', hashtags: '#community #latteart', platform: 'instagram', img: 5 },
    { caption: 'A good flat white is 1/3 espresso, 2/3 steamed milk, and 100% about the pour. Here is ours this morning.', pillar: 'Brewing tips', hashtags: '#flatwhite #coffee', platform: 'instagram', img: 1 },
    { caption: 'New on the shelf: our house blend, now in 250g bags for home. Same cup you love at the counter, on your own kitchen counter.', pillar: 'Bean origins', hashtags: '#houseblend #coffeebeans', platform: 'facebook', img: 0 },
    { caption: 'Quiet Tuesday energy. Grab a corner, open the laptop, let us keep the cups coming.', pillar: 'Behind the counter', hashtags: '#remotework #coffeeshopvibes', platform: 'x', img: 3 },
];

const SCHEDULED_COPY: Seed[] = [
    { caption: 'Weekend plan: pour-over flight of three origins, side by side. Taste the difference the farm makes. Saturdays from 10am.', pillar: 'Community & events', hashtags: '#coffeetasting #weekend', platform: 'instagram', img: 3 },
    { caption: 'Behind the counter this week: meet Priya, who has been dialling in our espresso since day one. Ask her about the Colombian — she lights up.', pillar: 'Behind the counter', hashtags: '#meettheteam #barista', platform: 'instagram', img: 1 },
    { caption: 'Brewing tip: your water is 98% of your cup. Filtered, just off the boil (around 94°C), and everything tastes cleaner. Try it tomorrow.', pillar: 'Brewing tips', hashtags: '#brewingtips #coffeehacks', platform: 'linkedin', img: 4 },
    { caption: 'Fresh in: a natural-process Brazilian that tastes like dark chocolate and toasted hazelnut. Made for a cosy autumn morning.', pillar: 'Bean origins', hashtags: '#newbeans #brazil', platform: 'facebook', img: 0 },
    { caption: 'Save the date — our monthly Coffee & Vinyl night is back on the 28th. Bring a record, we will bring the decaf (and the good stuff too).', pillar: 'Community & events', hashtags: '#event #coffeeandvinyl', platform: 'instagram', img: 5 },
];

// The live AI review queue — autonomous drafts awaiting the human tick.
const PENDING_COPY: (Seed & { confidence: 'green' | 'amber'; claims?: unknown[] })[] = [
    { caption: 'Slow mornings deserve a slow pour. Our Yirgacheffe is back on the guest bar this week — floral, bright, and best enjoyed unhurried.', pillar: 'Bean origins', hashtags: '#pourover #singleorigin', platform: 'instagram', img: 3, confidence: 'green' },
    { caption: 'Rainy-day reminder: the window seats are free, the wifi is fast, and the second refill is on the house before noon. See you soon?', pillar: 'Behind the counter', hashtags: '#coffeeshop #remotework', platform: 'facebook', img: 2, confidence: 'green' },
    { caption: 'Brewing tip: a 1:16 coffee-to-water ratio is a brilliant place to start. Tweak from there to taste — coffee is personal.', pillar: 'Brewing tips', hashtags: '#brewingtips #coffeeathome', platform: 'linkedin', img: 4, confidence: 'green' },
    // The amber one — a factual claim the confidence scorer would hold for review. This is the
    // trust beat in the video: the safety rail catching an unverifiable stat.
    {
        caption: 'Fun fact: our house blend is the most-ordered flat white in the entire city — over 10,000 cups poured last month alone. Thank you! 💛',
        pillar: 'Behind the counter', hashtags: '#houseblend #thankyou', platform: 'instagram', img: 1, confidence: 'amber',
        claims: [
            { claim: "our house blend is the most-ordered flat white in the entire city", claimType: 'statistic', sourceAvailable: false },
            { claim: 'over 10,000 cups poured last month', claimType: 'statistic', sourceAvailable: false },
        ],
    },
];

// A green preflight audit result, shaped exactly as social-preflight-audit.ts writes it.
function greenPreflight(platform: string) {
    const checks = [
        { id: 'CHK-01', label: 'Account linked & published', status: 'pass' },
        { id: 'CHK-02', label: 'Business account connected', status: 'pass' },
        { id: 'CHK-03', label: 'Publishing permission granted', status: 'pass' },
        { id: 'CHK-04', label: 'Token valid & unexpired', status: 'pass' },
    ];
    const runAt = new Date().toISOString();
    return {
        platform,
        preflightStatus: 'passed',
        preflightAuditResults: checks,
        preflightAuditHistory: [{ runAt, preflightStatus: 'passed', checks }],
        preflightAuditedAt: runAt,
    };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
const daysFromNow = (d: number, hour = 9) => {
    const t = new Date();
    t.setUTCDate(t.getUTCDate() + d);
    t.setUTCHours(hour, 0, 0, 0);
    return t;
};

async function main() {
    console.log(`\nSeeding demo tenant "${ORG_NAME}" …`);

    // 1. Resolve the saver master plan + the Social Media Manager master role.
    const [masterPlan] = await db.select().from(masterPlans).where(eq(masterPlans.tierKey, TIER_KEY)).limit(1);
    if (!masterPlan) throw new Error(`master_plans has no tierKey='${TIER_KEY}'. Run db:seed first.`);
    const [smmRole] = await db.select().from(masterAssistants).where(eq(masterAssistants.roleKey, 'social_media_manager')).limit(1);
    if (!smmRole) throw new Error("master_assistants has no 'social_media_manager'. Run db:seed-catalog first.");

    // 2. Org (idempotent on slug).
    const [org] = await db.insert(organisations).values({
        name: ORG_NAME, slug: ORG_SLUG,
        industry: 'Food & Beverage',
        businessDescription: 'Small-batch artisan coffee roaster and neighbourhood café.',
        websiteUrl: 'https://willowbrook-demo.test',
        targetAudience: ONBOARDING_CONTEXT.audience,
        socialHandles: { instagram: '@willowbrookcoffee', facebook: 'WillowbrookCoffee', linkedin: 'willowbrook-coffee', x: '@willowbrookco' },
        onboardingCompleted: true,
        complianceAcceptedAt: new Date(),
    }).onConflictDoUpdate({
        target: organisations.slug,
        set: { name: ORG_NAME, onboardingCompleted: true, updatedAt: new Date() },
    }).returning();
    const orgId = org.id;

    // 3. Owner user + membership.
    const [user] = await db.insert(users).values({
        firstName: 'Sam', lastName: 'Willowbrook', email: OWNER_EMAIL,
        organisationId: orgId, status: 'active', role: 'user',
    }).onConflictDoUpdate({ target: users.email, set: { organisationId: orgId, status: 'active' } }).returning();
    const userId = user.id;
    await db.insert(userOrganisations).values({ userId, organisationId: orgId, role: 'owner' })
        .onConflictDoNothing();

    // 4. Active saver plan (unlocks the quality-review panel).
    const existingPlan = await db.select({ id: plans.id }).from(plans)
        .where(and(eq(plans.organisationId, orgId), inArray(plans.status, ['active', 'past_due']))).limit(1);
    if (existingPlan.length === 0) {
        await db.insert(plans).values({
            userId, organisationId: orgId, masterPlanId: masterPlan.id,
            planName: masterPlan.name, planType: 'subscription', status: 'active',
        });
    }

    // 5. Clean this org's previous demo rows so re-runs are deterministic.
    await db.delete(scheduledPosts).where(eq(scheduledPosts.organisationId, orgId));
    await db.delete(contentAssets).where(eq(contentAssets.organisationId, orgId));
    await db.delete(systemConnections).where(eq(systemConnections.organisationId, orgId));
    await db.delete(contentRules).where(eq(contentRules.workspaceId, orgId));
    await db.delete(aiAssistants).where(eq(aiAssistants.organisationId, orgId));

    // 6. The assistant.
    const [assistant] = await db.insert(aiAssistants).values({
        userId, organisationId: orgId, masterAssistantId: smmRole.id,
        name: ASSISTANT_NAME, aiAssistantJobRole: 'Social Media Manager',
        model: 'claude-sonnet-5', systemPrompt: 'You are the Willowbrook Coffee social media manager.',
        draftHorizonDays: 7,
        autonomousMediaEnabled: true, autonomousMediaMonthlyCap: 20,
        mediaSources: ['ai', 'stock', 'manual'],
        reviewNotifPreference: 'immediate',
        onboardingContext: ONBOARDING_CONTEXT,
        isActive: true, lifecycleStatus: 'working', provisioningStatus: 'complete',
    }).returning();
    const assistantId = assistant.id;

    // 7. Connections — 4 platforms, all preflight-green.
    for (const platform of PLATFORMS) {
        await db.insert(systemConnections).values({
            userId, organisationId: orgId, assistantId,
            serviceName: platform, connectionType: 'oauth', status: 'active', isActive: true,
            externalUserId: `demo-${platform}`,
            metadata: greenPreflight(platform),
        });
    }

    // 8. Image library.
    const assetIds: number[] = [];
    for (const im of IMAGE_LIBRARY) {
        const [row] = await db.insert(contentAssets).values({
            userId, organisationId: orgId, name: im.name, assetType: 'image',
            externalUrl: im.url, provider: 'fal', prompt: im.prompt, aspectRatio: im.ar,
            status: 'scheduled',
        }).returning({ id: contentAssets.id });
        assetIds.push(row.id);
    }

    // 9. Posts — published (past), scheduled (future), pending (review queue).
    const linkAsset = async (postId: number, assetIdx: number) => {
        await db.insert(scheduledPostAssets).values({
            scheduledPostId: postId, contentAssetId: assetIds[assetIdx], position: 0,
        }).onConflictDoNothing();
    };

    // Published — spread across the last ~24 days, all created THIS month so the
    // Hours-Saved tile counts them (get-time-saved.ts windows on created_at >= monthStart).
    for (let i = 0; i < PUBLISHED_COPY.length; i++) {
        const s = PUBLISHED_COPY[i];
        const when = daysFromNow(-(2 + i * 3));
        const [p] = await db.insert(scheduledPosts).values({
            assistantId, userId, organisationId: orgId,
            platform: s.platform, postFormat: 'image', publishDate: when, publishedAt: when,
            caption: s.caption, hashtags: s.hashtags, pillar: s.pillar, status: 'published',
            ownerLabel: `AI: ${ASSISTANT_NAME}`, ownerId: userId,
            confidenceScore: 'green', factualClaimsCount: 0,
            platformPostUrl: `https://${s.platform}.com/willowbrook/${1000 + i}`,
            createdAt: when,
        }).returning({ id: scheduledPosts.id });
        await linkAsset(p.id, s.img);
    }

    // Scheduled (approved, future) — the visibly-full pipeline for Clip 1.
    for (let i = 0; i < SCHEDULED_COPY.length; i++) {
        const s = SCHEDULED_COPY[i];
        const [p] = await db.insert(scheduledPosts).values({
            assistantId, userId, organisationId: orgId,
            platform: s.platform, postFormat: 'image', publishDate: daysFromNow(1 + i),
            caption: s.caption, hashtags: s.hashtags, pillar: s.pillar, status: 'scheduled',
            ownerLabel: `AI: ${ASSISTANT_NAME}`, ownerId: userId,
            confidenceScore: 'green', factualClaimsCount: 0,
            createdAt: new Date(),
        }).returning({ id: scheduledPosts.id });
        await linkAsset(p.id, s.img);
    }

    // Pending approval — the live AI review queue (autonomous drafts).
    for (let i = 0; i < PENDING_COPY.length; i++) {
        const s = PENDING_COPY[i];
        const [p] = await db.insert(scheduledPosts).values({
            assistantId, userId, organisationId: orgId,
            platform: s.platform, postFormat: 'image', publishDate: daysFromNow(2 + i),
            caption: s.caption, hashtags: s.hashtags, pillar: s.pillar,
            status: 'pending_approval', isAutonomous: true, triggerType: 'scheduled',
            ownerLabel: `AI: ${ASSISTANT_NAME}`,
            generationReason: `Drafted to fill an empty ${s.platform} slot on ${daysFromNow(2 + i).toDateString()}.`,
            confidenceScore: s.confidence,
            factualClaimsCount: s.claims ? s.claims.length : 0,
            factualClaims: s.claims ?? null,
            createdAt: new Date(),
        }).returning({ id: scheduledPosts.id });
        await linkAsset(p.id, s.img);
    }

    // 10. Learned brand rules — one manual, one born from rejection/voice feedback.
    //     Powers the "it learns your voice" payoff (Clip 2). content_rules is exactly
    //     what classify-voice-feedback.ts → tune-assistant.ts writes.
    const [rejectedPost] = await db.select({ id: scheduledPosts.id }).from(scheduledPosts)
        .where(and(eq(scheduledPosts.organisationId, orgId), eq(scheduledPosts.status, 'published'))).limit(1);
    await db.insert(contentRules).values([
        {
            assistantId, workspaceId: orgId, createdByUserId: userId,
            ruleText: "Always spell it 'flat white', never 'flatwhite'. Use UK spelling throughout.",
            category: 'response_formatting', origin: 'manual', isActive: true,
        },
        {
            assistantId, workspaceId: orgId, createdByUserId: userId,
            ruleText: "Keep captions warm, not salesy — avoid 'buy now' / hard-sell language. Invite, don't push.",
            category: 'tone_of_voice', origin: 'rejection_feedback',
            originPostId: rejectedPost?.id ?? null,
            note: 'Learned from voice feedback on a rejected draft.',
            isActive: true,
        },
    ]);

    // 11. Report the resulting Hours-Saved headline so you know what will be on screen.
    //     NOTE: this seed deliberately does NOT write gamification.time_multipliers —
    //     that row is PLATFORM-WIDE and would change every org's tile on a shared DB.
    //     We read staging's existing value and report the honest number instead.
    const [cfg] = await db.select({ value: platformConfig.value }).from(platformConfig)
        .where(eq(platformConfig.key, 'gamification.time_multipliers')).limit(1);
    const perPost = Number((cfg?.value as { content_drafted?: number } | undefined)?.content_drafted ?? 5);
    const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(scheduledPosts)
        .where(and(eq(scheduledPosts.organisationId, orgId),
            sql`${scheduledPosts.createdAt} >= date_trunc('month', now())`));
    const hours = (Number(count) * perPost / 60).toFixed(1);

    console.log(`✓ org #${orgId} "${ORG_NAME}" — login as ${OWNER_EMAIL}`);
    console.log(`✓ assistant #${assistantId} "${ASSISTANT_NAME}" (saver tier, 4 platforms preflight-green)`);
    console.log(`✓ ${PUBLISHED_COPY.length} published · ${SCHEDULED_COPY.length} scheduled · ${PENDING_COPY.length} in review (1 amber)`);
    console.log(`✓ 2 learned brand rules (1 from voice feedback)`);
    console.log(`✓ Hours-Saved tile will read ≈ ${hours}h this month (${count} posts × ${perPost}min, existing platform multiplier — not modified)\n`);
}

main()
    .then(() => client.end())
    .catch((err) => { console.error(err); client.end(); process.exit(1); });
