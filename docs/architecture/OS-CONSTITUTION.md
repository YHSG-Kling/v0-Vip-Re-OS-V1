# OS constitution (wave 98, lane 98C)

These are the rules the platform runs on. Each one names the code or proof that enforces it, or says **not yet enforced**.

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
| 14 | **The cheapest adequate provider comes first, and every spend is booked.** The AI ledger is the invoice. | `CONTACT_PROVIDER_ROUTES` (sorted by cost), `logAIUsage`, `meterVendorSpend`, provider health routing around a `failing` provider | **Enforced, with frozen debt.** `test:ai-spend-booked` (4 files frozen, down from 27), `test:provider-cost-routing`. |
| 15 | **The live database is the source of truth.** Files are not the database. | Generated caches (`scripts/schema-snapshot.ts`, `check-vocabularies.ts`, `live-tables.ts`), "WRITTEN, NOT APPLIED" migration headers | **Enforced.** `test:schema-drift`, `test:schema-cache-drift`, `test:migration-claim`. |

## Not yet enforced anywhere

- Data **retention classes** per table.
- A **versioned domain API**.
- **Experiments and replay**.
- A brokerage **objective → mission** engine.

All four are marked MISSING or PARTIAL in `OS-BLUEPRINT-GAP-MAP.md` under "Planes not yet mapped".
