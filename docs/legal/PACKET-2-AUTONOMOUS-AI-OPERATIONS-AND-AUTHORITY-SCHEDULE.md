> **DRAFT — OWNER AND QUALIFIED LEGAL COUNSEL REVIEW — NOT APPROVED FOR USE**

# Packet 2 — Schedule 2: Autonomous AI Operations and Authority Schedule

Version: 0.1.0-draft (2026-11-09) · Document ID: VIP-LEGAL-P2 · Wave 151, lane 151A2 · Written against commit `b2c93720`

This Schedule is incorporated into the Platform Subscription and Services Agreement (Packet 1). Capitalized terms have the meanings given there. Where this Schedule and Packet 1 §8 differ, this Schedule controls (Packet 1 §24).

**How to read the code citations.** Every line that says the Service *does* or *does not* do something names the file and symbol that enforces or records it, written `path/to/file.ts::symbolName`. The proof `scripts/legal-packets-guard.ts` checks that each cited file exists in the tree and that each cited symbol is defined in that file, so a clause here cannot outlive the gate it describes without the build going red. Nothing in this Schedule describes authority the code does not have.

## Variables

| Variable | Meaning | Status |
|---|---|---|
| `[[PLATFORM_LEGAL_ENTITY]]` | The contracting platform entity (Packet 1). | OPEN |
| `[[SUBSCRIBER_LEGAL_ENTITY]]` | The subscriber (Packet 1). | PER-SUBSCRIBER |
| `[[SUBSCRIBER_BROKER_OF_RECORD]]` | The licensed broker responsible for the subscriber's real estate activity. | PER-SUBSCRIBER |
| `[[AI_DISCLOSURE_RULE]]` | The disclosure the subscriber's jurisdictions require when a consumer interacts with an automated system or receives AI-generated content; counsel supplies the rule per state. | OPEN |
| `[[INCIDENT_NOTICE_HOURS]]` | Platform's notice window for a confirmed incident affecting the subscriber (Packet 1 §12.6). | OPEN |
| `[[CHANGE_NOTICE_DAYS]]` | Days of notice before a change to the authority model or the approval gates takes effect. | OPEN |

---

## 1. Purpose and principles

1.1 This Schedule states what the Service's AI Managers may do for `[[SUBSCRIBER_LEGAL_ENTITY]]` without a person acting first, what they may only draft or propose, what they may never do, and which code gate enforces each line. It also states how the Service records what it did, how it recovers from its own failures, what its limits are, how a person stops it, and how Platform tells Subscriber when the model changes.

1.2 Five principles govern every clause below. They are the owner's architectural laws recorded in `docs/architecture/OS-CONSTITUTION.md` and are restated here as contract terms:

(a) **Agents request capabilities, not vendors.** An AI Manager asks for a capability (a valuation, a contact append, a map) and a router chooses the Provider; no manager holds a vendor key (`lib/ai-isa/property-lookup-rail.ts::routeCapability`).

(b) **AI does not bypass business rules.** A manager reaches data and Providers only through a tool, an authority check, a policy, a capability and a domain service, in that order; a model never writes to the database directly (`lib/ai-isa/persona-tool-policy.ts::selectToolsForPersona`).

(c) **Consequential actions leave evidence.** Every external action is ledgered with who or what initiated it, why, on what evidence, which policy permitted it, which tool and Provider were used, what it cost and what happened (`lib/kernel/action-ledger.ts::withActionLedger`).

(d) **Humans own consequential actions.** Communication to a person requires an authority level Subscriber sets; obligating money requires the highest level and a named human gate; signing, filing and irreversible acts are never available to a manager (`lib/ai-isa/persona-tool-policy.ts::MIN_AUTHORITY_FOR_RISK`).

(e) **Fail closed.** A gate that cannot run refuses; "nobody checked" is never rendered as "checked and fine".

## 2. The AI Managers and their domains

2.1 The governed managers are those in the manager registry (`lib/kernel/manager-registry.ts::MANAGERS`). Each has a domain of approved tasks:

| Manager | Domain of approved tasks |
|---|---|
| Deal Coordinator | Transactions and closings: deadlines, milestones, document checklists, party coordination. |
| Shopping Agent | The buyer journey: saved homes, alerts, showing requests, buyer education. |
| Listing Concierge | Sellers and listings: pre-listing research, listing packets, launch coordination. |
| Sphere Manager | Lifetime relationships with closed and past clients: anniversaries, touches, repeat and referral care. |
| Campaign Orchestrator | Multi-touch campaigns, newsletters, content and brand promotion. |
| Asset Manager | The media and brand library: renders, images, video, documents. |
| Ads Manager | Paid advertising: audiences, creative, budgets — within the fair-housing rules in Schedule 5. |
| AI ISA | Lead qualification, nurture and re-engagement; works Leads, never a human seat. |
| Data Steward | Data integrity, identity resolution, field stewardship, duplicates. |
| Recruiting Manager | Agent recruiting and talent pipeline for brokerage growth. |
| Compliance Officer | Fair housing, consent and regulatory governance findings. |
| Finance Manager | Commissions, brokerage profit and loss, back-office finance — reviews, never moves, money. |
| Cron Manager | Schedules, heartbeat and loop health. |

2.2 A platform-scope manager, the Platform Sentinel (`lib/kernel/manager-registry.ts::PLATFORM_MANAGERS`), watches the fleet of Subscribers for Platform's own staff. It drafts proposals for Platform staff; it never messages, notifies or acts on a Subscriber's Contacts.

2.3 The AI ISA is a system actor. Every ledger row it writes is attributed to the brokerage's AI ISA system identity, never to the agent beside it; a human who approves an ISA draft keeps the human as the actor (`lib/kernel/action-ledger.ts::withActionLedger`).

## 3. Tool risk classes

3.1 Every tool an AI Manager can call is classed (`lib/ai-isa/persona-tool-policy.ts::riskClassForTool`, over the table `lib/ai-isa/persona-tool-policy.ts::TOOL_RISK_CLASS`):

| Class | Meaning | Examples in the table |
|---|---|---|
| READ | Reads data; no side effect outside the Service. | lookups, searches, property and comparable reads, skip-trace reads (spend gated separately). |
| LOW_RISK_WRITE | Writes the Subscriber's own records or makes an internal hand-off that a person completes. | save a prospect, record a qualification, request an appointment or showing, schedule a callback, escalate to an agent, update a vendor's own availability, create a task, log an activity, stage a draft packet, campaign, open house, blog, podcast, video, direct-mail or ad campaign. |
| COMMUNICATION | Reaches a person outside the Service. | send a sign-up link, enroll in a newsletter, send a market report, send an explainer video (after human approval), send matching listings, send a portal message. |
| FINANCIAL | Obligates or moves money. | start a subscription (the person pays; the tool only emails a checkout). |
| LEGAL | Signs or files. | **No AI tool carries this class.** |
| IRREVERSIBLE | Cannot be undone. | **No AI tool carries this class.** |

3.2 **Unclassified means forbidden.** A tool name the table does not list and whose prefix does not state a pure read resolves to IRREVERSIBLE and never mounts (`lib/ai-isa/persona-tool-policy.ts::refuseUnmountableTools`). A new capability therefore cannot reach a manager by omission.

3.3 **Staged drafts are not sends.** Every `stage_*` tool writes a draft that a person must open and launch; nothing sends, mails, publishes or spends until the person does (`lib/wizard-staging/content-staging.ts`). An ad or direct-mail budget in a staged draft is a field, not a charge.

## 4. The authority ladder

4.1 Subscriber sets, for each AI Manager in its Tenant, one authority level from 0 to 6 (`lib/ai-isa/persona-tool-policy.ts::AUTHORITY_LEVEL_LABELS`). The level is stored as policy on the manager's configuration row, written only by Subscriber's broker or administrator (`app/actions/admin/manager-evals.ts::setManagerAuthorityLevel`) and read at every tool mount and every send (`lib/managers/autonomy-gate.ts::resolveAgentAuthorityLevel`). Every change is appended to the policy-version history with who changed it and why (`lib/kernel/tenant-policy.ts::appendTenantPolicyVersion`); a revert is a new version.

| Level | Label | What mounts | Effect on an outbound send |
|---|---|---|---|
| 0 | Read only | READ tools only. | Held. |
| 1 | Record (own records) | READ and LOW_RISK_WRITE. | Held. |
| 2 | Draft (a human sends) | Same as 1. | Every autonomous outbound send is held for a human in the approval queue. |
| 3 | Communicate | Adds COMMUNICATION tools. | Allowed, always through the outbound policy chain (§5). |
| 4 | Act and report | Same mount as 3 today (reserved rung; no extra capability in code). | As 3. |
| 5 | Act within budget | Same mount as 3 today (reserved rung; spend remains gated by the budget gates in §7). | As 3. |
| 6 | Full — consequential actions need human approval | Adds FINANCIAL tools, and only those with a named human-approval gate (§4.4). LEGAL and IRREVERSIBLE never mount. | As 3. |

4.2 **Default.** A manager with no recorded level operates at level 6 (`lib/ai-isa/persona-tool-policy.ts::DEFAULT_AUTHORITY_LEVEL`). Level 6 is today's behavior exactly: every tool that mounted before the ladder still mounts, and every consequential tool still sits behind its human gate. Subscriber may lower any manager at any time.

4.3 **The minimum rung per class** is fixed in code (`lib/ai-isa/persona-tool-policy.ts::MIN_AUTHORITY_FOR_RISK`): READ at 0, LOW_RISK_WRITE at 1, COMMUNICATION at 3, FINANCIAL at 6, LEGAL and IRREVERSIBLE never. The check that applies it is `lib/ai-isa/persona-tool-policy.ts::isToolAllowedAtAuthority`.

4.4 **The human-approval gates.** A FINANCIAL tool, and every COMMUNICATION tool, must have an entry in the approval-gate table (`lib/ai-isa/persona-tool-policy.ts::TOOL_APPROVAL_GATE`) naming the existing gate that stands in front of it. The entries as of this version are:

| Tool | Where the human or the policy chain stands |
|---|---|
| send_signup_link | The outbound dispatcher's policy chain (§5), addressed only to the prospect's own email or phone. |
| send_newsletter | Enrollment is refused on opt-out, unsubscribe or unverified email; each issue is delivered through the dispatcher's policy chain. |
| send_market_report | Answers condition and trend in conversation without a dollar figure; delivery rides the newsletter path above. |
| send_explainer_video | A compliance and AI-tell redraft runs before render; the row enters the unified approval queue as pending review and is delivered to the Contact only after a person approves it (`lib/kernel/approval-queue-aggregator.ts::applyMarketingAssetApproval`). |
| send_matching_listings | Writes a property-alert row for the person who asked; delivery runs through the dispatcher's policy chain. |
| start_subscription | A trial moves no money; a paid plan emails a checkout the prospect completes — the human approves by paying; enterprise or custom pricing hands off to a person. |
| send_portal_message | Staff session only; the Contact is re-read under the session's Tenant before the insert; the message lands in the Contact's authenticated portal inbox and no email or text leaves. |

4.5 **The protective exception.** The tool that records a person's do-not-contact request is honored at every level, including read-only (`lib/ai-isa/persona-tool-policy.ts::isToolAllowedAtAuthority`): a rung can withhold outreach, it can never withhold an opt-out.

## 5. Autonomous communications: the posture and the policy chain

5.1 **Autonomy posture.** Separately from the ladder, each manager carries an autonomy posture — autonomous, review recommended, or approval required (`lib/managers/eval-scoring.ts::AutonomyPosture`) — that Subscriber's broker may set as an override and that the Service otherwise derives from the manager's measured evaluation. The posture is consulted on every unattended send by the pure decision `lib/managers/autonomy-gate.ts::autonomyDecision`, in this order:

(a) a send with no governed manager behind it (a transactional notice, a vendor message, a system notice) is out of scope and never gated by posture;
(b) a send a human approved in the approval queue is never blocked (`lib/managers/autonomy-gate.ts::HUMAN_APPROVED_SYSTEM_SOURCE`) — the person already exercised judgment;
(c) the **platform halt** (§9.1) holds every autonomous manager action across all Tenants;
(d) the **Tenant halt** (§9.2) holds every autonomous manager action for Subscriber's Tenant;
(e) a manager whose **authority level** is below Communicate (3) is held;
(f) a manager on **approval required** is held;
(g) a manager on an explicit autonomous posture whose domain's **measured prediction accuracy** has not earned autonomy is held (`lib/managers/accuracy-gate.ts`);
(h) otherwise the send proceeds to the policy chain.

A held send is placed in Subscriber's approval queue with its reason; a person sends or discards it.

5.2 **The outbound policy chain.** Every email, text and direct-mail piece — autonomous or human-approved — leaves through one dispatcher (`lib/providers/dispatch.ts::dispatchEmail`, `lib/providers/dispatch.ts::dispatchSms`, `lib/providers/dispatch.ts::dispatchDirectMail`) that runs, outside the model and before any Provider is called:

| Gate | What it refuses | Code |
|---|---|---|
| Autonomy | A held posture, level or halt (§5.1). | `lib/managers/autonomy-gate.ts::resolveManagerAutonomy` |
| Consent | A channel the person never consented to, or a purpose the consent does not cover (advisory to the arbiter; the TCPA gate is the deterministic decision). | `lib/kernel/compliance/require-contact-consent.ts::answerConsentQuestion` |
| Suppression | An unsubscribed, opted-out or do-not-call flag on the Contact, a Tenant suppression row by contact, email, phone or mailing address, or a platform-wide suppression entry (spam complaint, litigator, federal do-not-call, explicit opt-out). | `lib/kernel/compliance/check-suppression.ts::checkSuppression`, `lib/platform/suppression-list.ts` |
| Do-not-call and TCPA | A number without express written consent for texts or calls, on the do-not-call list, flagged as a litigator, reassigned, or outside quiet hours; a stored verdict older than the staleness window is re-verified live, and an unconfigured verifier with a stale verdict refuses rather than assumes clean. | `lib/communication/tcpa-gate.ts::enforceTCPACompliance`, `lib/communication/tcpa-gate.ts::DNC_TCPA_SCRUB_STALENESS_DAYS`, `lib/communication/call-compliance.ts::checkQuietHours` |
| Content compliance | Fair-housing and consumer-protection violations in the content; a hard block refuses, a soft warning passes through with its audit row. | `lib/kernel/communication-compliance.ts::evaluateOutboundCompliance` |
| Content-safety backstop | A second, independent fair-housing check on an **unattended** send that hard-blocks; a human-approved send is flagged but allowed. | `lib/providers/content-safety.ts::contentSafetyBackstop` |
| De-confliction | Over-contact of one person across channels and senders within the window. | `lib/kernel/deconflict/index.ts::evaluateDeconflict` |
| Budget | Spend past the Tenant's vendor budget ceiling for the month (advisory and fail-open by design: a broken budget read never silences a compliant, consented message, and a compliance refusal never spends). | `lib/vendor-governance/budget-gate.ts::checkVendorBudget` |

5.3 **Outbound voice.** An AI-placed phone call runs a separate, ordered gate stack before any dial (`lib/voice/outbound-call-gates.ts::runOutboundCallGates`, used by `lib/voice/twilio-outbound.ts::placeOutboundAiCall`): autonomy; conversion finality (a Lead that has become a Contact is not a dial target); lead channel (an unconverted Lead is never dialed — Leads receive email and direct mail only); suppression; TCPA; de-confliction; vendor budget last so that money never masks a consumer-protection refusal. Nothing in the gate module can dial.

5.4 **Direct mail.** A mailer is checked against the suppression list by mailing address as well as by person, is printed on a blank layout carrying Subscriber's brokerage-of-record return address and never Platform's, and passes the address-verification gate before a Provider is paid (`lib/providers/dispatch.ts::dispatchDirectMail`).

5.5 **Waiting is an action.** When the next-best-action planner decides to wait or to do nothing for a Lead, that decision is recorded with its reasons as a ledger row (`lib/ai-isa/lead-action-plan.ts::planNextLeadTouch`, `lib/kernel/action-ledger.ts::recordNonAction`). An unanswered person is a decision Subscriber can read, not a silence.

5.6 **Disclosure.** Where `[[AI_DISCLOSURE_RULE]]` requires a consumer to be told they are interacting with an automated system or receiving AI-assisted content, Subscriber is responsible for enabling the disclosure the Service offers for that channel and for any disclosure the Service does not offer. The Service's writing passes remove machine tells from drafts and inject the brand voice; they do not remove a legally required disclosure.

## 6. Generated copy, estimates and decision windows

6.1 **Copy.** Every draft an AI Manager writes is conditioned on Subscriber's own voice settings from the first draft and passes the fair-housing writing directive before the model runs and the fair-housing check after (`lib/video/script-compliance.ts::precheckBriefForFairHousing`, Schedule 5 §4). A hard fair-housing flag escalates to a person; a warning passes through with its audit row. A claim of housing for older persons is verified against Subscriber's recorded exemption, never assumed (`lib/compliance/fair-housing-older-persons.ts::assessOlderPersonsClaim`).

6.2 **Property and market estimates.** A home value the Service shows is an automated valuation with a point, a range, a Provider and a retrieval time (`lib/avm/provider-chain.ts::requestPropertyValuation`). It is not an appraisal, a broker price opinion or a comparative market analysis unless a licensed person produces one. Comparable sales carry their source so a reader can tell a Provider record from a multiple-listing record. Nothing that reaches a licensed appraiser is authored by a model; the appraiser packet assembles documents and facts and coaches the agent (`lib/kernel/appraiser-packet.ts`).

6.3 **Readiness and decision windows.** The Service separates desire, expectation, feasibility, timing and confidence, and labels the evidence behind each as verified intent, expressed interest, inferred possibility, market-level opportunity, or stale and contradicted. A decision window is stated with its evidence and its uncertainty. A person's own statements outrank speculative enrichment; a Contact's type (buyer, seller, both) is never an intent signal; a vendor's propensity score is never a probability of closing; a public employer, permit or military event never creates a named-person Lead on its own. Timing is expressed in buckets (one to three months, three to six, six to twelve), never as a date the person did not give.

6.4 **Sensitive inferences.** No automatic outreach is triggered solely by a sensitive inferred circumstance (a divorce, a death, a financial distress signal). Such a signal may inform the choice of helpful content and the manager's recommendation; a person decides whether and how to reach out.

## 7. Spending and financial approval boundaries

7.1 **No manager moves money.** No tool obligates or transfers Subscriber's money. The one FINANCIAL tool (start a subscription) emails a checkout that the prospect completes; the prospect's payment is the approval.

7.2 **Provider spend is metered and capped.** Every Provider call is metered to the Tenant (`lib/vendor-governance/meter-vendor.ts::meterVendorSpend`) and checked against the Tenant's monthly vendor ceiling for its Tier (`lib/vendor-governance/budget-gate.ts::checkVendorBudget`). AI usage is booked per call on the AI usage ledger, which is the invoice (`lib/ai/cost-tracking.ts::logAIUsage`). A paid pull is approved before it runs, never after.

7.3 **Autonomy envelopes.** Where Subscriber grants a manager a period budget to spend without asking each time — the Ads Manager shifting part of a monthly budget between proven campaigns, the provider router buying enrichment above the per-decision cap for a high-value opportunity, the Asset Manager's renders per campaign, the Recruiting Manager's prospect data, experiments, auto-booked procurement — the spend goes through one atomic envelope check that refuses a zero envelope, refuses over the cap, and leaves a FINANCIAL ledger row whether it allowed or refused (`lib/kernel/autonomy-budgets.ts::consumeAutonomyEnvelope`, over `lib/kernel/autonomy-budgets.ts::AUTONOMY_ENVELOPES`). The default envelope is zero: recommendation only until Subscriber sets one.

7.4 **Entitlement first.** Before any gated capability runs, the Service asks whether Subscriber's subscription permits it and can afford it (`lib/billing/billing-access.ts::mayUseAndAfford`), failing closed on an unreadable subscription.

7.5 **Finance reviews; the OS never corrects money.** The Finance Manager reconciles and reports. A money discrepancy halts the writer and routes to Finance for a person's decision (`lib/kernel/os-health.ts::decideRecovery`). Accounting synchronization incidents receive a read-only diagnosis only. Platform's own merchant account and Subscriber's are distinct, and the resolver refuses rather than falls back when the right account is missing (`lib/billing/stripe-account-scope.ts::stripeAccountSideFor`).

## 8. Transactions, signatures and sensitive communications

8.1 **Signatures.** No AI Manager signs anything. E-signature requests are created by a person from a document the person has approved in the form wizard and are sent through the Tenant's own e-signature account (`lib/workflow/adapters/send-for-esign.ts`; the implemented providers are `lib/integrations/providers/catalog.ts::getEsignProviders`), resolved from the Tenant's own credential and never from a platform-wide one (`lib/integrations/providers/provider-resolver.ts::resolveTenantProviderCredentials`). A signature request is never re-sent blind by the self-healer; its documents may be re-pulled and its checklist recounted.

8.2 **Offers and contracts.** A manager may extract, summarize, compare and stage; it may not submit an offer, accept a counter, execute an addendum or release a contingency. An executed addendum updates the governing terms only when a person records the executed instrument.

8.3 **Stage moves.** Advancing a listing or transaction stage is a LOW_RISK_WRITE because the kernel validates prerequisites and blockers before the move and a person can move it back; it is never a filing with any outside body.

8.4 **Sensitive communications.** Communications about a pending transaction's terms, a party's financial position, a legal dispute, a license matter or a complaint are drafted for a person and are not sent autonomously. Compliance findings route to the Compliance Officer manager and to Subscriber's compliance staff, never to the Contact.

8.5 **Portal.** A message to a Contact's portal inbox is a staff-session action; the Contact is re-read under the session's Tenant before the write and nothing leaves by email or text from it.

## 9. Kill switches, halts and user overrides

9.1 **Platform halt (the red button).** Platform staff may set emergency mode or switch the AI engine off for the whole platform. Either freezes every autonomous manager action across all Tenants (`lib/platform/platform-controls.ts::resolvePlatformHalt`, read on the hot path by `lib/platform/platform-controls.ts::loadPlatformHalt`). The AI gateway also refuses generation while the engine is off. Human-approved sends are unaffected.

9.2 **Tenant halt.** Platform staff may pause autonomous AI for one Tenant by a staff-only feature override that no tenant-side write path can clear (`lib/managers/autonomy-gate.ts::loadTenantAutonomyHalt`, keyed by `lib/managers/autonomy-gate.ts::TENANT_AUTONOMY_FEATURE_KEY`). The staff-entered reason is shown to the Tenant. The Tenant's own autonomous setting cannot override it; only Platform lifts it.

9.3 **Subscriber's switches.** Subscriber's brokers and administrators may, at any time and without Platform's involvement: set any manager's posture to approval required; lower any manager's authority level to 0; freeze the experiments arm and the direct-mail exploration arm (`lib/kernel/tenant-policy.ts::TENANT_POLICY_SETTINGS_KEYS` keys `experiments` and `direct_mail_exploration`); disable or narrow a manager's enabled capabilities (`ai_agent_capabilities`); set every autonomy envelope to zero (§7.3); and record a Contact's opt-out, which is honored at once on every channel (`lib/kernel/compliance/check-suppression.ts::addSuppression`).

9.4 **Person-level overrides.** A Contact's STOP, unsubscribe, do-not-call request or portal preference withdraws the channel for every sender in the Tenant at the next send, and a platform-wide entry withdraws it for every Tenant. These are honored regardless of any manager's level or posture.

9.5 **Fail-open and fail-closed, stated honestly.** The halts and the posture read fail **open** on an infrastructure error (a transient database fault never freezes or unfreezes the platform by accident) because the consumer-protection gates in §5.2 have already run and each of those fails **closed** on its own read. The budget gate fails open by design (§5.2). Counsel should note the distinction when describing the system's behavior to a regulator.

## 10. Event and action evidence; auditability

10.1 **The action ledger.** Every external action an AI Manager or automation takes is one row in the action ledger (`lib/kernel/action-ledger.ts::withActionLedger`): the actor (a manager key, a user, an agent record or the system), the Tenant (the dispatcher's verified Tenant, never a request body), the subject, the action, the canonical reason code, the risk class, the causation and correlation identifiers that tie it to the event that caused it, the Provider and its reference, the cost, the status (proposed, executed, failed, unknown, skipped) and the outcome. An idempotency key gives at-most-once delivery; a timed-out Provider call is marked unknown and is never retried blind.

10.2 **Events.** Lifecycle and kernel events are emitted with causation (`lib/kernel/emit.ts::emitKernelEvent`) and feed the flight recorder Subscriber's administrators read (`app/actions/flight-recorder.ts`).

10.3 **Policy versions.** Every change to a Tenant operating policy — authority levels, autonomy postures, kill switches, routing, allocation, healing policy — is an immutable version row with the actor, the reason, the new value and the previous value; the database refuses updates and deletes of a version, and a revert is a new version (`lib/kernel/tenant-policy.ts::appendTenantPolicyVersion`).

10.4 **Compliance logs.** Consent is a ledger with scope (channels, purposes, wording hash, version, evidence, who gave it and when) (`lib/kernel/compliance/require-contact-consent.ts::persistContactConsent`); every TCPA decision on a call or text is logged for discovery and audit; every suppression check and content refusal leaves its row; every governed document access is logged (`lib/kernel/document-custody.ts::issueGovernedDocumentUrl`).

10.5 **Cost evidence.** AI cost and Provider spend are booked per call (§7.2). A wrong number on the AI ledger is a wrong invoice, and Platform treats it as such.

10.6 **Subscriber's access to evidence.** Subscriber's administrators may read the Tenant-scoped rows of these ledgers in the Service. Platform will provide a structured extract on reasonable request for a regulatory inquiry, a complaint or litigation hold.

## 11. Self-healing: what heals itself and what goes to a person

11.1 **The supervisor.** An operating-system health supervisor detects incidents and decides recovery through one decision point (`lib/kernel/os-health.ts::decideRecovery`, run by `lib/kernel/os-health.ts::runOsHealthSupervisor`). A transient failure on an idempotent action is retried up to a cap; a rate limit gets backoff; a failing Provider fails over through the capability router (`lib/agentic-os/connector-healer.ts::healProviderFailure`); a stuck workflow whose next step never started is resumed.

11.2 **The hard gate runs first.** Before any diagnosis, an incident touching money, a Tenant boundary, security, credentials, a legal rule, data deletion, a destructive schema change or an external action that could repeat is classified forbidden and routed to a person with the diagnosis attached and no automatic action (`lib/kernel/self-healing.ts::classifyForbidden`).

11.3 **Declared playbooks only.** The healer may select and parameterize only a declared playbook (`lib/kernel/self-healing.ts::SELF_HEAL_PLAYBOOKS`) from the list its domain allows (`lib/kernel/self-healing.ts::DOMAIN_PLAYBOOKS`); an invented action, an undeclared parameter or SQL in a parameter is refused (`lib/kernel/self-healing.ts::validatePlaybookSelection`). Direct mail is never re-mailed (postage is money). Accounting synchronization receives diagnosis only. Transactions and portal incidents receive notification and diagnosis only.

11.4 **Bounded attempts, bounded spend.** Playbook attempts per incident per day, the AI diagnosis spend per incident, and the confidence below which a fix waits for a person are Tenant policy under a platform ceiling (`lib/kernel/healing-policy.ts::loadHealingPolicy`, defaults in `lib/kernel/healing-policy.ts::HEALING_POLICY_DEFAULTS`, ceilings set only by Platform staff through `lib/kernel/healing-policy.ts::setPlatformHealingCeilings`). A tenant value may only demand more confidence, never less. After the attempt cap, the incident becomes a healing proposal for a person. A refused policy read resolves to zero attempts and zero spend.

11.5 **Code is never edited by the system.** A diagnosis whose fix is a production source edit becomes a governed change request for Platform staff (`lib/kernel/improvement-proposals.ts::GOVERNED_CHANGE_CLASSES`); no manager, healer or runtime path edits code, commits, deploys or applies a migration (`lib/kernel/self-healing.ts::troubleshootIncident`).

11.6 **Evidence.** Every healing step is ledgered with its cost and lands an incident row Subscriber's exception center shows.

## 12. Model and Provider limitations

12.1 **Models.** All inference runs through one AI gateway with per-Tenant cost tracking and the platform halt; Subscriber never holds a model key and Platform does not expose model identities in this Schedule. Model output may be wrong, out of date, biased or inconsistent between runs. Model routing by task complexity is Platform's and may change without notice where quality and cost are maintained.

12.2 **Providers.** A capability served by one Provider is unavailable while that Provider is down; a capability served by two fails over (`lib/agentic-os/connector-gateway.ts::deriveProviderHealth`). A research capability degrades gracefully with its reason recorded; a compliance capability with a single Provider (do-not-call scrubbing) sends the incident to a person rather than guessing. Provider data carries the Provider's own accuracy, currency and licensing limits (Schedule 3 §4).

12.3 **Dormant Providers.** A Provider the Service lists as dormant has no transport, makes no live calls and produces nothing until Platform activates it under a reviewed change (`lib/ai-isa/property-lookup-rail.ts::PROVIDER_ACTIVATION`); no manager or healer can flip that state.

12.4 **No fabrication.** An unconfigured or unavailable capability is reported as such. The Service does not fabricate a Provider response, an ingestion, a delivery, a payout status or an approval.

## 13. Incident escalation and change notification

13.1 **Incidents.** An incident the self-healer cannot resolve, or that the hard gate forbids, is handed to the accountable manager's humans in Subscriber's Tenant (`lib/notifications/brokerage-admins.ts::notifyBrokerageAdmins`) and, where it concerns Platform's operation, to Platform staff. Errors are collected to a central store for Platform's operations (`lib/errors/collect-error.ts::collectError`). A confirmed security incident is notified under Packet 1 §12.6 within `[[INCIDENT_NOTICE_HOURS]]` hours.

13.2 **Changes to this model.** Platform will give Subscriber at least `[[CHANGE_NOTICE_DAYS]]` days' notice through the Service's change log and status notice before (a) adding a tool to the COMMUNICATION or FINANCIAL class, (b) changing the minimum rung for any class, (c) adding or removing a human-approval gate, or (d) adding an acting playbook to a self-healing domain. A change that only narrows what the Service does autonomously may take effect on notice.

13.3 **Published mapping.** This Schedule's tables are published beside the version identifier of the Agreement. A change to the code that makes a table untrue fails the build until the Schedule is updated (`scripts/legal-packets-guard.ts`).

## 14. Subscriber's responsibilities under this Schedule

14.1 `[[SUBSCRIBER_BROKER_OF_RECORD]]` is responsible for setting each manager's authority level and posture appropriately for Subscriber's business and jurisdictions, for staffing the approval queue so held actions are reviewed promptly, for reviewing the flight recorder and exception center, and for every communication an AI Manager sends within the authority Subscriber granted.

14.2 Subscriber will not attempt to circumvent a gate, classify a tool, alter a policy row outside the Service's own settings, or grant a manager authority the Service does not offer.

14.3 Subscriber acknowledges that a lower authority level reduces what the Service does for it and that level 6 with a staffed approval queue is the configuration the Service is designed around.

---

> **Drafting note (not contract text) — what this Schedule deliberately does not claim.** (1) Levels 4 and 5 are reserved rungs with no extra capability in code; the table says so rather than inventing one. (2) The vendor budget gate fails open and is advisory; this is stated, not hidden. (3) Voice, push, portal and some AI tool calls are not yet ledgered through `withActionLedger` (the constitution records this as partial); §10.1 therefore says "every external action an AI Manager or automation takes" in the sense the dispatcher and the voice lane implement today, and counsel should decide whether to narrow it to "every outbound email, text and mailer and every AI-placed call" until the ledger coverage proof closes. (4) There is no field on the ledger named "policy permitted"; the risk class and the policy reference stand in. (5) The halts fail open on infrastructure error; the gates fail closed. These five points are listed in the review packet's risk summary.
