# Manager governance — policy improvement, governed self-healing, duplicate retirement

Wave 146, lane 146G. Owner rulings 14 and 15 (2026-10-29). This page states the rules and names the code that enforces each one. `scripts/manager-governance-change-guard.ts` (`test:manager-governance-change`) and `scripts/manager-duplicate-proof-guard.ts` (`test:manager-duplicate-proofs`) hold this page and the code to each other. Nothing here is a new approval system. Every rule runs on a rail that already existed (LAW 1/2).

## Ruling 14 — managers may improve policy; code edits stay governed

> "Managers should be allowed to change policies if they align with the business process and can heal the playbook edit code."

**One rule.** `lib/kernel/improvement-proposals.ts` `classifyGovernedChange` derives the class from the change itself: its surface, its kind and its payload. It never reads the row's stored `authority_required`. `promotionDecision` refuses a manager or the system on every consequential class, whatever rung the row was stored with. The kernel's own doors (`decideProposal`, `promoteProposal`) always pass the derived class. Anything on neither list is `unlisted`, and `unlisted` is consequential (fail closed).

### Safe operational adaptation — a manager may propose AND apply, within its authority, with evidence

| Class | Rail that carries it | Within authority means |
|---|---|---|
| `playbook_parameters` | `lib/kernel/self-optimization.ts` `OPTIMIZATION_CLASS_DEFS`: `followup_timing`, `model_routing`, `transaction_reminder_timing`, plus predictor `threshold` proposals | Rung 4, the class is on the tenant's human-set `self_optimization` list, and the autonomy gate allows it. Only the class's allowed fields change. |
| `provider_failover` | `routeCapability` + the `failover` playbook; the `provider_selection` optimization class | The healing policy (`self_healing`) under the platform ceiling. The owner-ruled primary is never skipped. |
| `retry` | `lib/kernel/os-health.ts` `decideRecovery` + the `retry` playbook | Idempotent recoveries only, bounded by `OS_HEALTH_RETRY_CAP`. |
| `notification_routing` | The `notify_owner_manager` / `refresh_token_prompt` hand-offs | The incident is handed to its accountable owner. Nothing acts. |
| `content_channel_selection` | Variant proposals (`sequence_ab:` / `media_kind:`) and experiments (`EXPERIMENT_CLASSES`); the `campaign_sequencing`, `creative_choice`, `education_intervention` and `property_recommendation` optimization classes | Rung 4 plus the tenant's autonomous list. An experiment's spend comes out of the human-set experiment envelope. |
| `self_healing_repair` | `lib/kernel/self-healing.ts` `validatePlaybookSelection` → a declared playbook → its owning-rail executor | The hard gate, the healing policy, a validated selection, a VERIFIED outcome and bounded attempts. |

Every applied change is ledgered (`withActionLedger`). A policy promotion appends a `tenant_policy_versions` row. The ledger detail of every `learning.proposal.promote` now records `governed_change: { class, verdict }`.

### Consequential change — a manager only PROPOSES; a human decides

| Class | Where it waits for a human |
|---|---|
| `financial_calculation` | The `financial_rule` forbidden surface. Owner-level policy (authority 6). Finance. |
| `legal_compliance` | `law_rule` proposals and `requires_compliance` (a compliance approver only). The `compliance_boundary` surface. |
| `rls_security` | A migration file, WRITTEN, NOT APPLIED. The integrator applies public-table policies. `storage.objects` is owner SQL. |
| `tenant_authority` | The `authority_policy` surface (`authority_level:*`, `autonomy_tier:*`, `self_optimization`, `ai_agent_capabilities`, `procurement_autonomy`, lead routing). Lead-assignment allocations. |
| `production_source_edit` | A **change request** (`openChangeRequest` → `connector_healing_proposals`, kind `change_request`). Platform staff approve it in `approveProposalAction` (`applied_by` is a user id, never `auto`). |
| `credentials` | `refresh_token_prompt`: the account owner reconnects. No manager writes a credential. |
| `destructive_schema` | `classifyForbidden` `data_deletion`. DROP INDEX / DROP COLUMN are owner SQL. |
| `money_movement` | `classifyForbidden` `money` → `halt_and_route_finance`. A marketing budget allocation. |

**Change control** (`CHANGE_CONTROL_REQUIREMENTS`; each change request prints `CHANGE_CONTROL_HOW`):

- `human_approval`
- `versioned_change` — a tenant-policy version, or a reviewed commit / migration file
- `tests` — the owning domain's proofs and the full guard chain (`GUARD_EXIT=0`)
- `deployment_authorization` — a human-authorized deploy

**No unrestricted code-edit or deploy rights.**
- No manager, healer or runtime path edits code, commits, deploys or applies a migration.
- `PROPOSAL_SUBJECT_KINDS` names no code kind.
- `SELF_HEAL_PLAYBOOKS` holds no code action.
- The auto-applier's `SAFE_KINDS` never holds `change_request` or `playbook_exhausted`.
- The runtime census of code-mutation and deploy shapes is `scripts/production-readiness-guard.ts` section A (A1–A5, lane 145I).

## Ruling 14 — a broken workflow is an incident

DETECT → DIAGNOSE → OWNER → SAFE REPAIR / PROPOSAL → VERIFY → NOTIFY / ESCALATE. Each stage runs on its existing survivor. The record is `IncidentLifecycle` (`lib/kernel/self-healing.ts` `incidentLifecycle`). It rides every troubleshoot result and every playbook incident row (`self_heal_events.detail.lifecycle`).

| Stage | Survivor |
|---|---|
| DETECT | `lib/kernel/os-health.ts` `DETECTORS` (one survivor table per detector) |
| DIAGNOSE | `troubleshootIncident`: the hard gate, then one bounded AI diagnosis (`runBoundedModel`) |
| OWNER | `incidentOwner` takes the manager the recovery policy routes the class to. When that is "a human decides", it takes the subject steward `DETECTOR_OWNER`, which is the `TABLE_MANAGER` steward, re-derived by the proof. |
| SAFE REPAIR / PROPOSAL | A declared playbook (safe). A `playbook_exhausted` proposal (attempts spent). A `change_request` (consequential: a code defect). |
| VERIFY | The owning-rail executors re-read their survivor. An unverified repair is never "done". |
| NOTIFY / ESCALATE | The supervisor's escalation (`defaultNotify`, `publishManagerSignal`) and the Exception Center |

## Ruling 15 — duplicates are retired only with proof

> "Duplicate actions that don't have a provable survivor shouldn't be retired until there is proof they aren't beneficial."

`scripts/manager-duplicate-proof-guard.ts` re-derives the duplicate census from stripped source: every `export async function` name exported by more than one `app/actions/**` module, with importers resolved module-aware. It holds the census to the `DUPLICATE_ACTION_LEDGER`, which has one row per name. The guard enforces three rules:

1. A NEW duplicate name with no row fails the guard.
2. A **retired** row must carry all eight steps: file/function → intended behaviour → candidate survivor → proof the survivor covers it → callers migrated → unique behaviour preserved → retired with a tombstone → guards re-run. Its twin must be gone. Its tombstone must name a survivor `file:line` that exists and still exports the name.
3. A **kept** row must name its dependency. A "both wired" row whose side has lost its importers must be re-triaged.

## Proofs

- `test:manager-governance-change` (new)
- `test:manager-duplicate-proofs` (new)
- `test:controlled-learning`
- `test:self-optimization`
- `test:proposal-compliance-gate`
- `test:self-healing`
- `test:healing-policy`
- `test:os-health`
- `test:manager-cross-cooperation`
