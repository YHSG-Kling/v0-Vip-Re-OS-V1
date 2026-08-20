# CLAUDE.md

Working rules for this repository. Written 2026-08-20, after a lane reported that
this file did not exist — every parallel lane had been told to read it, and every
one of them silently proceeded without the rules below.

Everything here is a ruling already in force or a trap already paid for. Nothing
is aspirational.

---

## 1. The orphan doctrine

When something is referenced by nothing, or writes with no reader, or reads with
no writer:

1. **If a DUPLICATE exists** — merge whatever the survivor is missing ONTO the
   survivor **first**, then delete the duplicate, leaving a tombstone comment
   naming the survivor at `file:line`.
2. **If NO duplicate exists** and the capability is wanted — **BUILD** the
   missing half.
3. **If the functionality already lives elsewhere** — delete, with a tombstone
   naming where it went.

**Deleting to move a number is forbidden.** Every deletion names its survivor.

**Unreferenced is not dead.** Cron routes, webhook handlers, and public/external
endpoints are unreferenced *by design*. Prove reachability before proposing any
deletion — check `vercel.json`, `lib/kernel/cron-dispatch.ts`, provider consoles,
and same-origin self-calls written as `` `${baseUrl}/api/…` ``. When you cannot
prove it either way, write "unresolved" rather than guessing.

## 2. Measurement discipline

A guard that cannot see the code it judges is worse than no guard: it reports
zero and reads as a clean bill of health.

- **Never hand-roll a comment stripper.** `scripts/strip-comments.ts` is the one
  correct scanner. Use `stripComments` when you report LINE NUMBERS,
  `blankComments` when you compute positions from match indices, `blankStrings`
  when a quoted literal would confuse the parse. The recurring defect is
  stripping `/* */` blocks *before* `//` lines: one `//` containing `/*`, an
  apostrophe, or a URL makes the block regex swallow real code, and the analyzer
  then accuses live code of being absent.
- **Every absence assertion needs a POSITIVE CONTROL.** A broken regex and a
  clean tree both report zero. If you claim "0 found", prove the finder still
  recognises the defect it was written for.
- **Publish blind spots beside the number.** A count without its denominator and
  exclusions is not a measurement.
- **A count that moves is the finding.** If a fix changes a number, say which
  direction and why. More findings = the check was blind. Fewer = it was
  accusing live code.

## 3. The live database is the source of truth

Supabase project `hrvaqgvukzxfskkcrwbt`.

- Schema caches are **generated, never hand-edited**: `schema-snapshot.ts`,
  `schema-fk-map.ts`, `check-vocabularies.ts`, `live-tables.ts`. Regenerate by
  piping live JSON into `scripts/generate-*.ts` (each generator's header carries
  the exact SQL).
- **Files are not the database.** A migration that exists as a `.sql` file has
  not been applied. Lanes write migrations; only the integrator applies them.
- After any applied migration that adds a CHECK, **regenerate the vocabulary
  cache** so `check-vocabulary-guard` can hold code and database in agreement.

### Traps that have cost real time

- **supabase-js RESOLVES refusals.** Always destructure `{ data, error }` and
  READ the error. A swallowed refusal degrades silently.
- **PGRST204** — an INSERT/UPDATE naming an absent column is refused
  **entirely**. Not "most of the row": nothing.
- **PGRST201** — a bare embed between two tables joined by more than one FK kills
  the query.
- **`agents.id` and `users.id` are DISJOINT** (23503). Cross via `agents.user_id`.
- **`contacts` has TWO uuid columns**: `id` (PK) and `contact_id` (secondary
  unique). Picking the wrong one produces a query that always returns nothing.
- A column written only by a **migration backfill, an `.rpc()`, or a DB trigger**
  reads as writerless without being writerless. Check all three before calling
  anything one-sided.

## 4. Tenancy and identity

- **Tenant comes from the SESSION.** Never from a request body, never from a
  parameter. Body-supplied `brokerageId` on a service client is the IDOR shape
  found repeatedly here.
- `"use server"` files: **every export is a public HTTP endpoint** and must be
  `async`. There is no such thing as a private helper in one.
- Gate first, then use the service client — see the pattern named at
  `lib/kernel/manager-registry.ts`.
- **Fail closed.** A gate that cannot run must refuse, not pass. "Nobody checked"
  must never render as "checked and fine".

### Roles

- Tenant roster: `broker`, `broker_admin`, `broker_owner`, `team_lead`, `admin`.
- **Platform staff live in the `platform_role` column** — NOT `user_type='superadmin'`,
  which no live row has.
- Team lead anchors on `teams.team_lead_id`. A team is a mini brokerage.
- Teams see only their own board; platform sees all tenants.

## 5. Product rulings in force

- **Leads belong to the BROKERAGE.** Agents never claim leads and see CONTACTS
  only. A lead reaches an agent only once qualified or showing positive intent.
- **Contacts, lenders and vendors see no financials** — only their own.
- Commission is off agent-facing display.
- **AI is platform-covered**, with per-tier overage. `ai_tool_usage` is the cost
  ledger; it feeds `meter_readings.ai_tokens` and the overage projection. A wrong
  number there is a wrong invoice.
- Timeline stays in **buckets** (1-3 / 3-6 / 6-12), never 30/60/90.
- Impersonation is a support-investigation tool: a grant walks the account and
  never exceeds it.
- Video scripts are written **compliance-first** — fair housing in the writing
  prompt, not only in the post-hoc scan. Warnings pass through; only a hard
  fair-housing flag escalates to a human.
- Anything reaching a **licensed appraiser** must not be model-authored.

## 6. One vocabulary per function

If two spellings of the same idea exist, they are a defect, not a style choice —
scorers cannot match writers across them. Merge onto one, then delete the other.
This has bitten timeline (six spellings), video status (22), and vendor category.

## 7. Verification before claiming

- Run the thing. Quote its output. "Should work" is not a result.
- Report failures with their output. If a step was skipped, say so.
- The **full guard chain** runs before any push:
  `NODE_OPTIONS="--max-old-space-size=10000" npm run guard`
  and **`GUARD_EXIT` grepped from the log is the only trustworthy signal** —
  the log contains the words "fail" and "failed" hundreds of times in prose.
- Do not run a full `tsc --noEmit` or full guard chain in parallel lanes; they
  OOM each other.

## 8. CI

`next-build` intermittently dies with exit 134, "Ineffective mark-compacts near
heap limit". Re-run the job **unchanged**; escalate only after three consecutive
failures at the same commit. The heap bracket is empirical and documented in
`.github/workflows/build.yml` — read it there rather than re-deriving it, and add
new measurements to it. Note that a compile abort happens with *committed* heap
at ~90% of the configured cap, so the cap is not the usable budget.
