// src/lib/triggers/types.ts
// The one shape every buying-trigger source produces (docs/buying-triggers-plan.md §3).
//
// A trigger is "something happened to a business on a given day", read from a public register. Its
// wording is fixed and written by CODE (each adapter's `label`), never by a model, so a "why now" line
// can never claim more than the register said.

export type TriggerKind = 'food_premises_registered';
export type TriggerSourceKey = 'fsa_fhrs';
export type TriggerSubjectType = 'ch_number' | 'fhrs_id' | 'domain' | 'place_id' | 'us_entity';
/** positive = a reason to get in touch; neutral = news; negative = a warning (e.g. liquidation). */
export type TriggerDirection = 'positive' | 'neutral' | 'negative';

export interface TriggerEvent {
    kind: TriggerKind;
    source: TriggerSourceKey;
    /** Unique within the source — the FSA's FHRSID for the FSA. */
    sourceEventId: string;
    country: 'GB' | 'US';
    subjectType: TriggerSubjectType;
    subjectId: string;
    name: string | null;
    postcode: string | null;
    area: string | null;
    tradeCodes: string[];
    /** YYYY-MM-DD — the day it happened, or (for a diffed list) the day we first saw it. */
    occurredOn: string;
    payload: Record<string, unknown>;
}

export interface TriggerLabel {
    text: string;
    direction: TriggerDirection;
}
