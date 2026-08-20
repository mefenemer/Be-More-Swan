// src/config/newsletter-merge-vars.ts
// The merge variables a newsletter issue may use — the closed vocabulary shared by the drafting
// prompt, the editor's insert menu, the preview, and the send worker.
//
// ⚠️ ONE LIST, four readers. A model told it may write {{contact.first_name}} while the send worker
// supplies `firstName` produces "Hi ," in every inbox — the classic tell of a broken mailing, and
// invisible until it has already gone out. So the keys, the samples and the fallbacks live here and
// nowhere else.
//
// Personalisation happens at SEND time, in code, against this vocabulary. The model never sees a
// recipient list: 5,000 per-recipient drafts would be 5,000 model calls, would break the approval
// model (a human approved ONE issue, not 5,000 unseen variants) and would make the provenance
// record meaningless.

export interface NewsletterMergeVar {
    /** The path used in {{…}}. Resolved by renderMergeVars against the context below. */
    key: string;
    label: string;
    /** Dummy value for the preview and the test send. */
    sample: string;
    /**
     * What renders when the contact has no value. ⚠️ Never empty for a name: "Hi ," is the
     * single most recognisable sign of a bulk mailing gone wrong.
     */
    fallback: string;
}

export const NEWSLETTER_MERGE_VARS: NewsletterMergeVar[] = [
    { key: 'contact.first_name', label: 'First name', sample: 'Jane',        fallback: 'there' },
    { key: 'contact.last_name',  label: 'Last name',  sample: 'Okafor',      fallback: '' },
    { key: 'contact.company',    label: 'Company',    sample: 'Acme Ltd',    fallback: 'your team' },
    { key: 'contact.email',      label: 'Email',      sample: 'jane@acme.com', fallback: '' },
    { key: 'sender.name',        label: 'Your business name', sample: 'Acme Ltd', fallback: '' },
];

export const NEWSLETTER_MERGE_KEYS = NEWSLETTER_MERGE_VARS.map((v) => v.key);

/** The one merge tag worth showing a model, written with its fallback already in place. */
export const GREETING_EXAMPLE = '{{contact.first_name | "there"}}';

/** Build the send-time context for one recipient. Shape must match the keys above. */
export function contactMergeContext(
    contact: { firstName?: string | null; lastName?: string | null; company?: string | null; email?: string | null },
    senderName: string,
): Record<string, unknown> {
    return {
        contact: {
            first_name: contact.firstName ?? '',
            last_name: contact.lastName ?? '',
            company: contact.company ?? '',
            email: contact.email ?? '',
        },
        sender: { name: senderName ?? '' },
    };
}

/** The same shape, filled with samples — for the editor preview and the test send. */
export function sampleMergeContext(senderName = 'Acme Ltd'): Record<string, unknown> {
    const ctx: Record<string, Record<string, string>> = {};
    for (const v of NEWSLETTER_MERGE_VARS) {
        const [group, field] = v.key.split('.');
        (ctx[group] ||= {})[field] = v.sample;
    }
    ctx.sender = { ...(ctx.sender || {}), name: senderName };
    return ctx;
}

/**
 * Apply the declared fallback to any tag written WITHOUT one.
 *
 * A model (or a person) writing a bare `{{contact.first_name}}` is the common case, and
 * renderMergeVars would resolve it to '' for every contact with no name on file. Rewriting it to
 * `{{contact.first_name | "there"}}` at save time means the fallback is visible in the editor —
 * the author can see what a nameless subscriber will actually read.
 */
export function applyDefaultFallbacks(text: string): string {
    if (!text) return '';
    let out = text;
    for (const v of NEWSLETTER_MERGE_VARS) {
        if (!v.fallback) continue;
        const bare = new RegExp(`\\{\\{\\s*${v.key.replace('.', '\\.')}\\s*\\}\\}`, 'g');
        out = out.replace(bare, `{{${v.key} | "${v.fallback}"}}`);
    }
    return out;
}
