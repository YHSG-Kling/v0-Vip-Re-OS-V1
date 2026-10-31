-- ── APPLIED LIVE 2026-10-24 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 143, lane 143H; statement by statement where the MCP held a batch ──
--
-- m840 — ONE doc_type spelling for the title company's PRELIMINARY closing statement (CLAUDE.md §6).
--        Owner-approvable DATA migration. It is one UPDATE and it renames no column and no table.
--
-- THE DEFECT (wave 142 lane 142C named it, left it open "no column/data rename this wave"):
--   one artifact, two doc_type spellings in public.transaction_documents —
--     · 'preliminary_closing_disclosure' — written by app/actions/cda-portal.ts:1225 (the agent / TC attach and the
--       preliminary-CD bridge), paired with 'final_closing_disclosure' (cda-portal.ts:1782);
--     · 'settlement_statement'           — written by the TITLE PORTAL upload (app/portal/title/[transactionId]/
--       document-upload.tsx:55, option label "Preliminary HUD/ALTA") through app/actions/title-portal.ts uploadTitleDocument.
--   lib/transactions/cda-closing-policy.ts:75 PRELIMINARY_STATEMENT_DOC_TYPES reads the two as ONE family so the version
--   counter and the statement-vs-waterfall comparison work today, but a scorer, a report or a policy that names one
--   spelling misses the other (the §6 shape that bit timeline, video status and vendor category).
--
-- WHICH SPELLING SURVIVES, AND WHY: 'preliminary_closing_disclosure'. 'settlement_statement' is ambiguous against the
--   FINAL document the closing flow also stores ('final_settlement_statement' — the AI classifier's value, read by
--   lib/offers/closing-cost-accuracy.ts:577, lib/net-sheet/net-sheet-guard-runner.ts:105, lib/documents/auto-filer.ts:74);
--   the survivor says what the artifact IS (preliminary) and pairs with its final twin. Nothing is invented: it is the
--   value cda-portal.ts already writes, the value the family reader already lists first.
--
-- LIVE, READ 2026-10-23 (project hrvaqgvukzxfskkcrwbt, read-only aggregate queries):
--   · public.transaction_documents: 0 rows (the database has never been operated) — so nothing is rewritten today and
--     this file's job is to be in place BEFORE the first title upload creates a row with the retiring spelling.
--   · doc_type text, NO CHECK on it (the only checks are transaction_documents_status_check and
--     transaction_documents_has_a_parent), NO unique index touching doc_type, NO UPDATE trigger — the UPDATE below
--     cannot be refused by a constraint and cannot collide.
--   · metadata jsonb, updated_at timestamptz DEFAULT now().
--
-- COUPLED CODE CHANGE (outside lane 143H — listed in the lane notes with file:line; ships in the SAME release):
--   1. app/portal/title/[transactionId]/document-upload.tsx:55,60 — option value 'settlement_statement' → 'preliminary_closing_disclosure'.
--   2. app/actions/title-portal.ts:218 (read list), :276 (documentType union), :337-338 (the preliminary/final branch).
--   3. lib/transactions/cda-closing-policy.ts:75 — drop 'settlement_statement' from PRELIMINARY_STATEMENT_DOC_TYPES AFTER
--      this file is applied and re-run once (below) and the code in 1–2 is live.
--   4. scripts/cda-closing-flow-guard.ts:100,119 and scripts/canaries/preliminary-cd.ts:34,75 — re-assert the RULE
--      (the family is exactly the survivor) instead of the two-spelling waypoint.
--   The file is SAFE TO APPLY BEFORE OR AFTER the code: the family reader accepts both spellings throughout the window, and
--   the UPDATE is idempotent — re-run it once after the code ships to sweep any row the old writer created in between.
--
-- PROVENANCE IS KEPT, NOT DISCARDED: the retired spelling is recorded in metadata.legacy_doc_type, so the rewrite is
-- reversible row by row (rollback below) and an auditor can see which rows the title portal created.
--
-- ROLLBACK (only if the coupled code is reverted too):
--   UPDATE public.transaction_documents
--      SET doc_type = metadata->>'legacy_doc_type', updated_at = now()
--    WHERE metadata->>'doc_type_unified_by' = 'm840' AND metadata ? 'legacy_doc_type';

UPDATE public.transaction_documents
   SET doc_type   = 'preliminary_closing_disclosure',
       metadata   = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('legacy_doc_type', 'settlement_statement', 'doc_type_unified_by', 'm840'),
       updated_at = now()
 WHERE doc_type = 'settlement_statement';
