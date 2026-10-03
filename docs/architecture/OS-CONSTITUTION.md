# OS constitution (wave 98, lane 98C; laws added wave 99, lane 99C)

These are the rules the platform runs on. Each one names the code or proof that enforces it, or says **not yet enforced**.

## Preamble (owner, verbatim, 2026-10-03)

> This repository is an existing production-oriented multi-tenant autonomous real-estate SaaS OS. Do not reinterpret the blueprint as instructions to rebuild it. Identify and preserve the canonical survivor for every capability. Extend or consolidate survivors before creating anything new. Never create parallel kernel infrastructure. New architecture must integrate with tenant isolation, subscription/entitlement enforcement, authority/risk policy, memory, events, action/decision evidence, usage/cost accounting, provider abstraction, outcome attribution and existing proofs. Preserve existing business rules unless an explicit owner ruling changes them. No new subsystem may be created until the current survivor has been identified and proven insufficient.

## The five laws (owner, verbatim, 2026-10-03)

The laws sit above the 15 principles. Each principle below is a specific rule under one law (see "Principles under the laws"). The law text is the owner's. The diagrams for LAW 3 and LAW 4 are the owner's. The diagrams for LAW 1, 2 and 5 are drawn from the law text.

### LAW 1 — Extend before replacing — existing working code is the default survivor.

```
need ──► find the survivor ──► extend it ──► (proven insufficient?) ──► only then build new
                                   │
                    duplicate? ──► merge onto the survivor ──► delete the duplicate + tombstone "survivor file:line"
```

| Enforced by | Status |
|---|---|
| CLAUDE.md §1 (orphan doctrine, tombstones name the survivor). Lane notes open with "Already existed — reused". `test:orphan-exports` (a new export nothing wires fails), `test:orphan-routes`. | **Partial — by process, not by guard.** Nothing fails when a NEW module duplicates an existing survivor, and nothing checks that a tombstone's `file:line` exists. **Smallest enforcing guard:** `test:tombstone-survivor` — scan stripped comments for `TOMBSTONE` and fail when the named survivor path does not exist (positive control: a fixture naming a missing file). |

### LAW 2 — One canonical path — three systems doing one function consolidate toward ONE kernel service, never a fourth.

```
system A ─┐
system B ─┼──► ONE kernel service      (never: A, B, C ──► new D)
system C ─┘
```

| Enforced by | Status |
|---|---|
| One-definer checks per function: `test:provider-cost-routing` Layer 4 (only `property-lookup-rail.ts` defines the BatchData gate and the route table), `test:enrichment-one-rail`, `test:ai-gateway-lane` (one AI egress), `test:connector-gateway` / `test:egress-coverage` (one vendor egress), `test:vocabulary-drift` (one spelling, CLAUDE.md §6). | **Enforced where a one-definer guard exists.** No registry lists every kernel concept with its one file. **Smallest enforcing guard:** a `KERNEL_SURVIVORS` table (concept → the one file that defines its token, e.g. `withActionLedger`, `emitKernelEvent`, `routeCapability`, `dispatchEmail`) and one scan that fails when a second file defines the same token. |

### LAW 3 — Agents request capabilities, not vendors — AI ISA → ENRICH_PERSON → capability router → Versium / Provider B / Provider C.

```
AI ISA ──► ENRICH_PERSON ──► capability router ──► Versium
                                               ├─► Provider B
                                               └─► Provider C
```

| Enforced by | Status |
|---|---|
| The ONE route table `CONTACT_PROVIDER_ROUTES` and the router `routeCapability` (`lib/ai-isa/property-lookup-rail.ts`), which skips a provider in a `failing` cool-down (`lib/agentic-os/connector-gateway.ts::deriveProviderHealth`). `resolveContactProviderRoute` picks the order for one record. The AVM is the `property_valuation` capability: `lib/avm/provider-chain.ts::requestPropertyValuation` (RentCast primary, BatchData backup, health-aware, normalized result, each leg metered). Agents get tools by persona and risk class (`persona-tool-policy.ts` `selectToolsForPersona` / `riskClassForTool`), never a vendor key. | **Enforced for valuation and contact append.** `test:provider-cost-routing` Layer 10 (no `getRentcastAVM(` call outside its client and the capability; positive control), `test:connector-gateway` (failing RentCast falls to BatchData, healthy unchanged, cost metered, shape normalized). **Not yet routed:** the property RECORD lookup (`getPropertyRecordWithFallback`) and CMA comps still name RentCast then BatchData in code, without a health check; only the Versium leg of owner_contact reads health. **Smallest enforcing guard:** extend Layer 10's direct-call scan to `getRentcastPropertyDetailWithOutcome(` and `fetchBatchDataPropertyFallback(`. |

### LAW 4 — AI doesn't bypass business rules — AI manager → tool → authority → policy → capability → domain service → database/provider. Never LLM → SQL.

```
AI manager ──► tool ──► authority ──► policy ──► capability ──► domain service ──► database / provider
      ╳──────────────────────────────── never LLM ──► SQL ───────────────────────────────╳
```

| Enforced by | Status |
|---|---|
| Tool: `selectToolsForPersona`. Authority: `isToolAllowedAtAuthority` + `resolveAgentAuthorityLevel` (levels 0-6). Policy: `TOOL_APPROVAL_GATE`, `lib/providers/dispatch.ts` (autonomy, consent, suppression, DNC, quiet hours, budget), `autonomy-gate.ts`. Capability: LAW 3. Proofs: `test:persona-tool-realism` Layers R and A, `test:autonomy-gate`, `test:outbound-call-gates`. | **Enforced for tools and outbound.** **"Never LLM → SQL" is not yet enforced by a guard.** Measured 2026-10-03: no `.rpc("exec_sql" / "execute_sql" / "run_sql" / "sql")` in `app/` or `lib/` (blind spot: other RPC names, raw Postgres clients). **Smallest enforcing guard:** `test:no-llm-sql` — fail on a generic SQL RPC, `new Pool(`, `postgres(` or a `sql\`` template under `app/` `lib/` (stripped, positive-control fixture). |

### LAW 5 — Consequential actions leave evidence — who/what initiated, why, what evidence, which policy permitted, which tool, which provider, what it cost, what happened.

```
action ──► agent_action_ledger row
             who/what initiated  actor {type, userId, agentId, managerKey}
             why                 reason_code / reason_detail
             what evidence       causation_id / correlation_id + detail
             which policy        risk_class            (no explicit policy field yet)
             which tool          action
             which provider      provider / provider_ref
             what it cost        cost_usd
             what happened       status / outcome
```

| Enforced by | Status |
|---|---|
| `lib/kernel/action-ledger.ts::withActionLedger` (m687), causation (`lib/kernel/causation.ts`, `lib/kernel/emit.ts`), the flight recorder (`app/actions/flight-recorder.ts`, read at `app/dashboard/admin/ai-audit`). Spend: `ai_tool_usage` / `logAIUsage`, `meterVendorSpend`. Proofs: `test:action-ledger`, `test:ai-spend-booked`. | **Partial.** `withActionLedger` is called from `lib/providers/dispatch.ts` only (email, SMS, direct mail); `recordNonAction` ledgers the wait / do-nothing verdicts (`lead-action-plan.ts`, `conversion-welcome.ts`). Voice, push, portal and AI tool calls are not ledgered (principle 8). "Which policy permitted" has no field of its own (`risk_class` stands in). **Smallest enforcing guard:** a scan that every function returning a COMMUNICATION / FINANCIAL tool result (`riskClassForTool`) reaches `withActionLedger(`, with the unledgered list frozen as a ratchet. |

**Source.** No lane could read the owner's original 15-principle text. These 15 were rebuilt from the blueprint summary recorded in the wave 96 rulings and from the rulings already in force in `CLAUDE.md`. The owner should confirm or correct the wording. The enforcement column is measured from the code either way.

| # | Principle | Enforced by | Status |
|---|---|---|---|
| 1 | **Each step of the chain is its own thing.** The chain is Person → Relationship → Opportunity → Signal → State → Decision → Action → Outcome → Revenue → Learning. | `lifecycle_events` + causation (`lib/kernel/emit.ts`, m687), `agent_action_ledger` (`lib/kernel/action-ledger.ts`), `outcome_reconciliations` | **Partial.** There is no canonical Person record (gap map #15) and no decision → revenue link (#28). Proof: `test:action-ledger`. |
| 2 | **Providers sit behind OUR capability contracts.** No raw vendor shape leaks into the product. | `lib/agentic-os/connector-gateway.ts` (single egress + shape adapter), `lib/external/versium-client.ts` | **Enforced.** `test:connector-gateway`, `test:egress-coverage`, `test:enrichment-one-rail`. |
| 3 | **Buy only the gap.** The enrichment waterfall asks what is missing that could change the decision. | `property-lookup-rail.ts` `runVersiumContactLeg` / `PROPERTY_LOOKUP_RUNG_ORDER`, `versiumDemographicCategoriesNeeded` | **Enforced.** `test:provider-cost-routing`, `test:enrichment-one-rail`. |
| 4 | **Every enriched field carries provenance** (source, retrieved_at, confidence, purpose). | `enrichment_profile.field_provenance`, `enrichment-column-map.ts::fieldProvenanceForDisplay` | **Partial.** Only Versium and household financials stamp per field (gap map #4). |
| 5 | **Credentials are centralised** and never sit in an agent's context. | Vendor keys are read in the adapter only, plus `lib/agentic-os/agent-credentials.ts` | **Partial.** `test:ai-gateway-lane` A3 covers Versium and the AI providers. Other vendors are unresolved. |
| 6 | **Tools are small and risk-classed**, with approval by class. | `persona-tool-policy.ts` `riskClassForTool` / `TOOL_APPROVAL_GATE` / `isToolAllowedAtAuthority` | **Enforced at every mount.** `test:persona-tool-realism` Layers R and A. |
| 7 | **The policy engine is separate from the LLM.** The model proposes and domain services enforce. | `lib/providers/dispatch.ts` (autonomy, consent, suppression, DNC, quiet hours, de-confliction, budget), `lead-action-plan.ts` (NBA in code) | **Enforced for outbound.** `test:autonomy-gate`, `test:lead-action-plan`, `test:outbound-call-gates`. |
| 8 | **Every action is ledgered and idempotent, and reconciled against the provider.** | `withActionLedger` at `dispatch.ts` (email, SMS, direct mail), `outcome_reconciliations` | **Partial.** Voice, push, portal and AI tool calls are not ledgered yet. Nothing sweeps `unknown` rows (#11). |
| 9 | **Model routing follows task complexity**, through the AI Gateway. | `lib/ai/models.ts` `AI_TASK_ROUTING` + `toGatewayModel` | **Enforced.** `test:ai-gateway-lane`, `test:ai-routing-coverage`. |
| 10 | **"Wait" and "do nothing" are legitimate actions**, each with its reasons. | `planNextLeadTouch` (`wait` / `do_nothing` + `reasonsNotToAct`, including the wave 98 dead ends), `recordNonAction` | **Enforced for leads.** `test:lead-action-plan`. Contacts are **not yet enforced**. |
| 11 | **Controlled autonomy: humans own consequential actions.** | Authority ladder levels 0-6 (`resolveAgentAuthorityLevel`), COMMUNICATION needs level 3 or above, FINANCIAL needs level 6 and an approval gate, LEGAL and IRREVERSIBLE never; tenant and platform halts in `autonomy-gate.ts` | **Enforced (wave 98).** `test:persona-tool-realism` Layer A, `test:autonomy-gate`. |
| 12 | **The tenant comes from the session. Fail closed.** | `requireCallerTenant` / `getAgentContext`, `bookedGenerateObject` (session tenant only) | **Enforced.** `test:tenant-scope`, `test:conditional-tenant-predicate`, `test:ai-spend-booked` A5. |
| 13 | **One vocabulary per function.** | Live CHECK caches, `canonicalDeadEnd` (wave 98), `ACTION_REASON_CODES` | **Enforced where a guard exists.** `test:check-vocabulary`, `test:vocabulary-drift`, `test:lead-action-plan` DEAD-END-VOCAB. |
| 14 | **The cheapest adequate provider comes first, and every spend is booked.** The AI ledger is the invoice. | `CONTACT_PROVIDER_ROUTES` (sorted by cost, except the owner-ordered `property_valuation`), `routeCapability`, `logAIUsage`, `meterVendorSpend`, provider health routing around a `failing` provider | **Enforced, with frozen debt.** `test:ai-spend-booked` (4 files frozen, down from 27), `test:provider-cost-routing`. |
| 15 | **The live database is the source of truth.** Files are not the database. | Generated caches (`scripts/schema-snapshot.ts`, `check-vocabularies.ts`, `live-tables.ts`), "WRITTEN, NOT APPLIED" migration headers | **Enforced.** `test:schema-drift`, `test:schema-cache-drift`, `test:migration-claim`. |

## Principles under the laws (wave 99 reconciliation)

No principle restates a law. Each one is the specific rule a law is enforced through.

| Law | Principles under it |
|---|---|
| LAW 1 Extend before replacing | 15 (the live database is the truth: extend the schema that is there) |
| LAW 2 One canonical path | 13 (one vocabulary per function), 1 (one record per chain step) |
| LAW 3 Capabilities, not vendors | 2 (our contracts, not vendor shapes), 3 (buy only the gap), 4 (provenance per field), 5 (credentials centralised), 9 (model routing by task), 14 (cheapest adequate first, every spend booked — `property_valuation` is the one owner-ordered exception, RentCast before the cheaper BatchData, carried in `OWNER_ORDERED_CAPABILITIES`) |
| LAW 4 AI doesn't bypass business rules | 6 (small risk-classed tools), 7 (policy separate from the LLM), 10 (wait / do nothing), 11 (humans own consequential actions), 12 (tenant from the session, fail closed) |
| LAW 5 Consequential actions leave evidence | 8 (ledgered, idempotent, reconciled) |

## Not yet enforced anywhere

- Data **retention classes** per table.
- A **versioned domain API**.
- **Experiments and replay**.
- A brokerage **objective → mission** engine.

All four are marked MISSING or PARTIAL in `OS-BLUEPRINT-GAP-MAP.md` under "Planes not yet mapped".
