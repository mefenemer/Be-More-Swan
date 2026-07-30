// src/utils/blueprint-prompt.ts
// Renders compiled blueprint sections into the system prompt a drafting model sees.
//
// ONE renderer, because there are two callers — the real drafting worker
// (process-content-jobs.ts) and the admin smoke test (admin-test-generate-background.ts) — and an
// admin test that assembles its prompt differently from production is worse than no test: it
// reports on a prompt no customer ever gets. The two had already drifted; the admin copy carried
// no withholding rules whatsoever and was dumping the disclosure strings that production learned
// to hide after prod shipped a post with three of them.

import { AURA_SAFE_CONTENT_BENCHMARK } from '../constants/safety-benchmark';

/** Keys withheld from the prompt wherever they appear. */
export const PROMPT_KEY_BLOCKLIST = new Set([
    // The literal disclosure text. Code appends the resolved footer AFTER generation, so showing
    // the model the string only teaches it to write a second copy into the caption body.
    'disclosureText', 'orgFooterText', 'orgFooterEnabled',
    // Section 2's brief, compiled at HIRE TIME and never rebuilt. Every fact in it is also carried
    // live by sections 3/4/5/6/7, so dumping it put a frozen copy of the user's audience, tone,
    // platforms and guardrails beside the current ones and left the model unable to tell which was
    // true. It also ends with the platform's own approval-protocol paragraph ("…managed exclusively
    // through your Be More Swan Workspace"), which has no place in copy written for the CLIENT's
    // brand. Section 2's `workflowText` is sourced live and still rendered.
    'systemPrompt',
]);

/** Sections withheld wholesale — header included, so no empty heading implies missing content. */
export const PROMPT_SECTION_BLOCKLIST = new Set([
    // Plan name, monthly price, task/token limits, usage counters. A model given a price is a model
    // that can put that price in a caption, and nothing downstream would catch it.
    '8-plan',
    // maxLlmCalls / maxToolCalls / maxCostGbp. Real budgets, no meaning to a copywriter.
    '10-execution',
]);

/**
 * The compiled brief ends with a full copy of the safety benchmark (compileServerSideBrief appends
 * it at onboarding), and the caller appends the canonical copy itself. Stripped from ANY rendered
 * string: the benchmark has exactly one correct position in the prompt, and it is the end.
 */
function withoutBenchmark(s: string): string {
    return s.includes(AURA_SAFE_CONTENT_BENCHMARK)
        ? s.split(AURA_SAFE_CONTENT_BENCHMARK).join('').trimEnd()
        : s;
}

export interface BlueprintSection { content?: Record<string, unknown> | null }

/**
 * Sections that carry a ready-written `directive` string and must be emitted VERBATIM rather than
 * flattened to `field: value` lines.
 *
 * Section 12 (goals) is the case this exists for. Its content holds both the structured goal data
 * (for the UI and for tests) and a `directive` string built by renderGoalDirective() — prose that
 * has been deliberately worded to steer without overriding guardrails. The generic flattener would
 * emit the prose AND `goals: [{"metricKey":"instagram_followers",...}]` beside it, so the model
 * would read the same targets twice in two formats, one of them raw JSON. Emitting the directive
 * alone keeps exactly one authoritative statement of the goal in the prompt.
 */
const VERBATIM_DIRECTIVE_SECTIONS = new Set(['12-goals']);

/**
 * Render sections as `--- KEY ---` blocks of `field: value` lines.
 *
 * Returns the body only — callers add their own preamble and append the safety benchmark, so the
 * benchmark stays under the caller's control while the withholding rules stay under this file's.
 */
export function renderBlueprintPrompt(sections: Record<string, BlueprintSection>): string {
    let out = '';
    for (const [key, sec] of Object.entries(sections || {})) {
        if (PROMPT_SECTION_BLOCKLIST.has(key)) continue;

        if (VERBATIM_DIRECTIVE_SECTIONS.has(key)) {
            const directive = sec?.content?.directive;
            // An empty section (no active goals) emits nothing at all — not even a header, which
            // would otherwise read to the model as "goals exist but are unknown".
            if (typeof directive === 'string' && directive.trim()) {
                out += `\n--- ${key.toUpperCase()} ---\n${withoutBenchmark(directive.trim())}\n`;
            }
            continue;
        }

        out += `\n--- ${key.toUpperCase()} ---\n`;
        for (const [k, v] of Object.entries(sec?.content || {})) {
            if (v == null) continue;
            if (PROMPT_KEY_BLOCKLIST.has(k)) continue;
            out += `${k}: ${typeof v === 'object' ? JSON.stringify(v) : withoutBenchmark(String(v))}\n`;
        }
    }
    return out;
}
