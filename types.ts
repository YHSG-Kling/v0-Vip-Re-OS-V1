// UserRole — canonical string union sourced from lib/security/types.ts.
// The const object below preserves the legacy dot-access pattern (UserRole.ADMIN)
// used throughout the codebase while emitting the correct canonical values.
// Do NOT add new roles here — add them to lib/security/types.ts first.
export type UserRole =
  | 'superadmin'
  | 'admin'
  | 'broker'
  | 'team_lead'
  | 'agent'
  | 'isa'
  | 'tc'
  | 'compliance_officer'
  | 'vendor'
  | 'lender'
  | 'title_agent'
  | 'contact'

// Runtime accessor object — enables UserRole.ADMIN, UserRole.TC, etc.
// Values are always the canonical strings above.
export const UserRole = {
  SUPERADMIN: 'superadmin' as const,
  ADMIN: 'admin' as const,
  BROKER: 'broker' as const,
  TEAM_LEAD: 'team_lead' as const,
  /** @deprecated Use TEAM_LEAD. Kept for backward compatibility. */
  TEAM_LEADER: 'team_lead' as const,
  AGENT: 'agent' as const,
  ISA: 'isa' as const,
  TC: 'tc' as const,
  COMPLIANCE_OFFICER: 'compliance_officer' as const,
  VENDOR: 'vendor' as const,
  LENDER: 'lender' as const,
  TITLE_AGENT: 'title_agent' as const,
  CONTACT: 'contact' as const,
} as const

// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `PersonaType` deleted with
// the journey trio below — they were its only referencers, and it was a THIRD
// spelling of the persona idea (§6). The live persona vocabulary is the
// contacts/leads `persona`/`contact_persona` CHECK (scripts/check-vocabularies.ts)
// with labels in constants/crm-standards.ts (PERSONA_LABELS), and the buyer/seller
// side lives on contact_type/lead_type — never fused into one union.

// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `JourneyStage` deleted with
// the journey trio below (see the JOURNEY SYSTEM tombstone) — its only referencers.

export interface User {
  id: string
  name: string
  role: UserRole
  avatar?: string
  email?: string
  // Real fields from Supabase auth + users + agents tables:
  user_type?: string
  subType?: string          // contact_persona or agent sub-classification
  agentId?: string          // from agents.id where user_id = user.id
  contactId?: string        // for portal users: contacts.id
  vendorId?: string         // for vendor portal users: vendors.id
  teamId?: string           // from users.team_id
  teamIds?: string[]        // all teams this user belongs to
  brokerageId?: string      // from users.brokerage_id or role_assignments.brokerage_id
  managedAgentIds?: string[] // for team leads: agent IDs they manage
  playbookId?: string
  lastLogin?: string
  ownsProperty?: boolean
  searchCriteria?: any
  stats?: any
}

// --- AI TOOLS SUITE ---
// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `AIToolName` deleted with
// `SavedAIOutput` (below) — its only user. The live tool-name vocabulary is the
// tool registry in app/actions/ai-tools-hub.ts (executeAITool), spend-ledgered in
// ai_tool_usage.


// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `AIToolUsage` deleted — a
// camelCase restatement of the ai_tool_usage cost-ledger row that nothing referenced
// (verified on stripped, string-blanked source; positive control UserRole 112 refs).
// The row's one honest spelling is the writer executeAITool in
// app/actions/ai-tools-hub.ts (the ONE tool-run ledger writer per the
// ai_tool_tenanted_spend registry entry), held against the live schema by
// scripts/schema-snapshot.ts (ai_tool_usage).
// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `AIPromptTemplate` deleted —
// referenced by nothing. Prompts on this platform live in CODE on the gateway rail
// (lib/ai/models.ts MODEL_CONFIG + per-feature routing), not in a template table;
// the live ai_prompt_templates table itself has ZERO in-tree readers or writers and
// stays recorded on the opposite-missing wire list for the table-retirement lane.
// TABLE RETIRED (lane CD, 2026-08-28): m578 drops ai_prompt_templates — 0 rows, no
// triggers/procs/inbound FKs live-verified; prompts stay code-resident per §5.

// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `SavedAIOutput` deleted —
// referenced by nothing. The live saved-output row is saved_ai_outputs, written by
// lib/kernel/ai-tools.ts and read by services/supabaseService.ts.


// --- VOICE AI SYSTEM ---
// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `VoiceCommand` deleted — an
// aspirational voice-command row referenced by nothing. The live voice assistant is
// BUILT ANOTHER WAY: app/actions/voice-assistant/core/dispatch-command.ts (command
// dispatch + typed results, covered by test:voice-command-coverage), which carries
// its own intent vocabulary and persists to agent_assistant_sessions.

// --- FAIR HOUSING COMPLIANCE ---
// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche):
// `ComplianceContentType` deleted with `ComplianceFlag` below — its only
// referencer. One cluster, one decision.
// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `ViolationType`
// deleted with `ComplianceFlag` below — its only referencer (the FlaggedPhrase
// tombstone above kept it alive for exactly that reference).

// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `FlaggedPhrase` deleted —
// referenced by nothing. The live fair-housing violation shape is `RuleViolation`
// in lib/compliance-rules/rule-evaluators.ts (federal + state classes via
// lib/compliance-rules/state-fair-housing.ts, proof test:state-fair-housing);
// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `ComplianceFlag`
// deleted — a v0 mock shape referenced by nothing. The live fair-housing
// violation shape is `RuleViolation` in lib/compliance-rules/rule-
// evaluators.ts (proof test:state-fair-housing); outbound-communication
// compliance verdicts ride lib/kernel/compliance + the compliance ledger
// (test:compliance-ledger).

// --- USER MANAGEMENT SYSTEM ---
// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `PortalUser` deleted — a
// restatement of the users row referenced by nothing. The identity's one honest
// spelling is the live `users` table (scripts/schema-snapshot.ts) with roles from
// lib/security/types.ts; portal-side identity resolves through
// lib/kernel/portal.ts, never through this shape.
// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `UserActivity` deleted —
// referenced by nothing. The live activity write is logUserActivity in
// app/actions/workflows.ts (session-derived identity), with its own vocabulary.

// --- JOURNEY SYSTEM ---
// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `JourneyState`,
// `JourneyBlueprint` and `JourneyTool` deleted — camelCase restatements of the
// journey_states / journey_blueprints / journey_tools rows, referenced by nothing
// (stripped-source verified). The live journey lane reads journey_states through
// lib/kernel/portal.ts and lib/kernel/dual-intent-linker.ts, and the portal
// journey UI carries its OWN JourneyStage shape in lib/portal/persona-config.ts
// (rendered by app/portal/[contactId]/journey/page.tsx). `JourneyStage` (the
// "lead"→"post_close" union defined near the top of this file) is deleted WITH
// them — these three were its only referencers, and leaving it would mint a brand
// new orphan the census would rightly flag.

// --- TEAM & ISA SYSTEM ---
// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `DealTeamMember`
// deleted — referenced by nothing. The live deal team renders from transaction
// parties: app/components/portal/DealTeamCard.tsx (its own local role labels),
// parties on the transaction (test:parties-notify).

// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `AIISAActivity` deleted — a
// camelCase restatement of the ai_isa_activities row that nothing referenced. The
// live ISA activity ledger is written by app/actions/ai-isa/engage-contact.ts and
// app/actions/ai-isa/handle-inbound-email.ts, and its shape is held against the
// live schema by scripts/schema-snapshot.ts (ai_isa_activities).

// --- TRANSPARENCY SYSTEM ---
// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `TransparencyUpdate` deleted —
// referenced by nothing. The live transparency lane is transparency_updates (25
// call sites; writer/reader app/actions/transaction-transparency.ts).


// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `TransparencyVideo` deleted —
// referenced by nothing. Stage-explainer content rides the transparency lane
// (app/actions/transaction-transparency.ts) and the video lane (video_assets);
// the zero-code transparency_videos table (anon already off per m413) stays
// recorded on the opposite-missing wire list for the table-retirement lane.
// TABLE RETIRED (m581, 2026-08-28): dropped live — survivor video_assets.


// --- CORE OS ENHANCEMENTS ---
// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `OS_Event` deleted — an
// aspirational event-bus row referenced by nothing. The live event spine is the
// kernel: lib/kernel/events.ts (KernelEvent) + lifecycle_events rows
// (LIFECYCLE_EVENT_CONTRACT.md).


// TOMBSTONE (§1.3, 2026-08-28, lane E4 table-retirement tranche): `Playbook` deleted —
// imported by nothing (positive control: the finder still sees a synthetic
// `import { Playbook } from "@/types"` specimen). It mirrored the 030-era shape of
// the `playbooks` table, which m581 retires: the live playbook rows are plan_tasks
// (writer createPlaybook app/actions/services-config.ts:235, reader getPlaybooks
// :208, clone writer app/actions/academy.ts:cloneTemplate) and the cross-tenant
// library is template_marketplace, where m581 merges the seed rows.

// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `SmartAssistantSuggestion`
// deleted — referenced by nothing. The live suggestion row is
// smart_assistant_suggestions (18 call sites; app/actions/assistant.ts).


// --- COPILOT PLANS ---
// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `RelationshipPlan` +
// `PlanTask` deleted together — referenced by nothing. The live copilot-plan lane
// is copilot_plans + plan_tasks, written by generateCopilotPlan
// (app/actions/workflows.ts:129, called from app/crm/page.tsx).



// --- TRANSACTIONS ---
// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `TransactionMilestone`
// deleted — camelCase restatement of the live transaction_milestones row
// (app/actions/transaction-milestones.ts; shape held by scripts/schema-
// snapshot.ts), referenced by nothing.

// --- RELIABILITY / AUDIT ---
// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `AutomationError`
// deleted — restatement of the live automation_errors row (lib/errors/auto-
// retry.ts, surfaced by lib/platform/ai-ops.ts; proof test:automation-errors),
// referenced by nothing.

// --- ANALYTICS SYSTEM ---
// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `ListingEngagement` deleted —
// referenced by nothing. Live engagement telemetry is the property-interaction
// lane (property_views / property_interactions / qr_scan_events, per
// scripts/agent-fk-columns.ts) feeding seller reporting
// (lib/listings/seller-weekly-report-runner.ts); the zero-code listing_engagement
// table stays recorded on the opposite-missing wire list.
// TABLE RETIRED (m581, 2026-08-28): dropped live — the feed lives on the written
// primitives (property_views / saved_properties / listing_inquiries / showings).


// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `ListingMetrics`
// deleted — referenced by nothing. Live listing performance is MEASURED, not
// modeled: lib/listing-health/health-scorer.ts writes listing_health_scores
// from real showings/feedback/DOM rows.

// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `Listing` deleted —
// camelCase restatement of the live `listings` row (lib/kernel/listings.ts
// writers; shape held by scripts/schema-snapshot.ts), referenced by nothing.

// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `Deal` deleted —
// referenced by nothing. The live deal object is the `transactions` row with
// the m291 status ladder (lib/transactions/transaction-status.ts, proof
// test:deal-ladder).

// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `Lead` deleted —
// referenced by nothing (in-file "Lead" hits are string literals in other
// unions). The live lead is the `leads` row (lead-pipeline lanes; leads belong
// to the BROKERAGE, product ruling §5).

// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `ShowingFeedback`
// deleted — referenced by nothing. Live feedback lives ON the showings row
// (feedback, rating, buyer_interest_level under the love_it/like_it/maybe/no
// CHECK), read by lib/listing-health/health-scorer.ts.

// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `RealEstateEvent` deleted —
// referenced by nothing; the sibling of the EventRegistration tombstone below.
// Events live on open_house_events/open_house_attendees (lib/kernel/open-house.ts)
// and calendar_events; the real_estate_events table is retired by m578.


// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `PropertyUpgrade`
// deleted — scaffolding for a v0 surface that no longer exists, referenced by
// nothing. No live counterpart tracks per-property upgrades; if the product
// wants that capability it is a decision to make, not a type to keep.

export interface UserContext {
  userId: string
  lastLatLong: string
  predictedIntent: string
  clientName: string
  address: string
  lockboxCode: string
}

// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `FEATURE_FLAGS`
// deleted — three booleans (CREDIT_COPILOT / SYSTEM_LOGS / SUGGESTIONS) that
// no code ever consulted: a flag nothing reads gates nothing (§2 — it reads as
// control and controls nothing). Live capability gating is plan tiers
// (test:plan-catalog) and per-surface authz, never this const.

// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `PastClient` deleted —
// referenced by nothing. Past clients are `contacts` rows worked by the
// lifetime/returning-customer lanes (test:wealth-lifecycle, test:returning-
// customer), never a separate shape.

// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `CreditConversationLog`
// deleted — referenced by nothing. The credit lane lives at
// app/actions/credit-copilot.ts; the live credit_conversation_logs table has zero
// in-tree readers/writers and stays recorded on the opposite-missing wire list.
// TABLE RETIRED (lane CD, 2026-08-28): m578 drops credit_conversation_logs —
// survivors conversation_logs (logConversationMetadata) + activities; the credit
// lane's own rebuild (scripts/060:7) had already DROPped it and not recreated it.

// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `CreditPartnerReferral`
// deleted — referenced by nothing. The live referral row is
// credit_partner_referrals, written and read by app/actions/credit-copilot.ts
// (insert :367, board read :512); its status vocabulary is the table CHECK
// (referred|in_progress|completed|declined), not this type's four spellings.


// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `VideoEngagementEvent`
// deleted — referenced by nothing. The live row is video_engagement_events (8
// call sites; ingest door app/api/video/engagement/route.ts, read by
// app/actions/contact-details.ts and video-generation.ts).


// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `Script` deleted — a
// HeyGen-era mock (heygenAvatarId/heygenVoiceId; the platform renders through
// D-ID + ElevenLabs). Live video scripts ride the compliance-first script lane
// (test:video-script-compliance, test:script-compliance-first).

// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `ScriptStatus`,
// `TargetPersona`, `VideoMode` deleted with `Script` above — their only
// referencer. One cluster, one decision.

// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `VideoAssetLibraryRecord`
// deleted with its status vocabulary `VideoGenerationStatus` (below) —
// referenced by nothing. The live asset row is video_assets (21 call sites;
// app/actions/composition-library.ts, video-repurposing.ts, copilot.ts), whose
// status vocabulary is the live CHECK held by scripts/check-vocabularies.ts.


// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `VideoGenerationStatus` deleted
// with `VideoAssetLibraryRecord` (above) — one cluster, one decision.



// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `DocumentRegistryEntry`
// deleted — a Google-Drive-era registry shape (driveLink) referenced by nothing.
// The live document registry is the doc kernel: client_documents +
// document_classifications, filed by lib/documents/auto-filer.ts under the
// vocabulary in lib/compliance/document-classifications.ts (proof test:doc-kernel).

// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `TaskMasterTemplate` deleted —
// referenced by nothing. Task templating lives on the seeded template catalogues
// transaction_milestone_templates + listing_task_templates (SEEDED_REFERENCE in
// scripts/writerless-read-sweep.ts), consumed by app/actions/transaction-tasks.ts
// and transaction-milestones.ts.


// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `ComplianceRule` deleted —
// a three-field sketch referenced by nothing. The live rule row is compliance_rules
// (read by app/actions/services-config.ts, evaluated by
// lib/compliance-rules/rule-evaluators.ts; shape in scripts/schema-snapshot.ts).
// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `ContractTemplate` deleted —
// referenced by nothing. Contract templating rides the forms kernel
// (app/actions/forms-kernel.ts) and the dotloop template mapping in
// app/actions/dotloop-integration.ts; no in-tree contract_templates table exists.
// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `ComplianceReport` deleted —
// referenced by nothing. The live compliance reporting surface is
// app/compliance/reports (export-report-button.tsx) over compliance_checks rows,
// tenant-scoped per the compliance_checks brokerage_id fix (commit dd56fc92).

// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `SmartOffer` deleted — referenced by
// nothing. The live offer lane is the offers kernel:
// app/actions/offer-kernel-actions.ts + buyer-offers.ts over the offers tables.


// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `AudienceType` deleted
// — a Title-case second spelling, referenced by nothing. The live audience
// vocabulary is lib/kernel/ads.ts `AudienceType` + the audience lanes
// (test:audience-eligibility, test:audience-persona-basis).
// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `ContextType` deleted
// — referenced by nothing; outreach context lives in the live
// campaign/sequence vocabularies (campaign_sequence_steps.channel CHECK), not
// a display-string union.

// --- ADDED MISSING TYPES ---

// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `DetectedDefect` deleted —
// scaffolding for the long-deleted BuyerPortal.tsx, referenced by nothing. The live
// inspection-defect lane is app/actions/transaction-inspections.ts (inspection
// records + vendor quote flow on the transaction detail surface).

// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `MarketplaceVendor` deleted —
// scaffolding for the deleted BuyerPortal.tsx/PartnersManager.tsx, referenced by
// nothing. `Vendor` (this file) survives with live users; "featured" placement is
// the live vendor-premium-placement lane (app/actions/vendor-premium-placement.ts)
// and offers live on vendor_marketplace (app/actions/vendor-marketplace.ts).


// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `ResourceGuide` deleted —
// scaffolding for the deleted BuyerPortal.tsx, referenced by nothing. Client
// education material is the portal education lane (app/actions/portal-education.ts
// + education-kernel.ts).


// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `Showing` deleted —
// camelCase restatement of the live `showings` row
// (scheduled_date/status/buyer_interest_level; readers include lib/listing-
// health/health-scorer.ts, proof test:tour-checkin), referenced by nothing.

// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `CalendarSlot` deleted
// with `Showing` above — its only referencer. One cluster, one decision.

// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `ComplianceChecklistItem`
// deleted — scaffolding for the deleted BuyerPortal.tsx, referenced by nothing. The
// live checklist row is compliance_checklists, written by
// app/actions/workflows.ts:triggerComplianceChecklist and read by
// app/actions/ai-transaction-documents.ts.
// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `ESignEnvelope` deleted —
// scaffolding for the deleted BuyerPortal.tsx, referenced by nothing. E-sign status
// lives in the coordination vocabulary (lib/transactions/coordination-status.ts,
// ContractEsignStatus) fed by the docusign / authentisign / skyslope / dotloop
// webhook doors under app/api/webhooks/ (proof test:coordination-status).

// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `ClientReferral` deleted —
// scaffolding for the deleted BuyerPortal.tsx/SphereManager.tsx, referenced by
// nothing. Referrals live on the referrals lane (app/actions/referrals/) and
// referral_partners (app/actions/credit-copilot.ts:163 reads the partner side).


// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `NegotiationRound` deleted —
// scaffolding for the deleted BuyerPortal.tsx, referenced by nothing. Offer
// rounds live on the offers kernel and the counter-offer lane
// (app/actions/counter-offer-diff.ts, negotiation-copilot.ts).


// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `TransactionTask` deleted —
// scaffolding for the deleted BuyerPortal.tsx/ClosingDashboard.tsx, referenced by
// nothing. The live row is transaction_tasks (25 call sites;
// app/actions/transaction-tasks.ts), whose status/priority vocabularies are the
// table CHECKs, not this type's Title Case spellings.


// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `LoanStage` deleted —
// referenced by nothing. The financing milestones an agent chases live on the
// m291 transactions.status ladder (pending / clear_to_close —
// lib/transactions/transaction-status.ts); the lender portal reads
// transactions, not a parallel loan-stage union.

// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `Tour` deleted —
// referenced by nothing. Live buyer tours are the buyer-tours lane rows
// (test:buyer-tours, test:tour-checkin).

// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `TourStop` deleted
// with `Tour` above — its only referencer. One cluster, one decision.

// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `VideoAsset` deleted — scaffolding for
// the deleted MarketingStudio.tsx, referenced by nothing. The live asset row is
// video_assets (21 call sites; app/actions/composition-library.ts and siblings).


// TOMBSTONE (§1.3, 2026-08-28, lane CD): `ContentIdea` + `ContentIdeaType` +
// `ContentIdeaPlatform` deleted as ONE decision — the trio the CompetitorSnapshot
// tombstone below deferred "for a later tranche, together". All three were
// scaffolding for the deleted MarketingStudio.tsx; word-boundary search on
// stripped source finds ZERO references outside this file (positive control on the
// same run: SocialPlatform resolves in 3 live modules).
//   · ContentIdea → the row's one honest spelling is the LIVE content_ideas lane
//     (125 rows, tenant policy content_ideas_tenant): writer saveContentIdea
//     (app/actions/content-studio.ts:358), readers getContentIdeas/getSavedIdeas
//     + app/content-studio/content-studio-client.tsx, registry owner
//     campaign_orchestrator (lib/kernel/manager-registry.ts:1638).
//   · ContentIdeaType ("Educational"|"Local"|"Personal"|"Listing") → a second,
//     never-written spelling of content_ideas.content_type, whose live values are
//     snake_case ("social_post" UI default; live rows carry "video") — §6.
//   · ContentIdeaPlatform → the live platform vocabulary is SOCIAL_PLATFORMS /
//     SocialPlatform at lib/constants/index.ts:371 (the social publishing lane).

// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `CompetitorSnapshot` deleted
// — scaffolding for the deleted MarketingStudio.tsx, referenced by nothing. The live
// competitor lane is competitor_profiles / competitor_posts, written by the
// content-intel-scan cron (app/api/cron/content-intel-scan/route.ts) and read by
// app/actions/marketing-intelligence.ts. (`ContentIdea` above STAYS this tranche:
// deleting it would strand ContentIdeaType/ContentIdeaPlatform as new orphans —
// the trio is one decision for a later tranche, together.)

// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `Keyword` deleted —
// referenced by nothing. Keyword strategy lives in the SEO/GEO lane (test:seo-
// geo-consolidation, test:citation-share), not a v0 mock shape.

// ContentIdeaType and ContentIdeaPlatform deleted with ContentIdea — one trio,
// one decision; tombstone above at the ContentIdea site (lane CD, 2026-08-28).

// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `SocialTone` deleted with the
// `SocialContent` cluster — tone vocabulary lives with the social publishing
// lane's own prompt options (app/actions/social/generate-social-post.ts).


// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `LongFormVideo` deleted with
// `ShortClip`/`ClipPlatform`/`ClipDimensions` (below) — the MarketingStudio.tsx
// repurposing scaffolding, referenced by nothing. The live repurposing lane is
// app/actions/video-repurposing.ts over video_snippets (source assets in
// video_assets); the zero-code long_form_videos table (anon off per m413) stays
// recorded on the opposite-missing wire list.
// TABLE RETIRED (m581, 2026-08-28): dropped live — survivor ai_video_projects.


// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `ShortClip` deleted with `LongFormVideo`
// (above); clip platform/dimension vocabulary lives in
// app/actions/video-repurposing.utils.ts on the video_snippets lane.


// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `SourceType` deleted —
// referenced by nothing; video content types live in the video lanes' own
// CHECK-backed vocabularies (scripts/check-vocabularies.ts), not a three-value
// union.

// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `ClipPlatform` + `ClipDimensions`
// deleted with `ShortClip` (above) — one cluster, one decision.



// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `KeywordIntent`,
// `KeywordCategory` deleted with `Keyword` above — their only referencer. One
// cluster, one decision.


// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `SocialPlatform`
// deleted — a Title-case display spelling ("Instagram", "X") added for the
// deleted SocialScheduler.tsx. SURVIVOR: lib/constants/index.ts
// SOCIAL_PLATFORMS and its derived SocialPlatform (lowercase canonical values,
// validated by lib/services/social-publishing.service.ts). §6: labels are
// rendered from values, never stored beside them.

// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `NewsletterCampaign` deleted —
// scaffolding for the deleted MarketingStudio.tsx, referenced by nothing. The
// live campaign row is newsletter_campaigns (60 call sites;
// app/actions/ai-newsletter.ts, newsletter/schedule-newsletter.ts).


// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `DirectMailCampaign` deleted
// — scaffolding for the deleted MarketingStudio.tsx, referenced by nothing. The live
// row is direct_mail_campaigns, written/read by app/actions/direct-mail.ts (and the
// QR + approval lanes), shape held by scripts/schema-snapshot.ts.

// TOMBSTONE (§1.3, 2026-09-01, lane N4): `Prospect` deleted — a three-field
// compile stub added only to satisfy the since-deleted CRM.tsx ("Added to
// fix … has no exported member 'Prospect'"), referenced by nothing. The name
// lives on for a DIFFERENT subject: the platform growth funnel's prospect row
// (app/dashboard/superadmin/growth/platform-growth-board.tsx:19, a local
// interface over platform_prospects) — same word, unrelated shape; do not
// merge them.

// TOMBSTONE (§1.3, 2026-09-01, lane N4): `ScrapeJob` deleted — a two-field
// compile stub for the same deleted CRM.tsx, referenced by nothing. Scraping
// job records are the scraping lane's own: app/actions/lead-scraping-config.ts
// (createScrapingJob / updateScrapingJob over the scraping-jobs rail) owns
// that shape.

// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `SearchActivityLog` deleted —
// scaffolding for the deleted CRM.tsx, referenced by nothing. Search telemetry
// lives on property_search_log (app/actions/idx-search.ts).


// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `SocialLeadLog` deleted —
// scaffolding for the deleted CRM.tsx, referenced by nothing. Social-origin leads
// ride the signal-ingest lane (app/actions/lead-signal-ingest.ts,
// scrape-social-media.ts) into the brokerage lead board.


// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `Vendor` deleted —
// camelCase restatement of the live `vendors` row (lib/vendors lanes; shape
// held by scripts/schema-snapshot.ts), referenced by nothing.

// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `PointRule` + `ScoringWeight`
// deleted together — scaffolding for the deleted SystemConfig.tsx, referenced by
// nothing. Points live on the gamification lane (app/actions/gamification.ts over
// achievements/gamification_badges); lead-score weighting is the scoring lane
// (app/actions/ai-lead-scoring.ts).



// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `ComplianceLogEntry` deleted
// — scaffolding for the deleted SystemConfig.tsx, referenced by nothing. Phone
// compliance evidence lives on the scrub lane: lib/compliance/phone-scrub.ts +
// phone-scrub-runner.ts and the contact channel gate
// (lib/compliance/contact-channel-gate.ts; proofs test:phone-scrub,
// test:channel-preference).

// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `Agent` deleted —
// restatement of the live `agents` row, referenced by nothing. agents.id is
// DISJOINT from users.id (§3) — resolve through lib/kernel/agent-identity-
// resolver.ts, never a parallel shape.

// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `ChannelType` and
// `Message` deleted with `Conversation` below — their only referencer. One
// cluster, one decision.

// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `Conversation` deleted
// — scaffolding for the deleted UnifiedInbox.tsx, referenced by nothing. Live
// conversation history is served by app/actions/communications.ts
// getRecentCommunications + app/actions/contact-details.ts getContactActivity.

// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `SellerReport` deleted — scaffolding
// for the deleted SellerDashboard.tsx/ListingReports.tsx, referenced by nothing.
// The live weekly report is seller_weekly_reports, produced by
// lib/listings/seller-weekly-report-runner.ts and read by the seller portal
// (app/portal/[contactId]/listing/page.tsx).


// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `MarketStat` deleted —
// referenced by nothing. Live market facts are `market_data` rows (read by
// app/actions/home-value.ts with "unknown" as a real answer when no row covers
// the area).

// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `MarketingAsset` deleted —
// scaffolding for the deleted SellerDashboard.tsx, referenced by nothing. The
// live asset row is marketing_assets (37 call sites;
// app/actions/marketing-studio.ts, marketing/image-library.ts).


// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `OpenHouse` deleted — scaffolding for
// the deleted SellerDashboard.tsx/OpenHouseManager.tsx, referenced by nothing.
// The event row is open_house_events + open_house_attendees
// (lib/kernel/open-house.ts); m543 already retired the open_houses table twin.


// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `NetSheetScenario`
// deleted — referenced by nothing. Seller economics ride the seller-decision /
// CDA lanes (test:seller-decision, test:cda-flow), computed from the live
// commission engine, not a mock scenario shape.

// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `CommissionRecord`
// deleted — referenced by nothing. SURVIVOR: the live commission engine types
// in lib/commission/types.ts (CommissionCalculationResult, DistributionRecord)
// over commission_distributions (test:commission-ledger-sync).

// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `MarketingChannel`
// deleted — referenced by nothing. Live channel vocabularies are per-lane
// CHECKs (campaign_sequence_steps.channel; test:campaign-channels).

// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `Payout` deleted —
// referenced by nothing. Agent payouts are commission_distributions + the CDA
// flow (test:cda-flow, test:commission-finalization); commission is off agent-
// facing display (§5).

// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `TransactionDocument`
// deleted — restatement of the live transaction_documents row (doc kernel,
// test:doc-kernel; test:transaction-document-wiring), referenced by nothing.

// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `DocType` and `PrivacyLevel`
// deleted — scaffolding for the deleted Documents.tsx, referenced by nothing. The
// live document vocabulary is DocumentClassification in
// lib/compliance/document-classifications.ts (labels + side + signature-bearing
// rosters), applied by lib/documents/auto-filer.ts; document visibility is decided
// by the doc kernel's custody/access lane (lib/kernel/document-custody.ts), not by
// a three-value string.

// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `ClientPlaybookData` deleted —
// scaffolding for the deleted ClientPlaybook.tsx, referenced by nothing.
// `PlaybookStep` (below) survives with live users; guided client journeys live on
// the journey lane (journey_blueprints + app/actions/journey-tasks.ts).


// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `PlaybookStep` deleted
// — its parent `Playbook` was already deleted (tombstone above); steps live as
// workflow chains + sequence steps (lib/workflow-orchestrator/chains,
// campaign_sequence_steps).

// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `Review` deleted —
// referenced by nothing. Reviews/reputation ride lib/kernel/reputation.ts over
// the live review rows (test:openhouse-reputation-wiring).

// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `ReviewAndFeedback` deleted —
// scaffolding for the deleted SphereManager.tsx, referenced by nothing. Review
// collection lives on review_requests (12 call sites;
// app/actions/ai-review-automation.ts, reputation-kernel.ts) and NPS on
// app/actions/nps.ts.


// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `TaskRole` deleted — scaffolding for the
// deleted ComplianceManager.tsx, referenced by nothing. Transaction party roles
// live on the parties lane (lib/notifications/notify-helpers.ts,
// notifyTransactionParties) and transaction_tasks.assigned_to.


// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `AuditFlag` deleted —
// a v0 mock (leadName/transcriptSnippet), referenced by nothing. Live call
// risk facts are call_analyses rows (lib/voice/call-analysis.ts) and
// compliance verdicts ride the compliance ledger (test:compliance-ledger).

// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `VendorApplication` deleted —
// scaffolding for the deleted VendorCompliance.tsx, referenced by nothing. Vendor
// intake/verification lives on app/actions/vendor-invite.ts +
// vendor-verification.ts + vendor-w9.ts over the vendors lane.


// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `EventRegistration` deleted
// — scaffolding for the deleted Events.tsx, referenced by nothing. Event attendance
// on this platform is the open-house lane: check-ins through
// lib/kernel/open-house.ts (proof test:tour-checkin covers the tour sibling); the
// live real_estate_events table has zero in-tree readers/writers and stays recorded
// on the opposite-missing wire list.
// TABLE RETIRED (lane CD, 2026-08-28): m578 drops real_estate_events — survivors
// open_house_events/open_house_attendees (attendance) + calendar_events (dated,
// located, titled events with tenancy this table never grew).

// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `RoutingLog` deleted — scaffolding for
// the deleted LeadDistribution.tsx, referenced by nothing. Lead routing and its
// audit trail live on app/actions/lead-assignment/assign-lead.ts writing
// assignment_log.


// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `NotificationRule` deleted —
// scaffolding for the deleted NotificationSettings.tsx, referenced by nothing.
// The live rule row is notification_rules (lib/kernel/notification-rules.ts +
// notification-engine.ts, surfaced at app/dashboard/settings/page.tsx).


// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `NotificationPreference`
// deleted — scaffolding for the deleted NotificationSettings.tsx, referenced by
// nothing. Channel preferences ride notification_rules (above) and push
// subscriptions (app/actions/push-subscriptions.ts); the zero-code
// notification_preferences table stays recorded on the opposite-missing wire
// list for the table-retirement lane.
// TABLE RETIRED (m581, 2026-08-28): dropped live — the capability is the
// agents.notification_preferences COLUMN (plus contacts.metadata), the side
// consulted at send time.


// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `DealStakeholder` deleted —
// scaffolding for the deleted NotificationSettings.tsx, referenced by nothing.
// Transaction parties live on the parties-notify lane:
// lib/notifications/notify-helpers.ts (notifyTransactionParties, proof
// test:parties-notify) over the transaction's own party records.
// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `CommsAuditLog` deleted —
// scaffolding for the deleted NotificationSettings.tsx, referenced by nothing. The
// message ledger is the universal inbox kernel (lib/kernel/communications.ts,
// loadUniversalInbox/sendInboxReply) over the communications table.

// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `ReminderConfig` deleted —
// scaffolding for the deleted NotificationSettings.tsx (it even carried API keys
// as fields), referenced by nothing. Reminders live on the notification kernel
// (lib/kernel/notification-engine.ts) and calendar_events.deadline_notified.


// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `Closing` deleted —
// referenced by nothing. Closing lives ON the transaction (clear_to_close →
// closed → funded, lib/transactions/transaction-status.ts) orchestrated by the
// closing lane (test:closing-orchestration-integrity).

// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `ListingApproval` deleted —
// scaffolding for the deleted ListingApprovals.tsx, referenced by nothing.
// Listing risk review lives on app/actions/listing-risk-agent.ts and the
// compliance lane (compliance_checks); marketing approvals on
// app/actions/marketing-ai-approvals.ts.


// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `OHTemplate` deleted — scaffolding for
// the deleted OpenHouseManager.tsx, referenced by nothing. Open-house content
// generation lives on app/actions/open-house-automation.ts over the
// open_house_events lane.


// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `TagRule` deleted — scaffolding for the
// deleted SegmentationDesk.tsx, referenced by nothing. Segmentation lives on
// contact_segments (lib/workflow/adapters/segment-ops.ts,
// lib/marketing/email-campaign-sender.ts).


// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `AvailabilitySettings`
// deleted — scaffolding for the deleted CalendarDashboard.tsx, referenced by
// nothing. Calendar availability is managed by app/actions/ai-calendar-management.ts
// on the live calendar_events lane.
// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `FeedbackConfig` deleted —
// scaffolding for the deleted FeedbackDesk.tsx, referenced by nothing. Showing
// feedback flows through showings.feedback/rating read by
// app/actions/seller-showing-sentiment.ts (lib/behavior-learning/signal-mapping.ts
// tourInterestToRating), and seller sharing is governed there — not by a flag.

// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `RiskIncident` deleted — scaffolding
// for the deleted RiskManagement.tsx, referenced by nothing. Conversation-risk
// escalation lives on conversation_audit_flags
// (app/actions/conversation-analytics.ts) and deal risk on
// app/actions/deal-risk-agent.ts / deal-shaky.ts.


// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `SocialContent` deleted with
// `SocialCategory`/`MediaFormat` (below) and `SocialTone` — SocialScheduler.tsx/
// MarketingStudio.tsx scaffolding, referenced by nothing. The live lane is
// social publishing (app/actions/social-publishing.ts,
// social/generate-social-post.ts) with the SOCIAL_PLATFORMS vocabulary at
// lib/constants/index.ts:371. `SocialPlatform` here survives — it has live users.


// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `SocialCategory` + `MediaFormat`
// deleted with `SocialContent` (above) — one cluster, one decision.



// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `AgentVideo` deleted —
// scaffolding for the deleted VideoGenerator.tsx, referenced by nothing. Agent
// videos ride the Director rail (ai_video_projects; commissionVideo) and the intro
// lane's own agent_intro_videos rows (welcome/anniversary delivery proofs
// test:welcome-avatar-video, test:anniversary-video-delivery).

// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `Recruit` deleted —
// referenced by nothing. Live recruiting rides lib/recruiting/* over its own
// rows (test:recruiting-roi wiring, leaderboard/retention lanes).

// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `SyndicationLink` +
// `SyndicationError` deleted together — scaffolding for the deleted
// ListingDistribution.tsx, referenced by nothing. Syndication is the listing
// execution lane (app/actions/seller-listing/execution-engine.ts, emitting
// seller.listing.syndicated at :1832).



// --- MISSING INTERFACES FOR FINANCIALS AND CLIENT SELF-SERVICE ---

// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `ClientDocument`
// deleted — restatement of the live client_documents row (doc kernel: filed by
// lib/documents/auto-filer.ts, proof test:doc-kernel), referenced by nothing.

// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `ShowingRequest`
// deleted — referenced by nothing. Showing requests are the live showings/tour
// lanes (test:buyer-tours), not a portal mock shape.

// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche):
// `CommissionCalculation` deleted — a v0 restatement, referenced by nothing.
// SURVIVOR: lib/commission/types.ts CommissionCalculationResult, the type the
// waterfall engine (lib/commission/engine.ts) actually returns.

// TOMBSTONE (§1.3, 2026-08-27, lane CB orphan tranche): `BusinessExpense` deleted —
// scaffolding for the deleted FinancialsView.tsx, referenced by nothing. The live
// row is business_expenses, written/read by app/actions/financials.ts and the tax
// lane (app/actions/tax-planning.ts), shape held by scripts/schema-snapshot.ts.

// TOMBSTONE (§1.3, 2026-08-31, lane M4 census tranche): `TaxProjection`
// deleted — scaffolding for a v0 surface, referenced by nothing. No live
// counterpart projects agent taxes; if the product wants that capability it is
// a decision to make, not a type to keep.

// TOMBSTONE (§1.1/§1.3, 2026-09-01, lane N3a): `InsiderEditVibe` /
// `InsiderEditInput` / `InsiderEditSection` / `InsiderEditNewsletter` deleted —
// their ONLY consumers were the app/api/ai/insider-edit-{generate,rewrite-
// section,save} route trio, deleted the same day (no UI ever addressed them).
// SURVIVORS for the capability: the curator voice + section direction + tone
// pass live in lib/newsletter/insider-edit.ts, selected as the "insider"
// template of app/actions/ai-newsletter.ts:aiWriteNewsletterContent, whose
// NewsletterSection/generateObject schema is the one section shape (§6 — two
// section vocabularies for one newsletter lane was the defect); the save half
// is createNewsletterCampaign in the same file, which now carries the trio's
// upsert-by-id edit semantics.

// TOMBSTONE (§1.3, 2026-08-28, lane CD census tranche): `ListingAnalysis` deleted —
// referenced by nothing. (Its tombstone used to name the insider-edit route as
// the live consumer of the InsiderEdit* types; both the route trio and those
// types are gone as of 2026-09-01 — see the tombstone above.) Listing scoring
// lives on lib/listing-health (health-scorer) and app/actions/predictive-listing.ts.


export type {
  Contact,
  ContactType,
  ContactPersona,
  ContactStatus,
  ContactTimeline,
  ContactSource,
  ContactFilters,
  // `PropertyInterest` left this list 2026-09-01 — the interface was deleted
  // from types/contact.ts with its tombstone (zero importers; the fact lives
  // on leads.property_interest + the property_interests child table). The
  // BuyerPropertyInterest family in lib/kernel/forms is a different subject.
} from "./types/contact"
