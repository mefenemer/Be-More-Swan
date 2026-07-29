// scripts/backfill-onboarding-guardrails.ts
//
// Materialises each assistant's onboarding guardrails as content_rules rows — the same thing
// onboarding.ts has done at hire time since 2026-07-28 (commit b56b8b4), applied retroactively to
// every assistant hired before that.
//
// ── Why this exists ─────────────────────────────────────────────────────────────────────────────
// The onboarding wizard collects guardrails into configuration.inputs.strictRules and, until that
// commit, stopped there. The rules DID reach the model (blueprint section 3 reads strictRules live,
// and section 2's hire-time brief carries a frozen copy), but no content_rules row was ever
// written, and that row is what two other things look for:
//
//   • get-assistant-readiness.ts — the Kick-Off "Guardrails & rules set" check needs ≥1 ACTIVE row
//     scoped to the assistant, so it stayed red no matter what the user typed at onboarding.
//   • post-quality-review.ts — reads blueprint section 4 out of the latest PERSISTED blueprint and
//     passes the rules to the reviewer model. No rows meant nothing to review against.
//
// The second one is why this script recompiles the blueprint after inserting: writing the rows
// alone does not reach quality review until section 4 is rebuilt.
//
// ── Safety ──────────────────────────────────────────────────────────────────────────────────────
// DRY RUN BY DEFAULT — prints what it would insert and writes nothing. Pass --apply to commit.
// It prints the target host and database first, because .env in this repo has pointed at a stale
// database before now and "which database am I actually on" is not a question to answer by
// assumption. Idempotent: an assistant that already has rules is skipped, and an individual rule
// whose exact text already exists is skipped, so a re-run after a partial failure is safe.
//
// Usage:
//   npx tsx scripts/backfill-onboarding-guardrails.ts                  # dry run, all assistants
//   npx tsx scripts/backfill-onboarding-guardrails.ts --assistant=1    # dry run, one assistant
//   npx tsx scripts/backfill-onboarding-guardrails.ts --apply          # write
//   npx tsx scripts/backfill-onboarding-guardrails.ts --apply --no-recompile

import { config } from 'dotenv';
import * as path from 'path';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client';
import { aiAssistants, contentRules, organisations } from '../db/schema';
import { extractOnboardingGuardrails } from '../src/utils/onboarding-guardrails';
import { sanitizeUserInput } from '../src/utils/sanitize-user-input';
import { assembleBlueprint } from '../src/utils/blueprint';

config({ path: path.resolve(process.cwd(), '.env') });

const RULE_TEXT_CAP = 300; // content-rules.ts's own cap — keep the backfill inside it

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const recompile = !args.includes('--no-recompile');
const onlyAssistant = Number(args.find(a => a.startsWith('--assistant='))?.split('=')[1]) || null;

/** Host + database name of the connection, so the operator can confirm the target. Never the password. */
function describeTarget(): string {
    const raw = process.env.NETLIFY_DATABASE_URL;
    if (!raw) return 'NETLIFY_DATABASE_URL is not set — the script will fail to connect';
    try {
        const u = new URL(raw);
        return `${u.host}${u.pathname}`;
    } catch {
        return 'unparseable NETLIFY_DATABASE_URL';
    }
}

async function main() {
    console.log('\nOnboarding guardrail backfill → content_rules');
    console.log(`  target   : ${describeTarget()}`);
    console.log(`  mode     : ${apply ? 'APPLY (writes)' : 'DRY RUN (no writes)'}`);
    console.log(`  scope    : ${onlyAssistant ? `assistant ${onlyAssistant}` : 'all assistants'}`);
    console.log(`  recompile: ${apply && recompile ? 'yes, after insert' : 'no'}\n`);

    const db = getDb();

    const assistants = await db
        .select({
            id: aiAssistants.id,
            userId: aiAssistants.userId,
            organisationId: aiAssistants.organisationId,
            jobRole: aiAssistants.aiAssistantJobRole,
            configuration: aiAssistants.configuration,
            orgName: organisations.name,
        })
        .from(aiAssistants)
        .innerJoin(organisations, eq(organisations.id, aiAssistants.organisationId));

    const targets = onlyAssistant ? assistants.filter(a => a.id === onlyAssistant) : assistants;
    if (targets.length === 0) {
        console.log('No matching assistants.\n');
        return;
    }

    let inserted = 0;
    let skippedHasRules = 0;
    let skippedNoGuardrails = 0;
    const recompiled: number[] = [];

    for (const a of targets) {
        const label = `#${a.id} ${a.orgName} — ${a.jobRole ?? 'unknown role'}`;

        const inputs = (a.configuration as Record<string, unknown> | null)?.inputs as Record<string, unknown> | undefined;
        // Same extraction onboarding runs: keep only '- NON-NEGOTIABLE: ' entries (the KNOWLEDGE
        // BASE entries sharing that array are context, not rules), then sanitise and cap.
        const ruleTexts = extractOnboardingGuardrails(inputs?.strictRules)
            .map(r => sanitizeUserInput(r).slice(0, RULE_TEXT_CAP))
            .filter(r => r.length > 0);

        if (ruleTexts.length === 0) {
            skippedNoGuardrails++;
            console.log(`  ○ ${label}\n      no onboarding guardrails to materialise`);
            continue;
        }

        // Existing rules — ACTIVE and inactive alike. A rule the user deliberately switched off
        // must not be resurrected by a backfill.
        const existing = await db
            .select({ ruleText: contentRules.ruleText })
            .from(contentRules)
            .where(eq(contentRules.assistantId, a.id));

        if (existing.length > 0) {
            // Already has rules from onboarding, the Guardrails panel or the feedback loop. Only
            // fill genuine gaps, matching on exact text.
            const have = new Set(existing.map(r => r.ruleText));
            const missing = ruleTexts.filter(r => !have.has(r));
            if (missing.length === 0) {
                skippedHasRules++;
                console.log(`  ○ ${label}\n      ${existing.length} rule(s) already present, nothing missing`);
                continue;
            }
            console.log(`  + ${label}\n      ${existing.length} present, adding ${missing.length}:`);
            missing.forEach(r => console.log(`        · ${r}`));
            if (apply) {
                await db.insert(contentRules).values(missing.map(ruleText => ({
                    assistantId: a.id,
                    workspaceId: a.organisationId,
                    ruleText,
                    origin: 'manual' as const,
                    createdByUserId: a.userId,
                    isActive: true,
                })));
                recompiled.push(a.id);
            }
            inserted += missing.length;
            continue;
        }

        console.log(`  + ${label}\n      inserting ${ruleTexts.length} rule(s):`);
        ruleTexts.forEach(r => console.log(`        · ${r}`));
        if (apply) {
            await db.insert(contentRules).values(ruleTexts.map(ruleText => ({
                assistantId: a.id,
                workspaceId: a.organisationId,
                ruleText,
                origin: 'manual' as const,
                createdByUserId: a.userId,
                isActive: true,
            })));
            recompiled.push(a.id);
        }
        inserted += ruleTexts.length;
    }

    // Section 4 is read by post-quality-review.ts from the PERSISTED blueprint, so the rows only
    // reach the reviewer once the blueprint is rebuilt. Best-effort per assistant: a recompile
    // failure must not undo rows that are already committed.
    if (apply && recompile && recompiled.length > 0) {
        console.log('\n  Recompiling blueprints so section 4 picks the rules up…');
        for (const id of recompiled) {
            try {
                await assembleBlueprint(id, 'script-backfill-guardrails', 'context_update');
                console.log(`    ✓ assistant ${id}`);
            } catch (e) {
                console.warn(`    ! assistant ${id}: recompile failed (rules ARE saved) — ${e instanceof Error ? e.message : e}`);
            }
        }
    }

    console.log('\n  ── Summary ────────────────────────────────');
    console.log(`  assistants scanned      : ${targets.length}`);
    console.log(`  no guardrails stored    : ${skippedNoGuardrails}`);
    console.log(`  already covered         : ${skippedHasRules}`);
    console.log(`  rules ${apply ? 'inserted        ' : 'that would insert'} : ${inserted}`);
    if (!apply && inserted > 0) console.log('\n  Dry run — nothing was written. Re-run with --apply to commit.');
    console.log('');
}

main()
    .then(() => process.exit(0))
    .catch(err => {
        console.error('\nBackfill failed:', err);
        process.exit(1);
    });
