# Lead Scoring — Canonical Layering

Four separate scoring systems exist that touch the `contacts` score columns.
This document defines their canonical roles + write boundaries so future
contributors don't add a fifth or bypass a layer.

## The columns

| Column | Owner layer | Type |
|---|---|---|
| `lead_score` | **Multi-Factor (Layer 1)** — sole writer | numeric 0-100, deterministic |
| `engagement_score` | AI Scoring (Layer 2) — primary; multi-factor may seed | numeric 0-100 |
| `intent_score` | AI Scoring (Layer 2) — primary; multi-factor may seed | numeric 0-100 |
| `motivation_score` | AI Scoring (Layer 2) — primary | numeric 0-100 |
| `qualification_score` | AI Scoring (Layer 2) — primary | numeric 0-100 |
| `readiness_level` | AI Scoring (Layer 2) — primary | enum `cold` `warm` `hot` `ready_now` |

## The four scoring systems

### Layer 1 — Multi-Factor (deterministic baseline)
- **File:** `lib/lead-governance/multi-factor-scorer.ts`
- **Function:** `calculateLeadScore(lead)` — synchronous, pure
- **Output:** single composite 0-100 from explainable factors (intent + urgency + engagement + data quality + source reliability)
- **Writes:** persisted to `contacts.lead_score` by callers (e.g., `contact-capture.ts`, `govern-lead.ts`)
- **Cadence:** synchronous on contact create / govern cycle
- **Role:** the **deterministic baseline** for the agent dashboard ranking

### Layer 2 — AI Scoring (nuance refinement)
- **File:** `app/actions/ai-lead-scoring.ts`
- **Function:** `scoreLeadWithAI({ contactId, agentId })`
- **Output:** five-dimensional AI judgement (overall, engagement, intent, qualification, motivation, readiness)
- **Writes:** persists to `engagement_score`, `intent_score`, `qualification_score`, `motivation_score`, `readiness_level` on `contacts`. **MAY also write `lead_score`** when called explicitly from agent UI ("Run AI Score" button) — this is an OVERRIDE, not the default baseline.
- **Cadence:** on-demand via agent click + nightly cron for hot contacts
- **Role:** **nuance refinement** of conversational/behavioral signals that the deterministic scorer can't capture

### Layer 3 — Signal Extensions (event boosts)
- **File:** `lib/lead-intelligence/signal-extensions.ts`
- **Function:** `applySignalDelta(delta)` — idempotent per `(contact_id, source, evidenceId, day)`
- **Output:** per-bucket score deltas pushed UP via `lead_score_history` audit
- **Writes:** updates `contacts.engagement_score` and `contacts.intent_score` (the two columns that exist on `contacts`); writes full delta to `lead_score_history`
- **Cadence:** event-driven (offer-lost, neighbor-sold-high, equity-threshold, predictive-seller)
- **Role:** **never overwrites a higher score**; only pushes UP

### Lead Management Service (orchestrator)
- **File:** `lib/services/lead-management.service.ts`
- **Function:** `calculateLeadScore({ id, table })` — async, persists
- **Role:** wrapper that fetches record + applies multi-factor + writes back. Used by lead-application-service + lead-intelligence cron
- **Calls:** Layer 1 internally
- **Status:** orchestrator, not a separate scoring algorithm

## Layering rules

1. **`lead_score` is owned by Layer 1.** Layer 2 may override on explicit agent action; layer 3 never overwrites.
2. **Layer 2 should not silently overwrite a higher Layer 1 baseline.** When called from background/automation cron, Layer 2 writes only to AI-nuanced dimensions (`engagement_score`, `intent_score`, etc.), preserving the deterministic baseline. Only explicit agent action ("Run AI Score") may overwrite `lead_score`.
3. **Layer 3 only pushes UP.** Never overwrites a higher value.
4. **No new scoring functions.** If you need new logic, add it as a factor inside Layer 1 (deterministic) or as a signal source inside Layer 3 (additive). Do not create a fifth top-level scorer.
5. **`lead_score_history` is the single audit log** for all score changes regardless of which layer wrote them.

## Enforcement state (current)

Confirmed writers of `contacts.lead_score`:

| Writer | Status |
|---|---|
| `lib/services/lead-management.service.ts:calculateLeadScore` | ✅ CANONICAL — uses Layer 1 (multi-factor) baseline + 30% behavioral refinement |
| `lib/lead-governance/multi-factor-scorer.ts:calculateLeadScore` | ✅ Layer 1 algorithm — called by orchestrator + govern-lead |
| `app/actions/lead-governance/govern-lead.ts` | ✅ Calls multi-factor directly (canonical); writes via lifecycle pipeline |
| `app/actions/ai-lead-scoring.ts:scoreLeadWithAI` | ✅ MODE-GATED — `override` writes lead_score (agent UI only); `refine` (default) writes AI-nuanced columns only |
| `app/actions/ai-lead-nurturing.ts` | ✅ NO LONGER writes lead_score — writes engagement_score / intent_score / ai_insights blob only |
| `app/actions/ai-auto-response.ts:calculateLeadScore` | ⚠️ Writes to separate `lead_scores` TABLE (not `contacts.lead_score` column) — different concern; deprecated for new callers |

Confirmed callers of `scoreLeadWithAI`:

| Caller | Mode | Reason |
|---|---|---|
| CRM page "Run AI Score" button | `override` | explicit agent action |
| ai-lead-scoring.ts internal bulk rescore | default `refine` | background |

## Open follow-ups (lower priority)

- `ai-auto-response.ts:calculateLeadScore` writes to separate `lead_scores` table — review whether this table should be merged with `lead_score_history` or kept as a per-agent attribution log
- Add a CI check: any new function named `calculateLeadScore` or `scoreLead*` blocks the commit
- Add metrics: track which layer last wrote each contact's score so we can audit drift
