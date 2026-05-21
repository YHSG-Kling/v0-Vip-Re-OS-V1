---
description: Author or audit Row Level Security policies per this repo's governance model
argument-hint: <table or policy goal, e.g. "leads table" or "let TCs read milestones">
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

Work on RLS for: **$ARGUMENTS**

This is security-critical. Follow `supabase/rls-governance/` exactly and delegate
to the `supabase-expert` agent for the actual policy authoring/review.

Requirements:
1. Read `supabase/rls-governance/README.md` and the relevant existing policy
   file(s) first. Reuse the helper functions (`auth.user_type()`,
   `auth.user_brokerage_id()`, `auth.is_admin()`, `auth.is_broker()`,
   `auth.is_agent()`, `auth.is_contact()`, `auth.owns_record(...)`).
2. `users.user_type` is the ONLY authority. `contact_persona` is UX-only — never
   gate access on it.
3. Enforce `brokerage_id` isolation (admin bypasses; broker = whole brokerage;
   others scoped). Default to least privilege; deny on ambiguity.
4. Name policies `[user_type]_[operation]_[table]_[condition]`.
5. Produce an access matrix: for the affected table, list each user type and
   what it can do (SELECT/INSERT/UPDATE/DELETE) after your change. Explicitly
   flag anything that widens access.
6. If auditing, report gaps: tables with RLS enabled but no policy, policies that
   don't use the helpers, or any cross-brokerage leak.

End with a one-line security verdict: who gained or lost access, and whether it
is intentional.
