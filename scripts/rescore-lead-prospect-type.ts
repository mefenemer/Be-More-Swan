// scripts/rescore-lead-prospect-type.ts
//
// Retro-fits the prospect-type gate (src/config/icp-profile.ts) to leads that were scored before
// it existed. The prod run of 2026-08-12 produced 65 leads under the old prose-only rule, two of
// which were suppliers to the target market rated hot — treyd.io at 75 and idsfulfillment.com at
// 72. The code fix only changes what FUTURE runs produce; those rows keep their old verdict until
// something rewrites them, and this is that something.
//
// ── Gate-only, never a re-score ─────────────────────────────────────────────────────────────────
// Calls classifyProspects(), which asks for a prospectType and nothing else, then replays the
// stored card through the same normaliseLeadCard() clamp a live run uses. So this can only ever
// DEMOTE. A full re-score would re-roll every number in the batch and a lead could move from cold
// to hot for reasons unrelated to the gate, leaving the operator unable to tell the fix from the
// model's nondeterminism.
//
// ── What it writes, and what it must not destroy ────────────────────────────────────────────────
// Two rows per demoted lead:
//
//   • discovered_leads      — score, rating, scoring_card. NOT contact_email, NOT signals.
//   • assistant_records     — status, and the card MERGED into `data` with jsonb `||`.
//
// ⚠️ The merge is load-bearing. recordEnrichment() (process-discovery-jobs.ts) stamps contactEmail,
// emailKind, emailSource, emailFoundOn and enrichAttemptedAt ON TOP of the scoring card in
// `assistant_records.data`. Replacing that object wholesale would wipe the scraped addresses — 4
// out of 65 leads have one, and it is the scarcest thing in the pipeline. `||` overwrites only the
// card's own keys, so the enrichment stamps survive.
//
// ⚠️ A demoted lead LEAVES the Review tab, by design and by request. Membership there requires a
// drafted body AND a resolvable recipient (src/config/lead-recipient.ts isLeadDeliverable), and the
// clamp nulls outreachDraft. The lead returns to Leads as cold with its address intact, so nothing
// disqualified can be approved and emailed to a real stranger by mistake.
//
// ── Safety ──────────────────────────────────────────────────────────────────────────────────────
// TWO STEPS, ALWAYS. The dry run classifies and writes a PLAN file; --apply replays that plan and
// makes no model calls at all. They cannot be collapsed into one command, because two calls to the
// classifier demonstrably disagree (see the note above PlanEntry) — so a one-shot classify-and-write
// would show one diff and commit another. The plan pins the database it was built against and
// refuses to land anywhere else.
//
// Prints the target host and database first: .env in this repo points at STAGING, and these leads
// are in production, so "which database am I on" is not a question to answer by assumption.
// Idempotent: an already-clamped card replays to itself, so a re-run after a partial failure is
// safe, and a lead the model cannot classify is left strictly alone. A lead that has MOVED since
// the plan was written is skipped, never overwritten.
//
// Usage:
//   npx tsx scripts/rescore-lead-prospect-type.ts --list          # inventory only, no model calls
//   npx tsx scripts/rescore-lead-prospect-type.ts --campaign=2 --url-var=PROD_DATABASE_URL
//   npx tsx scripts/rescore-lead-prospect-type.ts --apply --plan=prospect-gate-plan.json --url-var=PROD_DATABASE_URL
//
// Start with --list. Without --campaign the run sweeps EVERY campaign in the database, and the
// campaign id is not something to guess at when the next step writes to production.

import { config } from 'dotenv';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'path';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '../db/client';
import { aiAssistants, assistantRecords, discoveredLeads, discoveryCampaigns } from '../db/schema';
import {
    applyProspectType,
    classifyProspects,
    normaliseLeadCard,
    type LeadScoringCard,
    type ScoreCandidate,
} from '../src/lib/discovery-scoring';
import { isLeadDeliverable } from '../src/config/lead-recipient';
import type { ProspectType } from '../src/config/icp-profile';

config({ path: path.resolve(process.cwd(), '.env') });

/** One model call per batch. Small enough that 1536 output tokens is never the binding constraint. */
const BATCH = 15;

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const listOnly = args.includes('--list');
const flag = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.split('=')[1];
const onlyCampaign = Number(flag('campaign')) || null;
const onlyAssistant = Number(flag('assistant')) || null;
const urlVar = flag('url-var') ?? 'NETLIFY_DATABASE_URL';
const planFile = flag('plan') ?? null;
const planPath = flag('plan-out') ?? path.resolve(process.cwd(), 'prospect-gate-plan.json');

/** Host + database of the connection, so the operator can confirm the target. Never the password. */
function describeTarget(): string {
    const raw = process.env[urlVar];
    if (!raw) return `${urlVar} is not set — the script will fail to connect`;
    try {
        const u = new URL(raw);
        return `${u.host}${u.pathname}  [${urlVar}]`;
    } catch {
        return `unparseable ${urlVar}`;
    }
}

function asCard(raw: unknown, fallbackName: string): LeadScoringCard {
    return normaliseLeadCard(raw, fallbackName);
}

// ── The plan file ───────────────────────────────────────────────────────────────────────────────
//
// ⚠️ The apply step must NOT re-classify. temperature 0 is not determinism — measured, not assumed:
// nationalgeographic.org came back "media" on one staging run and "target_business" on the next
// identical one. If --apply asked the model again, the operator would review one diff and commit a
// different one, which is the whole failure mode a dry run exists to prevent.
//
// So the dry run writes what it decided, and --apply replays exactly that. The plan also pins the
// database it was produced against, because a plan built from staging must never land on prod.

interface PlanEntry {
    leadId: number;
    campaignId: number;
    companyName: string;
    domain: string | null;
    /**
     * `demote` moves the lead's standing; `classify` only records what it is.
     *
     * Both write the same two rows — the split exists so the operator reading a plan can tell the
     * five entries that change a score from the fifty that add a label, rather than scrolling a
     * flat list looking for the ones that matter.
     */
    kind: 'demote' | 'classify';
    prospectType: ProspectType;
    rationale: string | null;
    beforeScore: number;
    beforeRating: string;
    afterScore: number;
    afterRating: string;
    leavesReviewTab: boolean;
}

interface Plan {
    createdAt: string;
    target: string;          // host/database the plan was computed against
    scope: string;
    entries: PlanEntry[];
}

async function main() {
    // getDb() reads NETLIFY_DATABASE_URL. Pointing it elsewhere is what makes --url-var work at all;
    // done before the first call so no connection is ever opened against the default.
    if (urlVar !== 'NETLIFY_DATABASE_URL') {
        const override = process.env[urlVar];
        if (!override) {
            console.error(`\n${urlVar} is not set. Export it, or drop --url-var to use NETLIFY_DATABASE_URL.\n`);
            process.exit(1);
        }
        process.env.NETLIFY_DATABASE_URL = override;
    }

    // ⚠️ --apply NEVER classifies. It replays a plan a human has already read. Allowing a one-shot
    // classify-and-write would mean the diff shown and the diff committed came from two separate
    // model calls, and those calls demonstrably disagree (see the note above PlanEntry).
    if (apply) {
        if (!planFile) {
            console.error('\n--apply requires --plan=<file> from a dry run. Two steps, on purpose:');
            console.error('  1. npx tsx scripts/rescore-lead-prospect-type.ts --campaign=<id>' + (urlVar !== 'NETLIFY_DATABASE_URL' ? ` --url-var=${urlVar}` : ''));
            console.error('  2. read the diff, then re-run with --apply --plan=<the file it wrote>\n');
            process.exit(1);
        }
        await applyPlan();
        return;
    }

    console.log('\nProspect-type gate → existing discovered leads');
    console.log(`  target : ${describeTarget()}`);
    console.log(`  mode   : ${listOnly ? 'LIST (no model calls, no writes)' : apply ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);
    console.log(`  scope  : ${onlyCampaign ? `campaign ${onlyCampaign}` : onlyAssistant ? `assistant ${onlyAssistant}` : 'ALL campaigns'}\n`);

    const db = getDb();

    // --list answers "which campaign, and how much would this cost" without spending a token. The
    // campaign id has to come from somewhere, and guessing it is how a backfill hits the wrong rows.
    if (listOnly) {
        const inventory = await db
            .select({
                campaignId: discoveredLeads.campaignId,
                assistantName: aiAssistants.name,
                total: sql<number>`count(*)::int`,
                scored: sql<number>`count(*) FILTER (WHERE ${discoveredLeads.status} IN ('qualified','promoted'))::int`,
                hot: sql<number>`count(*) FILTER (WHERE ${discoveredLeads.rating} = 'hot')::int`,
                warm: sql<number>`count(*) FILTER (WHERE ${discoveredLeads.rating} = 'warm')::int`,
                cold: sql<number>`count(*) FILTER (WHERE ${discoveredLeads.rating} = 'cold')::int`,
                withEmail: sql<number>`count(*) FILTER (WHERE ${discoveredLeads.contactEmail} IS NOT NULL)::int`,
                gated: sql<number>`count(*) FILTER (WHERE ${discoveredLeads.scoringCard} ? 'prospectType')::int`,
            })
            .from(discoveredLeads)
            .innerJoin(discoveryCampaigns, eq(discoveryCampaigns.id, discoveredLeads.campaignId))
            .innerJoin(aiAssistants, eq(aiAssistants.id, discoveryCampaigns.aiAssistantId))
            .groupBy(discoveredLeads.campaignId, aiAssistants.name)
            .orderBy(discoveredLeads.campaignId);

        if (inventory.length === 0) {
            console.log('  No discovered leads in this database.\n');
            return;
        }
        console.log('  campaign  assistant                    total  scored   hot  warm  cold  email  already-gated');
        for (const r of inventory) {
            console.log(
                `  ${String(r.campaignId).padStart(8)}  ${String(r.assistantName ?? '—').slice(0, 26).padEnd(26)} ` +
                `${String(r.total).padStart(5)} ${String(r.scored).padStart(7)} ${String(r.hot).padStart(5)} ` +
                `${String(r.warm).padStart(5)} ${String(r.cold).padStart(5)} ${String(r.withEmail).padStart(6)} ` +
                `${String(r.gated).padStart(14)}`,
            );
        }
        console.log('\n  "already-gated" leads carry a prospectType and would replay to themselves.');
        console.log('  Re-run with --campaign=<id> for the dry run.\n');
        return;
    }

    const where = [
        // 'discovered' leads were never scored, 'discarded' ones are already out of the pipeline.
        inArray(discoveredLeads.status, ['qualified', 'promoted']),
    ];
    if (onlyCampaign) where.push(eq(discoveredLeads.campaignId, onlyCampaign));
    if (onlyAssistant) where.push(eq(discoveryCampaigns.aiAssistantId, onlyAssistant));

    const leads = await db
        .select({
            id: discoveredLeads.id,
            companyName: discoveredLeads.companyName,
            domain: discoveredLeads.domain,
            contactEmail: discoveredLeads.contactEmail,
            signals: discoveredLeads.signals,
            score: discoveredLeads.score,
            rating: discoveredLeads.rating,
            scoringCard: discoveredLeads.scoringCard,
            assistantRecordId: discoveredLeads.assistantRecordId,
            campaignId: discoveredLeads.campaignId,
            icpSnapshot: discoveryCampaigns.icpSnapshot,
            assistantName: aiAssistants.name,
        })
        .from(discoveredLeads)
        .innerJoin(discoveryCampaigns, eq(discoveryCampaigns.id, discoveredLeads.campaignId))
        .innerJoin(aiAssistants, eq(aiAssistants.id, discoveryCampaigns.aiAssistantId))
        .where(and(...where))
        .orderBy(discoveredLeads.id);

    if (leads.length === 0) {
        console.log('  No scored leads in scope.\n');
        return;
    }
    console.log(`  ${leads.length} scored lead(s) in scope.\n`);

    // Grouped by campaign: the ICP snapshot and assistant name are per-campaign, and they are what
    // the classifier reasons against. Batching across campaigns would judge one campaign's leads
    // against another's profile.
    const byCampaign = new Map<number, typeof leads>();
    for (const l of leads) {
        const list = byCampaign.get(l.campaignId) ?? [];
        list.push(l);
        byCampaign.set(l.campaignId, list);
    }

    let demoted = 0;
    let classified = 0;
    let unchanged = 0;
    let unclassified = 0;
    let skippedKeyLoss = 0;
    let conflicted = 0;
    let leftReviewQueue = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    const plan: PlanEntry[] = [];

    for (const [campaignId, group] of byCampaign) {
        const icp = (group[0].icpSnapshot && typeof group[0].icpSnapshot === 'object'
            ? group[0].icpSnapshot : {}) as Record<string, unknown>;
        const assistantName = group[0].assistantName ?? 'your business';
        console.log(`  ── campaign ${campaignId} — ${group.length} lead(s), assistant "${assistantName}"`);

        for (let start = 0; start < group.length; start += BATCH) {
            const slice = group.slice(start, start + BATCH);
            const candidates: ScoreCandidate[] = slice.map((l) => ({
                companyName: l.companyName,
                domain: l.domain,
                // The SERP snippet the scorer originally saw, so the classification is made on the
                // same evidence rather than on the company name alone.
                snippet: (l.signals as Record<string, unknown> | null)?.snippet as string ?? null,
            }));

            const { results, inputTokens: it, outputTokens: ot } = await classifyProspects(candidates, icp, assistantName);
            inputTokens += it;
            outputTokens += ot;

            for (let i = 0; i < slice.length; i++) {
                const lead = slice[i];
                const { prospectType, rationale } = results[i];
                const label = `#${lead.id} ${lead.companyName}${lead.domain ? ` (${lead.domain})` : ''}`;

                if (!prospectType) {
                    // A failed call or an unparseable answer. Leaving the card alone is the only safe
                    // move: clamping on silence would demote a real customer on a network error.
                    unclassified++;
                    console.log(`    ? ${label}\n        not classified — left untouched`);
                    continue;
                }

                const before = asCard(lead.scoringCard, lead.companyName);
                const after = applyProspectType(before, prospectType);

                const scoreMoved = after.score !== before.score || after.rating !== before.rating
                    || (after.outreachDraft === null) !== (before.outreachDraft === null);
                const stored = before.prospectType ?? null;
                const classificationNew = stored === null;

                if (!scoreMoved && !classificationNew && stored === prospectType) {
                    unchanged++;
                    console.log(`    · ${label}  ${prospectType}  — already recorded (${before.score}/${before.rating})`);
                    continue;
                }

                // ⚠️ NEVER overwrite a classification that is already on the card. This backfill
                // ADDS a missing verdict; it does not revise an existing one.
                //
                // Learned on prod: credobeauty.com was stored `aggregator`, and that verdict is
                // what capped it 72/hot → 10/cold. A later pass called it `target_business` and
                // the write went through, because the clamp is a ceiling so the score never moved
                // and the change looked cosmetic. It was not — the card ended up asserting
                // `target_business` above a reason reading "classified aggregator … so capped at
                // 10". The classifier is not deterministic (temperature 0 is not determinism), so
                // a disagreement between runs is expected and must never be resolved by whichever
                // run happened to go last. Report it and leave the record alone.
                if (stored !== null && stored !== prospectType) {
                    conflicted++;
                    console.log(`    ! ${label}\n        CONFLICT — stored "${stored}", this run says "${prospectType}". Left as stored.`);
                    continue;
                }

                // ⚠️ `discovered_leads.scoring_card` is REPLACED, not merged (unlike the mirrored
                // record, which carries enrichment stamps beside the card). Anything the stored card
                // holds that normaliseLeadCard does not emit would be dropped on the floor. Every
                // card the worker writes is already normalised, so this should never fire — which is
                // exactly why it must be checked rather than assumed.
                const storedKeys = (lead.scoringCard && typeof lead.scoringCard === 'object')
                    ? Object.keys(lead.scoringCard as Record<string, unknown>) : [];
                const lost = storedKeys.filter((k) => !(k in after));
                if (lost.length) {
                    skippedKeyLoss++;
                    console.log(`    ! ${label}\n        SKIPPED — writing the card would drop: ${lost.join(', ')}`);
                    continue;
                }

                // Classification-only: the verdict is recorded, nothing about the lead's standing
                // moves. Worth writing on its own — a cold lead the classifier calls `media` and a
                // cold lead that is a real company scoring badly on fit look identical in the Leads
                // tab, and they need opposite fixes (queries versus the ICP). The clamp is a
                // ceiling, so anything already at or below it keeps its score.
                if (!scoreMoved) {
                    classified++;
                    console.log(`    = ${label}  ${before.score}/${before.rating}  ${prospectType}` +
                        (rationale ? `\n        "${rationale}"` : ''));
                    plan.push({
                        leadId: lead.id, campaignId, companyName: lead.companyName, domain: lead.domain,
                        kind: 'classify', prospectType, rationale,
                        beforeScore: before.score, beforeRating: before.rating,
                        afterScore: after.score, afterRating: after.rating,
                        leavesReviewTab: false,
                    });
                    continue;
                }

                // Deliverability is judged on the MERGED view the UI reads: the card plus the
                // enrichment stamps that live beside it on assistant_records.data. contactEmail is
                // the enriched address, and it is NOT a card key — which is exactly why the write
                // below merges instead of replacing.
                const stamps = { contactEmail: lead.contactEmail ?? undefined };
                const wasDeliverable = isLeadDeliverable({ ...before, ...stamps });
                const nowDeliverable = isLeadDeliverable({ ...after, ...stamps });
                if (wasDeliverable && !nowDeliverable) leftReviewQueue++;

                demoted++;
                console.log(`    ↓ ${label}`);
                console.log(`        ${before.score}/${before.rating}  →  ${after.score}/${after.rating}   ${prospectType}`);
                if (rationale) console.log(`        "${rationale}"`);
                // ⚠️ Deliverability, not the draft, decides Review-tab membership. Most demoted
                // leads have a draft and no recipient, so they were never in that queue — saying
                // "leaves the Review tab" for all of them buries the handful that genuinely do.
                if (before.outreachDraft && !after.outreachDraft) {
                    console.log(wasDeliverable
                        ? `        ⚠️  LEAVES THE REVIEW TAB — draft withdrawn, address kept on the record`
                        : `        draft withdrawn (was not in the Review tab — no recipient)`);
                }

                plan.push({
                    leadId: lead.id,
                    campaignId,
                    companyName: lead.companyName,
                    domain: lead.domain,
                    kind: 'demote',
                    prospectType,
                    rationale,
                    beforeScore: before.score,
                    beforeRating: before.rating,
                    afterScore: after.score,
                    afterRating: after.rating,
                    leavesReviewTab: wasDeliverable && !nowDeliverable,
                });
            }
        }
    }

    // What the run is FOR, banked as data rather than left in the scrollback: how many of this
    // campaign's leads were never companies we could sell to. A cold lead the classifier calls
    // `media` and a cold lead that is a real company scoring badly on fit look identical in the
    // Leads tab and need opposite fixes — the queries, or the ICP.
    const byType = new Map<string, number>();
    for (const e of plan) byType.set(e.prospectType, (byType.get(e.prospectType) ?? 0) + 1);

    console.log('\n  ── Summary ────────────────────────────────');
    console.log(`  leads in scope          : ${leads.length}`);
    console.log(`  demoted by the gate     : ${demoted}`);
    console.log(`  classification recorded : ${classified}`);
    console.log(`  already recorded        : ${unchanged}`);
    console.log(`  not classified (skipped): ${unclassified}`);
    if (skippedKeyLoss) console.log(`  skipped, would lose keys: ${skippedKeyLoss}`);
    if (conflicted) console.log(`  classification conflicts : ${conflicted} (left as stored)`);
    console.log(`  leaving the Review tab  : ${leftReviewQueue}`);
    console.log(`  tokens                  : ${inputTokens} in / ${outputTokens} out`);

    if (byType.size) {
        console.log('\n  ── What this campaign actually found ──────');
        for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
            console.log(`  ${t.padEnd(24)}: ${n}`);
        }
    }

    if (plan.length > 0) {
        const doc: Plan = {
            createdAt: new Date().toISOString(),
            target: describeTarget(),
            scope: onlyCampaign ? `campaign ${onlyCampaign}` : onlyAssistant ? `assistant ${onlyAssistant}` : 'all campaigns',
            entries: plan,
        };
        writeFileSync(planPath, JSON.stringify(doc, null, 2));
        console.log(`\n  Plan written to ${planPath}`);
        console.log('  Nothing was written to the database. Review the diff above, then apply THAT plan:');
        console.log(`    npx tsx scripts/rescore-lead-prospect-type.ts --apply --plan=${planPath}${urlVar !== 'NETLIFY_DATABASE_URL' ? ` --url-var=${urlVar}` : ''}`);
    }
    console.log('');
}

/**
 * Apply a plan produced by an earlier dry run. Makes NO model calls.
 *
 * Re-reads each lead and re-derives the card from what is stored NOW, clamped to the prospectType
 * the operator reviewed. Two rows that have moved since the plan was written are skipped rather
 * than overwritten: between the dry run and the apply, a user may have approved, rejected or edited
 * a lead, and a backfill silently reverting that is worse than a backfill that misses it.
 */
async function applyPlan(): Promise<void> {
    const doc = JSON.parse(readFileSync(planFile!, 'utf8')) as Plan;
    const target = describeTarget();

    console.log('\nProspect-type gate → applying a reviewed plan');
    console.log(`  plan     : ${planFile}`);
    console.log(`  built    : ${doc.createdAt}  against ${doc.target}`);
    console.log(`  target   : ${target}`);
    console.log(`  entries  : ${doc.entries.length}\n`);

    // ⚠️ A plan computed on staging must never land on prod. Same lead ids exist in both.
    if (doc.target !== target) {
        console.error('  REFUSING TO APPLY — this plan was built against a different database.');
        console.error(`    plan   : ${doc.target}`);
        console.error(`    target : ${target}`);
        console.error('  Re-run the dry run against this database and apply the plan it produces.\n');
        process.exit(1);
    }

    const db = getDb();
    let applied = 0;
    let demoted = 0;
    let classified = 0;
    let skipped = 0;

    for (const e of doc.entries) {
        const [lead] = await db
            .select({
                id: discoveredLeads.id,
                companyName: discoveredLeads.companyName,
                score: discoveredLeads.score,
                rating: discoveredLeads.rating,
                scoringCard: discoveredLeads.scoringCard,
                assistantRecordId: discoveredLeads.assistantRecordId,
            })
            .from(discoveredLeads)
            .where(eq(discoveredLeads.id, e.leadId))
            .limit(1);

        const label = `#${e.leadId} ${e.companyName}${e.domain ? ` (${e.domain})` : ''}`;

        if (!lead) {
            skipped++;
            console.log(`    ! ${label}\n        gone since the plan was written — skipped`);
            continue;
        }
        if (lead.score !== e.beforeScore || lead.rating !== e.beforeRating) {
            skipped++;
            console.log(`    ! ${label}`);
            console.log(`        moved since the plan was written (${e.beforeScore}/${e.beforeRating} → ${lead.score}/${lead.rating}) — skipped`);
            continue;
        }

        // Re-derived from what is stored now, not from the plan's copy of the card: the plan records
        // the DECISION, the database remains the source of truth for the content being clamped.
        const after = applyProspectType(asCard(lead.scoringCard, lead.companyName), e.prospectType);

        await db.update(discoveredLeads)
            .set({ score: after.score, rating: after.rating, scoringCard: after, updatedAt: new Date() })
            .where(eq(discoveredLeads.id, lead.id));

        if (lead.assistantRecordId) {
            // MERGE, never replace — see the warning at the top of this file. The card's own keys win
            // (outreachDraft becomes JSON null, which is what withdraws the draft); contactEmail and
            // the enrichment stamps are not card keys, so they survive.
            await db.update(assistantRecords)
                .set({
                    status: after.rating,
                    data: sql`COALESCE(${assistantRecords.data}, '{}'::jsonb) || ${JSON.stringify(after)}::jsonb`,
                    updatedAt: new Date(),
                })
                .where(eq(assistantRecords.id, lead.assistantRecordId));
        }

        applied++;
        if (e.kind === 'classify') {
            classified++;
            console.log(`    = ${label}  ${after.score}/${after.rating}  ${e.prospectType}  (classification only)`);
        } else {
            demoted++;
            console.log(`    ✓ ${label}  ${e.beforeScore}/${e.beforeRating} → ${after.score}/${after.rating}  ${e.prospectType}`
                + (e.leavesReviewTab ? '   ⚠️ left the Review tab' : ''));
        }
    }

    console.log('\n  ── Summary ────────────────────────────────');
    console.log(`  applied                : ${applied}`);
    console.log(`    demoted              : ${demoted}`);
    console.log(`    classification only  : ${classified}`);
    console.log(`  skipped                : ${skipped}`);
    console.log('');
}

main()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('\nRe-score failed:', err);
        process.exit(1);
    });
