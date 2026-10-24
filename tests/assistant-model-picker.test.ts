// tests/assistant-model-picker.test.ts
// Admin ▸ Assistants ▸ Model & rules (owner, 2026-10-24): choose a role's Claude model, see what it
// costs, and see the rules its prompts are built from. The adapter is what makes a model change
// safe — the current generation thinks first (and bills it against max_tokens), returns a thinking
// block before the text, and refuses a temperature — so most of this pins the adapter and the
// wiring, not the page.
// Run:  npx tsx tests/assistant-model-picker.test.ts

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import {
    MODEL_OPTIONS, adaptForModel, effectiveThinking, estimateCallUsd, modelOption, replyText,
} from '../src/config/model-options';
import { withRoleModel } from '../src/utils/assistant-model';
import { LIST_PRICE_PER_1K } from '../src/utils/ai-usage';
import { CHAT_DEFAULT_MODEL, ROLE_MODEL_PATHS, promptLayersFor } from '../src/config/assistant-prompt-layers';

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) { await fn(); console.log(`  ✓ ${name}`); passed++; }
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

async function main() {

    await check('a previous-generation model gets the request exactly as before', () => {
        const p = { model: 'x', max_tokens: 700, temperature: 0.4, system: 's', messages: [] };
        assert.deepStrictEqual(adaptForModel(p, 'claude-haiku-4-5-20251001', 'high'), { ...p, model: 'claude-haiku-4-5-20251001' });
        assert.deepStrictEqual(adaptForModel(p, 'claude-sonnet-4-6', 'low'), { ...p, model: 'claude-sonnet-4-6' });
    });
    
    await check('a thinking model gets room to think, an effort, and no temperature', () => {
        const out = adaptForModel({ model: 'x', max_tokens: 700, temperature: 0.4, top_p: 0.9 }, 'claude-opus-5-5', 'low') as Record<string, unknown>;
        assert.strictEqual(out.temperature, undefined);
        assert.strictEqual(out.top_p, undefined);
        assert.deepStrictEqual(out.thinking, { type: 'adaptive' });
        assert.deepStrictEqual(out.output_config, { effort: 'low' });
        assert.strictEqual(out.max_tokens, 4700);
        // Capped where the SDK would refuse a non-streaming call.
        assert.strictEqual((adaptForModel({ model: 'x', max_tokens: 6000 }, 'claude-opus-5-5', 'high') as { max_tokens: number }).max_tokens, 16000);
    });
    
    await check('Off is sent the way each model accepts it, and Opus cannot be Off', () => {
        assert.deepStrictEqual((adaptForModel({ model: 'x', max_tokens: 500 }, 'claude-sonnet-5-5', 'off') as Record<string, unknown>).thinking, { type: 'between_tools' });
        assert.deepStrictEqual((adaptForModel({ model: 'x', max_tokens: 500 }, 'claude-haiku-5-5', 'off') as Record<string, unknown>).thinking, { type: 'disabled' });
        assert.strictEqual(effectiveThinking('claude-opus-5-5', 'off'), 'low');
        assert.strictEqual(effectiveThinking('claude-haiku-4-5-20251001', 'high'), 'off');
        assert.strictEqual(effectiveThinking('claude-sonnet-5-5', 'nonsense' as never), 'low');
    });
    
    await check('replyText reads past a thinking block — content[0] would be empty', () => {
        const content = [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }];
        assert.strictEqual(replyText(content), '{"a":1}');
        assert.strictEqual(replyText(null), '');
    });
    
    await check('every offered model is priced in the usage ledger at the same rate', () => {
        for (const m of MODEL_OPTIONS) {
            const p = LIST_PRICE_PER_1K[m.id];
            assert.ok(p, `${m.id} has no LIST_PRICE_PER_1K — its calls would record $0`);
            assert.ok(Math.abs(p.input * 1000 - m.inPerM) < 1e-9 && Math.abs(p.output * 1000 - m.outPerM) < 1e-9, `${m.id} price differs`);
        }
    });
    
    await check('cost estimates allow for the newer tokenizer and for thinking', () => {
        // Same model → just the price. 10k in / 500 out on Sonnet 4.6 = $0.0375.
        assert.ok(Math.abs(estimateCallUsd('claude-sonnet-4-6', 'claude-sonnet-4-6', 10_000, 500)! - 0.0375) < 1e-9);
        const opus = estimateCallUsd('claude-sonnet-4-6', 'claude-opus-5-5', 10_000, 500, 'low')!;
        assert.ok(Math.abs(opus - (13_800 * 4 + 950 * 20) / 1e6) < 1e-9, String(opus));
        assert.ok(estimateCallUsd('claude-sonnet-4-6', 'claude-haiku-5-5', 10_000, 500)! < 0.005);
        assert.strictEqual(estimateCallUsd('a', 'not-a-model', 1, 1), null);
    });
    
    await check('no choice runs the default once, thinking off — the code exactly as before', async () => {
        const calls: string[] = [];
        const out = await withRoleModel(null, 'claude-haiku-4-5-20251001', async (m, t) => { calls.push(`${m}:${t}`); return 'ok'; });
        assert.strictEqual(out, 'ok');
        assert.deepStrictEqual(calls, ['claude-haiku-4-5-20251001:off']);
    });
    
    await check('a refused request on the chosen model is retried on the default; other errors are not', async () => {
        const calls: string[] = [];
        const refused = new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'temperature is not supported' } }, 'temperature is not supported', new Headers());
        const out = await withRoleModel({ model: 'claude-opus-5-5', thinking: 'low' }, 'claude-haiku-4-5-20251001', async (m) => {
            calls.push(m); if (m === 'claude-opus-5-5') throw refused; return 'fallback';
        }, { label: 'test' });
        assert.strictEqual(out, 'fallback');
        assert.deepStrictEqual(calls, ['claude-opus-5-5', 'claude-haiku-4-5-20251001']);
        const credit = new Anthropic.BadRequestError(400, {}, 'Your credit balance is too low', new Headers());
        await assert.rejects(withRoleModel({ model: 'claude-opus-5-5', thinking: 'low' }, 'd', async () => { throw credit; }));
    });
    
    await check('a request path is held at Low thinking whatever the setting', async () => {
        let seen = '';
        await withRoleModel({ model: 'claude-opus-5-5', thinking: 'high' }, 'd', async (_m, t) => { seen = t; }, { requestPath: true });
        assert.strictEqual(seen, 'low');
        await withRoleModel({ model: 'claude-opus-5-5', thinking: 'high' }, 'd', async (_m, t) => { seen = t; });
        assert.strictEqual(seen, 'high');
    });
    
    await check('each wired path reads its own role, adapts the request and no longer reads content[0]', () => {
        const paths: Array<[string, string]> = [
            ['src/utils/newsletter-generate.ts', "loadRoleModel(db, 'newsletter_editor')"],
            ['src/utils/blog-generate.ts', "loadRoleModel(db, 'blog_writer')"],
            ['netlify/functions/lead-generation.ts', "loadRoleModel(db, 'lead_qualifier')"],
            ['netlify/functions/chat-orchestrator.ts', 'loadRoleModel(db, assistantRow.roleKey)'],
            ['netlify/functions/process-content-jobs.ts', 'loadRoleModel(db, await roleKeyOfAssistant(db, job.assistant_id))'],
        ];
        for (const [file, marker] of paths) {
            const src = read(file);
            assert.ok(src.includes(marker), `${file}: ${marker}`);
            if (!file.includes('process-content-jobs')) {
                assert.ok(src.includes('adaptForModel('), `${file} adapts the request`);
                assert.ok(!/\.content\[0\]/.test(src), `${file} still reads content[0]`);
            }
        }
        // Social drafting goes through the gateway, which adapts a role's model and reads every text block.
        const gw = read('src/lib/ai-gateway.ts');
        assert.ok(gw.includes('adaptForModel(params, model, req.thinking)') && gw.includes('const text = replyText(response.content);'));
        assert.strictEqual(read('netlify/functions/process-content-jobs.ts').match(/\.\.\.roleModel/g)?.length, 3, 'the draft and both re-asks');
    });
    
    await check('the code defaults shown on the page are the models the code really uses', () => {
        assert.ok(read('src/utils/newsletter-generate.ts').includes(`export const NEWSLETTER_MODEL = '${ROLE_MODEL_PATHS.newsletter_editor[0].defaultModel}'`));
        assert.ok(read('src/utils/blog-generate.ts').includes(`export const BLOG_MODEL = '${ROLE_MODEL_PATHS.blog_writer[0].defaultModel}'`));
        assert.ok(read('netlify/functions/lead-generation.ts').includes(`const MODEL = '${ROLE_MODEL_PATHS.lead_qualifier[0].defaultModel}'`));
        assert.ok(read('src/lib/ai-gateway.ts').includes(`?? '${ROLE_MODEL_PATHS.social_media_manager[0].defaultModel}'`));
        assert.ok(read('netlify/functions/chat-orchestrator.ts').includes(`const DEFAULT_MODEL = '${CHAT_DEFAULT_MODEL}'`));
        for (const p of Object.values(ROLE_MODEL_PATHS).flat()) assert.ok(modelOption(p.defaultModel), `${p.defaultModel} is offered`);
    });
    
    await check('every rule layer the page shows is really in the prompt of the path it names', () => {
        // export used by the layer → the identifier that must appear in its source path's file.
        const USES: Record<string, string> = {
            standards: 'CONTENT_QUALITY_STANDARDS', platform_craft: 'platformCraftBlock(', shapes: 'socialShapeLine(', hooks: 'socialHookFor(',
            email_craft: 'emailCraftBlock(', email_openings: 'emailOpeningBlock(', cta_email: 'CTA_BINDING_RULE',
            article_types: 'blogArticleTypeBlock(', blog_openings: 'blogOpeningBlock(', cta_blog: 'CTA_BINDING_RULE',
            special_social: 'SPECIAL_CATEGORY_RULE', special_email: 'SPECIAL_CATEGORY_RULE', special_blog: 'SPECIAL_CATEGORY_RULE', special: 'SPECIAL_CATEGORY_RULE',
        };
        const PATH: Record<string, string> = {
            standards: 'netlify/functions/process-content-jobs.ts', platform_craft: 'netlify/functions/process-content-jobs.ts',
            shapes: 'netlify/functions/process-content-jobs.ts', hooks: 'netlify/functions/process-content-jobs.ts', special_social: 'netlify/functions/process-content-jobs.ts',
            email_craft: 'src/utils/newsletter-generate.ts', email_openings: 'src/utils/newsletter-generate.ts', cta_email: 'src/utils/newsletter-generate.ts', special_email: 'src/utils/newsletter-generate.ts',
            article_types: 'src/utils/blog-generate.ts', blog_openings: 'src/utils/blog-generate.ts', cta_blog: 'src/utils/blog-generate.ts', special_blog: 'src/utils/blog-generate.ts',
            special: 'netlify/functions/chat-orchestrator.ts',
        };
        for (const role of Object.keys(ROLE_MODEL_PATHS)) {
            for (const l of promptLayersFor(role)) {
                assert.ok(l.text.trim().length > 20, `${role}/${l.key} has text`);
                if (USES[l.key]) assert.ok(read(PATH[l.key]).includes(USES[l.key]), `${role}/${l.key}: ${USES[l.key]} not in ${PATH[l.key]}`);
            }
        }
        // Lead outreach: the first-email rules (and the openings inside them) go straight into lead-generation's prompts.
        assert.ok(read('netlify/functions/lead-generation.ts').includes('${outreachFirstEmailBlock('));
        // Every role, even one with no drafting of its own, shows its chat rules.
        assert.ok(promptLayersFor('mystery_shopper').some((l) => l.key === 'team'));
    });
    
    await check('the admin page has the tab, saves through the endpoint, and copes with the SQL not applied', () => {
        const html = read('admin.html');
        assert.ok(html.includes(`data-tab="model" onclick="aaTab('model')"`) && html.includes("else if (tab === 'model') aaRenderModel();"));
        assert.ok(html.includes('&action=model`, { method: \'POST\''));
        const fn = read('netlify/functions/admin-assistants.ts');
        assert.ok(fn.includes("q.config === '1'") && fn.includes("q.action === 'model'"));
        assert.ok(fn.includes("if (pgCode(err) === '42P01') return { rows: [], needsSetup: true };"));
        assert.ok(fn.includes("action: 'assistant_model_change'"), 'audited');
        assert.ok(read('db/assistant-model-settings.sql').includes('CREATE TABLE IF NOT EXISTS assistant_model_settings'));
    });

    console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
