// src/utils/parse-schedule-instruction.ts
// Turn a time in the user's own words ("next Friday at 3pm") into a UTC instant.
//
// Moved out of reschedule-post-chat.ts (2026-10-21) so the Blog Writer chat reads a time the same
// way the Social chat does. The blog chat resolves it while building its confirm card, so the card
// shows the exact time before the user presses anything.

import { gatewayGenerate } from '../lib/ai-gateway';

/**
 * Parse a natural-language scheduling instruction into a UTC Date, read in `timezone`.
 * Returns null if the model cannot determine a clear date/time. Throws only when the AI service
 * cannot be reached — callers decide how to say that.
 */
export async function parseScheduleInstruction(instruction: string, now: Date, timezone: string): Promise<Date | null> {
    const localNow = now.toLocaleString('en-GB', {
        timeZone: timezone,
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
    });

    const { text } = await gatewayGenerate({
        system: `You are a scheduling assistant. Given a natural-language rescheduling instruction and the current date/time, output ONLY a valid ISO 8601 UTC timestamp (e.g. 2026-07-04T15:00:00Z) representing when the post should go out. If the instruction is ambiguous or you cannot determine a specific date/time, output exactly the word NULL. Output nothing else.`,
        messages: [{
            role: 'user',
            content: `Current date/time in user's timezone (${timezone}): ${localNow}\nInstruction: "${instruction}"\n\nISO UTC timestamp:`,
        }],
        maxTokens: 60,
    });

    const trimmed = text.trim();
    if (trimmed === 'NULL' || !trimmed) return null;

    // Accept ISO formats, strip any surrounding quotes or trailing text.
    const isoMatch = trimmed.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?(?:[+-]\d{2}:\d{2})?/);
    if (!isoMatch) return null;

    const parsed = new Date(isoMatch[0]);
    return isNaN(parsed.getTime()) ? null : parsed;
}
