# Note Taker launch notices: DRAFTS (25 November 2026, revised after the legal review)

Three messages for you to send. ⟨L⟩ = launch day: **Fri 27 November 2026** on the fast route, or **Wed 9 December 2026** on the fully clean route. Charging starts **Fri 1 January 2027** on both. The legal review suggested 1 January rather than 25 December: the allowance resets on the 1st, and it avoids Christmas Day.

Changed from the drafts in `docs/note-taker-bot-legal.md` §7:
- **Zoom removed.** Zoom isn't available until our Zoom app is approved.
- **Cost key corrected** to `meeting_bot_call`. The legal doc and the review both say `meeting_bot_per_5_min`, which is wrong.
- **Charge wording updated:** the bot isn't charged for the time it waits after everyone has left (PR #809).
- **AssemblyAI wording made exact.** It now matches what Recall actually said, not a "within 3 days at most" guarantee.
- **Recall's 48-hour deletion added** (PR #836).
- **The "Your choice" paragraph now depends on the route.**

---

## 1. Charge announcement (Admin → Money → Task costs): send TODAY

**Change:** `meeting_bot_call`, from 0 to **1**, starting **1 January 2027**.

**"Why" text** (customers see it in the email and in the app):

> The Note Taker can now join your Google Meet and Microsoft Teams calls and take the notes itself, even on free Meet and Teams accounts, which make no transcript of their own. It is free to use until 1 January 2027. From then, each meeting it joins uses 1 task for each started 5 minutes it is in the call with you, so a 1-hour meeting is 12 tasks. Nothing is charged if it isn't let in, or for the time it waits after everyone has left. Pasting notes or a transcript stays free.

⚠️ Send this only once ⟨L⟩ is fixed, because it says the Note Taker "can now join". If ⟨L⟩ is 9 December, change the first sentence to "From 9 December, the Note Taker can join…".

---

## 2. Sub-processor email (to every workspace owner): send TODAY

**Subject:** A new sub-processor for the Note Taker: Recall.ai

> Hello,
>
> Our Data Processing Agreement promises to tell you about new sub-processors, so here it is: from ⟨L⟩ we will use **Recall.ai** for the Note Taker's meeting feature.
>
> **What it does.** When you send your Note Taker to a Google Meet or Microsoft Teams call, Recall.ai's bot joins the call and records it only to make the transcript, which we turn into minutes for you to approve. Recall.ai uses its own sub-processor, **AssemblyAI**, to turn the audio into text. AssemblyAI deletes the audio once it has made the text; if that deletion fails, the audio and text are deleted within 3 days. AssemblyAI may keep limited billing and technical log records. We delete the recording at Recall.ai as soon as we have saved the transcript, and Recall.ai deletes anything left after 48 hours.
>
> **Where.** For UK and EU workspaces, recordings and transcripts are made and stored in the EU (Frankfurt); for US workspaces, in the US. Recall.ai's support staff in the US may access data when they need to, to support or fix the service, under the standard contractual clauses and UK Addendum in Recall.ai's data processing agreement.
>
> ⟨YOUR CHOICE paragraph, one of the two below⟩
>
> The full list of sub-processors is on our Trust page: bemoreswan.com/trust.html#sub-processors
>
> The Be More Swan team

**Your choice: fast route (⟨L⟩ = 27 November)**

> **Your choice.** Nothing changes for your workspace unless an owner or admin accepts version 1.2 of our Data Processing Agreement, which names Recall.ai and AssemblyAI, and someone sends the Note Taker to a meeting. If you have accepted and change your mind, stop sending it, or ask us at privacy@bemoreswan.com and we will switch the Note Taker's meeting feature off for your workspace.

**Your choice: clean route (⟨L⟩ = 9 December)**

> **If you object.** Reply to this email before 9 December 2026. If we can't resolve your concern, you can choose not to use the Note Taker's meeting feature, or end your subscription without an early-termination charge (clause 5 of our Data Processing Agreement). Nothing reaches Recall.ai unless you send the Note Taker to a meeting.

---

## 3. Questions for Recall (to hello@recall.ai): send TODAY

The review rates the first question **High**. On the fast route, the bot isn't switched on until Recall answers it.

**Subject:** Two data-protection questions before we launch (EU + US workspaces)

> Hello,
>
> Thank you for your answers on 24 November. Before we launch, we have two more questions:
>
> 1. **Model training.** Do Recall.ai or AssemblyAI use our customers' meeting audio, recordings or transcripts to train or improve any models, and does this differ between the EU (eu-central-1) and US workspaces? If any such use is possible, how do we opt out contractually?
> 2. **Breach notification.** How long after becoming aware of a personal data breach affecting our data will Recall.ai notify us? Our own agreement with our customers promises notice within 48 hours.
>
> Also, can you confirm that speaker labels in `recallai_streaming` transcripts come from the meeting platform's participant names, with no voice-based speaker identification?
>
> Many thanks,
> ⟨your name⟩, Be More Swan

---

## Still to fix in `docs/note-taker-bot-legal.md` (in the launch PR)

- **§1:** the cost key should be `meeting_bot_call`, and the charge date 1 January 2027.
- **§2 Trust row:** drop Zoom; use the exact AssemblyAI wording above; add the 48-hour deletion.
- **§4 DPA 1.2:** add the clause 5 paragraph that names Recall.ai and AssemblyAI as specifically authorised.
- **§5 Terms 2.5:** clause 5.2 adds "(a 1-hour meeting is 12 tasks; before 1 January 2027, no tasks)".
