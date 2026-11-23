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
            'Tell them in a way the law allows: in a conversation you are already having (in person, or a call or meeting arranged for something else), in reply when they raise the problem, or by message or email only if they have agreed to hear recommendations from you. Knowing someone, or having them as a client or group member, is not consent to a marketing message (PECR, ePrivacy rules, Partner Terms 5.3). Everyone else hears about it from your public posts.',
            'A personal conversation with 20 well-chosen people usually beats a post seen by 2,000 strangers. Do both, but start with the 20.',
            'Don’t chase people who aren’t a fit (large companies with marketing teams, people who don’t run a business). It wastes your goodwill and their trial.',
        ],
    },
    launch_30_days: {
        title: 'A 30-day launch plan',
        advice: [
            'Week 1: post your personal story (why you use or recommend Be More Swan, and who it’s for). Then tell 5 people from your list of 20 personally — in conversation, or by message only if they have agreed to hear from you.',
            'Week 2: record a 2–3 minute screen-share of your own workspace (or a walk through what it does, from the facts) and share it publicly, with the ad label. Tell 5 more people the same way.',
            'Week 3: email your newsletter subscribers — only people who opted in to hear from you, not people on a list only because they bought from you. One clear reason, one link. Tell 5 more people.',
            'Week 4: run a short live demo or Q&A for your community or clients (30–45 minutes). Send the recording to everyone who registered, and your link only to those who ticked a box at sign-up to hear from you. Tell the last 5.',
            'Every week: check your numbers on the Partner page (visits → sign-ups → paying) and change one thing based on them.',
            'Consistency beats volume: one good post a week for a month does more than five posts in one day.',
        ],
    },
    story_first: {
        title: 'Lead with your own story',
        advice: [
            'Show, don’t sell. "Here’s what changed for my business" is more persuasive than any list of features.',
            'If they have a workspace, my_results gives real counts from their own account (posts published, articles published, leads found), offered as suggestions to check. Use them as what they are — counts of activity, with the time period ("since I joined in [month] I’ve published [number] posts through Be More Swan") — never as business results (sales, customers, followers, revenue, time saved) unless they have their own records to prove it. Call leads found "possible leads the Lead Generator suggested", never customers or sales. Never invent, round up or pick a flattering period.',
            'Make clear it is their own experience and don’t imply it is typical; if a number appears, add "what you get will depend on your business". Only say they use Be More Swan if they use it now.',
            'Structure: the problem you had → what you tried → what you use now and what it does for you → who you think it would help → your link.',
            'A screenshot of their own (real) work beats stock images. They should hide any customer names or private details first.',
            'If they don’t use it themselves yet, be honest: recommend it for what it does (from the facts) and say why you think it suits the reader.',
        ],
    },
    objections: {
        title: 'Answering common worries',
        advice: [
            '"I’m not techy" — the assistants draft and suggest, and the owner decides what goes out (only as bms_facts puts it). Point to the free trial so they can judge for themselves; don’t promise it will be easy for them.',
            '"Is AI writing any good?" — suggest they judge it in the trial. Describe how it works only from bms_facts; don’t say they approve "everything" or that it writes "in their voice" unless bms_facts says so.',
            '"I already use ChatGPT" — the difference is a team of assistants set up for their business rather than a blank chat box; name only the jobs bms_facts lists.',
            '"It’s too expensive" — they can compare it with what they spend on marketing help today, but don’t state savings of time or money for them; quote prices only from bms_facts. The trial and the invite offer lower the risk.',
            '"I don’t have time to set it up" — the trial needs no card, so they can try it when it suits them; don’t promise how long set-up takes.',
            'Never answer a worry with a promise of results, guaranteed income, a feature that isn’t in bms_facts, or a discount, refund, gift or payment of your own (Partner Terms 5.3 and 6.1).',
        ],
    },
    demo_script: {
        title: 'Demo and workshop scripts',
        advice: [
            '10-minute screen-share: start by saying they are a paid partner and earn a commission. 1) the problem (2 min) 2) their own workspace — one assistant drafting something real (5 min) 3) how approval works (1 min) 4) the trial, the invite offer and the link (2 min).',
            'Before sharing their screen or recording: use a demo business or hide client names, contact details, leads and anything private. Read anything an assistant drafts live before presenting it as what Be More Swan does.',
            '45-minute workshop for clients or a community: say at the start, and on the first slide, that they are a paid partner and earn a commission. 10 min on the marketing jobs small businesses never get to; 20 min live demo; 10 min Q&A; 5 min on how to start (trial + invite offer + link). If it is recorded, say so in the invitation and at the start, and let people stay off camera and ask in the chat.',
            'Always end with one clear next step: "Start your free trial with my link — it’s in the chat / description." Answer product, price or refund questions only from bms_facts or send them to Be More Swan; never agree a special deal.',
            'Send the recording afterwards with the ad label at the top; include the link only for people who agreed at registration to hear from them.',
        ],
    },
    dm_and_followup: {
        title: 'Personal messages and follow-up',
        advice: [
            'Write to one person at a time, by name, and only to people who have asked about it or agreed to hear recommendations from you — knowing someone, or having them as a client, is not consent. Marketing messages without consent can break PECR, the EU ePrivacy rules, CAN-SPAM, CASL and the Partner Terms (5.3), and a message asking whether they would like to hear about it counts as marketing too. Start the message with the ad label.',
            'The most natural opening is when someone raises the problem first (in a comment, a conversation or a reply): answer them with a short, labelled recommendation.',
            'Ask, don’t push: in a conversation they started, "Would it help if I showed you what I use?" gets more replies than a link on its own.',
            'Follow up once, 3–5 days later, only if the first message went to someone who asked or agreed, and they haven’t replied. If they say no or ask you to stop, stop. Never add them to a list, send bulk messages, or message people the Lead Generator finds.',
            'If they sign up and tell you, offer a 15-minute call to help them get started — as yourself, not as Be More Swan support. Never ask for their password or log in to their account, and send product, billing or refund questions to Be More Swan.',
        ],
    },
    trial_period: {
        title: 'While people are in the free trial',
        advice: [
            'People who sign up get the free trial and then, through a partner, the invite offer (describe it only from bms_facts). Commission starts when they first pay, so sign-ups with nobody paying usually means they are still in the trial.',
            'The partner never sees who signed up (customers are numbered, never named), and must not try to find out. They can only help people who tell them they are trying it — for example someone who mentioned it, or who came to their workshop.',
            'Useful help: a short "how I set mine up" video, an offer to answer questions, a reminder of what to try first — by message only to people who asked or agreed to hear from them. Not useful: pressure, deadlines that aren’t real, or offering money, gifts or discounts of their own to get them to pay (Partner Terms 5.3).',
        ],
    },
    channels: {
        title: 'Channels: what works where',
        advice: [
            'Everywhere: the ad label goes first, in the content itself — the first line, the start of the caption, on screen or said aloud at the start — and the platform’s paid-partnership setting goes on as well, not instead. Every comment or reply that carries their link or code needs its own label.',
            'LinkedIn: a personal story post, text first, one image or a short video; "#ad" as the first word, link in the post. Turn on LinkedIn’s brand partnership label if their account offers it. Once a week is plenty.',
            'Instagram / Facebook / TikTok: a short video or carousel showing real work; "#ad" at the very start of the caption and, for Reels, Stories and TikToks, also on screen in the first seconds (and on every Story frame with a link), because many people never read the caption. Turn on the paid-partnership or content-disclosure setting. Link in bio or story; a link-in-bio page should say it is a partner link too.',
            'Facebook groups and communities: follow each group’s rules on promotion; answer questions helpfully and share the link only where it’s allowed — and still with the label. Never message group members privately to promote it unless they have asked.',
            'Newsletter: one email, one reason, one link — only to subscribers who opted in to hear from them (not people on a list only because they bought from them). If the whole email is about Be More Swan, mark it as an ad in the subject line too; otherwise label the section at its start. Their name, postal address and unsubscribe stay in every email.',
            'YouTube / podcasts: say it’s a paid partnership at the start (and again in long videos and live streams), show it on screen, tick YouTube’s paid promotion box, and put the label at the top of the description next to the link and code.',
            'Events and workshops: say at the start, and on the first slide, that they are a paid partner; share the code out loud. Send the link afterwards only to people who agreed at sign-up to hear from them.',
            'Paid ads: allowed with the ad label and within the platform’s rules, but never bid on "Be More Swan", close variations or misspellings, or use our name in the ad text or display URL; add "Be More Swan" as a negative keyword.',
            'Personal messages and email to individuals: only to people who asked or agreed to hear from them (see personal messages).',
        ],
    },
    rules: {
        title: 'The rules (Partner Terms v1.3)',
        advice: [
            '5.1 Label every promotion as an ad at the start, before anyone engages: "#ad" first in a post, a line at the top of an email or message, said and shown at the start of a video or live session. A label only at the end, or hidden behind "see more", does not count, and "#affiliate", "#partner" or "#sp" on their own are not enough. Drafts from this assistant already start with a label; keep it there if they edit.',
            '5.1 Write the label in the language of the post (for example "Anzeige" or "Werbung" in German, "Publicité" or "Collaboration commerciale" in French) and also turn on the platform’s paid-partnership or branded-content setting where there is one. The rules of the UK, of the country they are based in and of every country they target all apply (CAP Code, DMCCA 2024, EU Unfair Commercial Practices Directive, FTC Endorsement Guides and its rule on reviews and testimonials).',
            '5.2 Be accurate: no invented features, results, prices, offers, testimonials or endorsements, and never imply they are Be More Swan or speak for us.',
            '5.3 Not allowed: listing the link or code on coupon, voucher, deal or cashback sites, or in browser extensions or forums that apply codes for people they did not introduce; paid ads on any search engine or social platform that bid on "Be More Swan" or close variations, or use it in the ad text or display URL (add it as a negative keyword); domains, social accounts or apps that could be mistaken for ours; paying, rewarding or giving anything to people to sign up beyond our offer (including paying for or discounting their plan themselves); anything misleading, offensive or unlawful.',
            '5.3 Claims about what Be More Swan or its AI can do (features, accuracy, results, data security, compliance) must not go beyond our website, in any language. They may describe their own genuine experience. A translation of our materials must be faithful, add nothing and say it is their translation.',
            '5.3 Marketing emails, texts, DMs and calls need the consent the recipient’s law requires (PECR and UK GDPR, the EU ePrivacy rules, CAN-SPAM, CASL). Knowing someone is not consent. Only email people who opted in to hear from them, or company addresses where the recipient’s law allows it; the "soft opt-in" for their own customers does not cover Be More Swan. Every marketing email shows their name, a postal address, an honest subject line (no false deadlines or urgency) and a working unsubscribe they act on within 10 days.',
            '5.3 No texts or phone calls promoting Be More Swan to anyone in the US or Canada, and no marketing calls to UK numbers on the Telephone Preference Service or Corporate Telephone Preference Service. No bought, rented or scraped lists, and never use people the Lead Generator (or any similar tool) finds to promote Be More Swan — not by email, DM, call or in bulk.',
            '5.4 / 5.5 What they publish is theirs to check, including anything this assistant drafts: read it, make sure it is accurate and still carries the label.',
            '5.5 Never present AI-written testimonials or results as real; label AI-generated or AI-altered images, video or voice of a person as AI-generated where they publish it; never remove an AI label, watermark or metadata we add.',
            '5.6 No reviews or ratings of Be More Swan on review sites, app stores, marketplaces, comparison sites or Google, and never ask or reward anyone else to post one. No fake or bought followers, likes, views or comments, and never present a recommendation as independent, or as a real customer’s experience, if it is not.',
            '5.7 We may check their promotion. If we ask, they tell us where they have promoted Be More Swan within 5 working days, and correct or remove anything we, a regulator, a platform or the public raise within 48 hours.',
            '6.1 They are an independent partner, not our agent: they cannot agree prices, discounts, refunds, warranties or support on our behalf — they point people to our website.',
            '6.2 Our name, logo and materials only as we supply them; removed within 7 days if the partnership ends.',
            '6.3 The people they introduce become Be More Swan customers, not theirs; commission is an introduction fee, not a share in the customer. While a partner, they must not encourage those customers to cancel or move to a competitor.',
            '9.3 Their contacts, subscribers and audience are their own responsibility under UK GDPR (they are an independent controller), and they must never send us personal data about the people they promote to.',
            '3.1 No commission on themselves, accounts they or their business control, existing or past customers, or people someone else introduced first. Questions about a commission must be raised within 60 days of it appearing (or when it should have appeared).',
            '7.5 Staying active: if 6 months go by without a new paying customer through them, we may end the partnership with notice; their Partner page shows the date. On the standard commission period they keep earning on existing customers until each one’s period ends; only on a special period longer than that does commission stop, 3 months after ending. A new paying customer during the notice cancels it.',
            'The full Partner Terms are at /partner-terms.html; if anything here differs, the Terms apply.',
        ],
    },
};
