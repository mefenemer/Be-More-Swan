// The public channels a Slack recipe can post to, for its channel picker (integration-scenarios.ts
// GET /options). The workspace's main channel (Slack's is_general — #general in older workspaces,
// #all-<name> in newer ones) comes first. Capped: a picker of hundreds is not a picker.

export interface SlackChannelOption { value: string; label: string; main: boolean }

export async function listSlackChannels(accessToken: string): Promise<SlackChannelOption[]> {
    const res = await fetch('https://slack.com/api/conversations.list?types=public_channel&exclude_archived=true&limit=200', {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data: { ok?: boolean; error?: string; channels?: Array<{ id: string; name: string; is_general?: boolean }> } = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(`Slack returned ${data.error || res.status} listing channels`);
    return sortSlackChannels(data.channels ?? []);
}

/** Main channel first, then by name. Pure. */
export function sortSlackChannels(channels: Array<{ id: string; name: string; is_general?: boolean }>): SlackChannelOption[] {
    return channels
        .filter((c) => c && c.id && c.name)
        .map((c) => ({ value: c.id, label: `#${c.name}`, main: !!c.is_general }))
        .sort((a, b) => Number(b.main) - Number(a.main) || a.label.localeCompare(b.label))
        .slice(0, 200);
}
