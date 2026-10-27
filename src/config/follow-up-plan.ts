// src/config/follow-up-plan.ts
// The rules for an editable follow-up plan — the Lead Generator's chasers after a first email.
// docs/lead-outreach-restructure-plan.md, Phase 3.
//
// One validator, three callers: lead-generation.ts `save_follow_up_plan` (the Outreach tab's
// Follow-up plan panel), src/utils/chat-follow-up-plan.ts (the chat's follow_up_plan card), and
// src/utils/outreach-sequences.ts saveSequenceSteps (the only writer of sequence_steps). The panel
// and the card cannot then accept a plan the save would refuse, or the other way round.
//
// ── Why step numbers never change ─────────────────────────────────────────────
// A lead part-way through records how far it got as a step NUMBER (sequence_enrolments.last_step_sent)
// and the worker sends the next enabled step with a HIGHER number. Renumbering under it would re-send
// a step or skip one. So: an edited step keeps its number, a removed step is switched off (its number
// is never reused), and a new step takes the next number up. That is also why reordering is refused —
// it is the one edit that cannot be expressed without renumbering. Same rule as Email Flows
// (newsletter-sequences.ts deleteStep).
//
// Pure: no imports from src/utils, no I/O.

import { MAX_STEPS_PER_ENROLMENT } from './outreach-sequences';

/** The panel's and the card's limits. The step ceiling is the worker's own hard cap. */
export const FOLLOW_UP_LIMITS = {
    maxSteps: MAX_STEPS_PER_ENROLMENT,
    minDelayDays: 1,
    maxDelayDays: 30,
    minBriefChars: 10,
    maxBriefChars: 600,
} as const;

/** One step as the panel and the card send it. `stepNumber` null = a new step. */
export interface FollowUpStepInput {
    stepNumber: number | null;
    delayDays: number;
    brief: string;
}

export interface CleanFollowUpStep {
    stepNumber: number | null;
    delayDays: number;
    brief: string;
}

/**
 * Check and normalise a whole new list of steps against the numbers already used.
 *
 * `usedNumbers` is every step number this plan has EVER had, enabled or not — a removed step's
 * number is not free again. Returns the cleaned list, or the first problem in words a user can act on.
 */
export function validateFollowUpSteps(
    input: unknown,
    usedNumbers: ReadonlyArray<number>,
): { ok: true; steps: CleanFollowUpStep[] } | { ok: false; error: string } {
    if (!Array.isArray(input)) return { ok: false, error: 'The follow-ups have to be a list.' };
    const L = FOLLOW_UP_LIMITS;
    if (input.length < 1) return { ok: false, error: 'Keep at least one follow-up, or switch chasing off instead.' };
    if (input.length > L.maxSteps) return { ok: false, error: `At most ${L.maxSteps} follow-ups — more than that reads as pestering.` };

    const used = new Set(usedNumbers);
    const steps: CleanFollowUpStep[] = [];
    let lastExisting = 0;
    let sawNew = false;
    for (let i = 0; i < input.length; i++) {
        const raw = input[i] as Record<string, unknown> | null;
        const n = i + 1;
        if (!raw || typeof raw !== 'object') return { ok: false, error: `Follow-up ${n} is missing.` };
        const delay = Number(raw.delayDays);
        if (!Number.isInteger(delay) || delay < L.minDelayDays || delay > L.maxDelayDays) {
            return { ok: false, error: `Follow-up ${n}: the wait has to be a whole number of days from ${L.minDelayDays} to ${L.maxDelayDays}.` };
        }
        const brief = typeof raw.brief === 'string' ? raw.brief.replace(/\s+/g, ' ').trim() : '';
        if (brief.length < L.minBriefChars) return { ok: false, error: `Follow-up ${n}: say in a sentence what it should say.` };
        if (brief.length > L.maxBriefChars) return { ok: false, error: `Follow-up ${n}: keep what it should say under ${L.maxBriefChars} characters.` };

        let stepNumber: number | null = null;
        if (raw.stepNumber != null) {
            stepNumber = Number(raw.stepNumber);
            if (!Number.isInteger(stepNumber) || !used.has(stepNumber)) {
                return { ok: false, error: `Follow-up ${n} refers to a step this plan doesn’t have.` };
            }
            // Existing steps keep their order, and new ones go after them — see the header.
            if (sawNew || stepNumber <= lastExisting) {
                return { ok: false, error: 'Follow-ups can’t be reordered yet — remove one and add a new one at the end instead.' };
            }
            lastExisting = stepNumber;
        } else {
            sawNew = true;
        }
        steps.push({ stepNumber, delayDays: delay, brief });
    }
    return { ok: true, steps };
}

/** "3 follow-ups — after 3 days, then 7 more, then 7 more" — the plan in one line. Pure. */
export function describeFollowUpPlan(enabled: boolean, steps: ReadonlyArray<{ delayDays: number }>): string {
    if (!enabled) return 'No follow-ups — approving a lead sends one email only';
    if (!steps.length) return 'No follow-ups';
    const days = (d: number) => `${d} day${d === 1 ? '' : 's'}`;
    const parts = steps.map((s, i) => (i === 0 ? `after ${days(s.delayDays)}` : `then ${days(s.delayDays)} later`));
    return `${steps.length} follow-up${steps.length === 1 ? '' : 's'} — ${parts.join(', ')}`;
}

/**
 * What the worker tells the drafter about the LAST email in the plan, whichever step that is.
 *
 * The setup question promises "the last one always says it is the last". With an editable plan the
 * user may delete the step written as a sign-off, so the promise is kept here in code rather than in
 * a brief anyone can edit.
 */
export const LAST_FOLLOW_UP_RULE = 'THIS IS THE LAST EMAIL IN THE SEQUENCE. Whatever else it does, say plainly that you will not follow up again, and invite them to reply if the timing changes later. No guilt, no false scarcity.';
