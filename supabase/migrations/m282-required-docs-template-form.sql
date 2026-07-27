-- m282 — Required-doc rules can carry the brokerage's own blank template form.
-- Keep-one: references the EXISTING brokerage_form_library (the
-- transaction-forms upload pipeline + brokerage-forms bucket) — never a second
-- upload path. ON DELETE SET NULL: removing a library form degrades the rule
-- gracefully, never breaks it.
--
-- Applied to the live database 2026-07-26 (MCP migration
-- required_docs_template_form_link); this file mirrors it into the repo record.
ALTER TABLE brokerage_required_documents
  ADD COLUMN IF NOT EXISTS template_form_id uuid
  REFERENCES brokerage_form_library(id) ON DELETE SET NULL;
