// src/config/partner-playbook.ts
// The Partner Assistant's know-how (docs/partner-onboarding-plan.md §3.1): how to recommend Be More Swan
// well, not just what to write. partner-assistant.ts serves one topic at a time through the
// `partner_playbook` tool.
//
// ⚠️ This is ADVICE ABOUT PROMOTING, not facts about the product. It must never state a feature,
// integration, result, price or offer — those come ONLY from `bms_facts` (memory public-copy-claims-vs-system).
// The `rules` topic mirrors Partner Terms v1.3; if the Terms change, change it too. Owner decision D8:
// the owner reads this file, and the affiliate-legal-counsel agent checks `rules` and `channels`.

export const PLAYBOOK_TOPICS = [
    'who_to_tell', 'launch_30_days', 'story_first', 'objections', 'demo_script',
    'dm_and_followup', 'trial_period', 'channels', 'rules',
] as const;
export type PlaybookTopic = typeof PLAYBOOK_TOPICS[number];

export const PARTNER_PLAYBOOK: Record<PlaybookTopic, { title: string; advice: string[] }> = {
    who_to_tell: {
        title: 'Who to tell first',
        advice: [
            'The best people are small business owners who already know and trust you, and who do their own marketing because there is nobody else to do it: solo owners, small teams, your own clients, members of a community you run.',
            'Pick your first 20 by name before you post anything. Go through your clients, your contacts and your groups, and write down the people who have said "I never have time for social media / blogging / follow-ups".',
            'A personal message to 20 well-chosen people usually beats a post seen by 2,000 strangers. Do both, but start with the 20.',
            'Don’t chase people who aren’t a fit (large companies with marketing teams, people who don’t run a business). It wastes your goodwill and their trial.',
        ],
    },
    launch_30_days: {
        title: 'A 30-day launch plan',
        advice: [
            'Week 1: post your personal story (why you use or recommend Be More Swan, and who it’s for). Then send a personal message to 5 people from your list of 20.',
            'Week 2: record a 2–3 minute screen-share of your own workspace (or a walk through what it does, from the facts) and share it. Message 5 more people.',
            'Week 3: email your newsletter subscribers (only people who agreed to hear from you). One clear reason, one link. Message 5 more people.',
            'Week 4: run a short live demo or Q&A for your community or clients (30–45 minutes), then send the recording and your link to everyone who registered. Message the last 5.',
            'Every week: check your numbers on the Partner page (visits → sign-ups → paying) and change one thing based on them.',
            'Consistency beats volume: one good post a week for a month does more than five posts in one day.',
        ],
    },
    story_first: {
        title: 'Lead with your own story',
        advice: [
            'Show, don’t sell. "Here’s what changed for my business" is more persuasive than any list of features.',
            'If they have a workspace, use my_results for real numbers from their own account (posts published, articles, leads found) — and say these are suggestions for them to check. Never invent or round up a number.',
            'Structure: the problem you had → what you tried → what you use now and what it does for you → who you think it would help → your link.',
            'A screenshot of their own (real) work beats stock images. They should hide any customer names or private details first.',
            'If they don’t use it themselves yet, be honest: recommend it for what it does (from the facts) and say why you think it suits the reader.',
        ],
    },
    objections: {
        title: 'Answering common worries',
        advice: [
            '"I’m not techy" — the assistants draft and suggest, and the owner approves; they don’t need to learn a complex tool. Point to the free trial so they can see for themselves.',
            '"Is AI writing any good?" — they stay in control and approve everything; it writes in their voice from their own business information. Suggest they judge it in the trial.',
            '"I already use ChatGPT" — the difference is a team of assistants set up for their business that draft, schedule and follow up, rather than a blank chat box. Only describe what bms_facts says.',
            '"It’s too expensive" — compare it with what they pay (in time or money) for marketing help today; quote prices only from bms_facts. The trial and the invite offer lower the risk.',
            '"I don’t have time to set it up" — the trial needs no card; suggest they block 30 minutes to try it.',
            'Never answer a worry with a promise of results, guaranteed income or a feature that isn’t in bms_facts.',
        ],
    },
    demo_script: {
        title: 'Demo and workshop scripts',
        advice: [
            '10-minute screen-share: 1) the problem (2 min) 2) their own workspace — one assistant drafting something real (5 min) 3) how approval works (1 min) 4) the trial, the invite offer and the link (2 min).',
            '45-minute workshop for clients or a community: 10 min on the marketing jobs small businesses never get to; 20 min live demo; 10 min Q&A; 5 min on how to start (trial + invite offer + link). Say at the start that they are a paid partner.',
            'Always end with one clear next step: "Start your free trial with my link — it’s in the chat / description."',
            'Send the recording afterwards with the link and the ad label.',
        ],
    },
    dm_and_followup: {
        title: 'Personal messages and follow-up',
        advice: [
            'Write to one person at a time, by name — people they already know, or who have agreed to hear from them — about something they know about that person’s business. Mention they’re a partner (the ad label) in the message itself. Marketing messages to strangers can break PECR / CAN-SPAM and the Partner Terms (5.3).',
            'Ask, don’t push: "Would it help if I showed you what I use?" gets more replies than a link on its own.',
            'Follow up once, 3–5 days later, if they haven’t replied. Then stop. Never add them to a list or send bulk messages.',
            'If they sign up, offer a 15-minute call to help them get started — people who are helped in the first days are far more likely to keep going after the trial.',
        ],
    },
    trial_period: {
        title: 'While people are in the free trial',
        advice: [
            'People who sign up get the free trial and then, through a partner, their first paid month free (exact terms in bms_facts). Commission starts when they first pay, so sign-ups with nobody paying usually means they are still in the trial.',
            'The partner never sees who signed up (customers are numbered, never named). They can only help people they already know are trying it — for example someone who told them, or who came to their workshop.',
            'Useful help: a short "how I set mine up" video, an offer to answer questions, a reminder of what to try first. Not useful: pressure.',
        ],
    },
    channels: {
        title: 'Channels: what works where',
        advice: [
            'LinkedIn: a personal story post, text first, one image or a short video; link in the post with the ad label at the top. Once a week is plenty.',
            'Instagram / Facebook: a short video or carousel showing real work; label it as an ad at the start of the caption (and use the platform’s paid-partnership label where it has one); link in bio or story.',
            'Facebook groups and communities: follow each group’s rules on promotion; answer questions helpfully and share the link only where it’s allowed.',
            'Newsletter: one email, one reason, one link — only to subscribers who agreed to hear from them.',
            'YouTube / podcasts: say it’s a paid partnership at the start; link and code in the description.',
            'Events and workshops: say you’re a partner when you recommend it; share your code out loud — it’s easier than a link.',
        ],
    },
    rules: {
        title: 'The rules (Partner Terms v1.3)',
        advice: [
            '5.1 Label every promotion as an ad, at the start, where people see it before engaging (CAP Code, DMCCA 2024, FTC). Drafts from this assistant already do; keep the label if they edit.',
            '5.2 Be accurate: no invented features, results, prices, offers, testimonials or endorsements, and never imply they are Be More Swan or speak for us.',
            '5.3 Not allowed: listing the link or code on coupon, voucher, deal or cashback sites or code-applying extensions; paid ads that bid on "Be More Swan" (add it as a negative keyword); domains, social accounts or apps that could be mistaken for ours; marketing emails, texts, DMs or calls without the consent the law requires (PECR, UK GDPR, CAN-SPAM, CASL); paying or rewarding people to sign up beyond our offer; describing what our AI can do beyond what is on our website.',
            'Never bulk-message, or add to a list, the people the Lead Generator finds — personal contact only.',
            '5.3 No texts or phone calls promoting Be More Swan to anyone in the US or Canada; every marketing email shows their name, a postal address, an honest subject line and a working unsubscribe.',
            '5.6 No reviews or ratings of Be More Swan on review sites, app stores or Google (they are paid), and no fake or bought followers, likes or comments.',
            '5.1 Write the ad label in the language of the post (e.g. "Anzeige" in German, "Publicité" in French) and turn on the platform\u2019s paid-partnership setting where there is one.',
            '3.1 No commission on themselves, accounts they or their business control, existing or past customers, or people someone else introduced first.',
            '6.3 The people they introduce become Be More Swan customers, not theirs; commission is an introduction fee, not a share in the customer.',
            '7.5 Staying active: if 6 months go by without a new paying customer through them, we may end the partnership with notice. On the standard commission period they keep earning on existing customers until each one’s period ends; only on a special period longer than that does commission stop, 3 months after ending. A new paying customer during the notice cancels it.',
            '5.4 / 5.5 What they publish is theirs to check, including anything this assistant drafts: read it, make sure it is accurate and still carries the label.',
            'The full Partner Terms are at /partner-terms.html.',
        ],
    },
};
