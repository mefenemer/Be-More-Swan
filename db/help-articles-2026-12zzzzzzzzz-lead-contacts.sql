-- db/help-articles-2026-12zzzzzzzzz-lead-contacts.sql — Help Centre: how a search finds who to write to (2026-10-27).
--
-- Sorts after db/help-articles-2026-12zzzzzzzz-business-mentor.sql. Rewrites ONE live article,
-- 'Why Can''t This Lead Be Emailed?', which still described the old two-step lookup (website, then a
-- paid lookup for hot and warm leads only) and the old tab name. Same title, so ON CONFLICT updates
-- it in place — no rename, no second published copy.
--
-- Written from the code, not the plan (docs/lead-search-one-pass-plan.md):
--   order: website → Companies House → Hunter Email Finder → Hunter Domain Search
--                                       — src/utils/lead-enrichment.ts runContactWaterfall
--   who is chosen, and never a guess with several directors — src/config/lead-person.ts pickLeadPerson
--   Companies House match rules — src/lib/companies-house.ts chooseCompany
--   paid steps only for companies the scorer called a business you could sell to
--                                       — process-discovery-jobs.ts enrichBatch (isPaidEnrichEligible)
--   role inbox stays the send address, own address shown beside it — runContactWaterfall
--   Contact section wording — src/components/assistant-data-hub.js leadDetailLayout
--   chip names — CONTACT_CHIP in the same file
--
-- Same rules as the other help files: body dollar-quoted, title single-quoted with '' for the
-- apostrophe, NO semicolons inside the body. Apply staging first, and on prod only once
-- COMPANIES_HOUSE_API_KEY is set there (until then the Companies House step is skipped):
--   node scripts/db-migrate.mjs apply --only help-articles-2026-12zzzzzzzzz-lead-contacts --execute --yes

BEGIN;

INSERT INTO help_articles (category, sort_order, title, content_md, is_published) VALUES

('Lead Management', 10, 'Why Can''t This Lead Be Emailed?', $$
# Why Can't This Lead Be Emailed?

Outreach is email only, and many small companies don't publish an address. So "we can't reach this one" is a normal state for some leads, not a fault.

## What a search looks for

For every company it keeps, a search tries to find **a named person, their job title and an address**. It goes in this order, free sources first:

1. **Their own website.** The home page and the pages it links to: contact, about, team and policy pages. It keeps every address printed there, and keeps reading past info@ to find the owner's own address.
2. **Companies House**, for UK companies. The register lists who runs a limited company. It has names but no email addresses. A company is only matched when the name is the same and either their website prints the registered postcode or it is the only active company with that name.
3. **A paid lookup, last.** Only when the free steps left a gap, and only for companies the search judged you could sell to. It first looks up the named person's own address. Only if there is still no address at all does it look up the company's addresses.

The companies worth it are also researched in the same search: recent news, hiring and growth, and who is named on their team pages. Their rating is set from that, so there's no button to press afterwards.

Nothing is guessed. A name is only kept if it was printed on their site, is on the register or came from the lookup service. If a company has several directors and nothing says which one runs it, no name is chosen. An address like firstname@ is never made up.

## Reading the Contact section

Open a lead on the **All leads** tab and look at **Contact**:

- **The named person**, with their job title and where the name came from: *named on their website*, *from Companies House* or *from Hunter*. Click it to see the page or register entry.
- **Their own address**, when one was found. A general inbox like info@ stays the address your email goes to, because it's the safe first contact. To write to the person instead, put their address in with **Edit**.
- **The general address** the email will go to.

The **Contact** column on the table tells you which case you're in:

| Chip | Meaning | What you can do |
|------|---------|----------------|
| **Role inbox** | A general address like info@ or enquiries@ | Nothing. This is the best case |
| **Named person** | An individual's own address | Approving asks you to confirm before it sends |
| **None found** | Nothing was published anywhere we can check | Add one by hand with **Edit** if you have it |
| **Checking…** | A search is running and this lead is queued | Wait for the search to finish |
| **Not checked** | Not a company you could sell to, such as a directory or an article | Better targeting is the fix |

Hover over a chip to see the named person and the address.

## The other reasons a send is refused

Approving a lead runs several checks, and each one that stops a send tells you which:

| Reason | What it means |
|--------|--------------|
| **No postal address** | *Yours*, not theirs. Add it in Business Information. It's legally required in every outreach email, so nothing sends until it's saved |
| **Do not contact** | Qualification decided this is a competitor, an existing customer, or an internal or test account. You can override it with a written reason, which is recorded |
| **Suppressed** | The address, or its whole company, is on your suppression list. Usually your connected CRM says they're already a customer, or they asked to be left alone |
| **Named individual, unconfirmed** | A person's own address. Confirm once and it sends |
| **No mailbox connected** | The email is drafted and handed to you to send yourself |

Every one of these is checked on our side, not just in the browser, so none of them can be skipped by clicking twice.

## Duplicates

A search can't file the same company twice. Results are matched to a website and checked for duplicates before anything is scored, so a company's blog post and its home page can't arrive as two leads.
$$, TRUE)

ON CONFLICT (title) DO UPDATE SET
  category = EXCLUDED.category,
  sort_order = EXCLUDED.sort_order,
  content_md = EXCLUDED.content_md,
  updated_at = now();

COMMIT;

-- Check (expect 1 row, published, mentioning Companies House):
--   SELECT title, is_published, position('Companies House' in content_md) > 0 AS new_copy
--     FROM help_articles WHERE title = 'Why Can''t This Lead Be Emailed?';
