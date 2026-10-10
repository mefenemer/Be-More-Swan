// src/constants/special-category-rule.ts
// The special-category refusal every assistant follows — in the prompts that actually run.
//
// Until 2026-10-10 nothing any live assistant ran refused special-category personal data (UK GDPR
// Article 9). The go-live check read a master prompt version that live assistants never use (it is a
// fallback the drafting prompt withholds), and src/utils/prompt-sanitiser.ts — a regex filter — was
// never wired, rightly: it blocks any message containing "depression" or "medication" and treats any
// 13-digit number as a card, so a pharmacy or a mental-health charity could not use their assistant.
//
// So the safeguard is an instruction, worded about INFORMATION ON IDENTIFIABLE PEOPLE — not topics. A
// health-food shop writes about health; a church writes about faith; neither is affected.
//
// Injected where the Products & Services block is, i.e. every prompt that writes or chats:
//   chat (every role + handoff)   netlify/functions/chat-orchestrator.ts buildSystemPrompt
//   social drafting               netlify/functions/process-content-jobs.ts
//   articles                      src/utils/blog-generate.ts
//   emails + email campaigns      src/utils/newsletter-generate.ts (×2), src/utils/newsletter-campaign-generate.ts
//   lead outreach (4 prompts)     src/config/sender-identity.ts senderIdentityBlock
// tests/special-category-rule.test.ts fails if a seam stops carrying it; the go-live check
// (src/utils/assistant-go-live.ts) passes for a built role BECAUSE of that test.

export const SPECIAL_CATEGORY_RULE = `<special_category_data>
Never ask for, infer, record, repeat or act on special-category personal data about an identifiable person: their health (physical or mental), racial or ethnic origin, political opinions, religious or philosophical beliefs, trade-union membership, genetic or biometric data, sex life or sexual orientation. This covers customers, leads, subscribers, staff and anyone else named or identifiable.
- If someone shares it, do not use it, store it or build on it. Say briefly that you can't use that kind of personal information, and carry on with the task without it.
- Never guess these things about a person (for example from a name, a photo or where they live), and never target or personalise content on them.
- This is about information on PEOPLE, not subjects. Writing about health, faith, politics or identity as topics — for a pharmacy, a church, a campaign group or a charity — is fine, as long as no identifiable person's special-category data is used.
</special_category_data>`;
