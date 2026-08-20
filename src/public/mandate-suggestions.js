/**
 * src/config/mandate-suggestions.js
 *
 * Role-specific "Quick Start Suggestions" for the Mandate section of the
 * assistant profile (assistant-detail.html ▸ Profile ▸ Mandate). Mirrors the
 * clickable bottleneck suggestions shown during Social Media Manager onboarding
 * (onboarding-social-media.html) so every assistant — not just social ones —
 * offers one-click prompts that populate the "Your Bottleneck" field.
 *
 * Keyed by roleKey — must match db/seed-catalog.ts verbatim (note: it is
 * tier1_support_agent, with no underscore after "tier"). Unknown or missing
 * roleKeys fall back to the social_media_manager set, matching the fallback in
 * assistant-dashboard-registry.js (legacy assistants are all social).
 *
 * Loaded by:
 *   - workspace.html (alongside the other assistant config scripts)
 *
 * Consumed by:
 *   - assistants.js ▸ _renderMandateSuggestions() — renders the clickable chips
 *     and populates #edit_problem (onboardingContext.problem_statement).
 *
 * Each entry: { title, text } — `title` is the bold label, `text` is applied to
 * the bottleneck field verbatim when the chip is clicked.
 */
(function () {
  'use strict';

  window.MandateSuggestions = {

    social_media_manager: [
      { title: 'The Full Process Bottleneck', text: 'I spend hours every week researching topics, writing captions, finding the right images, and remembering to schedule posts.' },
      { title: 'The Consistency Struggle', text: 'I want to maintain a consistent posting schedule of 3 times a week, but I run out of ideas and forget to post on time.' },
      { title: 'The Multi-Platform Headache', text: 'I waste time taking one core message and rewriting it to fit perfectly across Facebook, Instagram, and LinkedIn.' },
      { title: 'The Cold Start & Growth Grind', text: "I need to rapidly test different value propositions and engage with niche communities to build our initial audience from scratch, but I don't have the bandwidth." },
    ],

    newsletter_editor: [
      { title: 'The Monthly Scramble', text: 'I mean to send a newsletter every month, then the month goes and I send nothing — or something rushed at 11pm that I am not proud of.' },
      { title: 'The List I Never Built', text: 'People ask to hear from us and I write their email on a receipt or lose it in my inbox, so there is no list to send anything to.' },
      { title: 'The Same Email to Everyone', text: 'I send one identical email to my whole list, so regulars get the beginner stuff and new customers get things that assume they already know us.' },
      { title: 'The Unsubscribe Worry', text: 'I am nervous about emailing people at all in case I get it wrong legally, so I end up not emailing anyone.' },
    ],
    blog_writer: [
      { title: 'The Blank-Page Bottleneck', text: 'I know we should be publishing long-form content regularly, but every post means hours of research, drafting and editing that I never find time for.' },
      { title: 'The Inconsistent Cadence', text: 'I want to publish on a steady schedule to build search traffic, but posts come in fits and starts and then dry up for weeks.' },
      { title: 'The Off-Brand Draft', text: 'When I do outsource writing, it comes back sounding generic and nothing like our voice, so I end up rewriting most of it myself.' },
      { title: 'The Publishing Faff', text: 'Even once a post is written, formatting it, adding images and getting it live on our site is a fiddly manual job I keep putting off.' },
    ],

    // Every one of these is about COORDINATION, not production — the pain of running several
    // assistants toward one goal. A suggestion here about writing posts or finding leads would
    // describe the Social Media or Lead Generation assistant, and the user would hire the wrong one.
    campaign_orchestrator: [
      { title: 'The Uncoordinated Push', text: 'When we launch something, the posts, the blog and the outreach all say slightly different things, because I brief each one separately and nothing joins them up.' },
      { title: 'The Objective That Never Lands', text: 'I set a target for the quarter, and then everything my assistants produce is exactly what they would have made anyway — the goal never actually changes the work.' },
      { title: 'The Blind Allocation', text: 'I have no idea whether the effort is going to the thing that is working. By the time I can tell, the month is over and the allowance is spent.' },
      { title: 'The Never-Ending Adjustment', text: 'Something is clearly not landing, but working out which part to change — the message, the audience, the channel — and then re-briefing everyone takes longer than the campaign.' },
    ],

    lead_qualifier: [
      { title: 'The Cold-Lead Time Sink', text: 'I spend hours every week researching inbound leads and manually deciding which ones are actually worth my sales team’s time.' },
      { title: 'The Inconsistent Scoring Problem', text: 'Every lead gets qualified differently depending on who picks it up, so good prospects slip through and weak ones eat up our calendar.' },
      { title: 'The Slow Follow-Up Gap', text: 'By the time I get around to researching and emailing a new lead, they’ve gone cold or bought from a competitor who replied faster.' },
      { title: 'The Personalisation Grind', text: 'I want every outreach email to feel researched and personal, but writing them one by one against our ideal customer profile takes forever.' },
    ],

    accounts_receivable_clerk: [
      { title: 'The Awkward Chase', text: 'I hate sending payment reminders, so I put it off — and unpaid invoices pile up while our cash flow suffers.' },
      { title: 'The Inconsistent Follow-Up', text: 'I forget which invoices are overdue and by how long, so some clients get chased twice and others never get chased at all.' },
      { title: 'The Manual Reconciliation Drag', text: 'I waste time cross-checking our accounting software against who has actually paid before I can send a single reminder.' },
      { title: 'The Escalation Guesswork', text: 'I never know when to send a firmer notice versus a gentle nudge, so overdue accounts drift for weeks without a clear next step.' },
    ],

    crm_enricher: [
      { title: 'The Dirty Database', text: 'Our CRM is full of half-filled records — missing company sizes, job titles and LinkedIn profiles — that make every campaign less effective.' },
      { title: 'The Manual Research Slog', text: 'I spend hours copying company details off the web into contact records instead of doing higher-value work.' },
      { title: 'The Stale-Data Problem', text: 'Contacts change roles and companies grow, but our records never get updated, so we’re always working from out-of-date information.' },
      { title: 'The Segmentation Blocker', text: 'I can’t segment or route leads properly because so many key fields are blank, and filling them by hand is impossible at our volume.' },
    ],

    tier1_support_agent: [
      { title: 'The Repetitive Ticket Flood', text: 'My team answers the same handful of questions — refunds, password resets, shipping times — over and over, all day long.' },
      { title: 'The Slow First Response', text: 'Customers wait hours for a first reply to simple questions, and our response times are hurting our satisfaction scores.' },
      { title: 'The After-Hours Gap', text: 'Tickets stack up overnight and at weekends when no one is online, so customers are left waiting until we’re back at our desks.' },
      { title: 'The Messy Escalation', text: 'When a query does need a human, it gets handed over with no context, so my team has to re-read the whole thread before they can help.' },
    ],

    meeting_note_taker: [
      { title: 'The Lost Action Items', text: 'Great decisions get made in meetings, but nobody writes down who owns what, so half the action items are forgotten by the next day.' },
      { title: 'The Note-Taking Distraction', text: 'I’m so busy scribbling notes that I can’t actually focus on the conversation or contribute properly.' },
      { title: 'The No-Record Meeting', text: 'People who missed the call have no idea what was discussed, and there’s no reliable summary to catch them up.' },
      { title: 'The Follow-Up Black Hole', text: 'Action items live in my notebook and never make it into our project board, so nothing gets tracked or actually gets done.' },
    ],

  };

  /**
   * Suggestions for a roleKey. Unknown/missing keys fall back to the
   * social_media_manager set (legacy assistants are all social), matching
   * assistant-dashboard-registry.js.
   */
  window.MandateSuggestions.get = function (roleKey) {
    return window.MandateSuggestions[roleKey] || window.MandateSuggestions.social_media_manager;
  };

})();
