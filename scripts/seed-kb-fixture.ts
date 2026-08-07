// scripts/seed-kb-fixture.ts
//
// Seeds a tier1_support_agent and a deliberately KEYWORD-ONLY knowledge base on staging, so the
// full-text fallback in retrieveKnowledgeBase (netlify/functions/chat-orchestrator.ts) can be
// exercised against real rows.
//
// ── Why this exists ─────────────────────────────────────────────────────────────────────────────
// That fallback shipped broken and stayed broken because there was nothing to test it on:
// kb_articles and kb_chunks were BOTH EMPTY on staging (measured 2026-08-07). Both safe tsquery
// parsers conjoin every content word, so a real support question needed all of its words inside one
// chunk and matched nothing — silently, since zero rows is indistinguishable from "nothing
// relevant". Source-level tests cannot catch that class of bug; only rows can. See
// src/utils/text-search.ts for the full account.
//
// ── Why the chunks have no embeddings ───────────────────────────────────────────────────────────
// On purpose, and it is the whole point. The semantic pass filters on `embedding IS NOT NULL`, so
// with every chunk unembedded it returns nothing and the keyword fallback becomes the ONLY path —
// which is the code under test. embedding_status is set to 'keyword_only', an existing schema state
// meaning "no embedding provider configured, full-text only". No vector_embeddings map rows are
// written either: that GDPR pairing registers EMBEDDED chunks, and these have no vectors.
//
// Chunking goes through the real chunkArticle() so boundaries match production ingestion.
//
// ── Safety ──────────────────────────────────────────────────────────────────────────────────────
// DRY RUN BY DEFAULT — prints what it would do and writes nothing. Pass --apply to commit.
// It prints the target host first and then refuses to write unless the environment tell says
// staging: assistant #1's organisation_id is 10 on staging and 37 on PRODUCTION. Both databases are
// named `neondb`, so current_database() distinguishes nothing and the URL alone is not proof.
// Idempotent: a re-run reuses the assistant and replaces its articles rather than duplicating them.
//
// Usage:
//   npx tsx scripts/seed-kb-fixture.ts            # dry run
//   npx tsx scripts/seed-kb-fixture.ts --apply    # seed
//   npx tsx scripts/seed-kb-fixture.ts --undo     # remove the assistant, its articles and chunks

import { config } from 'dotenv';
import * as path from 'path';
import postgres from 'postgres';
import { chunkArticle } from '../src/utils/kb-embeddings';

config({ path: path.resolve(process.cwd(), '.env') });

const ORG_ID = 10;              // "Mark's Workspace" on staging
const MASTER_ID = 23;           // master_assistants.role_key = 'tier1_support_agent'
const ASSISTANT_NAME = 'Support Assistant (KB fallback test)';
const STAGING_ASSISTANT1_ORG = 10;

const APPLY = process.argv.includes('--apply');
const UNDO = process.argv.includes('--undo');

const url = process.env.NETLIFY_DATABASE_URL;
if (!url) { console.error('NETLIFY_DATABASE_URL is not set'); process.exit(1); }
const sql = postgres(url, { max: 1, connect_timeout: 15 });

/** First-line support content for Be More Swan itself. Multi-paragraph, so chunking is realistic. */
const ARTICLES: { title: string; content: string }[] = [
    {
        title: 'Updating the payment card on your account',
        content: `You can change the card we bill at any time from Settings, then Billing. Choose "Update payment method", enter the new card details and save. The change takes effect on your next invoice — we never re-charge a card mid-period.

If a payment fails we retry twice over the following week and email you each time. Your assistants keep running during the retry window. If the final retry fails the workspace moves to a paused state rather than being deleted, and everything resumes the moment a working card is added.

We do not store card numbers ourselves. Payment details are held by our payment processor, and the only thing kept on our side is the last four digits and the expiry date so you can tell your cards apart.`,
    },
    {
        title: 'Refunds and the 14-day policy',
        content: `Refunds are available within 14 days of an annual charge. Contact support and we will process the return to the original payment method, which usually clears within five working days depending on your bank.

Monthly plans are not refunded for a partial month. Instead, cancelling stops the next renewal and you keep full access until the end of the period you have already paid for.

If you were charged after cancelling, that is a billing error rather than a policy question — send us the invoice number and we will correct it straight away, outside the 14-day window.`,
    },
    {
        title: 'Cancelling your subscription',
        content: `To cancel, open Settings, then Plan, and choose "Cancel subscription". You are asked to confirm once. There is no retention flow and no phone call.

Your workspace stays fully active until the end of the current billing period. After that it becomes read-only: you can still sign in, read past drafts and export your content, but assistants stop producing new work and scheduled posts stop publishing.

We keep a read-only workspace for 90 days before deletion. Reactivating inside that window restores everything exactly as it was, including your assistants' onboarding answers and their knowledge base.`,
    },
    {
        title: 'Why a connected social account stops working',
        content: `Connections expire. Most platforms issue a token that lasts somewhere between 60 days and a year, and some invalidate it early if you change your password, revoke app access, or a page changes ownership.

When that happens the connection shows as needing attention on the Connections page and scheduled posts for that platform stop publishing rather than failing silently. Reconnecting takes a few seconds and does not affect anything you have already scheduled.

If reconnecting does not stick, the usual cause is that the account you authorised with is not an admin of the page or property you are trying to post to. Platform permissions are granted per asset, not per person, so being the account owner is not always sufficient.`,
    },
    {
        title: 'What happens when you run out of tasks',
        content: `Every plan includes a monthly task allowance. A task is one unit of assistant work — generating a draft, running a discovery search, or publishing a scheduled post.

When the allowance runs out, work pauses until the next monthly period begins. This is a hard stop, not an overage charge: we never bill you for going over, and you will never receive a surprise invoice. Anything already scheduled stays scheduled and resumes automatically when the allowance resets.

If you regularly run out before the end of the month, the fix is a plan change rather than a top-up. Upgrading takes effect immediately and the new allowance is available the same day.`,
    },
];

function fail(msg: string): never { console.error(`\n✗ ${msg}`); process.exit(1); }

async function main(): Promise<void> {
    console.log(`target host : ${new URL(url!).host}`);
    console.log(`mode        : ${UNDO ? 'UNDO' : APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'}`);

    // ── Environment guard ───────────────────────────────────────────────────────────────────────
    // assistant #1's org is the stable tell: 10 = staging, 37 = PRODUCTION. Check it before any
    // write, every time — "which database am I on" is not a question to answer by assumption.
    const [tell] = await sql`
        SELECT (SELECT count(*)::int FROM organisations) AS orgs,
               (SELECT organisation_id FROM ai_assistants WHERE id = 1) AS assistant1_org`;
    console.log(`environment : assistant1_org=${tell.assistant1_org}, orgs=${tell.orgs}`);
    if (tell.assistant1_org !== STAGING_ASSISTANT1_ORG) {
        fail(`REFUSING TO RUN — assistant1_org is ${tell.assistant1_org}, not ${STAGING_ASSISTANT1_ORG}. `
            + '37 means this is PRODUCTION. Nothing has been changed.');
    }
    console.log('              → staging confirmed\n');

    const [org] = await sql`SELECT id, name FROM organisations WHERE id = ${ORG_ID}`;
    if (!org) fail(`org #${ORG_ID} not found`);
    const [master] = await sql`SELECT id, role_key FROM master_assistants WHERE id = ${MASTER_ID}`;
    if (!master || master.role_key !== 'tier1_support_agent') {
        fail(`master_assistants #${MASTER_ID} is not tier1_support_agent`);
    }

    const [existing] = await sql`
        SELECT id FROM ai_assistants WHERE organisation_id = ${ORG_ID} AND name = ${ASSISTANT_NAME}`;

    if (UNDO) {
        if (!existing) { console.log('nothing to undo — assistant not found'); return; }
        if (!APPLY) {
            const [n] = await sql`
                SELECT (SELECT count(*)::int FROM kb_articles WHERE ai_assistant_id = ${existing.id}) AS articles,
                       (SELECT count(*)::int FROM kb_chunks   WHERE ai_assistant_id = ${existing.id}) AS chunks`;
            console.log(`would remove assistant #${existing.id}, ${n.articles} articles, ${n.chunks} chunks`);
            console.log('\n(dry run — pass --apply to actually remove)');
            return;
        }
        // Both tables cascade from ai_assistants; deleting explicitly makes the counts visible.
        const ch = await sql`DELETE FROM kb_chunks   WHERE ai_assistant_id = ${existing.id} RETURNING id`;
        const ar = await sql`DELETE FROM kb_articles WHERE ai_assistant_id = ${existing.id} RETURNING id`;
        await sql`DELETE FROM ai_assistants WHERE id = ${existing.id}`;
        console.log(`removed assistant #${existing.id}, ${ar.length} articles, ${ch.length} chunks`);
        return;
    }

    // ai_assistants.user_id is NOT NULL; reuse whoever already owns an assistant in this org rather
    // than inventing an id that would fail the FK.
    const [owner] = await sql`
        SELECT user_id FROM ai_assistants WHERE organisation_id = ${ORG_ID} ORDER BY id LIMIT 1`;
    if (!owner) fail(`org #${ORG_ID} has no existing assistant to take a user_id from`);

    const plan = ARTICLES.map((a) => ({ title: a.title, chunks: chunkArticle(a.content).length }));
    console.log(existing ? `assistant   : reuse #${existing.id}` : `assistant   : CREATE in org #${ORG_ID} "${org.name}"`);
    for (const p of plan) console.log(`  ${existing ? 'replace' : 'insert '} "${p.title}" → ${p.chunks} chunk(s)`);
    const totalChunks = plan.reduce((n, p) => n + p.chunks, 0);
    console.log(`\n${ARTICLES.length} articles, ${totalChunks} chunks, all embedding NULL`);

    if (!APPLY) { console.log('\n(dry run — pass --apply to write)'); return; }

    await sql.begin(async (tx) => {
        let assistantId: number;
        if (existing) {
            assistantId = existing.id;
        } else {
            const [created] = await tx`
                INSERT INTO ai_assistants
                    (user_id, organisation_id, master_assistant_id, name, ai_assistant_job_role,
                     model, is_active, provisioning_status, lifecycle_status)
                VALUES (${owner.user_id}, ${ORG_ID}, ${MASTER_ID}, ${ASSISTANT_NAME},
                        'First-Line Support Assistant', 'claude-haiku-4-5-20251001',
                        -- 'ready_for_work', NOT 'active': ai_assistants_lifecycle_status_check allows
                        -- only provisioning/ready_for_work/working/paused/system_paused/archived.
                        true, 'complete', 'ready_for_work')
                RETURNING id`;
            assistantId = created.id;
        }

        // Replace rather than append, so a re-run does not duplicate the corpus.
        await tx`DELETE FROM kb_chunks   WHERE ai_assistant_id = ${assistantId}`;
        await tx`DELETE FROM kb_articles WHERE ai_assistant_id = ${assistantId}`;

        for (const a of ARTICLES) {
            const chunks = chunkArticle(a.content);
            const [article] = await tx`
                INSERT INTO kb_articles
                    (organisation_id, ai_assistant_id, title, content, source,
                     embedding_status, chunk_count, created_by)
                VALUES (${ORG_ID}, ${assistantId}, ${a.title}, ${a.content}, 'manual',
                        'keyword_only', ${chunks.length}, ${owner.user_id})
                RETURNING id`;
            for (let i = 0; i < chunks.length; i++) {
                await tx`
                    INSERT INTO kb_chunks
                        (kb_article_id, organisation_id, ai_assistant_id, chunk_index, content, embedding)
                    VALUES (${article.id}, ${ORG_ID}, ${assistantId}, ${i}, ${chunks[i]}, NULL)`;
            }
        }
        console.log(`\nseeded under assistant #${assistantId}`);
    });

    const [check] = await sql`
        SELECT count(*)::int AS chunks,
               count(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded,
               count(*) FILTER (WHERE content_tsv IS NOT NULL)::int AS tsv
          FROM kb_chunks WHERE organisation_id = ${ORG_ID}`;
    console.log(`verify: ${check.chunks} chunks, ${check.embedded} embedded, ${check.tsv} with content_tsv`);
}

main()
    .then(() => sql.end())
    .catch(async (err) => {
        // Drizzle/postgres wrappers hide the real Postgres error on .cause.
        const cause = (err as { cause?: { code?: string; message?: string } }).cause;
        console.error('FAILED', (err as Error)?.message ?? err, cause ? `| pg ${cause.code}: ${cause.message}` : '');
        await sql.end();
        process.exit(1);
    });
