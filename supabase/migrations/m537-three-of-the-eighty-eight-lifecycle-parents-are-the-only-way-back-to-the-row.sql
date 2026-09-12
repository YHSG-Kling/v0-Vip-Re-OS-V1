-- m537 — THREE OF THE EIGHTY-EIGHT LIFECYCLE PARENTS ARE THE ONLY WAY BACK TO THE ROW
--
-- m535 converted 68 tenant anchors from ON DELETE SET NULL to RESTRICT and named
-- 88 LIFECYCLE-PARENT SET NULL foreign keys it deliberately did NOT resolve:
--
--     "Those are 88 individual product judgements, not one rule, and CLAUDE.md §1
--      says to write 'unresolved' rather than guess. They are named here so the
--      next lane starts from a list instead of re-deriving one."
--
-- This is that lane. The owner ruling that released m535/m536 — "we need to
-- resolve since lifecycle is important" — is the reason the 88 are being answered
-- now rather than deferred again.
--
-- THE ANSWER IS 3, NOT 88, AND NOT 0. The reasoning below is per-bucket and every
-- count in it was measured live against hrvaqgvukzxfskkcrwbt on 2026-08-23,
-- AFTER m535 and m536 were applied.
--
-- ══ THE BUCKET, REPRODUCED EXACTLY ═══════════════════════════════════════════
--
-- m535's "88" is reproducible from the live catalogue and is not an estimate:
--
--   confdeltype='n' AND confrelid IN (contacts, leads, listings, transactions)
--   AND child column IN (contact_id, lead_id, listing_id, transaction_id,
--                        property_id)
--     → 88 rows exactly.
--
--   contacts.contact_id          41
--   transactions.transaction_id  18
--   leads.lead_id                14
--   listings.listing_id          14
--   listings.property_id          1   (open_houses — a SECOND spelling of
--                                      listing_id on the same table; §6 defect,
--                                      recorded below, not fixed here)
--   ─────────────────────────────────
--                                88
--
-- ══ THE TEST THIS MIGRATION APPLIES ══════════════════════════════════════════
--
-- m535's defect is not "a row lost a pointer". It is "a row a TENANT READ CAN NO
-- LONGER SEE, while the service-role client still sees it". So the question for
-- each of the 88 is not "is this parent important" but:
--
--     WHEN THIS PARENT GOES NULL, IS THERE STILL A READ PATH THAT REACHES THE ROW?
--
-- That has a structural half and a code half, and BOTH were measured.
--
-- ── STRUCTURAL HALF: 87 of the 88 child tables keep their own tenant anchor ──
--
-- Measured from pg_attribute: 87 of the 88 child tables carry their OWN
-- `brokerage_id` column. Exactly ONE does not — `demo_persona_contacts`.
--
-- This is m535's own control argument, generalised. m535 left the 16 `team_id`
-- SET NULL keys alone because every one of those tables ALSO carries
-- `brokerage_id`, so a dissolved team demotes the row from team-level to
-- brokerage-level rather than stranding it. The same holds here: when a listing
-- is removed, a `vendor_invoice` that still carries `brokerage_id` has not left
-- the tenant's jurisdiction — it has been demoted from deal-scoped to
-- brokerage-scoped, which is a state the product has surfaces for.
--
-- And after m535/m533 that anchor is now itself RESTRICT-protected, so the
-- demotion is a floor and not a slope: the row cannot subsequently lose the
-- brokerage too. m535 is what makes "leave the other 85 alone" safe rather than
-- merely tolerable.
--
-- ── CODE HALF: for 3 of the 88, no read path survives the NULL ───────────────
--
-- Structural anchoring is necessary but not sufficient: a row can carry a
-- perfectly good `brokerage_id` and still be reachable from nowhere, if every
-- read the product actually performs filters on the lifecycle parent. Those rows
-- are m535's defect exactly — present to the service client, invisible to the
-- tenant — arrived at through the query layer instead of through RLS.
--
-- Every `.from()` site for each candidate table was enumerated and its filters
-- read. THREE tables have no surviving read path:
--
--   ┌ contract_reviews.transaction_id ──────────────────────────────────────┐
--   │ TWO call sites in the entire tree.                                    │
--   │   app/actions/ai-contract-review.ts:160   the only writer             │
--   │   app/transactions/[transactionId]/page.tsx:165                       │
--   │       .eq("transaction_id", transactionId)   the only reader          │
--   │ With transaction_id NULL the review is reachable from NOTHING. It     │
--   │ retains brokerage_id, so it is billed to and stored by the tenant,    │
--   │ and displayed to nobody. These are AI-authored contract-review        │
--   │ artifacts — compliance evidence — so silently stranding them is the   │
--   │ worst of the three outcomes here.                                     │
--   └───────────────────────────────────────────────────────────────────────┘
--
--   ┌ compliance_alerts.transaction_id ─────────────────────────────────────┐
--   │ FOUR call sites, all in lib/application/compliance-monitoring.ts:      │
--   │   :453 and :554  inserts                                              │
--   │   :71   the ONLY list read — .eq("transaction_id", transactionId)     │
--   │            .eq("resolved", false)                                     │
--   │   :165  resolve — .eq("id", alertId).eq("brokerage_id", …)            │
--   │ The resolve path needs an alert id, and :71 is the only thing that    │
--   │ hands one out. So a NULL transaction_id leaves an alert that is       │
--   │ permanently `resolved = false`, listed by nothing and clearable by    │
--   │ nobody. CLAUDE.md §4 — "'nobody checked' must never render as         │
--   │ 'checked and fine'" — and this is the sharper version: an open        │
--   │ compliance flag that no surface can show and no action can close.     │
--   └───────────────────────────────────────────────────────────────────────┘
--
--   ┌ commission_splits.transaction_id ─────────────────────────────────────┐
--   │ STATED PRECISELY, because this one is NOT invisible everywhere and    │
--   │ claiming that it is would be overreach:                               │
--   │   app/dashboard/financials/page.tsx:42  .eq("agent_id", agentId)      │
--   │       → the AGENT still sees the payout after transaction_id goes NULL │
--   │   lib/intelligence/brokerage-pnl.ts:158                                │
--   │       .eq("brokerage_id", …).in("transaction_id", txnIds)             │
--   │       → the BROKERAGE'S OWN P&L silently DROPS the row, because a     │
--   │         NULL matches no id in the IN list.                            │
--   │ So it is invisible to the TENANT-LEVEL financial read while remaining │
--   │ visible on the agent's page: one payout, two surfaces, two different  │
--   │ numbers, and `brokerageNet` / `agentPayouts` both understated with no │
--   │ error anywhere. A paid commission split whose deal was hard-deleted   │
--   │ is money attributed to nothing; the delete should be refused, not     │
--   │ absorbed.                                                             │
--   └───────────────────────────────────────────────────────────────────────┘
--
-- Positive control for that code measurement (CLAUDE.md §2): the same finder was
-- run over `title_orders.transaction_id`, which was ALSO hand-checked. It reports
-- a surviving read — app/title/orders/page.tsx:49 reads `.eq('brokerage_id', …)`
-- and selects transaction_id rather than filtering on it — matching the manual
-- reading. The finder distinguishes the two cases; it does not report "no
-- surviving read" for everything.
--
-- ══ WHY RESTRICT IS SAFE HERE, MEASURED AND NOT ASSUMED ══════════════════════
--
-- m535's integrator section is the precedent: a RESTRICT is only safe once the
-- hard-delete paths that would hit it have been fixed. That check was repeated
-- for these three, and it passes for a reason specific to `transactions`:
--
--   1. NO PRODUCTION HARD DELETE OF `transactions` EXISTS. Every `.from(...)`
--      / `.delete()` pair in app/, lib/ and services/ was enumerated; there is
--      none for transactions. POSITIVE CONTROL: the identical finder run against
--      `brokerages` returns the known hard deletes, and against `listings`
--      returns app/actions/listings.ts:253 — so a zero here is a measured zero,
--      not a broken search.
--
--   2. NOTHING CASCADES INTO `transactions`. Measured from pg_constraint: of the
--      four lifecycle parents, only `leads` is CASCADE from `brokerages`.
--      `transactions.brokerage_id → brokerages` is RESTRICT (m533/m535), so a
--      tenant delete is already refused ONE LEVEL ABOVE these three constraints.
--      A RESTRICT added here therefore cannot fire from inside a cascade, and
--      cannot change the outcome of lib/kernel/tenant-creation-rollback.ts.
--
--   3. THE ONE SIMULATOR THAT SEEDS A SPLIT ALREADY DELETES CHILD-FIRST.
--      scripts/brokerage-pnl-simulator.ts pushes {transactions} then
--      {commission_splits} onto its cleanup list and unwinds it with
--      `[...cleanup].reverse()` at :113 — split before transaction. Nothing in
--      scripts/ inserts compliance_alerts or contract_reviews at all; the other
--      files naming them are generated caches and source-text analyzers.
--
-- ══ THE 85 THAT ARE LEFT, AND WHY — THIS IS THE ANSWER, NOT A DEFERRAL ═══════
--
--   · ALL 15 LEAD-KEYED FKs — LEAVING THEM IS FORCED, NOT PREFERRED.
--     `leads.brokerage_id → brokerages` is ON DELETE **CASCADE** (measured). A
--     RESTRICT on any lead child would fire from INSIDE that cascade and make
--     brokerage deletion fail whenever any lead had a child row — which would
--     break lib/kernel/tenant-creation-rollback.ts, the very rollback m535
--     required as its own precondition. Converting lead children would trade
--     m535's orphan-child defect for the orphan-PARENT defect m535 warned about.
--     Additionally, `leads` is the one lifecycle parent with NO `deleted_at`
--     column, so its deletes are genuinely hard. These stay SET NULL.
--     (Four of the 15 — batchdata_motivated_sellers_raw, zenrows_property_search
--     _raw, social_search_raw_results, platform_lead_distributions — are also
--     lead-acquisition tables that this lane was scoped out of touching.)
--
--   · ALL 15 LISTING-KEYED FKs (14 listing_id + 1 property_id) — PRECONDITION
--     UNMET, AND THIS IS A FINDING IN ITS OWN RIGHT.
--     app/actions/listings.ts:253 `deleteListing` is a LIVE, PRODUCTION,
--     CHILD-BLIND hard delete: it gates the caller and then issues
--     `.from("listings").delete().eq("id", …).eq("brokerage_id", …)` with no
--     child cleanup. It is the listing-side twin of the two brokerage deletes
--     m535 named, and unlike those it has NOT been fixed. Converting any
--     listing-keyed FK to RESTRICT today would break listing deletion outright.
--     m535's own rule applies unchanged: fix the delete path FIRST. Recorded here
--     so the next lane starts from the file and line rather than re-deriving it.
--
--   · ALL 49 CONTACT-KEYED FKs — NOT CONVERTED. `contacts.brokerage_id` is
--     RESTRICT and no production hard delete of `contacts` exists, so the
--     precondition would likely pass — but 74 hard-delete cleanup sites across
--     scripts/ touch `contacts`, and this lane verified the delete ORDER for
--     exactly one simulator, not 74. Converting 49 constraints on the strength of
--     an unverified assumption about the other 73 is the guess CLAUDE.md §1
--     forbids. UNRESOLVED, with the blocker named: the work is auditing those 74
--     cleanup orders, not re-deriving the FK list.
--
--   · THE OTHER 15 TRANSACTION-KEYED FKs — CORRECTLY SET NULL, AND SAYING SO IS
--     PART OF THE ANSWER. Each was checked for a read path that survives the
--     NULL, and each has one: activities, tasks, documents, vendor_invoices,
--     client_gifts, thank_you_notes, portal_event_stream, workflow_runs,
--     generated_documents, vendor_contact_assignments, lender_applications,
--     ai_assistant_notes, income_gap_recommended_actions and title_orders are all
--     read by brokerage_id, agent_id, contact_id or document_id somewhere;
--     signature_requests is additionally reachable by `provider_envelope_id`
--     (lib/kernel/ingress-continuity.ts:52) and by brokerage_id
--     (lib/kernel/flow-integrity.ts:507). For these the deal is one CONTEXT of a
--     row that has others — a task, a document, an invoice outlives the deal it
--     was raised against — and SET NULL is the humane, correct rule, exactly as
--     it is for the 63 actor references m535 protected.
--
--   · `demo_persona_contacts.contact_id` — LEFT, AND ESCALATED AS A DIFFERENT
--     FINDING. It is the ONE table of the 88 with no `brokerage_id`, so a NULL
--     contact_id strands it completely. It is NOT converted anyway, because it
--     has ZERO `.from("demo_persona_contacts")` sites in the entire tree: making
--     contact deletion RESTRICT-refuse on account of a demo-seed row that nothing
--     reads would be strictly worse than the defect. This is an ORPHAN TABLE
--     (CLAUDE.md §1), not a delete-rule question, and belongs to the orphan sweep
--     that m536 was part of. UNRESOLVED here, deliberately.
--
--   · `open_houses` CARRIES BOTH `listing_id` AND `property_id`, BOTH SET NULL,
--     BOTH REFERENCING `listings`. That is two spellings of one idea on one
--     table — the §6 defect, in the schema rather than in code. Every read found
--     (lib/kernel/launch-war-room.ts:235, lib/video/director-content.ts:564,
--     scripts/launch-war-room-simulator.ts:30) uses `listing_id`; `property_id`
--     has no reader. NOT fixed here: merging them is a column drop with its own
--     evidence and its own migration, and doing it inside a delete-rule migration
--     would be the "deleting to move a number" §1 forbids. NAMED so it is not
--     re-derived.
--
-- ══ WHAT THIS MIGRATION CHANGES ══════════════════════════════════════════════
--
--   3 constraints, named explicitly rather than derived by a loop. m535 looped
--   because its population was 68 and homogeneous; three hand-picked constraints
--   that each required an individual product judgement should be legible as three
--   individual statements, and a loop over a predicate would invite a future
--   schema addition to be swept in without the judgement being made.
--
--   NOTHING TO VALIDATE: RESTRICT and SET NULL differ only in what happens during
--   a parent DELETE. No existing row can refuse these.

BEGIN;

-- Guard: refuse if the schema is not the one this migration reasoned about.
-- FAIL CLOSED (CLAUDE.md §4) — a gate that cannot confirm its premise refuses.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
  FROM pg_constraint c
  JOIN pg_class src ON src.oid = c.conrelid
  JOIN pg_namespace nn ON nn.oid = src.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
  WHERE c.contype = 'f'
    AND c.confdeltype = 'n'
    AND nn.nspname = 'public'
    AND c.confrelid = 'public.transactions'::regclass
    AND a.attname = 'transaction_id'
    AND cardinality(c.conkey) = 1
    AND src.relname IN ('contract_reviews', 'compliance_alerts', 'commission_splits');

  IF n <> 3 THEN
    RAISE EXCEPTION
      'm537 ABORTED: expected 3 single-column SET NULL transaction_id FKs on '
      '(contract_reviews, compliance_alerts, commission_splits), found %. '
      'The population this migration reasoned about has changed. Re-measure.', n;
  END IF;
END $$;

-- ── 1 · contract_reviews — the only reader filters on transaction_id ────────
ALTER TABLE public.contract_reviews
  DROP CONSTRAINT contract_reviews_transaction_id_fkey;
ALTER TABLE public.contract_reviews
  ADD  CONSTRAINT contract_reviews_transaction_id_fkey
  FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE RESTRICT;

-- ── 2 · compliance_alerts — the only list read filters on transaction_id, and
--        the resolve path can only act on an id that list hands out ──────────
ALTER TABLE public.compliance_alerts
  DROP CONSTRAINT compliance_alerts_transaction_id_fkey;
ALTER TABLE public.compliance_alerts
  ADD  CONSTRAINT compliance_alerts_transaction_id_fkey
  FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE RESTRICT;

-- ── 3 · commission_splits — the brokerage P&L folds splits through
--        `.in("transaction_id", txnIds)`; a NULL leaves the tenant's own books
--        while the agent's page still shows the money ────────────────────────
ALTER TABLE public.commission_splits
  DROP CONSTRAINT commission_splits_transaction_id_fkey;
ALTER TABLE public.commission_splits
  ADD  CONSTRAINT commission_splits_transaction_id_fkey
  FOREIGN KEY (transaction_id) REFERENCES public.transactions(id) ON DELETE RESTRICT;

-- ASSERT THE RESULT rather than trusting the statements above (CLAUDE.md §2/§7).
DO $$
DECLARE converted int; leftover int;
BEGIN
  SELECT count(*) INTO converted
  FROM pg_constraint c
  JOIN pg_class src ON src.oid = c.conrelid
  JOIN pg_namespace nn ON nn.oid = src.relnamespace
  WHERE c.contype='f' AND c.confdeltype='r' AND nn.nspname='public'
    AND c.confrelid='public.transactions'::regclass
    AND src.relname IN ('contract_reviews','compliance_alerts','commission_splits');

  IF converted <> 3 THEN
    RAISE EXCEPTION 'm537 FAILED: % of 3 transaction_id FKs are RESTRICT', converted;
  END IF;

  -- The COMPLEMENT is asserted too. This migration claims to change 3 and to
  -- leave 85; a silent over-reach would be as much a defect as a silent
  -- under-reach, and only one of the two is caught by counting successes.
  SELECT count(*) INTO leftover
  FROM pg_constraint c
  JOIN pg_class src ON src.oid = c.conrelid
  JOIN pg_class tgt ON tgt.oid = c.confrelid
  JOIN pg_namespace nn ON nn.oid = src.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
  WHERE c.contype='f' AND c.confdeltype='n' AND nn.nspname='public'
    AND tgt.relname IN ('contacts','leads','listings','transactions')
    AND a.attname IN ('contact_id','lead_id','listing_id','transaction_id','property_id');

  IF leftover <> 85 THEN
    RAISE EXCEPTION
      'm537 FAILED: expected exactly 85 lifecycle-parent SET NULL FKs to remain '
      '(88 - 3), found %. This migration changed something it did not describe.', leftover;
  END IF;

  RAISE NOTICE 'm537 VERIFIED — 3 of 88 lifecycle parents converted SET NULL -> RESTRICT; 85 remain SET NULL by explicit verdict';
END $$;

COMMIT;

-- ══ WHAT THIS MIGRATION DELIBERATELY DOES NOT DO ═════════════════════════════
--
--   · It does not touch app/actions/listings.ts:253 `deleteListing`. That file
--     is code, not schema, and the fix (delete children first and READ the
--     error, as lib/kernel/tenant-creation-rollback.ts already does for
--     brokerages) is a separate change with its own review. It is the blocker on
--     the 15 listing-keyed FKs and is named above so it is not lost.
--
--   · It does not drop `open_houses.property_id`, the readerless second spelling
--     of `listing_id`.
--
--   · It does not resolve `demo_persona_contacts`, an orphan TABLE rather than
--     an orphan delete rule.
--
--   · It adds no NOT NULL. Same reasoning m535 gave: RESTRICT closes the DELETE
--     door, the INSERT door is a separate migration with separate evidence.
