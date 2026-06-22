# Supabase migrations — drift & the "Supabase Preview" check

## Why the **Supabase Preview** CI check fails

Error: `Remote migration versions not found in local migrations directory.`

Two migration naming schemes drifted apart:

- **Remote DB** (`hrvaqgvukzxfskkcrwbt`) records migrations with **timestamp versions** applied via the
  Supabase CLI/dashboard, e.g. `20260616021717_m229_followup_scheduling` … (~320 entries — see
  `supabase migration list`).
- **This repo's** `supabase/migrations/` uses a **different convention** — `m229-followup-scheduling.sql`,
  `023-video-ugc-mode.sql` (184 files) — with no `<timestamp>_` prefix.

The Supabase↔GitHub **Preview/branching** integration matches local *filenames* to the remote's recorded
*versions*. Because the local files don't carry the timestamp prefix, it reports the remote versions as
"not found locally" and the preview branch can't reconcile. **This fails on every PR, independent of the
PR's code** — no PR here touches migrations.

## Fix (run where the DB is reachable — NOT in the Claude web sandbox, whose egress allowlist blocks the DB host)

### Option A — sync local migrations to the remote (recommended, ~2 min)
```bash
supabase link --project-ref hrvaqgvukzxfskkcrwbt
supabase db pull            # regenerates local migration file(s) matching the remote history
git add supabase/migrations
git commit -m "chore(db): sync local migrations with remote history"
git push
```
`db pull` writes a baseline that the integration recognizes; the check goes green and stays green.

### Option B — reconcile histories without pulling
```bash
supabase link --project-ref hrvaqgvukzxfskkcrwbt
supabase migration list     # shows Local vs Remote, marks the diverged versions
# for each remote-only version the list flags:
supabase migration repair --status reverted <version>
```

### Option C — this repo doesn't deploy schema via committed CLI migrations
The `m###`/`0##` naming indicates schema is applied through a custom process, not `supabase db push`.
If so, **disable Preview/branching** for this repo so the check stops running:
Supabase Dashboard → Project → Integrations → GitHub → turn off branch/preview for the repo
(or remove the required-status-check in GitHub branch protection).

## Important
- The **Supabase Preview** check is *informational* — it is almost certainly **not a required status
  check**, so PRs can merge while it's red. The checks that gate this code (`guards`,
  `guards / compliance`) are the ones to keep green.
- Do **not** "fix" this by hand-creating timestamp-named placeholder migration files: empty/stub files
  make the preview branch build an empty schema and corrupt the recorded history. Use `db pull`.
