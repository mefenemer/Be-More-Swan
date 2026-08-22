// src/config/sender-identity.ts
// WHO the outreach is from, in ONE place.
//
// ⚠️ Every drafting prompt in the Lead Generator opened with the same line:
//
//     You write ... for "${assistant.name}", a business using Be More Swan
//
// which told the model two things, neither of them the sender's identity. `assistant.name` is the
// name of the ASSISTANT ("Lead Generator", "Sales Assistant") — a piece of workspace furniture the
// prospect has never heard of — and "Be More Swan" is the PLATFORM. So the only proper noun in the
// whole system prompt that looked like a company was ours, and the model signed off with it:
// approved drafts for a Restorative Futures campaign went out signed "Be More Swan". That is not a
// brand string to grep for (see the rebrand audit) — the string was never wrong, it was simply the
// only name on offer. The fix is to give the model the real one.
//
// The sender's actual business identity already exists, on the `organisations` row: `name`,
// `businessDescription`, `industry` and `websiteUrl`, captured on the Business Information page.
// The compliance footer has always used `organisations.name` (src/config/outreach-footer.ts), which
// is why a wrongly-signed email still footed "This message was sent by Restorative Futures." — the
// body and the footer were reading different sources for the same fact.
//
// This module renders that identity as prompt text. Loading it lives in
// src/utils/sender-identity.ts — the same split as icp-profile.ts / icp-snapshot.ts: config renders,
// utils reads the DB.

/**
 * The sender's own business, as the prospect should perceive it. Every field except `businessName`
 * is optional because the Business Information page does not require them.
 */
export interface SenderIdentity {
    /** `organisations.name`. Blank when the org row has never been named. */
    businessName: string;
    businessDescription?: string | null;
    industry?: string | null;
    websiteUrl?: string | null;
}

/**
 * Render the sender's identity for a prompt that writes prospect-facing prose.
 *
 * ⚠️ The no-name branch does NOT fall back to the assistant name, the platform, or a placeholder.
 * A borrowed name is worse than no name: "the sender" in a draft is an obvious blank for a reviewer
 * to fill, whereas a confident sign-off under the wrong company reads as finished work and ships.
 * That is exactly how the original bug reached approved drafts.
 */
export function senderIdentityBlock(sender: SenderIdentity): string {
    const name = (sender.businessName || '').trim();
    const lines: string[] = [];

    if (name) {
        lines.push(`You are writing on behalf of ${name}. Every email here comes FROM ${name} — sign off as ${name} and no one else.`);
    } else {
        lines.push('The sender business has not been named in this workspace. Do NOT guess a name, do NOT borrow one from anywhere in these instructions, and do NOT invent a sign-off — end the email with the sender\'s first name only, or with no company name at all.');
    }

    const description = (sender.businessDescription || '').trim();
    if (description) lines.push(`What ${name || 'they'} do: ${description}`);

    const industry = (sender.industry || '').trim();
    if (industry) lines.push(`Their industry: ${industry}`);

    const website = (sender.websiteUrl || '').trim();
    if (website) lines.push(`Their website: ${website}`);

    return lines.join('\n');
}

/**
 * The rule that makes the block above bite.
 *
 * Stated as a prohibition and not just an instruction to sign off correctly, because the failure
 * was not the model ignoring a sign-off rule — there wasn't one — it was the model reaching for the
 * only company name it could see. Naming the two names it must never use closes that off directly.
 */
export const SENDER_IDENTITY_RULE =
    'NEVER mention Be More Swan, this platform, an AI assistant, or the name of the assistant producing this email in anything the prospect will read — not in the subject, the body, or the sign-off. The prospect has no relationship with any of them, and a sign-off carrying a name the sender does not trade under makes a genuine email look like it came from a stranger. The only business you may name as the sender is the one identified above.';
