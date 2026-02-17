# LIFECYCLE EVENT CONTRACT (AUTHORITATIVE)

**VERSION:** 1.0.0  
**STATUS:** Constitutional - Must be obeyed by all systems  
**LAST UPDATED:** 2026-02-10

---

## PURPOSE

This contract defines the single authoritative event model used across all systems to advance, freeze, roll back, or block journeys and automation. This contract governs how the `activities` table is interpreted as the source of truth for all lifecycle state.

---

## CRITICAL CONSTRAINTS

✅ **ALLOWED:**
- Emit events to `activities` table
- Read events from `activities` table
- Derive state from event sequences
- Define event semantics
- Map external signals to canonical events
- Deduplicate events

🚫 **FORBIDDEN:**
- Create new database tables
- Modify schema columns
- Store state outside `activities` table
- Generate execution logic
- Generate UI components
- Bypass deduplication

---

## CANONICAL EVENT MODEL

Every lifecycle event stored in `activities` table MUST contain:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `activity_id` | UUID | ✅ | Unique event identifier |
| `event_type` | String | ✅ | Namespaced event type (see taxonomy below) |
| `contact_id` | UUID | ✅ | Associated contact |
| `user_id` | UUID | ✅ | Actor who triggered event (may be system) |
| `activity_type` | String | ✅ | High-level category (journey, document, communication, etc.) |
| `description` | Text | ✅ | Human-readable event description |
| `metadata` | JSONB | ✅ | Event-specific structured data |
| `created_at` | Timestamp | ✅ | Event timestamp |

### Metadata Structure (Flexible)

While `metadata` is flexible JSONB, common fields include:

```json
{
  "actor_role": "agent | broker | admin | lender | contact | system",
  "actor_id": "uuid",
  "journey_type": "buyer | seller",
  "stage_from": "PREVIOUS_STAGE",
  "stage_to": "NEW_STAGE",
  "related_entity_type": "listing | transaction | document | tour | offer",
  "related_entity_id": "uuid",
  "reason": "human_readable_reason",
  "override": false,
  "override_reason": "if_override_is_true",
  "evidence_type": "document | conversation | external_integration",
  "evidence_id": "uuid"
}
```

---

## EVENT NAMESPACING (REQUIRED)

All `event_type` values MUST follow this namespacing convention:

```
<namespace>.<action>
```

### Namespace Definitions

| Namespace | Purpose | Examples |
|-----------|---------|----------|
| `buyer.*` | Buyer journey events | `buyer.financial_verification_submitted`, `buyer.search_configured` |
| `seller.*` | Seller journey events | `seller.equity_confirmed`, `seller.presentation_delivered` |
| `listing.*` | Listing lifecycle events | `listing.stage_changed`, `listing.photos_uploaded` |
| `transaction.*` | Transaction events | `transaction.created`, `transaction.closed` |
| `document.*` | Document events | `document.uploaded`, `document.signed` |
| `financial.*` | Financial verification events | `financial.preapproval_uploaded`, `financial.verification_expired` |
| `compliance.*` | Compliance events | `compliance.freeze`, `compliance.cleared` |
| `voice.*` | Voice assistant intents | `voice.intent.search_properties`, `voice.intent.schedule_tour` |
| `automation.*` | System automation events | `automation.drip_sent`, `automation.sla_breach` |
| `journey.*` | Journey state changes | `journey.rollback`, `journey.advance`, `journey.freeze` |
| `offer.*` | Offer events | `offer.submitted`, `offer.accepted`, `offer.rejected` |
| `tour.*` | Showing/tour events | `tour.scheduled`, `tour.completed`, `tour.cancelled` |
| `repair.*` | Repair events | `repair.plan_created`, `repair.completed`, `repair.failed` |
| `integration.*` | External system signals | `integration.dotloop_sync`, `integration.mls_status_changed` |

---

## EVENT SEMANTICS

### Event Categories by Impact

**ADVANCE Events** - Move journey forward:
- `buyer.financial_verification_submitted`
- `buyer.search_configured`
- `seller.presentation_delivered`
- `seller.decision_list`
- `listing.stage_changed` (to higher stage)
- `transaction.closed`

**FREEZE Events** - Pause journey progression:
- `journey.freeze`
- `compliance.freeze`
- `transaction.created` (freezes buyer/seller journey at `*_UNDER_CONTRACT`)

**ROLLBACK Events** - Move journey backward:
- `journey.rollback`
- `offer.rejected`
- `offer.withdrawn`
- `transaction.terminated`
- `financial.verification_expired`
- `repair.failed`
- `listing.cancelled`
- `listing.expired`

**BLOCK Events** - Prevent progression without rollback:
- `compliance.freeze`
- `financial.verification_required`
- Gate validation failures (computed, not stored)

**ESCALATION Events** - Trigger human review:
- `automation.sla_breach`
- `journey.stuck`
- `compliance.review_required`
- `repair.failed`

**EVIDENCE Events** - Provide proof of completion:
- `document.uploaded`
- `document.signed`
- `tour.completed`
- `conversation.buyer_qualified`

---

## EVENT TAXONOMY (COMPREHENSIVE)

### Buyer Journey Events

| Event Type | Semantic | Description | Metadata Requirements |
|------------|----------|-------------|----------------------|
| `buyer.contact_created` | Advance | Buyer contact created | `contact_id`, `source` |
| `buyer.financial_verification_required` | Block | Gate triggered | `reason` |
| `buyer.financial_verification_submitted` | Advance | Pre-approval or POF uploaded | `document_id`, `verification_type`, `expiration_date` |
| `buyer.financially_verified` | Advance | Verification confirmed valid | `verified_by`, `valid_until` |
| `buyer.search_configured` | Advance | Search preferences set | `price_min`, `price_max`, `bedrooms`, `location` |
| `buyer.search_executed` | Evidence | Search performed | `result_count`, `search_criteria` |
| `buyer.tour_scheduled` | Evidence | Tour scheduled | `listing_id`, `tour_date` |
| `buyer.tour_completed` | Evidence | Tour completed | `listing_id`, `feedback` |
| `buyer.offer_submitted` | Advance | Offer submitted | `offer_id`, `listing_id`, `offer_amount` |
| `buyer.under_contract` | Freeze | Offer accepted | `transaction_id`, `offer_id` |
| `buyer.closed` | Advance | Transaction closed | `transaction_id`, `close_date` |
| `buyer.disengaged` | Rollback | Buyer no longer active | `reason` |

### Seller Journey Events

| Event Type | Semantic | Description | Metadata Requirements |
|------------|----------|-------------|----------------------|
| `seller.contact_created` | Advance | Seller contact created | `contact_id`, `source` |
| `seller.equity_confirmed` | Advance | Positive equity verified | `estimated_value`, `mortgage_balance` |
| `seller.prep_plan_created` | Advance | Repair/staging plan created | `plan_id`, `estimated_cost`, `timeline` |
| `seller.prep_completed` | Advance | Repairs/staging finished | `actual_cost`, `completion_date` |
| `seller.presentation_ready` | Advance | CMA + net sheet assembled | `cma_id`, `net_sheet_id` |
| `seller.presentation_delivered` | Advance | Presentation given to seller | `delivery_date`, `delivery_method` |
| `seller.decision_list` | Advance | Seller decides to list | `decision_date`, `listing_agreement_id` |
| `seller.decision_wait` | Block | Seller decides to wait | `reason`, `follow_up_date` |
| `seller.decision_decline` | Rollback | Seller declines to list | `reason` |
| `seller.listing_prep` | Advance | Preparing for MLS | `listing_id`, `target_live_date` |
| `seller.coming_soon` | Advance | Pre-MLS marketing | `listing_id`, `coming_soon_start` |
| `seller.active_listing` | Advance | Live on MLS | `listing_id`, `mls_number`, `list_price` |
| `seller.offer_received` | Advance | Offer received | `offer_id`, `listing_id` |
| `seller.under_contract` | Freeze | Offer accepted | `transaction_id`, `offer_id` |
| `seller.closed` | Advance | Transaction closed | `transaction_id`, `close_date` |
| `seller.disengaged` | Rollback | Seller no longer active | `reason` |

### Rollback Events

| Event Type | Semantic | Description | Metadata Requirements |
|------------|----------|-------------|----------------------|
| `journey.rollback` | Rollback | Journey rolled back | `journey_type`, `from_stage`, `to_stage`, `reason` |
| `offer.rejected` | Rollback | Offer rejected by seller | `offer_id`, `reason` |
| `offer.withdrawn` | Rollback | Offer withdrawn by buyer | `offer_id`, `reason` |
| `transaction.terminated` | Rollback | Contract cancelled | `transaction_id`, `termination_reason` |
| `financial.verification_expired` | Rollback | Verification no longer valid | `document_id`, `expired_date` |
| `repair.failed` | Rollback | Repair plan failed | `repair_type`, `failure_stage`, `reason` |
| `listing.cancelled` | Rollback | Listing cancelled by seller | `listing_id`, `reason` |
| `listing.expired` | Rollback | Listing expired without sale | `listing_id`, `expiration_date` |

### Repair Events (Explicit)

| Event Type | Semantic | Description | Metadata Requirements |
|------------|----------|-------------|----------------------|
| `repair.plan_created` | Evidence | Repair plan created | `repair_type: pre_listing | under_contract`, `estimated_cost` |
| `repair.plan_approved` | Evidence | Plan approved | `approved_by`, `approval_date` |
| `repair.in_progress` | Evidence | Repairs underway | `contractor_id`, `start_date` |
| `repair.completed` | Evidence | Repairs finished | `completion_date`, `actual_cost` |
| `repair.failed` | Rollback | Repair plan failed | `failure_stage: pre_listing | under_contract`, `reason` |

**Repair Failure Distinction:**
- `repair.failed` with `failure_stage: pre_listing` → Rollback to `SELLER_DECISION_PENDING`
- `repair.failed` with `failure_stage: under_contract` → Rollback to `SELLER_ACTIVE_LISTING`

### Compliance Events

| Event Type | Semantic | Description | Metadata Requirements |
|------------|----------|-------------|----------------------|
| `compliance.freeze` | Freeze | Journey frozen by compliance | `freeze_reason`, `compliance_manager_id` |
| `compliance.cleared` | Unfreeze | Compliance issue resolved | `cleared_by`, `resolution_notes` |
| `compliance.review_required` | Escalation | Requires manual compliance review | `review_reason`, `priority` |

### Voice Assistant Events

| Event Type | Semantic | Description | Metadata Requirements |
|------------|----------|-------------|----------------------|
| `voice.intent.search_properties` | Evidence | Voice search request | `search_criteria`, `actor_role` |
| `voice.intent.schedule_tour` | Evidence | Voice tour request | `listing_id`, `preferred_date` |
| `voice.intent.check_progress` | Evidence | Voice progress inquiry | `journey_type` |
| `voice.intent.explain_blocker` | Evidence | Voice blocker explanation | `stage`, `blocker_reason` |

### Integration Events

| Event Type | Semantic | Description | Metadata Requirements |
|------------|----------|-------------|----------------------|
| `integration.dotloop_sync` | Evidence | Dotloop data synced | `dotloop_loop_id`, `sync_type` |
| `integration.mls_status_changed` | Advance/Rollback | MLS status changed | `listing_id`, `old_status`, `new_status` |
| `integration.media_vendor_delivered` | Evidence | Photos/video delivered | `vendor`, `asset_type`, `asset_ids` |
| `integration.lender_verification` | Evidence | Lender confirmed verification | `lender_id`, `verification_type` |

### Automation Events

| Event Type | Semantic | Description | Metadata Requirements |
|------------|----------|-------------|----------------------|
| `automation.drip_sent` | Evidence | Automated email sent | `drip_sequence_id`, `email_template` |
| `automation.sla_breach` | Escalation | SLA deadline missed | `sla_type`, `deadline`, `overdue_hours` |
| `automation.reminder_sent` | Evidence | Reminder sent | `reminder_type`, `recipient_role` |

---

## ROLLBACK EVENTS (EXPLICIT RULES)

### Rollback Event Requirements

Every rollback event MUST include:

```json
{
  "event_type": "journey.rollback",
  "metadata": {
    "journey_type": "buyer | seller",
    "from_stage": "STAGE_NAME",
    "to_stage": "STAGE_NAME",
    "reason": "offer_rejected | verification_expired | repair_failed | etc.",
    "trigger_event_id": "uuid of event that triggered rollback",
    "relocked_education": ["education_id_1", "education_id_2"],
    "actor_role": "agent | broker | admin | system",
    "actor_id": "uuid"
  }
}
```

### Rollback Scenarios

**Buyer Rollbacks:**

1. **Offer Rejected**
   - Trigger: `offer.rejected` event
   - From: `BUYER_OFFER_SUBMITTED`
   - To: `BUYER_OFFER_ELIGIBLE`
   - Reason: `offer_rejected`

2. **Offer Withdrawn**
   - Trigger: `offer.withdrawn` event
   - From: `BUYER_OFFER_SUBMITTED`
   - To: `BUYER_OFFER_ELIGIBLE`
   - Reason: `offer_withdrawn`

3. **Contract Terminated**
   - Trigger: `transaction.terminated` event
   - From: `BUYER_UNDER_CONTRACT`
   - To: `BUYER_SEARCHING` or `BUYER_DISENGAGED`
   - Reason: `contract_terminated`

4. **Financing Failed**
   - Trigger: `financial.verification_expired` or `transaction.terminated` with `reason: financing_failed`
   - From: `BUYER_UNDER_CONTRACT`
   - To: `BUYER_FINANCIAL_VERIFICATION_REQUIRED`
   - Reason: `financing_failed`

5. **Verification Expired**
   - Trigger: `financial.verification_expired` event (system-generated)
   - From: Any stage
   - To: `BUYER_FINANCIAL_VERIFICATION_REQUIRED`
   - Reason: `verification_expired`

**Seller Rollbacks:**

1. **Pre-Listing Repair Failure**
   - Trigger: `repair.failed` with `failure_stage: pre_listing`
   - From: `SELLER_PREP` or `SELLER_COMING_SOON_PREP`
   - To: `SELLER_DECISION_PENDING`
   - Reason: `repair_plan_failed`

2. **Under-Contract Repair Failure**
   - Trigger: `repair.failed` with `failure_stage: under_contract`
   - From: `SELLER_UNDER_CONTRACT`
   - To: `SELLER_ACTIVE_LISTING`
   - Reason: `repair_negotiation_failed`

3. **List Decision Reversed**
   - Trigger: `seller.decision_reversed` event
   - From: `SELLER_LISTING_PREP`
   - To: `SELLER_DECISION_PENDING`
   - Reason: `decision_changed`

4. **Listing Cancelled**
   - Trigger: `listing.cancelled` event
   - From: `SELLER_ACTIVE_LISTING`
   - To: `SELLER_DISENGAGED`
   - Reason: `listing_cancelled`

5. **Listing Expired**
   - Trigger: `listing.expired` event (system-generated)
   - From: `SELLER_ACTIVE_LISTING`
   - To: `SELLER_DECISION_PENDING`
   - Reason: `listing_expired`

6. **Contract Terminated**
   - Trigger: `transaction.terminated` event
   - From: `SELLER_UNDER_CONTRACT`
   - To: `SELLER_ACTIVE_LISTING`
   - Reason: `contract_terminated`

### Rollback Behavior

Every rollback MUST:

1. ✅ Emit `journey.rollback` event with full metadata
2. ✅ Preserve ALL historical events (never delete)
3. ✅ Identify stages to re-lock (education, checklists)
4. ✅ Include reason and trigger event reference
5. ✅ Log actor who approved rollback (if manual)

---

## DEDUPLICATION RULES

### Deduplication Logic

Events are considered duplicates if ALL conditions match:

```
same event_type
AND same contact_id
AND same related_entity_id (if present)
AND within deduplication_window (typically 60 seconds)
```

### Deduplication Strategy

**Window-Based:**
- Check for identical events within 60-second window
- If found, ignore duplicate
- Log `duplicate_event_ignored` in system logs

**Idempotency Key (Optional):**
- External integrations may provide `idempotency_key` in metadata
- If key matches existing event, ignore duplicate

### Events Exempt from Deduplication

These events are NEVER deduplicated:
- `voice.intent.*` (each voice command is distinct)
- `automation.drip_sent` (each email is distinct)
- `journey.rollback` (rollbacks must always be recorded)
- `compliance.freeze` (each freeze must be audited)

### Deduplication Examples

**Duplicate (Ignored):**
```json
// Event 1 at 10:00:00
{"event_type": "buyer.search_executed", "contact_id": "uuid-1", "created_at": "10:00:00"}

// Event 2 at 10:00:30 (within 60s window)
{"event_type": "buyer.search_executed", "contact_id": "uuid-1", "created_at": "10:00:30"}
// Result: IGNORED
```

**Not Duplicate (Both Recorded):**
```json
// Event 1 at 10:00:00
{"event_type": "buyer.search_executed", "contact_id": "uuid-1", "created_at": "10:00:00"}

// Event 2 at 10:02:00 (outside 60s window)
{"event_type": "buyer.search_executed", "contact_id": "uuid-1", "created_at": "10:02:00"}
// Result: BOTH RECORDED
```

---

## INTEGRATION SIGNAL NORMALIZATION

External systems emit signals that must be normalized to canonical events.

### Dotloop Integration

| Dotloop Signal | Canonical Event | Metadata Mapping |
|----------------|-----------------|------------------|
| Loop Created | `transaction.created` | `dotloop_loop_id`, `listing_id`, `buyer_contact_id` |
| Document Uploaded | `document.uploaded` | `dotloop_document_id`, `document_type` |
| Document Signed | `document.signed` | `dotloop_document_id`, `signer_role` |
| Loop Closed | `transaction.closed` | `dotloop_loop_id`, `close_date` |
| Loop Cancelled | `transaction.terminated` | `dotloop_loop_id`, `termination_reason` |

### MLS Integration

| MLS Signal | Canonical Event | Metadata Mapping |
|------------|-----------------|------------------|
| Status: Active | `listing.stage_changed` | `listing_id`, `old_status`, `new_status: active` |
| Status: Pending | `seller.under_contract` | `listing_id`, `pending_date` |
| Status: Sold | `seller.closed` | `listing_id`, `sold_date`, `sold_price` |
| Status: Withdrawn | `listing.cancelled` | `listing_id`, `withdrawn_date` |
| Status: Expired | `listing.expired` | `listing_id`, `expiration_date` |

### Media Vendor Integration

| Vendor Signal | Canonical Event | Metadata Mapping |
|---------------|-----------------|------------------|
| Photos Delivered | `integration.media_vendor_delivered` | `vendor`, `asset_type: photos`, `listing_id`, `asset_ids` |
| Video Delivered | `integration.media_vendor_delivered` | `vendor`, `asset_type: video`, `listing_id`, `asset_ids` |
| 3D Tour Delivered | `integration.media_vendor_delivered` | `vendor`, `asset_type: 3d_tour`, `listing_id`, `asset_url` |

### Lender Integration

| Lender Signal | Canonical Event | Metadata Mapping |
|---------------|-----------------|------------------|
| Pre-Approval Issued | `buyer.financial_verification_submitted` | `lender_id`, `verification_type: preapproval`, `loan_amount`, `expiration_date` |
| Clear to Close | `financial.clear_to_close` | `lender_id`, `transaction_id` |
| Financing Denied | `financial.verification_failed` | `lender_id`, `denial_reason` |

### Voice Assistant Integration

| Voice Command | Canonical Event | Metadata Mapping |
|---------------|-----------------|------------------|
| "Search for homes" | `voice.intent.search_properties` | `actor_role`, `search_criteria` |
| "Schedule a tour" | `voice.intent.schedule_tour` | `actor_role`, `listing_id`, `preferred_date` |
| "Check my progress" | `voice.intent.check_progress` | `actor_role`, `journey_type` |

---

## SLA & ESCALATION SUPPORT

### SLA Event Types

| SLA Type | Event Trigger | Metadata Requirements |
|----------|---------------|----------------------|
| Response Time | `automation.sla_breach` | `sla_type: response_time`, `expected_hours`, `actual_hours` |
| Document Upload | `automation.sla_breach` | `sla_type: document_upload`, `document_type`, `deadline`, `overdue_days` |
| Tour Follow-Up | `automation.sla_breach` | `sla_type: tour_followup`, `tour_id`, `deadline` |
| Offer Response | `automation.sla_breach` | `sla_type: offer_response`, `offer_id`, `deadline` |
| Repair Timeline | `automation.sla_breach` | `sla_type: repair_timeline`, `repair_id`, `deadline` |
| Contract Execution | `automation.sla_breach` | `sla_type: contract_execution`, `transaction_id`, `deadline` |

### Escalation Events

| Event Type | Purpose | Metadata Requirements |
|------------|---------|----------------------|
| `automation.sla_breach` | SLA deadline missed | `sla_type`, `deadline`, `overdue_hours`, `severity` |
| `journey.stuck` | No progress in X days | `journey_type`, `current_stage`, `stuck_days` |
| `compliance.review_required` | Manual compliance review needed | `review_reason`, `priority`, `assigned_to` |
| `repair.failed` | Repair plan failed | `failure_stage`, `reason`, `escalate_to` |

### Escalation Workflow

1. **SLA Breach Detection** (System-Generated):
   - System monitors deadlines
   - Emits `automation.sla_breach` event when deadline passed
   - Includes severity: `low`, `medium`, `high`, `critical`

2. **Notification** (System Action):
   - System reads `automation.sla_breach` events
   - Sends notifications to appropriate roles
   - Example: Broker notified of high-severity SLA breaches

3. **Manual Review** (Human Action):
   - Broker/admin reviews escalation
   - Takes corrective action
   - Emits resolution event (e.g., `journey.admin_override` to unblock)

---

## SYSTEM BEHAVIOR RULES

### Event Ordering

- Events are processed in `created_at` order
- Concurrent events (same timestamp) are processed in order of receipt
- Rollback events take precedence over advance events

### State Computation

- Current journey stage is ALWAYS computed from event sequence
- State is NEVER stored directly
- Query pattern:
  ```sql
  SELECT * FROM activities
  WHERE contact_id = $1
    AND event_type LIKE 'buyer.%'
  ORDER BY created_at DESC
  ```

### Event Immutability

- Events in `activities` table are IMMUTABLE
- Corrections emit new events (e.g., `journey.rollback`)
- Historical events are NEVER deleted or modified

### System-Generated Events

System may auto-generate these events:
- `financial.verification_expired` (when expiration date passes)
- `listing.expired` (when MLS expiration date passes)
- `automation.sla_breach` (when deadline passes)
- `journey.stuck` (when no progress for X days)

---

## ACCEPTANCE CRITERIA

This contract MUST:

✅ Eliminate ambiguous state by defining clear event semantics  
✅ Prevent double execution through deduplication rules  
✅ Support rollback with explicit rollback events and behavior  
✅ Enable integration normalization with signal mapping tables  
✅ Support SLA monitoring with escalation event types  
✅ Work with existing `activities` table schema  
✅ Distinguish pre-listing vs. under-contract repair failures  
✅ Define voice assistant event intents  
✅ Support multi-role authority with actor tracking  
✅ Enable audit trails through immutable event history  

---

## COMPLIANCE STATEMENT

All systems emitting or consuming lifecycle events MUST comply with this contract. Any deviation requires explicit documentation and broker/admin approval.

**Constitutional Status:** This contract is binding on all current and future systems.

---

**END OF CONTRACT**
