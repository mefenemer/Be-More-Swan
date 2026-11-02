// src/config/dated-switch.ts — an env switch that can be set ahead of the day it takes effect.
//
// A change the terms say needs notice (clause 5.2 / 20.2) has a start date in that notice. Setting
// the env var to the date lets it be set in Netlify the day the notice goes out, and it turns on by
// itself — nobody has to remember to flip it, and nobody can flip it early by accident.
//
//   'on'          → on now
//   'YYYY-MM-DD'  → on from 00:00 UTC that day (UK midnight in winter, 01:00 in summer)
//   anything else → off

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function switchedOn(value: string | undefined, now: Date = new Date()): boolean {
    const v = (value ?? '').trim();
    if (v === 'on') return true;
    if (!DATE_ONLY.test(v)) return false;
    const from = Date.parse(`${v}T00:00:00Z`);
    return Number.isFinite(from) && now.getTime() >= from;
}
