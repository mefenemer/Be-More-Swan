// src/utils/mail-reader/index.ts — the reader for a mailbox's provider (plan §4.1).
// mailbox-sync.ts and mailboxes.ts call this, never graph.ts / gmail.ts directly, so a third provider is
// one more adapter here.

import type { MailChanges } from './types';
import { GraphError, getGraphBodyText, getGraphHeaders, listGraphChanges } from './graph';
import { GmailError, getGmailBodyText, getGmailHeaders, listGmailChanges } from './gmail';

export interface MailReader {
    listChanges(accessToken: string, address: string, cursor: string | null, deadline: number): Promise<MailChanges>;
    getHeaders(accessToken: string, messageId: string): Promise<Record<string, string>>;
    getBody(accessToken: string, messageId: string): Promise<{ text: string; to: string[] }>;
}

const READERS: Record<string, MailReader> = {
    outlook: {
        listChanges: (t, _address, cursor, deadline) => listGraphChanges(t, cursor, deadline),
        getHeaders: getGraphHeaders,
        getBody: getGraphBodyText,
    },
    gmail: {
        listChanges: listGmailChanges,
        getHeaders: getGmailHeaders,
        getBody: getGmailBodyText,
    },
};

/** The reader for a provider, or null for one we can't read. */
export function readerFor(provider: string): MailReader | null {
    return READERS[provider] ?? null;
}

/** An HTTP error from either provider, as a status (and Retry-After). Null for anything else. Pure. */
export function providerHttpError(err: unknown): { status: number; retryAfterSec: number | null } | null {
    if (err instanceof GraphError || err instanceof GmailError) return { status: err.status, retryAfterSec: err.retryAfterSec };
    return null;
}

/**
 * The saved cursor is no longer usable and the 14-day window must be read again. Pure.
 *   Graph: 410 Gone / syncStateNotFound (and 400 on a malformed old link).
 *   Gmail: 404 on history.list — Google keeps history for about a week.
 */
export function cursorExpired(provider: string, status: number): boolean {
    if (provider === 'outlook') return status === 410 || status === 400;
    if (provider === 'gmail') return status === 404;
    return false;
}
