<!-- Fill the block with: npx tsx scripts/pr-tier.ts template <pr>   (docs/review-tiers-plan.md) -->

## Summary

---EVIDENCE---
Tier: <run scripts/pr-tier.ts — never chosen by hand>
What changed + why: <2–4 plain sentences>
Root cause: <Confirmed | Guessed | n/a (feature)>
Proof: <test that failed before and passes after | e2e smoke | screenshot>
SQL: <none | additive (files) — staging ✅ | NEEDS OWNER (non-additive)>
Review: <Pass | Pass with notes | Changes needed — reviewer run on <sha> | not needed (low tier)>
Risk if wrong: <who notices and how bad if this is wrong>
Rollback: <revert the PR | SQL down-step | switch off>
---END-EVIDENCE---
