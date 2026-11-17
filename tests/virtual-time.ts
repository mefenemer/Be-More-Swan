// tests/virtual-time.ts
// A virtual clock for tests whose code under test WAITS on real timers (poll intervals, retry
// back-off, hedge delays, call timeouts) while every fetch is faked.
//
// Not a test file — the runner (scripts/run-tests.mjs) globs `*.test.ts`, so this is only imported.
//
// WHY: x-media-failure.test.ts alone spent 60 s of every CI run sleeping through X's 3 s video
// polls. Nothing was being exercised in those 60 s — the fake fetch had already answered.
//
// HOW: setTimeout/clearTimeout are replaced by a queue ordered by due time. Whenever the program
// goes idle (nothing left but timers), the earliest timer fires and Date.now() jumps to its due
// time. Timers still fire IN ORDER and Date.now() still moves by the same amounts, so races
// (image-hedge: which model finishes first, when the hedge starts) resolve exactly as they would in
// real time — just without the waiting.
//
// ONLY for tests where all I/O is faked: real network or disk I/O would see time leap ahead of it.
// `new Date()` with no argument and AbortSignal.timeout() still use the real clock.

type Timer = { at: number; seq: number; fn: (...a: unknown[]) => void; args: unknown[] };

let installed = false;

export function useVirtualTime(): void {
    if (installed) return;
    installed = true;

    const realSetImmediate = globalThis.setImmediate;
    let now = Date.now();
    let seq = 0;
    const timers = new Map<number, Timer>();
    let pumpScheduled = false;

    // "Idle" = a few macrotask turns pass with nothing new happening. One turn is enough for promise
    // chains over faked fetch Responses; three is a margin for body streams that hop a turn or two.
    const IDLE_TURNS = 3;
    function schedulePump(turnsLeft = IDLE_TURNS): void {
        if (pumpScheduled && turnsLeft === IDLE_TURNS) return;
        pumpScheduled = true;
        realSetImmediate(() => {
            if (turnsLeft > 1) { schedulePump(turnsLeft - 1); return; }
            pumpScheduled = false;
            fireEarliest();
        });
    }

    function fireEarliest(): void {
        let nextId = -1;
        let next: Timer | undefined;
        for (const [id, t] of timers) {
            if (!next || t.at < next.at || (t.at === next.at && t.seq < next.seq)) { next = t; nextId = id; }
        }
        if (!next) return;
        timers.delete(nextId);
        if (next.at > now) now = next.at;
        try { next.fn(...next.args); } finally { if (timers.size) schedulePump(); }
    }

    // Handles behave like Node's Timeout enough for code that calls unref()/ref() or coerces to a number.
    function handle(id: number) {
        return {
            id,
            unref() { return this; },
            ref() { return this; },
            hasRef() { return true; },
            refresh() { return this; },
            [Symbol.toPrimitive]() { return id; },
        };
    }

    globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        const id = ++seq;
        timers.set(id, { at: now + Math.max(0, Number(ms) || 0), seq: id, fn, args });
        schedulePump();
        return handle(id);
    }) as unknown as typeof setTimeout;

    globalThis.clearTimeout = ((h?: unknown) => {
        if (h == null) return;
        timers.delete(typeof h === 'object' ? (h as { id: number }).id : Number(h));
    }) as typeof clearTimeout;

    Date.now = () => now;
}
