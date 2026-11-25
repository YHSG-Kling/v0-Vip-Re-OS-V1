# Wave 156 — the owner-held rows, adjudicated (recommendations, not rulings)

Lane 156M, 2026-11-25. Directive 156M ("Owner-held question resolution, not invented decisions"). **Owner-held stays owner-held.** Each row
below carries ONE recommendation from the six the directive allows, the code evidence (`file:line`, derived by
`scripts/os-coverage-ledger.ts --json` on the lane's tree), and the owner question in one plain sentence. Nothing here changes a census
state, the `OWNER_HELD` map, a baseline or a ratchet. `scripts/wave156-m-guard.ts` §F holds this table equal to the census's owner-held
set (derived, never pinned to a number) and checks that every row has exactly one recommendation.

The six recommendations: **observation-only** (an audit event with no downstream consumer by design) · **deterministic rule owner** (an
exact existing rule owns the decision) · **existing manager** (a registered manager acts, consumes and records) · **human/platform
authority** (a privileged act with a verified human decision and ledger — never an invented AI approver) · **wire-to-product** (a real
reachable UI / tool / cron, trigger and receipt) · **retire onto survivor** (remove a redundant dead endpoint only once the canonical
consumer is proven).

## Research (what the arbiter is, checked against published work — sources fetched 2026-11-25)

- **Policy decision point vs. policy enforcement point.** Open Policy Agent: "OPA decouples policy decision-making from policy
  enforcement" — the caller supplies structured input and enforces the returned decision
  (https://www.openpolicyagent.org/docs/latest/, fetched 2026-11-25). Here: the deciders (the follow-up arbiter, de-confliction, the
  envelope, the approval planes) RECORD a typed decision on `agent_action_ledger.detail.governance`; the sink (`sinkRule` in
  `lib/kernel/action-ledger.ts`) ENFORCES it with no model and no I/O.
- **Typed proposals, a deterministic authorization function.** Bhattarai & Vu, "Trustworthy Agentic AI Requires Deterministic
  Architectural Boundaries" (arXiv 2602.09947, Feb 2026, fetched 2026-11-25): the model proposes a typed action; "a deterministic,
  non-LLM policy checker evaluates σ using context (identity, session scope, labels, tool capabilities)"; the planner that reads
  untrusted input cannot execute privileged tools. Here: `ledgerToolCall` / `ledgerToolExecutions` set the trust class at the
  boundary and the model's own fields are recorded as `model_claims_ignored`, never read.
- **Scoped, budgeted, replay-proof capabilities; provenance fixed at ingress.** ToolFence (arXiv 2609.37196, Nov 2026, fetched
  2026-11-25): a deterministic monitor checks "workflow stage, evidence, scope, and budget before any action is reserved"; a
  violation "is denied and recorded for audit"; "tool output cannot approve the proposal or mint authority"; an unknown outcome stays
  held "pending reconciliation". Here: a carried decision is scoped (tenant, office), expiring, and bound to the facts it read
  (superseded on a changed version); the ledger's idempotency key makes a release at-most-once; `unknown` is never retried blindly.
- **Deterministic monitor + human approval + taint.** "Deterministic Policy Enforcement, Human Approval and Taint Tracking Against
  Prompt Injection in Tool-Using Agents" (arXiv 2611.11571, Nov 2026, fetched 2026-11-25): in-prompt guardrails erode, a task-bound
  deterministic monitor holds severe actions; "a human layer without a deterministic monitor fails against approval spamming". Here:
  the release classes (payout, CDA release) need a person's recorded decision or the typed decision they execute, and the rule runs
  BEFORE any human-facing queue.
- **Governance-first kernel.** "From Craft to Kernel" (Arbiter-K, arXiv 2604.18652, fetched 2026-11-25) — already the 155B3 reference
  (the model is a non-privileged proposal generator). Taken as RULES only; no runtime installed.
- **ECC (reference only, `plugins/ecc/`, read 2026-11-25):** `agents/loop-operator.md` (explicit stop conditions; escalate on no
  progress, repeated identical failures, cost drift), `skills/continuous-agent-loop` (freeze → audit → reduce scope → replay with
  explicit acceptance criteria), `skills/gateguard` (decide from gathered facts, never self-evaluation), `skills/agentic-os` (a routing
  kernel — NOT adopted: the existing kernel survives). Mapped onto the existing ledger: a refusal names its next trigger; an `unknown`
  send is reconciled before any retry; the late model result is evidence, re-judged on fresh facts.
- Not verified: no primary source was read for a production "arbiter kernel" product; vendor claims were not used.

## The standard action contract on the existing record

`source_event → verified scope/authority → policy decision → owning manager → typed proposed action → tool/worker → durable receipt →
readback → next event or terminal outcome → recovery`. Where each fact lives (no new table, no migration — m1055–m1059 unused):

| fact | where on the existing ledger row |
|---|---|
| decision id | the `agent_action_ledger.id` of the decision row; a later execution carries it as `ArbiterDecisionRef.id` (`decisionRefFromRow`) |
| policy version | `policy_ref` (`policy_key@version`, m700) |
| tenant & office scope | `brokerage_id` column; `detail.governance.scope.{brokerage_id, office_id, team_id, user_id}` |
| subject type / id | `subject_type`, `subject_id`, `detail.governance.entity` |
| known facts with provenance | `detail.governance.known_facts` (type / id / version read) + `dependency_fingerprint` |
| intent | `action` + `detail.governance.objective` |
| budget | `detail.governance.constraints.resource` (the envelope plane) + `cost_usd` |
| approval authority | `detail.governance.approval_basis` + `verification` (a named check or an authorized person) |
| idempotency key | `idempotency_key` (UNIQUE) + `detail.governance.replay` (`at_most_once` / `recorded_only`) |
| security provenance | `detail.governance.trust_class` (set by the boundary; three trusted, five untrusted classes) |
| dependency graph | `causation_id` / `correlation_id` + `known_facts` |
| human escalation | `detail.governance.approver` + `next_trigger.kind = human` |
| failure / replay decision | `status` (`failed` re-claims, `unknown` is reconciled first) + `next_trigger` |

## One accountable decider per conflict class (derived by `scripts/wave156-m-guard.ts` §D)

| conflict class | decider | survivor |
|---|---|---|
| same_contact | `ai_isa` | `lib/kernel/deconflict/index.ts` evaluateDeconflict |
| same_campaign | `campaign_orchestrator` | `lib/kernel/deconflict/index.ts` evaluateBroadcastDeconflict |
| competing_provider_spend | the envelope's ONE owner (`AUTONOMY_ENVELOPES[*].manager`) | `lib/kernel/autonomy-budgets.ts` consumeAutonomyEnvelope |
| same_transaction_terms | the delegation's assigned manager; the terms themselves have ONE writer (`lib/offers/governing-terms.ts`) | `lib/kernel/manager-delegation.ts` transitionDelegation |
| entity_version | the delegation's assigned manager | `lib/kernel/manager-delegation.ts` transitionDelegation |

Found and fixed: `same_contact` had TWO deciders at the starting commit (the AI ISA over touches, and a delegation's assignee when two
managers raced on a delegation ABOUT a contact). A delegation race is not a touch; it is now `entity_version`.

## The owner-held rows (72 — one per census owner-held row; recommendations: observation-only 25 · human/platform authority 17 · existing manager 11 · deterministic rule owner 10 · retire onto survivor 5 · wire-to-product 4)

| row | recommendation | evidence | owner question |
|---|---|---|---|
| `http:/api/admin/system/providers/test` | **human/platform authority** | app/api/admin/system/providers/test/route.ts:104 — a platform-role gate on its own path; recorded in the staff audit log | Should this platform-staff act stay a human platform act recorded in the staff audit log, with no AI manager performing it? |
| `kernel_event:agent_work_anniversary` | **deterministic rule owner** | lib/kernel/event-reactor.ts:4919 — the one award trigger, evidence-gated, under recruiting_manager | Does the deterministic award rule (LIFECYCLE_AWARD_RULES under recruiting_manager, evidence-gated) count as the decision owner, with a person able to revoke an award? |
| `kernel_event:brand_compliance_failed` | **existing manager** | scripts/event-claims-ledger.ts:26 — compliance_officer could hold the failed piece (the brand-scan writer is lib/kernel/brand-compliance.ts) | Should a failed brand scan become a compliance_officer hold on the piece instead of a record only? |
| `kernel_event:brand_compliance_passed` | **observation-only** | scripts/event-claims-ledger.ts:25 — the claims ledger's own reading: record? brand scan passed (lib/kernel/brand-compliance.ts); nothing must act on a pass | Is `brand_compliance_passed` a record that nothing needs to act on? |
| `kernel_event:buyer_broker_agreement_signed` | **deterministic rule owner** | lib/kernel/event-reactor.ts:4919 — the one award trigger, evidence-gated, under recruiting_manager | Does the deterministic award rule (LIFECYCLE_AWARD_RULES under recruiting_manager, evidence-gated) count as the decision owner, with a person able to revoke an award? |
| `kernel_event:buyer_disengaged` | **observation-only** | scripts/event-claims-ledger.ts:27 — the claims ledger's own reading: record? a buyer lifecycle state (lib/kernel/lifecycle.ts map); BUYER_STATE_CHANGED already reaches the concierges | Is `buyer_disengaged` a record that nothing needs to act on? |
| `kernel_event:buyer_search_executed` | **observation-only** | scripts/event-claims-ledger.ts:28 — the claims ledger's own reading: record? a buyer lifecycle state echo (same as above) | Is `buyer_search_executed` a record that nothing needs to act on? |
| `kernel_event:cda_generated` | **observation-only** | scripts/event-claims-ledger.ts:29 — the claims ledger's own reading: record? a CDA row was generated (app/actions/cda-portal.ts); approval is the CDA portal's own door | Is `cda_generated` a record that nothing needs to act on? |
| `kernel_event:ce_completed` | **deterministic rule owner** | lib/kernel/event-reactor.ts:4919 — the one award trigger, evidence-gated, under recruiting_manager | Does the deterministic award rule (LIFECYCLE_AWARD_RULES under recruiting_manager, evidence-gated) count as the decision owner, with a person able to revoke an award? |
| `kernel_event:competency_improved` | **deterministic rule owner** | lib/kernel/event-reactor.ts:4919 — the one award trigger, evidence-gated, under recruiting_manager | Does the deterministic award rule (LIFECYCLE_AWARD_RULES under recruiting_manager, evidence-gated) count as the decision owner, with a person able to revoke an award? |
| `kernel_event:contact_enrichment_completed` | **observation-only** | scripts/event-claims-ledger.ts:30 — the claims ledger's own reading: record? enrichment landed (lib/lead-pipeline/enrichment-orchestrator.ts); failure already routes (contact_enrichment_failed → ai_isa) | Is `contact_enrichment_completed` a record that nothing needs to act on? |
| `kernel_event:credit_status_updated` | **observation-only** | scripts/event-claims-ledger.ts:31 — the claims ledger's own reading: record? the credit status change (app/actions/credit-copilot.ts → logCreditStatusUpdated). Both orchestrator bodies are retired onto triggerCreditFlowActions (lane 155R24); is the lifecycle row the whole point (auditOnly: true), or must a manager act? | Is `credit_status_updated` a record that nothing needs to act on? |
| `kernel_event:deal_on_hold` | **observation-only** | scripts/event-claims-ledger.ts:32 — the claims ledger's own reading: record? a buyer lifecycle state echo (lib/kernel/lifecycle.ts) | Is `deal_on_hold` a record that nothing needs to act on? |
| `kernel_event:integration_failed` | **observation-only** | scripts/event-claims-ledger.ts:33 — the claims ledger's own reading: record? an admin's own integration TEST failed (app/api/integrations/test) — the admin is looking at the result | Is `integration_failed` a record that nothing needs to act on? |
| `kernel_event:lifetime_customer` | **deterministic rule owner** | lib/kernel/event-reactor.ts:4919 — the one award trigger, evidence-gated, under recruiting_manager | Does the deterministic award rule (LIFECYCLE_AWARD_RULES under recruiting_manager, evidence-gated) count as the decision owner, with a person able to revoke an award? |
| `kernel_event:lifetime_customer_touchpoint_sent` | **deterministic rule owner** | lib/kernel/event-reactor.ts:4919 — the one award trigger, evidence-gated, under recruiting_manager | Does the deterministic award rule (LIFECYCLE_AWARD_RULES under recruiting_manager, evidence-gated) count as the decision owner, with a person able to revoke an award? |
| `kernel_event:marketing_campaign_approved` | **observation-only** | scripts/event-claims-ledger.ts:34 — the claims ledger's own reading: record? the approval is decided by decideMarketingApproval (lib/kernel/approval-authority.ts); the event is its echo | Is `marketing_campaign_approved` a record that nothing needs to act on? |
| `kernel_event:mentor_session_held` | **deterministic rule owner** | lib/kernel/event-reactor.ts:4919 — the one award trigger, evidence-gated, under recruiting_manager | Does the deterministic award rule (LIFECYCLE_AWARD_RULES under recruiting_manager, evidence-gated) count as the decision owner, with a person able to revoke an award? |
| `kernel_event:offer_eligible` | **observation-only** | scripts/event-claims-ledger.ts:35 — the claims ledger's own reading: record? a buyer lifecycle state echo (lib/kernel/lifecycle.ts) | Is `offer_eligible` a record that nothing needs to act on? |
| `kernel_event:property_recommended` | **observation-only** | scripts/event-claims-ledger.ts:36 — the claims ledger's own reading: record? a buyer FAVORITED one of our listings (lib/kernel/forms.ts); the preference learner already runs inline | Is `property_recommended` a record that nothing needs to act on? |
| `kernel_event:referral_advanced` | **existing manager** | scripts/event-claims-ledger.ts:37 — sphere_of_influence already owns referral_received / referral_reciprocity | Should the Sphere Manager act on a referral stage change (a thank-you or a next step), or is the stage a record only? |
| `kernel_event:referral_converted` | **deterministic rule owner** | lib/gamification/lifecycle-awards.ts:485 — referralEvidenceTransaction requires a closed/funded transaction before the award | Does the deterministic award rule (LIFECYCLE_AWARD_RULES under recruiting_manager, evidence-gated) count as the decision owner, with a person able to revoke an award? |
| `kernel_event:report_emailed` | **observation-only** | scripts/event-claims-ledger.ts:39 — the claims ledger's own reading: record? a report was EMAILED (lib/kernel/reporting.ts emitEvent fans out; the financial.ts copy is already audit-only) — the send is the act | Is `report_emailed` a record that nothing needs to act on? |
| `kernel_event:report_exported_csv` | **observation-only** | scripts/event-claims-ledger.ts:40 — the claims ledger's own reading: record? a report was exported (lib/kernel/reporting.ts emitEvent fans out; the financial.ts copy is already audit-only) | Is `report_exported_csv` a record that nothing needs to act on? |
| `kernel_event:report_exported_pdf` | **observation-only** | scripts/event-claims-ledger.ts:41 — the claims ledger's own reading: record? a report was exported (lib/kernel/reporting.ts emitEvent fans out; the financial.ts copy is already audit-only) | Is `report_exported_pdf` a record that nothing needs to act on? |
| `kernel_event:report_generated` | **observation-only** | scripts/event-claims-ledger.ts:38 — the claims ledger's own reading: record? a report was generated (lib/kernel/reporting.ts emitEvent fans out) | Is `report_generated` a record that nothing needs to act on? |
| `kernel_event:seller_declined` | **existing manager** | scripts/event-claims-ledger.ts:42 — the Listing Concierge owns the seller relationship (recordSellerDecision) | Should the Listing Concierge schedule a respectful long-term nurture when a seller declines, or is the decline a record only? |
| `kernel_event:subscription_reminder_sent` | **observation-only** | scripts/event-claims-ledger.ts:43 — the claims ledger's own reading: record? a reminder was SENT (lib/billing/stripe-subscription-ops.ts) — the send is the act | Is `subscription_reminder_sent` a record that nothing needs to act on? |
| `kernel_event:tour_eligible` | **observation-only** | scripts/event-claims-ledger.ts:44 — the claims ledger's own reading: record? a buyer lifecycle state echo (lib/kernel/lifecycle.ts) | Is `tour_eligible` a record that nothing needs to act on? |
| `kernel_event:tour_planned` | **observation-only** | scripts/event-claims-ledger.ts:45 — the claims ledger's own reading: record? a buyer lifecycle state echo (lib/kernel/lifecycle.ts) | Is `tour_planned` a record that nothing needs to act on? |
| `kernel_event:user_account_incomplete` | **observation-only** | scripts/event-claims-ledger.ts:46 — the claims ledger's own reading: record? self-heal finding on dashboard load (app/dashboard/page.tsx) | Is `user_account_incomplete` a record that nothing needs to act on? |
| `kernel_event:user_account_repaired` | **observation-only** | scripts/event-claims-ledger.ts:47 — the claims ledger's own reading: record? self-heal outcome (lib/kernel/users.ts) | Is `user_account_repaired` a record that nothing needs to act on? |
| `kernel_event:user_brokerage_assigned` | **observation-only** | scripts/event-claims-ledger.ts:48 — the claims ledger's own reading: record? provisioning step (lib/kernel/users.ts) | Is `user_brokerage_assigned` a record that nothing needs to act on? |
| `kernel_event:user_domain_records_created` | **observation-only** | scripts/event-claims-ledger.ts:49 — the claims ledger's own reading: record? provisioning step (lib/kernel/users.ts) | Is `user_domain_records_created` a record that nothing needs to act on? |
| `kernel_event:user_domain_records_repaired` | **observation-only** | scripts/event-claims-ledger.ts:50 — the claims ledger's own reading: record? provisioning step (lib/kernel/users.ts) | Is `user_domain_records_repaired` a record that nothing needs to act on? |
| `kernel_event:user_invited` | **observation-only** | scripts/event-claims-ledger.ts:51 — the claims ledger's own reading: record? an invite was sent (app/actions/admin/invite-user.ts) — the send is the act | Is `user_invited` a record that nothing needs to act on? |
| `kernel_event:user_onboarding_completed` | **deterministic rule owner** | lib/kernel/event-reactor.ts:4919 — the one award trigger, evidence-gated, under recruiting_manager | Does the deterministic award rule (LIFECYCLE_AWARD_RULES under recruiting_manager, evidence-gated) count as the decision owner, with a person able to revoke an award? |
| `kernel_event:user_onboarding_started` | **observation-only** | scripts/event-claims-ledger.ts:52 — the claims ledger's own reading: record? onboarding started (lib/kernel/onboarding.ts); the onboarding-health sweep already watches stalls | Is `user_onboarding_started` a record that nothing needs to act on? |
| `kernel_event:user_onboarding_step_completed` | **deterministic rule owner** | lib/kernel/event-reactor.ts:4919 — the one award trigger, evidence-gated, under recruiting_manager | Does the deterministic award rule (LIFECYCLE_AWARD_RULES under recruiting_manager, evidence-gated) count as the decision owner, with a person able to revoke an award? |
| `orchestrator_event:transaction.closing_soon` | **human/platform authority** | lib/orchestrator/internal.ts:271 — a closing gift is spend (closing_gifts.price_cents); the consumer stays dormant | Will you set a tenant closing-gift policy (amount, who approves) so the closing-date approach may trigger a gift, or should the dormant consumer be retired? |
| `orchestrator_event:transaction.contingency_cleared` | **retire onto survivor** | lib/orchestrator/internal.ts:252 — nothing writes transactions.*_contingency_removed_at; the deadline monitor (lib/transactions/deadline-monitor.ts) is the survivor that watches contingency dates | May the dormant contingency-cleared consumer be retired onto the deadline monitor, since nothing produces the event? |
| `server_action:app/actions/admin/create-subscriber.ts#retrySubscriberInvite` | **human/platform authority** | app/actions/admin/create-subscriber.ts:221 — a platform-role gate on its own path; recorded in the staff audit log | Should this platform-staff act stay a human platform act recorded in the staff audit log, with no AI manager performing it? |
| `server_action:app/actions/admin/manager-evals.ts#completeRegionalConventionReview` | **existing manager** | app/actions/admin/manager-evals.ts:892 — typed as finance_manager's at lib/managers/regional-convention-review.ts:51 | Is the yearly regional closing-cost convention review the Finance Manager's act, as the code already types it? |
| `server_action:app/actions/admin/manager-evals.ts#overrideDeliberationWinner` | **human/platform authority** | app/actions/admin/manager-evals.ts:764 — recordPrincipalOverride writes the principal's call on the referral's manager_signals payload | Is a broker's override of a cross-manager deliberation a human authority act that no manager owns? |
| `server_action:app/actions/buyer-lifecycle-core.ts#executeBuyerStateTransition` | **existing manager** | app/actions/buyer-lifecycle-core.ts:98 — the Shopping Agent owns the buyer side | Is every buyer lifecycle transition the Shopping Agent's act, whatever state it lands in? |
| `server_action:app/actions/buyer-offers.ts#startOfferDraft` | **existing manager** | app/actions/buyer-offers.ts:120 — the Shopping Agent owns the buyer side of an offer | Is opening the offer wizard for a buyer the Shopping Agent's act? |
| `server_action:app/actions/communications.ts#addContactNote` | **retire onto survivor** | app/actions/communications.ts:391 — the live note door is app/actions/contacts.ts addContactNote; merge the external-CRM sync onto it first (orphan doctrine case 1) | Should contact notes still sync to the external CRM (merge that onto the live note door), so this unused namesake can be retired? |
| `server_action:app/actions/communications.ts#draftTeamAnnouncementAction` | **existing manager** | app/actions/communications.ts:684 — reference owner recruiting_manager; a model draft returned to the composer, telemetry only | Is drafting a team announcement the Recruiting Manager's act (agent communications), with the principal sending it? |
| `server_action:app/actions/communications.ts#notifyBrokerageAgentsAction` | **human/platform authority** | app/actions/communications.ts:553 — a principal's in-app announcement to the roster | Is a principal's announcement to the brokerage roster a human authority act that needs no manager owner? |
| `server_action:app/actions/content-compliance.ts#batchEvaluate` | **existing manager** | app/actions/content-compliance.ts:198 — reference owner compliance_officer | Is an explicit compliance evaluation the user asked for the Compliance Officer's act? |
| `server_action:app/actions/content-compliance.ts#evaluateCompliance` | **existing manager** | app/actions/content-compliance.ts:32 — reference owner compliance_officer | Is an explicit compliance evaluation the user asked for the Compliance Officer's act? |
| `server_action:app/actions/email-campaigns.ts#sendEmailCampaign` | **wire-to-product** | app/actions/email-campaigns.ts:456 — manual counterpart of the send-email-campaigns cron, waiting on a campaign management surface | Should the manual email-campaign send be wired to a campaign management screen (sends through dispatchEmail, receipt on the ledger)? |
| `server_action:app/actions/lead-intelligence.ts#resolveIdentity` | **retire onto survivor** | app/actions/lead-intelligence.ts:2498 — the automatic capture loop (trackBehavior → resolveSignalIdentity) already re-matches on arrival; lane 156F's visitor decision keeps anonymous visits anonymous | May the uncalled manual identity re-match be retired onto the automatic capture loop? |
| `server_action:app/actions/lifetime-customer-touchpoints.ts#calculateEngagementScore` | **wire-to-product** | app/actions/lifetime-customer-touchpoints.ts:296 — the ONLY writer of client_engagement_scores, which app/referrals/page.tsx reads | Should the engagement score be recalculated by the nightly sphere cycle (or a recalculate control), since its screen reads it? |
| `server_action:app/actions/listing-lifecycle.ts#scheduleListingAppointment` | **retire onto survivor** | app/actions/listing-lifecycle.ts:40 — createAppointment is the appointment survivor; merge the stage → APPOINTMENT_SET and listings.appointment_at writes onto it first | May the listing-appointment writes be merged onto createAppointment and this door retired? |
| `server_action:app/actions/newsletter/fetch-local-news.ts#fetchLocalNews` | **existing manager** | app/actions/newsletter/fetch-local-news.ts:11 — the Campaign Orchestrator stewards local_news_sources | Are a tenant's local news sources part of the newsletter the Campaign Orchestrator runs? |
| `server_action:app/actions/notifications.ts#markAllRead` | **human/platform authority** | app/actions/notifications.ts:115 — own rows only | Is a write pinned to the signed-in seat's own rows a human act that needs no manager owner (the session is the authority)? |
| `server_action:app/actions/notifications.ts#markNotificationRead` | **human/platform authority** | app/actions/notifications.ts:84 — own rows only | Is a write pinned to the signed-in seat's own rows a human act that needs no manager owner (the session is the authority)? |
| `server_action:app/actions/social/generate-social-post.ts#generateContextualDraft` | **existing manager** | app/actions/social/generate-social-post.ts:516 — a draft returned to the composer, compliance-checked, nothing published | Is a contextual social-post draft the Campaign Orchestrator's act? |
| `server_action:app/actions/superadmin/ai-ops.ts#replaySignalAction` | **human/platform authority** | app/actions/superadmin/ai-ops.ts:95 — a platform-role gate on its own path; recorded in the staff audit log | Should this platform-staff act stay a human platform act recorded in the staff audit log, with no AI manager performing it? |
| `server_action:app/actions/superadmin/ai-ops.ts#runCredentialRefreshAction` | **human/platform authority** | app/actions/superadmin/ai-ops.ts:85 — a platform-role gate on its own path; recorded in the staff audit log | Should this platform-staff act stay a human platform act recorded in the staff audit log, with no AI manager performing it? |
| `server_action:app/actions/superadmin/platform-announcements.ts#postPlatformAnnouncementAction` | **human/platform authority** | app/actions/superadmin/platform-announcements.ts:18 — a platform-role gate on its own path; recorded in the staff audit log | Should this platform-staff act stay a human platform act recorded in the staff audit log, with no AI manager performing it? |
| `server_action:app/actions/superadmin/platform-reception.ts#bindPlatformReceptionAction` | **human/platform authority** | app/actions/superadmin/platform-reception.ts:35 — a platform-role gate on its own path; recorded in the staff audit log | Should this platform-staff act stay a human platform act recorded in the staff audit log, with no AI manager performing it? |
| `server_action:app/actions/superadmin/platform-social.ts#startPlatformSocialConnectAction` | **human/platform authority** | app/actions/superadmin/platform-social.ts:72 — a platform-role gate on its own path; recorded in the staff audit log | Should this platform-staff act stay a human platform act recorded in the staff audit log, with no AI manager performing it? |
| `server_action:app/actions/superadmin/provider-posture.ts#getFullProviderPostureAction` | **human/platform authority** | app/actions/superadmin/provider-posture.ts:52 — a platform-role gate on its own path; recorded in the staff audit log | Should this platform-staff act stay a human platform act recorded in the staff audit log, with no AI manager performing it? |
| `server_action:app/actions/superadmin/secret-migration.ts#resealLegacyPlaintextSecretsAction` | **human/platform authority** | app/actions/superadmin/secret-migration.ts:15 — a platform-role gate on its own path; recorded in the staff audit log | Should this platform-staff act stay a human platform act recorded in the staff audit log, with no AI manager performing it? |
| `server_action:app/actions/superadmin/stripe-webhook-events.ts#registerStripeWebhookEventsAction` | **human/platform authority** | app/actions/superadmin/stripe-webhook-events.ts:58 — a platform-role gate on its own path; recorded in the staff audit log | Should this platform-staff act stay a human platform act recorded in the staff audit log, with no AI manager performing it? |
| `server_action:app/actions/transactions.ts#generateCostBreakdown` | **retire onto survivor** | app/actions/transactions.ts:923 — a MODEL-authored closing-cost estimate; the survivor is the deterministic calculator engine (lib/calculators/engine.ts, lane 156H) | May the model-authored cost breakdown be retired onto the deterministic closing-cost calculator, so no money figure is model-authored? |
| `server_action:app/actions/transactions.ts#updateTransaction` | **wire-to-product** | app/actions/transactions.ts:136 — the only door that corrects a deal's own details; the deal header (lane 156D's page) has no edit affordance | Should the deal header get an edit control for address / client name that calls this door with a receipt? |
| `server_action:app/actions/twin-scenario.ts#simulateTwinScenario` | **human/platform authority** | app/actions/twin-scenario.ts:69 — writes only its own evidence row; reads the twin through readBrokerageTwin | Is a write pinned to the signed-in seat's own rows a human act that needs no manager owner (the session is the authority)? |
| `server_action:app/actions/vendor-payments.ts#submitVendorInvoice` | **wire-to-product** | app/actions/vendor-payments.ts:301 — gated today; the vendor bills panel has createVendorInvoice beside it (lane 156N owns the file) | Should the draft → submit step be wired beside createVendorInvoice on the vendor bills panel? |
| `server_action:app/actions/workflows.ts#logUserActivity` | **human/platform authority** | app/actions/workflows.ts:940 — the seat's own session-start row | Is a write pinned to the signed-in seat's own rows a human act that needs no manager owner (the session is the authority)? |

## No-link rows reconciled (59 rows, derived from the census JSON)

The census reads these rows as `missing` links and classifies each from code (`scripts/os-coverage-ledger.ts` classify); they are not executable gaps:

- **54 × DECLARATIVE_READ_ONLY (kernel_event)** — every emission site passes `auditOnly: true` (lib/kernel/emit.ts shouldFanOut skips the reactor): the lifecycle_events row IS the record; no write, send or spend follows it
- **4 × SIMULATED_ONLY (http)** — fully linked in code; its caller is outside the app by design: a tenant's external MCP client holding a tenant-minted agent credential — recorded in docs/SERVICE-SECRETS.md, lib/agentic-os/mcp-tools.ts. In-repo proof drives the route with a constructed request; the live call needs that caller's own 
  - `http:/api/agentic-os/mcp` @ app/api/agentic-os/mcp/route.ts:89 — fully linked in code; its caller is outside the app by design: a tenant's external MCP client holding a tenant-minted agent credential — recorded in docs/SERVICE-SECRETS.md, lib/agentic-os/mcp-tools.ts. In-repo proof dri
  - `http:/api/v1/[resource]` @ app/api/v1/[resource]/route.ts:11 — fully linked in code; its caller is outside the app by design: a tenant's own integration holding a tenant-minted API credential (the endpoint is published on the developers settings screen) — recorded in app/settings/de
  - `http:/api/voice/relay/plan` @ app/api/voice/relay/plan/route.ts:23 — fully linked in code; its caller is outside the app by design: the relay companion process (tools/relay-companion), deployed beside the telephony provider and holding the relay secret — recorded in tools/relay-companion/
  - `http:/api/workflow/trigger` @ app/api/workflow/trigger/route.ts:71 — fully linked in code; its caller is outside the app by design: inbound provider webhooks registered in the provider's own console with the workflow webhook secret or a tenant signing secret — recorded in docs/SERVICE-SEC
- **1 × UNKNOWN (http)** — http: the caller may be outside the repo (provider console, external client, another scheduler) — unreferenced is not dead (CLAUDE.md §1)
  - `http:/api/errors/collect` @ app/api/errors/collect/route.ts:31 — http: the caller may be outside the repo (provider console, external client, another scheduler) — unreferenced is not dead (CLAUDE.md §1)

The 54 audit-only kernel events are proven by their emission sites (every one passes `auditOnly: true`, and `lib/kernel/emit.ts` shouldFanOut skips the reactor for those by design): they are records with a reader (the flight recorder), never orphaned work. The four outside-caller HTTP rows are fully linked in code with a caller outside the app by design (a tenant's own integration, the relay companion, an inbound provider); the one UNKNOWN HTTP row's caller may be a provider console or an external client — unresolved, not guessed (CLAUDE.md §1: unreferenced is not dead).
