# FK-child transfer classification

Written in wave 145, lane 145A, for owner ruling 24 (2026-10-27).

> "Parent/child: do NOT move all 286. Classify each FK child relationship (ownership follows parent · shared relationship remains · historical reference immutable · explicit transfer required · not transferable · derived/read-only) on real domain definitions and tenant policy; never transfer another party's contacts, confidential documents, financial records or unrelated brokerage property because an agent changes brokerage; code-level checks and tests now, live transfers only on explicit authorization."

**Rail:** `lib/kernel/brokerage-transfer.ts`. This is the ONE explicit transfer rail: an independent subscriber's workspace is adopted by a brokerage.

**Data:**
- `FK_CHILD_TRANSFER_CLASSIFICATION` — one class per child table, with the rule that decided it;
- `CHILD_TRANSFER_CLASS_MEANING`;
- `TRANSFER_AUTHORIZED_FOLLOWING_CHILDREN` — empty;
- `TRANSFER_SAFETY_CRITICAL_CHILDREN`.

**Proof:** `scripts/transfer-classification-guard.ts`, as `test:transfer-classification`.

## What "the 286" are

The census is derived and never listed by hand. It starts from every live foreign key in the generated FK cache (`scripts/schema-fk-map.ts`) that points into one of the 32 `TRANSFER_DATA_FAMILIES` tables. It keeps only FKs whose child table is not itself a family. That gives 306 child tables and 432 FKs:

- **286 tables** carry `brokerage_id`. These are wave 144's "286 unmoved FK children", with 411 FKs.
- **20 tables** have no tenant column (21 FKs). Their tenancy is their parent's, so they follow it implicitly; the class records what they are.

A further 59 FKs run between two families. Both ends move in the data step, so they are `follows_parent` by construction.

Re-measured live on 2026-10-27 from `pg_constraint` (single-column FKs): 491 FKs in total, 59 between families, 306 child tables and 432 child FKs. This matches the cache exactly.

The cache does not cover two kinds of children:
- children of the **membership** movers (`users`, `agents`, `teams`). The rail moves those through the canonical user services and the team step, not through this census.
- team form packets. The rail moves them explicitly with their team (`brokerage_form_library.team_id`, wave 144I).

## The six classes and what the rail does with each

| Class | Meaning (the definition each table is held to) | What the rail does |
|---|---|---|
| `follows_parent` | Part of the parent's own record: its sub-records, its workflow state, the client's stated preferences, and the agent's work product on it. | Moved **only** once the owner authorizes the table (`TRANSFER_AUTHORIZED_FOLLOWING_CHILDREN`, empty). An authorized table is moved exactly like a family: pinned to the source, counted, with a post-condition. |
| `shared_remains` | A relationship with another party: a vendor of the source bench, an outside agent, a title company's users, a referral or credit partner, a deal-team member's portal grant. | Never moved. The target re-establishes its own. |
| `historical_immutable` | What the source did: communications sent under its sender identity and consent basis, outreach, deliveries, observed events, audit and evidence (LAW 5), jobs. | Never moved, never edited. Kept with the archived source and readable by platform staff. |
| `explicit_transfer` | Another person's rights, or the source brokerage's executed contract: consent, privacy requests, the client's own financial data, a listing or buyer-broker agreement, confidential deal documents. | Never moved by the rail. Rows left behind are **counted** and routed to the Data Steward for a per-transfer decision (plan below). |
| `not_transferable` | Money, billing and usage, the supervising broker's compliance file, ad-account property, bearer tokens. | Never moved, and never crosses tenants. |
| `derived_readonly` | Computed from the parent: scores, predictions, health, insights, matches, AI drafts and plans, provider enrichment and scrapes, queues. | Never moved. Recomputed, re-enriched or re-planned in the target from the moved parent. |

## The owner's transfer vocabulary, with its domain evidence (wave 146, lane 146A)

Wave 146 named the rulings in six words: **owned / shared / historical evidence / nontransferable / membership-dependent / authorized copies**. Four are the classes above under their owner names. Two are not row classes at all: *membership-dependent* is about **access** (who may read a record while it stays where it is), and *authorized copies* is about **how** something reaches the target without moving (a copy, with the original kept). Each word below names its class or mechanism, the code that enforces it, and the business rule it rests on. The rules were checked against `.claude/skills/real-estate-expert` (Standards: RESPA, NAR Code of Ethics, transaction and document management) and CLAUDE.md §4–§5; no state-specific rule was invented — where state law varies (record retention periods, trust-account rules), the procedure names who decides and leaves the law to them.

| Owner's word | Class / mechanism | Enforced by | Domain evidence |
|---|---|---|---|
| **owned** | `follows_parent` | `TRANSFER_AUTHORIZED_FOLLOWING_CHILDREN` (moves only on authorization); verification `child_classification` | The deal, listing and client files are the parent's own record (milestones, the client's stated preferences, the agent's work product). They belong to whoever owns the parent, but ruling 24 still requires the owner's authorization before they move live. |
| **shared** | `shared_remains` | never named for moving; verification refuses it | A vendor bench, a title company's users, an outside agent and a referral partner contracted with the SOURCE brokerage. The counter-party never agreed to the adopting brokerage; the target re-establishes its own relationship. |
| **historical evidence** | `historical_immutable` | never moved, never edited; readable by platform staff | Communications carry the sender identity and consent basis they were sent under (TCPA / CAN-SPAM evidence); audits and ledgers are LAW 5 evidence. Rewriting their tenant would falsify who did what. |
| **nontransferable** | `not_transferable` | verification refuses it, even through the proof seam | Money (commission, trust / earnest money — RESPA and state trust-account rules bind the brokerage that holds it), billing and usage, the supervising broker's compliance file (record retention binds the brokerage that supervised), ad-account property, bearer tokens. |
| **membership-dependent** | ACCESS, read at query time | `supabase/migrations/m874-…sql` path rules (storage) and m854 (forms); the rail's team-packet step | Access that belongs to a person's CURRENT role, not to a row: an agent's licence and E&O certificate (`agent-documents/{user}/…`) are read by the oversight class of the agent's current brokerage, because the employing broker supervises the licensee; a vendor's access to a deal ends when its assignment is cancelled; a team's form packets follow the team. Leaving a brokerage, a team or a deal revokes at once — no stored grant is left to forget. |
| **authorized copies** | a COPY, the original kept | restriction copies in the rail's data step (`closure.restrictions_copied`); the per-transfer procedure E below | (a) **Restrictions travel automatically, as copies.** An opt-out (`contact_suppression_list`) is the person's own instruction not to be contacted; the rail copies every row into the adopting brokerage, keeps the original with the archived source as evidence, and records the count. A copy can only stop sending, so it can never make the target more permissive than the source — the safety argument. (b) **Everything else copies only on evidence**: a deal file, the client's financial data or a consent reaches the target only through procedure E (a release, the client's authorization, re-obtained consent). Consent is never copied silently: the target treats the person as unconsented until then — the safe direction. |

### Documents in storage (wave 146, lane 146A)

The bucket objects behind the document rows follow the same rules, through the m874 path rules (`public.document_bucket_path_access`):

- **`client-documents`** objects sit under `contacts/{contact}/…` and `transactions/{deal}/…`, and their rows (`client_documents`, a family) move with the contact or deal. The path rule reads the parent's CURRENT brokerage, so access moves with the authorized move of the row and never on its own.
- **`transaction-documents`** objects are the deal file, and their rows (`transaction_documents`) are `explicit_transfer`: they stay in the archived source while the transaction moves. The path rule therefore **holds** a deal's folder: while any `transaction_documents` row of the deal sits in a brokerage other than the transaction's, no session reads, writes or deletes that folder. The hold clears only when procedure E moves or copies the rows. Without it, the adopting brokerage would have gained the source's deal file through storage — a silent ownership change.
- **`agent-documents`** is membership-dependent (above).
- **`offer-documents`** is server-only; an offer PDF is reached through its offer row, which moves with the `offers` family.
- **A signed URL already handed out stays valid until it expires.** RLS cannot revoke a bearer token. The rows still persist 10-year links (`lib/storage/signed-doc-url.ts` `DOC_URL_TTL_SECONDS`), so the end state is sign-on-read, as `lib/kernel/document-custody.ts` already does for `client_documents`.

### How the rail enforces this

**Verification** gains a `child_classification` check, and it fails closed. A family classified as anything other than `follows_parent` refuses the run. So does any table named for moving that is not `follows_parent`, and so does an unclassified table. This holds even when the name arrives through the proof seam `deps.authorizedFollowingChildren`.

The guard runs the real rail in memory and proves the refusal for four cases. In each, nothing moves, not even the families:
- `agent_commissions` (`not_transferable`);
- `listing_agreements` (`explicit_transfer`);
- `communications` (`historical_immutable`);
- an unclassified name.

**The data step** does the following, in order:
1. Moves the families.
2. Moves the owner-authorized children. There are none in wave 145.
3. **Copies the restrictions** (wave 146): every row of a safety-critical restriction table that is not authorized to move (`contact_suppression_list`) is copied into the target with every column but its id and tenant, idempotently (a restriction the target already holds is not inserted twice), paged so a long list is never truncated. A refused read or insert STALLS the data step — an opt-out that did not arrive never reads as done.
4. Writes a **closure report** to the migration record (`migration.closure`):
   - rows held in the source per `explicit_transfer` table;
   - rows held per safety-critical child, and the restriction rows copied (`restrictions_copied`);
   - every table it could not read, listed as unread and never as 0.
5. If anything is pending, the Data Steward (`TRANSFER_HUMAN_ROUTES.explicit_transfer_pending`) is notified once, through the registered manager route. A copied safety table is named as copied, not as unsafe.

## Findings this classification surfaced

1. **An opt-out does not travel with the person (safety).** `contact_suppression_list` is `follows_parent`, but it is not authorized, so it stays in the archived source. Its readers pin it to the tenant:
   - `lib/lead-intent/lead-opt-out.ts` (`.eq("brokerage_id", …)`);
   - `lib/direct-mail/address-suppression.ts`.

   So after an adoption the target could not see a contact's opt-out, and could message that person again. Wave 145 counted these rows on every transfer and routed them as a **SAFETY** item. **Wave 146 (lane 146A) closes it in code:** the rail COPIES every restriction row into the target (the original stays with the source as evidence), so the opt-out holds in the target from the moment the data step completes. Moving the originals is still item 0 of the plan below, and still the owner's decision.

   Consent is the safe direction. `contact_consent_events` is left behind as `explicit_transfer`, the target sees no consent, and it sends nothing.
2. **Some children also point at a parent that stays.** For example, vendor links point at `vendors`. Moving such a row would leave it pointing at another tenant. The guard publishes every `follows_parent` child that has a staying tenant parent, and refuses to let one be authorized blind.
3. **Families that move confidential documents.** `documents` and `client_documents` are wave-141 families, so they already move. Ruling 24 says confidential documents must never move "because an agent changes brokerage". This rail adopts an independent subscriber's **own** workspace (the subscriber was that tenant's owner, and every seat moves with it), which is why those families were admitted. **Owner: confirm, or move them to `explicit_transfer`.** That change would alter live behaviour, so it is not made here.

## Owner-approval plan

Live moves happen only with explicit authorization. Each step below is one owner decision. It is enacted by adding table names to `TRANSFER_AUTHORIZED_FOLLOWING_CHILDREN`, which applies to `follows_parent` tables only, or by running the evidenced per-transfer procedure, which applies to `explicit_transfer` tables. After each decision, re-run `test:transfer-classification` and `test:brokerage-identity`.

### 0 — Safety first (recommended now)

`contact_suppression_list`. Authorize it so an opt-out moves with the contact. Since wave 146 the rail already COPIES every row into the target, so the opt-out is honoured there either way; authorizing the move only decides where the ORIGINAL evidence lives.
- **Evidence:** the closure report's `safety_critical` and `restrictions_copied` counts on any transfer.
- **Verify:** after the move, the target's opt-out readers find the row under the target `brokerage_id`.
- **Rollback:** move the counted ids back.

### 1 — The in-flight deal file (`follows_parent` batch A)

Authorize the deal file so the adopting brokerage can close a moved deal:
- `transaction_milestones`, `transaction_deadlines`, `transaction_timeline`, `transaction_pending_actions`;
- `transaction_closing_prep`, `transaction_inspections`, `transaction_repair_negotiations`;
- `transaction_participants`, `transaction_lenders`, `transaction_title_escrow`;
- `trid_timeline`, `buyer_move_cases`, `document_requests`, `document_folders`, `workflow_intake_sessions`.

`transaction_agent_roles` has no tenant column, so it already follows.

**Held out until resolved:** `transaction_assignments`. Its `coordinator_id → transaction_coordinators` points at a table that does NOT move, so the source's coordinator row would be referenced across tenants. Either re-assign it to the target's coordinator, or add the coordinator to the membership step first.

Precondition: none of these tables appears in the guard's published "parent that STAYS" list. The guard refuses an authorized table that does.

### 2 — The listing file and the attribution surfaces (batch B)

Authorize:
- `listing_price_changes`, `pricing_history`, `listing_stage_history`, `listing_inquiries`;
- `qr_codes`, `marketing_asset_qr_links`, `listing_marketing_content`;
- `listing_presentations`, `listing_promo_videos`, `open_house_events`;
- `showing_requests`, `saved_properties`, `showing_feedback`, `tours`, `tour_stops`, `cma_reports`, `property_upgrades`.

Left behind, printed QR codes and landing pages would keep attributing to the archived tenant. That is the same reason `lead_capture_forms` already moves.

**Siblings move together.** These pairs reference each other, so they must be authorized in the same decision:
- `qr_codes` with `marketing_asset_qr_links`, `open_house_events` and `direct_mail_campaigns`;
- `tours` with `tour_stops` and `showing_requests`;
- `saved_properties` with `showing_requests`;
- `listing_presentations` with `presentation_sections`.

**Held out until resolved:**
- `listing_landing_pages` (`template_id → content_templates`);
- `presentation_sections` (`render_id → remotion_composition_renders`, which is historical);
- `neighbor_notification_campaigns` (needs `direct_mail_campaigns`, see batch D).

### 3 — The client record (batch C)

Authorize:
- `contact_portal_modules`, `contact_portal_preferences`;
- `property_interests`, `property_preferences`, `property_feedback`, `saved_properties`, `collaborative_searches`;
- `offer_intents`, `valuation_requests`, `journey_states`, `journey_stage_progress`;
- `ai_assistant_notes`, `drip_campaigns`, `agent_reviews`, `agent_intro_videos`.

**Held out until resolved:** `ai_isa_qualifications` (`campaign_id → ai_isa_campaigns`, which stays).

### 4 — Campaign and content components (batch D)

Authorize the rest of the `follows_parent` list in the generated block below, after a per-table check of the staying-parent list. These tables currently point at parents that stay, so each needs its own decision first:
- `blog_post_keywords` → `seo_keywords`;
- `calendar_sync_mappings` and `calendar_sync_conflicts` → `calendar_provider_accounts` (the user's calendar connection);
- `direct_mail_campaigns` → presets / variants / `compliance_events` / `campaign_bundle_dispatches`;
- `podcast_episodes` → `podcast_templates`;
- `social_posts` → `social_media_accounts` (the connected social account).

### E — `explicit_transfer`: per transfer, never in bulk, never by the rail

The closure report names each table and its count. For each one, the Data Steward opens the item, and a human with the named authority decides and records the evidence. The move or copy is then done through the owning manager's tool, never by the rail, and it is recorded with `withActionLedger`.

| Table | Who decides | Evidence required before anything moves | What moves |
|---|---|---|---|
| `listing_agreements` | the seller (assignment or release) + both brokers | An executed assignment or release of the listing agreement to the adopting brokerage. | A new agreement row in the target that cites the executed assignment. The source row stays as history. |
| `buyer_broker_agreements` | the buyer + both brokers | An executed assignment, or a new buyer-broker agreement with the adopting brokerage. | Same as above. |
| `transaction_documents` | the source broker of record + the client | A written release of the deal file (state record-retention rules bind the supervising brokerage). | A copy into the target's deal file. The source keeps its retained copy. |
| `generated_documents` | same | same | same |
| `contact_consent_events` | the compliance officer | Consent is re-obtained by the target, or a compliance-approved determination that the consent covers the adopting brokerage. | Never a silent copy. Until decided, the target treats the person as unconsented, which is fail-safe. |
| `newsletter_subscribers` | the compliance officer | A re-subscription, or an approved determination as above. | same |
| `data_subject_requests` | the compliance officer / privacy owner | The request is honoured or recorded for the target, as controller. | A linked record in the target. The source row stays as evidence. |
| `buyer_financial_profiles` | the client | The client's written authorization to share with the adopting brokerage. | A copy only for the authorized fields. |
| `credit_accounts` | the client | same | same |
| `credit_status` | the client | same | same |
| `lender_applications` | the client + the lender | same, plus the lender's acknowledgement | same |

### Never, by any plan

`not_transferable`:
- money: commission, payout, trust (earnest money), books, cost, invoice and referral-fee records;
- billing and usage;
- the supervising broker's compliance file;
- ad-account property;
- bearer tokens and invites.

`shared_remains` relationships are re-established by the target. `historical_immutable` rows stay where they were written.

## Blind spots

- **The census is the generated FK cache.** It is current as of its last regeneration. A new FK makes the guard go red (the unclassified finder has a positive control). Multi-column FKs are not in the cache.
- **Classes are per table.** Every FK of a table onto a moved parent shares the table's class. No table in the census needs different classes per FK. A future one would need a per-FK key.
- **The closure report counts rows by `brokerage_id = source` in each `explicit_transfer` table**, not only the rows that reference a moved parent. For an independent workspace, every parent moves, so the two are the same set.
- **The rail is proven in memory.** No RLS, trigger or CHECK is executed. Live transfers: 0 (measured 2026-10-27).

## Generated classification (do not edit by hand — `tsx --conditions=react-server scripts/transfer-classification-guard.ts --write`)

<!-- BEGIN GENERATED: fk-child-classification (scripts/transfer-classification-guard.ts --write) -->
Census: 437 FKs from 309 child tables into the 33 moved families (288 tables carry brokerage_id; 21 have no tenant column and follow their parent's tenancy implicitly). 60 further FKs run between families (follows_parent by construction).

| Class | Tables | FKs |
|---|---|---|
| `follows_parent` | 72 | 108 |
| `shared_remains` | 13 | 19 |
| `historical_immutable` | 101 | 153 |
| `explicit_transfer` | 12 | 19 |
| `not_transferable` | 28 | 37 |
| `derived_readonly` | 83 | 101 |

### `follows_parent`

*part of the parent's own record (its sub-records, workflow state, the client's stated preferences, the agent's work product on it) — it belongs to whoever owns the parent; moved only once the owner authorizes the table.*

**THE DEAL FILE — milestones, deadlines, timeline, parties, inspections, repairs, closing prep and the deal's own lender / escrow details**

- `transaction_milestones` — transaction_id → transactions · deal_coordinator
- `transaction_deadlines` — source_document_id → documents, transaction_id → transactions · deal_coordinator
- `transaction_timeline` — transaction_id → transactions · deal_coordinator
- `transaction_pending_actions` — transaction_id → transactions · deal_coordinator
- `transaction_closing_prep` — transaction_id → transactions · deal_coordinator
- `transaction_inspections` — transaction_id → transactions · deal_coordinator
- `transaction_repair_negotiations` — transaction_id → transactions · deal_coordinator
- `transaction_participants` — transaction_id → transactions · deal_coordinator
- `transaction_assignments` — transaction_id → transactions · deal_coordinator
- `transaction_lenders` — transaction_id → transactions · deal_coordinator
- `transaction_title_escrow` — transaction_id → transactions · deal_coordinator
- `transaction_agent_roles` — transaction_id → transactions · no tenant column · no TABLE_MANAGER
- `trid_timeline` — transaction_id → transactions · deal_coordinator
- `buyer_move_cases` — transaction_id → transactions · deal_coordinator
- `document_requests` — contact_id → contacts, transaction_id → transactions · deal_coordinator
- `document_folders` — related_contact_id → contacts, related_lead_id → leads, related_transaction_id → transactions · deal_coordinator
- `workflow_intake_sessions` — contact_id → contacts, document_id → documents · campaign_orchestrator

**THE LISTING FILE — its own price and stage history, inquiries, landing pages, marketing content, presentations, open houses, showings and tours**

- `listing_price_changes` — listing_id → listings · listing_concierge
- `pricing_history` — listing_id → listings · listing_concierge
- `listing_stage_history` — listing_id → listings · listing_concierge
- `listing_inquiries` — listing_id → listings · listing_concierge
- `listing_landing_pages` — contact_id → contacts, listing_id → listings · listing_concierge
- `listing_marketing_content` — listing_id → listings · listing_concierge
- `listing_presentations` — contact_id → contacts, packet_document_id → documents · listing_concierge
- `presentation_sections` — contact_id → contacts · listing_concierge
- `listing_promo_videos` — listing_id → listings, video_project_id → ai_video_projects · asset_manager
- `open_house_events` — listing_id → listings · listing_concierge
- `property_upgrades` — listing_id → listings · shopping_agent
- `cma_reports` — contact_id → contacts, listing_id → listings · listing_concierge
- `showing_requests` — contact_id → contacts, converted_showing_id → showings, listing_id → listings · listing_concierge
- `showing_feedback` — showing_id → showings · listing_concierge
- `tour_stops` — contact_id → contacts, listing_id → listings, showing_id → showings · shopping_agent
- `tours` — contact_id → contacts · shopping_agent
- `appointments` — contact_id → contacts, listing_id → listings · no tenant column · data_steward
- `neighbor_notification_campaigns` — listing_id → listings · campaign_orchestrator

**THE CLIENT RECORD — the client's stated preferences, saved homes, journey state, opt-outs, qualification and the agent's notes / reviews / intro videos**

- `contact_portal_modules` — contact_id → contacts · data_steward
- `contact_portal_preferences` — contact_id → contacts · data_steward
- `contact_suppression_list` — contact_id → contacts · data_steward
- `property_interests` — contact_id → contacts · shopping_agent
- `property_preferences` — contact_id → contacts · shopping_agent
- `property_feedback` — contact_id → contacts, listing_id → listings · shopping_agent
- `saved_properties` — contact_id → contacts, listing_id → listings · shopping_agent
- `collaborative_searches` — contact_id → contacts, created_by_contact_id → contacts · shopping_agent
- `collaborative_search_properties` — added_by_contact_id → contacts · no tenant column · shopping_agent
- `offer_intents` — contact_id → contacts, listing_id → listings, offer_id → offers · shopping_agent
- `valuation_requests` — contact_id → contacts · listing_concierge
- `journey_states` — contact_id → contacts, deal_id → transactions, listing_id → listings · data_steward
- `journey_stage_progress` — contact_id → contacts · data_steward
- `journey_task_completions` — contact_id → contacts · no tenant column · no TABLE_MANAGER
- `ai_isa_qualifications` — contact_id → contacts, lead_id → leads · ai_isa
- `ai_assistant_notes` — contact_id → contacts, lead_id → leads, listing_id → listings, transaction_id → transactions · data_steward
- `drip_campaigns` — contact_id → contacts · campaign_orchestrator
- `agent_reviews` — contact_id → contacts, transaction_id → transactions · recruiting_manager
- `agent_intro_videos` — contact_id → contacts, video_project_id → ai_video_projects · asset_manager

**CAMPAIGN AND CONTENT COMPONENTS — schedules, steps, tasks, triggers, QR codes (printed codes keep resolving), sub-campaigns and the content cut from a moved project**

- `blog_post_keywords` — blog_post_id → blog_posts · campaign_orchestrator
- `campaign_calendar` — campaign_id → marketing_campaigns · campaign_orchestrator
- `campaign_sequence_steps` — sequence_id → campaign_sequences · no tenant column · campaign_orchestrator
- `marketing_campaign_comments` — campaign_id → marketing_campaigns · campaign_orchestrator
- `marketing_campaign_tasks` — campaign_id → marketing_campaigns · campaign_orchestrator
- `marketing_campaign_triggers` — campaign_id → marketing_campaigns · no tenant column · no TABLE_MANAGER
- `marketing_asset_qr_links` — marketing_asset_id → marketing_assets · asset_manager
- `qr_codes` — listing_id → listings, marketing_campaign_id → marketing_campaigns · data_steward
- `direct_mail_campaigns` — contact_id → contacts, lead_id → leads, marketing_campaign_id → marketing_campaigns · campaign_orchestrator
- `newsletter_campaigns` — marketing_campaign_id → marketing_campaigns · campaign_orchestrator
- `newsletter_video_renders` — video_project_id → ai_video_projects · asset_manager
- `podcast_episodes` — marketing_campaign_id → marketing_campaigns, source_video_asset_id → video_assets, source_video_project_id → ai_video_projects · campaign_orchestrator
- `social_posts` — listing_id → listings, marketing_campaign_id → marketing_campaigns · campaign_orchestrator
- `video_scripts_library` — contact_id → contacts, listing_id → listings · asset_manager
- `video_snippets` — source_video_asset_id → video_assets, video_project_id → ai_video_projects · asset_manager
- `training_videos` — ai_video_project_id → ai_video_projects, provider_project_id → ai_video_projects · asset_manager
- `calendar_sync_mappings` — calendar_event_id → calendar_events · data_steward
- `calendar_sync_conflicts` — calendar_event_id → calendar_events · no tenant column · no TABLE_MANAGER

### `shared_remains`

*a relationship with ANOTHER party (a vendor of the source bench, an outside agent, a title company's users, a referral / credit partner, a deal-team member's portal grant) — it stays where it was formed and the target re-establishes its own.*

**THE SOURCE'S VENDOR BENCH — the vendor relationship (and its vendors row, which does not move) is the source brokerage's; moving the row would point the target at another tenant's vendor**

- `contact_vendors` — contact_id → contacts, transaction_id → transactions · data_steward
- `vendor_assignments` — transaction_id → transactions · data_steward
- `vendor_bookings` — contact_id → contacts, listing_id → listings, transaction_id → transactions · data_steward
- `vendor_contact_assignments` — contact_id → contacts, transaction_id → transactions · data_steward
- `vendor_jobs` — transaction_id → transactions · data_steward
- `vendor_reviews` — transaction_id → transactions · sphere_of_influence
- `transaction_vendor_services` — transaction_id → transactions · deal_coordinator
- `title_orders` — transaction_id → transactions · deal_coordinator

**ANOTHER PARTY'S ACCESS OR RELATIONSHIP — outside agents, title-company users, deal-team members with portal grants, credit / referral partners: re-established by the target, never silently re-scoped**

- `outside_agent_contact_links` — contact_id → contacts, listing_id → listings, transaction_id → transactions · data_steward
- `title_company_users` — transaction_id → transactions · deal_coordinator
- `deal_team_members` — transaction_id → transactions · recruiting_manager
- `credit_partner_referrals` — contact_id → contacts · sphere_of_influence
- `referral_sources` — contact_id → contacts · no tenant column · sphere_of_influence

### `historical_immutable`

*what the SOURCE did — communications sent under its sender identity and consent basis, outreach, deliveries, analytics events, audits and evidence (LAW 5): immutable, kept with the archived source, readable by platform staff.*

**COMMUNICATIONS — sent or received under the source's sender identity, number and consent basis (TCPA / CAN-SPAM evidence)**

- `communications` — contact_id → contacts · data_steward
- `conversation_logs` — contact_id → contacts · data_steward
- `conversations` — contact_id → contacts · data_steward
- `messages` — contact_id → contacts · data_steward
- `email_sends` — campaign_id → email_campaigns, contact_id → contacts · data_steward
- `email_tracking` — contact_id → contacts · data_steward
- `newsletter_sends` — contact_id → contacts · campaign_orchestrator
- `voice_calls` — contact_id → contacts, lead_id → leads · data_steward
- `client_portal_messages` — contact_id → contacts, transaction_id → transactions · data_steward
- `chat_sessions` — contact_id → contacts, lead_id → leads · data_steward
- `embed_sessions` — contact_id → contacts · data_steward
- `live_agent_sessions` — contact_id → contacts · asset_manager
- `smart_landing_sessions` — contact_id → contacts, listing_id → listings · data_steward
- `agent_assistant_sessions` — context_contact_id → contacts, context_listing_id → listings, context_transaction_id → transactions · recruiting_manager
- `lead_conversation_history` — lead_id → leads · ai_isa
- `transaction_communications` — transaction_id → transactions · deal_coordinator

**OUTREACH AND DELIVERIES — what the source's managers and campaigns sent, gifted or reported**

- `ai_isa_activities` — contact_id → contacts, lead_id → leads · ai_isa
- `ai_isa_calls` — contact_id → contacts, lead_id → leads · ai_isa
- `ai_isa_engagement_tracking` — contact_id → contacts, lead_id → leads · ai_isa
- `isa_outreach_log` — calendar_event_id → calendar_events, contact_id → contacts, lead_id → leads · ai_isa
- `intelligent_outreach_log` — contact_id → contacts · ai_isa
- `campaign_bundle_dispatches` — contact_id → contacts, lead_id → leads · campaign_orchestrator
- `direct_mail_recipients` — contact_id → contacts, lead_id → leads · campaign_orchestrator
- `direct_mail_responses` — contact_id → contacts, lead_id → leads · campaign_orchestrator
- `mail_response_tracking` — contact_id → contacts, lead_id → leads · campaign_orchestrator
- `marketing_campaign_touchpoints` — campaign_id → marketing_campaigns, contact_id → contacts, sequence_id → campaign_sequences · campaign_orchestrator
- `sequence_step_executions` — contact_id → contacts, enrollment_id → sequence_enrollments, sequence_id → campaign_sequences · campaign_orchestrator
- `lifetime_customer_touchpoints` — contact_id → contacts, related_transaction_id → transactions · campaign_orchestrator
- `review_requests` — contact_id → contacts · sphere_of_influence
- `showing_feedback_requests` — showing_id → showings · listing_concierge
- `open_house_invitations` — contact_id → contacts · listing_concierge
- `open_house_rsvp_tracking` — contact_id → contacts · listing_concierge
- `seller_share_feed` — contact_id → contacts, listing_id → listings · listing_concierge
- `seller_updates` — contact_id → contacts, listing_id → listings · listing_concierge
- `seller_weekly_reports` — contact_id → contacts, listing_id → listings · listing_concierge
- `client_friendly_updates` — transaction_id → transactions · data_steward
- `timeline_transparency` — transaction_id → transactions · data_steward
- `transparency_updates` — contact_id → contacts, listing_id → listings, transaction_id → transactions · data_steward
- `closing_notifications` — transaction_id → transactions · no tenant column · deal_coordinator
- `thank_you_notes` — contact_id → contacts, transaction_id → transactions · sphere_of_influence
- `client_gifts` — contact_id → contacts, transaction_id → transactions · sphere_of_influence
- `closing_gifts` — contact_id → contacts, listing_id → listings · deal_coordinator
- `notifications` — activity_id → activities, contact_id → contacts · campaign_orchestrator

**OBSERVED EVENTS AND ANALYTICS — behaviour, views, clicks, scans and signals observed by the source**

- `blog_post_share_clicks` — blog_post_id → blog_posts, viewer_contact_id → contacts · campaign_orchestrator
- `blog_post_views` — blog_post_id → blog_posts, viewer_contact_id → contacts · campaign_orchestrator
- `behavioral_signals` — contact_id → contacts · data_steward
- `buyer_behavior_log` — contact_id → contacts, listing_id → listings · shopping_agent
- `client_portal_activity` — contact_id → contacts · data_steward
- `external_behavior` — contact_id → contacts · data_steward
- `lead_behavioral_data` — lead_id → leads · ai_isa
- `lead_external_behavior` — lead_id → leads · no tenant column · no TABLE_MANAGER
- `lead_idx_property_interactions` — contact_id → contacts, lead_id → leads · ai_isa
- `lead_property_searches` — lead_id → leads · ai_isa
- `lead_score_history` — contact_id → contacts, lead_id → leads · ai_isa
- `podcast_analytics_events` — listener_contact_id → contacts · campaign_orchestrator
- `portal_access_logs` — contact_id → contacts · data_steward
- `portal_event_stream` — contact_id → contacts, listing_id → listings, source_activity_id → activities, transaction_id → transactions · data_steward
- `property_alert_delivery_log` — alert_id → property_alerts, contact_id → contacts · shopping_agent
- `property_search_log` — contact_id → contacts, lead_id → leads · shopping_agent
- `property_views` — contact_id → contacts · shopping_agent
- `qr_scan_events` — contact_id → contacts · data_steward
- `site_activity` — contact_id → contacts · data_steward
- `video_engagement_events` — contact_id → contacts, video_asset_id → video_assets · asset_manager
- `website_visitors` — contact_id → contacts, lead_id → leads · data_steward
- `calculator_history` — contact_id → contacts, lead_id → leads · data_steward
- `google_search_activity` — lead_id → leads · shopping_agent
- `nextdoor_activity` — lead_id → leads · campaign_orchestrator
- `listing_page_analytics` — listing_id → listings · listing_concierge
- `ai_search_citation_observations` — project_id → ai_video_projects · shopping_agent
- `intelligence_signals_log` — contact_id → contacts · data_steward
- `manager_signals` — contact_id → contacts · campaign_orchestrator
- `open_house_attendees` — contact_id → contacts · listing_concierge
- `open_house_feedback` — contact_id → contacts · listing_concierge
- `social_publish_log` — campaign_id → marketing_campaigns · campaign_orchestrator
- `listing_syndication_tracking` — transaction_id → transactions · listing_concierge

**AUDIT, EVIDENCE AND PROVENANCE — policy decisions, compliance and fair-housing logs, privacy acceptances, e-sign envelopes, extraction / field audits, dedup / assignment / distribution logs, support tickets**

- `communication_audit_log` — contact_id → contacts, lead_id → leads · data_steward
- `outbound_message_compliance_log` — contact_id → contacts · deal_coordinator
- `transaction_compliance_log` — transaction_id → transactions · deal_coordinator
- `policy_decisions` — document_id → documents, transaction_id → transactions · compliance_officer
- `fair_housing_logs` — contact_id → contacts · no tenant column · compliance_officer
- `privacy_acceptances` — contact_id → contacts · no tenant column · no TABLE_MANAGER
- `document_field_audit` — document_id → documents · no tenant column · deal_coordinator
- `document_extraction_log` — transaction_id → transactions · deal_coordinator
- `signature_requests` — contact_id → contacts, document_id → client_documents, transaction_id → transactions · deal_coordinator
- `deconflict_suppression_log` — contact_id → contacts · data_steward
- `assignment_log` — lead_id → leads · ai_isa
- `lead_deduplication_log` — lead_id → leads · ai_isa
- `data_health_logs` — contact_id → contacts · data_steward
- `automation_errors` — lead_id → leads · cron_manager
- `outcome_reconciliations` — contact_id → contacts, lead_id → leads · compliance_officer
- `platform_lead_distributions` — lead_id → leads · data_steward
- `lead_sla_tracking` — lead_id → leads · ai_isa
- `seo_optimization_log` — blog_post_id → blog_posts · campaign_orchestrator
- `support_tickets` — contact_id → contacts · data_steward
- `business_card_scans` — contact_id → contacts · data_steward

**JOBS AND RUNS — renders, enhancement jobs, packet jobs and workflow runs the source executed (and paid for)**

- `workflow_runs` — contact_id → contacts, listing_id → listings, transaction_id → transactions · campaign_orchestrator
- `workflow_webhook_events` — contact_id → contacts · campaign_orchestrator
- `video_render_log` — project_id → ai_video_projects · asset_manager
- `remotion_composition_renders` — used_intro_asset_id → video_assets, used_music_asset_id → video_assets, used_outro_asset_id → video_assets · asset_manager
- `photo_enhancement_jobs` — photo_id → listing_media · asset_manager
- `listing_packet_jobs` — listing_id → listings · listing_concierge

### `explicit_transfer`

*another person's rights or the source brokerage's executed contract (consent, privacy requests, the client's own financial data, a listing / buyer-broker agreement, confidential deal documents) — it may move only by an explicit, evidenced, per-transfer human decision; this rail never moves it.*

**EXECUTED AGREEMENT WITH THE SOURCE BROKERAGE — a listing / buyer-broker agreement is the client's contract with the brokerage, not the agent; it moves only on the client's executed assignment or release. A client-agreement FEE (m859, ruling 5) is a term of that agreement and follows it (lane 145C Outside-lane 9: 'ownership follows the agreement') — so it is never moved apart from it**

- `listing_agreements` — listing_id → listings, seller_contact_id → contacts · listing_concierge
- `buyer_broker_agreements` — buyer_contact_id → contacts · shopping_agent
- `client_agreement_fees` — amendment_document_id → documents · finance_manager

**CONFIDENTIAL DEAL DOCUMENTS — third-party PII and signatures in the source's deal file; moved only on an explicit, evidenced release (ruling 24)**

- `transaction_documents` — contact_id → contacts, listing_id → listings, transaction_id → transactions · deal_coordinator
- `generated_documents` — contact_id → contacts, listing_id → listings, transaction_id → transactions · deal_coordinator

**CONSENT AND PRIVACY RIGHTS — given to the source sender / controller and never assumed by another; fail-safe while unmoved (the target treats the person as unconsented until consent is re-obtained or a compliance-approved copy lands)**

- `contact_consent_events` — contact_id → contacts, lead_id → leads · data_steward
- `newsletter_subscribers` — contact_id → contacts · campaign_orchestrator
- `data_subject_requests` — subject_contact_id → contacts · data_steward

**THE CLIENT'S OWN FINANCIAL DATA — credit, income, loan applications; moved only with the client's authorization (contacts see only their own financials — CLAUDE.md §5)**

- `buyer_financial_profiles` — contact_id → contacts · shopping_agent
- `credit_accounts` — contact_id → contacts · data_steward
- `credit_status` — contact_id → contacts · ai_isa
- `lender_applications` — contact_id → contacts, transaction_id → transactions · deal_coordinator

### `not_transferable`

*money, billing / usage, the supervising broker's compliance file, ad-account property and bearer tokens — never crosses tenants.*

**MONEY — commission, payout, earnest-money (trust), books, cost, invoice and referral-fee records stay with the brokerage that booked them; money never crosses tenants (m765; ruling 9: a referral obligation is the executing brokerage's)**

- `agent_commissions` — transaction_id → transactions · finance_manager
- `commission_adjustments` — offer_id → offers, transaction_id → transactions · finance_manager
- `commission_calculations` — transaction_id → transactions · finance_manager
- `commission_distributions` — transaction_id → transactions · finance_manager
- `commission_splits` — transaction_id → transactions · finance_manager
- `transaction_commissions` — transaction_id → transactions · deal_coordinator
- `closing_disclosure_agreement` — transaction_id → transactions · deal_coordinator
- `company_books_obligations` — transaction_id → transactions · finance_manager
- `deposits` — transaction_id → transactions · deal_coordinator
- `cost_breakdown_tracking` — transaction_id → transactions · data_steward
- `transaction_cost_breakdown` — transaction_id → transactions · deal_coordinator
- `net_sheet_reconciliations` — offer_id → offers, transaction_id → transactions · deal_coordinator
- `referrals` — referral_agreement_document_id → documents, referred_contact_id → contacts, referred_lead_id → leads, referrer_contact_id → contacts, transaction_id → transactions · sphere_of_influence
- `listing_marketing_packages` — transaction_id → transactions · listing_concierge
- `listing_marketing_services` — transaction_id → transactions · listing_concierge
- `vendor_invoices` — contact_id → contacts, listing_id → listings, transaction_id → transactions · data_steward
- `referral_partners` — agreement_document_id → documents · sphere_of_influence

**BILLING / USAGE — metered usage and vendor spend are the source subscription's invoice lines**

- `usage_events` — contact_id → contacts · data_steward
- `vendor_usage_tracking` — lead_id → leads · data_steward

**SUPERVISION — the supervising broker's compliance file for the deal (record retention binds the brokerage that supervised); the target runs its own review**

- `compliance_alerts` — transaction_id → transactions · compliance_officer
- `compliance_checklists` — transaction_id → transactions · compliance_officer
- `compliance_flags` — contact_id → contacts · compliance_officer
- `compliance_tasks` — transaction_id → transactions · compliance_officer

**AD-ACCOUNT PROPERTY — campaigns, creatives and audiences live in the source's connected ad accounts (spend, platform terms); the target rebuilds them in its own**

- `ad_campaigns` — marketing_campaign_id → marketing_campaigns · ads_manager
- `ad_creative_variations` — source_marketing_asset_id → marketing_assets · ads_manager
- `audience_members` — contact_id → contacts, lead_id → leads · ads_manager

**BEARER TOKENS / INVITES — never re-scoped to another tenant; the target re-issues them**

- `buyer_intake_tokens` — contact_id → contacts · shopping_agent
- `portal_contact_invites` — contact_id → contacts · data_steward

### `derived_readonly`

*computed from the parent (scores, predictions, insights, health, matches, AI drafts / plans, provider enrichment and scrapes, queues) — never moved; recomputed, re-enriched or re-planned in the target from the moved parent.*

**COMPUTED FROM THE PARENT — scores, predictions, health, insights, matches, checklists instantiated from policy, AI drafts and plans; recomputed in the target from the moved parent**

- `ai_autopilot_plans` — contact_id → contacts, lead_id → leads · data_steward
- `ai_comp_scores` — listing_id → listings · data_steward
- `ai_insights` — contact_id → contacts · data_steward
- `ai_listing_optimizations` — transaction_id → transactions · listing_concierge
- `ai_message_drafts` — contact_id → contacts, listing_id → listings · data_steward
- `buyer_behavior_predictions` — contact_id → contacts · shopping_agent
- `buyer_fatigue_scores` — contact_id → contacts · shopping_agent
- `call_analyses` — contact_id → contacts · data_steward
- `campaign_roi` — marketing_campaign_id → marketing_campaigns · campaign_orchestrator
- `client_detailed_personas` — contact_id → contacts · data_steward
- `client_engagement_scores` — contact_id → contacts · sphere_of_influence
- `closing_checklist_items` — transaction_id → transactions · deal_coordinator
- `closing_cost_accuracy_observations` — transaction_id → transactions · finance_manager
- `comp_risk_flags` — listing_id → listings · listing_concierge
- `contact_property_insights` — contact_id → contacts · data_steward
- `contact_segments` — contact_id → contacts · data_steward
- `contract_reviews` — transaction_id → transactions · deal_coordinator
- `conversation_insights` — contact_id → contacts · data_steward
- `conversation_intelligence` — lead_id → leads · data_steward
- `copilot_plans` — contact_id → contacts, lead_id → leads · campaign_orchestrator
- `deal_autopsies` — transaction_id → transactions · no tenant column · no TABLE_MANAGER
- `deal_autopsy_observations` — transaction_id → transactions · deal_coordinator
- `deal_health_components` — transaction_id → transactions · deal_coordinator
- `deal_health_factors` — transaction_id → transactions · deal_coordinator
- `deal_health_scores` — transaction_id → transactions · deal_coordinator
- `deal_health_snapshots` — transaction_id → transactions · deal_coordinator
- `document_checklist` — transaction_id → transactions · deal_coordinator
- `document_field_extractions` — document_id → documents · deal_coordinator
- `fatigue_alerts` — contact_id → contacts · data_steward
- `generated_content` — contact_id → contacts · no tenant column · data_steward
- `home_value_estimates` — contact_id → contacts · listing_concierge
- `income_gap_recommended_actions` — contact_id → contacts, listing_id → listings, transaction_id → transactions · data_steward
- `investor_deal_matches` — contact_id → contacts · shopping_agent
- `investor_offmarket_candidates` — contact_id → contacts · shopping_agent
- `lead_engagement_scores` — lead_id → leads · ai_isa
- `lead_intelligence` — lead_id → leads · ai_isa
- `lead_scores` — contact_id → contacts · ai_isa
- `lead_value_journey` — contact_id → contacts · ai_isa
- `learning_assignments` — contact_id → contacts · recruiting_manager
- `lifetime_customer_npv_scores` — contact_id → contacts · sphere_of_influence
- `listing_health_interventions` — listing_id → listings · listing_concierge
- `listing_health_scores` — listing_id → listings · listing_concierge
- `listing_metrics` — listing_id → listings · listing_concierge
- `motivated_seller_signals` — contact_id → contacts, lead_id → leads · ai_isa
- `negotiation_strategies` — contact_id → contacts, offer_id → offers · deal_coordinator
- `neighborhood_reports` — listing_id → listings · listing_concierge
- `net_sheet_calculations` — contact_id → contacts, listing_id → listings · deal_coordinator
- `offer_comparison` — listing_id → listings, recommended_offer_id → offers · deal_coordinator
- `person_identities` — canonical_contact_id → contacts · data_steward
- `predictive_lead_scores` — lead_id → leads · data_steward
- `predictive_listing_actions` — contact_id → contacts · listing_concierge
- `predictive_listing_scores` — contact_id → contacts · listing_concierge
- `price_predictions` — listing_id → listings · listing_concierge
- `price_trend_alerts` — listing_id → listings · listing_concierge
- `proactive_interventions` — transaction_id → transactions · data_steward
- `property_alert_results` — alert_id → property_alerts, contact_id → contacts, listing_id → listings · shopping_agent
- `property_intelligence` — contact_id → contacts · shopping_agent
- `property_matches` — contact_id → contacts · shopping_agent
- `scheduled_touchpoints` — contact_id → contacts · campaign_orchestrator
- `showing_analytics` — listing_id → listings · listing_concierge
- `showing_briefings` — showing_id → showings · listing_concierge
- `signal_reactivations` — contact_id → contacts, lead_id → leads · ai_isa
- `smart_checklists` — transaction_id → transactions · data_steward
- `smart_showing_recommendations` — contact_id → contacts, lead_id → leads · data_steward
- `social_intelligence` — contact_id → contacts · campaign_orchestrator
- `strategy_outcomes` — offer_id → offers · data_steward
- `strategy_recommendations` — contact_id → contacts, listing_id → listings, offer_id → offers · data_steward
- `transaction_health_factors` — transaction_id → transactions · deal_coordinator
- `unified_lead_profile` — contact_id → contacts, lead_id → leads · data_steward
- `video_performance_tracking` — video_asset_id → video_assets, video_project_id → ai_video_projects · asset_manager
- `wealth_advisor_recommendations` — contact_id → contacts · shopping_agent

**PROVIDER ENRICHMENT, SCRAPES AND QUEUES — re-enriched under the target's own provider accounts (gap-only, ruling 12) or re-queued; never copied across accounts**

- `lead_enrichment_queue` — contact_id → contacts, lead_id → leads · ai_isa
- `lead_osint_data` — lead_id → leads · ai_isa
- `lead_people_data` — lead_id → leads · ai_isa
- `lead_property_ownership` — lead_id → leads · ai_isa
- `lead_social_intelligence` — lead_id → leads · no tenant column · no TABLE_MANAGER
- `batchdata_motivated_sellers_raw` — lead_id → leads · ai_isa
- `raw_scraped_leads` — lead_id → leads · data_steward
- `social_search_raw_results` — lead_id → leads · no tenant column · no TABLE_MANAGER
- `zenrows_property_search_raw` — lead_id → leads · no tenant column · no TABLE_MANAGER
- `video_generation_queue` — project_id → ai_video_projects · no tenant column · asset_manager
- `video_streaming_status` — video_project_id → ai_video_projects · no tenant column · asset_manager

**RESEARCH-ONLY PROTECTED ATTRIBUTES (ruling 12) — vendor-modeled, held under the source tenant's access control and provenance for authorized research; never moved or copied across accounts (the target re-enriches gap-only under its own provider account); self-declared by its firewalled store**

- `protected_research_attributes` — contact_id → contacts · no tenant column · data_steward
<!-- END GENERATED: fk-child-classification -->
