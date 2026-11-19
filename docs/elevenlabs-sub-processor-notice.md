# Notice: ElevenLabs Added as a Sub-Processor

Written 2026-11-19. The owner asked for ElevenLabs to be added to the sub-processor lists, with the
email to workspace owners drafted for review.

## Why it is owed

The DPA (clause 5, `get-dpa-content.ts`) promises workspace owners **14 days' notice** before a new
sub-processor of Customer Personal Data, by email and by updating the Trust page list. ElevenLabs has
handled customer data without being listed:

| Since | What ElevenLabs receives | Commit |
|---|---|---|
| 2 Nov 2026 | Voiceover scripts (text-to-speech) | ddd2ffda |
| 12 Nov 2026 | Audio for word timings: our voiceovers, the customer's uploaded footage, own-voice recordings (Scribe) | b91cc6c4 |
| 12 Nov 2026 | The product tour narration and "Read aloud" samples | openai-audio-retirement-plan.md |

Uploaded footage and voice recordings contain people's voices, so this is personal data. The
notice is late, and the email says so plainly.

## What changes in this PR

- **trust.html:** an ElevenLabs row (US, link to elevenlabs.io/dpa). The OpenAI row loses "product
  tour narration", which moved to ElevenLabs on 12 Nov. It gains what OpenAI still does: one voice
  (the London man) and whisper as the backup when Scribe fails. The dates move to 19 November 2026.
- **privacy.html:** the same rows, kept identical, and the date.
- **faq.html:** "Which AI models power my assistant?" names ElevenLabs.
- **Broadcast `subprocessor_elevenlabs_notice`:** an email and in-app notice, listed in Admin →
  Growth → Broadcast. Nothing sends it until the owner presses Send.

## What the owner decides

1. **Whether to send the email, and when.** The objection window is "14 days from this email", with
   no fixed date, so it stays right whenever it goes out. Press **Test** first, which sends it to
   you only.
2. **Check the ElevenLabs DPA covers our account.** Their DPA (elevenlabs.io/dpa, checked
   2026-11-19) builds in the EEA SCCs and the UK Addendum, and applies wherever ElevenLabs
   processes customer personal data as a processor. It makes **no promise about model training**,
   so our copy makes none either. Check in the ElevenLabs account what applies to us, including any
   data-retention or training setting, before you send.
3. **Recipients:** Broadcast goes to every active user on a running plan, not just owners. That is
   more than the DPA needs, and it does no harm.

## After it is sent

- Answer any objection that reaches privacy@bemoreswan.com within the 14 days (DPA clause 5).
- The fuller register mentioned on the privacy page (privacy@ on request) needs an ElevenLabs line:
  the data it gets, the SCCs + UK Addendum, and the date it was reviewed.
