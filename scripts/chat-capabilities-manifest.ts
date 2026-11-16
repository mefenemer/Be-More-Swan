// scripts/chat-capabilities-manifest.ts
// Feature request #17 (Admin ▸ Assistants ▸ Chat capabilities). Reads what each assistant's chat can
// do FROM THE CODE and writes it to src/config/chat-capabilities.generated.ts, which the admin page
// reads (a Netlify function cannot load the chat orchestrator, so this is the server's copy).
//
//   npx tsx scripts/chat-capabilities-manifest.ts           → says whether the file is up to date
//   npx tsx scripts/chat-capabilities-manifest.ts --write   → rewrites it
//
// tests/assistant-chat-capabilities.test.ts calls buildChatManifest() and FAILS when the committed
// file differs, so a new route, route flag, prompt block, per-message extra or card cannot reach
// staging without the page knowing. The words that describe each item live in
// src/utils/assistant-chat-capabilities.ts (that test fails on any item without them).
//
// Derived here, never typed by hand:
//   routes        every ROUTES key: its flags, whether it offers cards, and every card type its role
//                 prompt names (rendered with every snapshot present, so no conditional card is missed)
//   routeFlags    the optional switches on `interface AssistantRoute`
//   promptBlocks  the blocks joined into `promptWithRules`, in order
//   turnExtras    what is added to the user's message each turn
//   targetCards   cards named by the "opened on a post / an email" blocks
//   uiCards       every card type the browser can draw (src/components/disruptive-ui-registry.js)

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTES } from '../netlify/functions/chat-orchestrator';
import { resolveTaskCosts } from '../src/utils/task-costs';
import { promptLayersFor } from '../src/config/assistant-prompt-layers';

const ROOT = join(__dirname, '..');
export const MANIFEST_PATH = 'src/config/chat-capabilities.generated.ts';
const ORCH_PATH = 'netlify/functions/chat-orchestrator.ts';
const UI_REGISTRY_PATH = 'src/components/disruptive-ui-registry.js';

// The shapes live with the reader (src/utils/assistant-chat-capabilities.ts), so the generated file has no imports.
export interface RouteManifest {
    /** Route flags that are switched on (usesSiteSnapshot, acceptsAttachments…). */
    flags: string[];
    /** contentSnapshot's value, when set. */
    contentSnapshot: string | null;
    /** false for the routes left out of `offersOwnCards` (they get none of the shared card blocks). */
    offersOwnCards: boolean;
    maxTokens: number;
    /** Card types (drawn by the browser) that the role prompt names. */
    cards: string[];
    /** Keys of this role's craft layers (assistant-prompt-layers.ts) whose text is IN its chat prompt. */
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

const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

/** Text between `start` and the first `end` after it. Throws when either is missing, so a refactor is loud. */
function between(src: string, start: string, end: string): string {
    const a = src.indexOf(start);
    if (a < 0) throw new Error(`chat-capabilities-manifest: "${start}" not found in ${ORCH_PATH}`);
    const b = src.indexOf(end, a + start.length);
    if (b < 0) throw new Error(`chat-capabilities-manifest: "${end}" not found after "${start}"`);
    return src.slice(a + start.length, b);
}

/** Every card type the browser registers a renderer for, snake_case only (PascalCase are legacy aliases). */
export function uiCardTypes(js: string = read(UI_REGISTRY_PATH)): string[] {
    return [...new Set([...js.matchAll(/register\(\s*'([a-z][a-z0-9_]*)'/g)].map((m) => m[1]))].sort();
}

/** Card types (from `known`) a prompt names as `"type": "x"`. */
export function cardsNamedIn(text: string, known: readonly string[]): string[] {
    const set = new Set(known);
    return [...new Set([...text.matchAll(/"type"\s*:\s*\\?"([a-z][a-z0-9_]*)\\?"/g)].map((m) => m[1]))]
        .filter((t) => set.has(t)).sort();
}

export function parseRouteFlags(src: string): string[] {
    const body = between(src, 'interface AssistantRoute {', '\n}');
    return [...body.matchAll(/^ {4}([A-Za-z]\w*)\?:/gm)].map((m) => m[1]);
}

export function parsePromptBlocks(src: string): string[] {
    const body = between(src, 'const promptWithRules = [', '].filter(Boolean)');
    const out: string[] = [];
    for (const part of body.split(',')) {
        // `offersOwnCards ? SUPPORT_REQUEST_PROMPT : null` → SUPPORT_REQUEST_PROMPT
        const ids = (part.match(/[A-Za-z_]\w*/g) ?? []).filter((t) => t !== 'offersOwnCards' && t !== 'null');
        const id = ids[ids.length - 1];
        if (id && !out.includes(id)) out.push(id);
    }
    return out;
}

export function parseTurnExtras(src: string): string[] {
    const body = between(src, "{ role: 'user' as const, content: [", '].filter(Boolean)');
    return [...body.matchAll(/^ {12}([a-z]\w*)\b/gm)].map((m) => m[1]).filter((v, i, a) => a.indexOf(v) === i);
}

/** The routes `offersOwnCards` leaves out (besides defaultRoute). */
export function parseNoCardRoutes(src: string): string[] {
    const line = between(src, 'const offersOwnCards =', ';');
    return [...line.matchAll(/ROUTES\.(\w+)/g)].map((m) => m[1]);
}

function functionText(src: string, name: string): string {
    return between(src, `function ${name}(`, '\n}\n');
}

/** A RouteContext with every snapshot present, so prompts render their "you can change it" branches. */
function fullRouteContext(): Parameters<(typeof ROUTES)[string]['buildRolePrompt']>[0] {
    const s = '[snapshot]';
    return {
        assistantName: 'Assistant', jobRole: null, baseSystemPrompt: null, onboardingContext: {},
        business: { name: 'Business', industry: null, description: null },
        knowledgeBase: { articleCount: 1, excerpts: s }, mediaSources: null, inspoBlock: s,
        leadsSnapshot: s, outreachOfferBlock: s, followUpPlanBlock: s, discussionsBlock: s,
        campaignsSnapshot: s, briefsSnapshot: s, taskCosts: resolveTaskCosts([]), videosSnapshot: s,
        mailboxSnapshot: s, siteAuditSnapshot: s, mentorSnapshot: s, siteSnapshot: s,
        attachmentsBlock: s, contentSnapshot: s, audienceSnapshot: s, meetingsSnapshot: s,
    } as Parameters<(typeof ROUTES)[string]['buildRolePrompt']>[0];
}

export function buildChatManifest(): ChatManifest {
    const src = read(ORCH_PATH);
    const uiCards = uiCardTypes();
    const routeFlags = parseRouteFlags(src);
    const noCards = new Set(parseNoCardRoutes(src));
    const rc = fullRouteContext();
    const routes: Record<string, RouteManifest> = {};
    for (const key of Object.keys(ROUTES).sort()) {
        const r = ROUTES[key] as unknown as Record<string, unknown> & (typeof ROUTES)[string];
        const prompt = r.buildRolePrompt(rc);
        routes[key] = {
            flags: routeFlags.filter((f) => r[f] === true),
            contentSnapshot: typeof r.contentSnapshot === 'string' ? r.contentSnapshot : null,
            offersOwnCards: !noCards.has(key),
            maxTokens: r.maxTokens,
            cards: cardsNamedIn(prompt, uiCards),
            craftInChat: promptLayersFor(key).filter((l) => l.kind === 'craft' && prompt.includes(l.text.trim().slice(0, 120))).map((l) => l.key),
        };
    }
    return {
        routes,
        routeFlags,
        promptBlocks: parsePromptBlocks(src),
        turnExtras: parseTurnExtras(src),
        targetCards: {
            draftTargetPromptBlock: cardsNamedIn(functionText(src, 'draftTargetPromptBlock'), uiCards),
            emailTargetPromptBlock: cardsNamedIn(functionText(src, 'emailTargetPromptBlock'), uiCards),
        },
        uiCards,
    };
}

export const manifestText = (m: ChatManifest) => [
    '// src/config/chat-capabilities.generated.ts',
    '// GENERATED by scripts/chat-capabilities-manifest.ts from the chat orchestrator. Do not edit by hand:',
    '// run `npx tsx scripts/chat-capabilities-manifest.ts --write`. tests/assistant-chat-capabilities.test.ts',
    '// fails when this file is out of date. Read by src/utils/assistant-chat-capabilities.ts (FR#17).',
    '',
    `export const GENERATED_CHAT_MANIFEST = ${JSON.stringify(m, null, 4)};`,
    '',
].join('\n');

if (require.main === module) {
    const next = manifestText(buildChatManifest());
    let current = '';
    try { current = read(MANIFEST_PATH); } catch { /* first run */ }
    if (process.argv.includes('--write')) {
        writeFileSync(join(ROOT, MANIFEST_PATH), next);
        console.log(current === next ? `${MANIFEST_PATH} was already up to date.` : `Wrote ${MANIFEST_PATH}.`);
    } else {
        console.log(current === next ? `${MANIFEST_PATH} is up to date.` : `${MANIFEST_PATH} is OUT OF DATE — run with --write.`);
        if (current !== next) process.exitCode = 1;
    }
}
