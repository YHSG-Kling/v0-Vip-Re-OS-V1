# JOURNEY + PROGRESS CONTRACT (AUTHORITATIVE)

**VERSION:** 1.0.0  
**STATUS:** Constitutional - Must be obeyed by all systems  
**LAST UPDATED:** 2026-02-10

---

## PURPOSE

This contract defines the single authoritative governance model for buyer and seller journeys, progress computation, persona-aware transparency, authority boundaries, rollback behavior, and voice assistant scope. All existing and future systems MUST comply with this contract.

---

## CRITICAL CONSTRAINTS

✅ **ALLOWED:**
- Read from existing tables
- Derive state from evidence (activities, documents)
- Emit lifecycle events to activities table
- Validate transitions
- Gate actions based on readiness
- Compute progress
- Enforce authority rules

🚫 **FORBIDDEN:**
- Create new database tables
- Add or modify schema columns
- Store journey state outside activities table
- Advance journey stages from UI/execution code
- Bypass governance rules
- Infer missing schema
- Break existing systems

---

## AUTHORITATIVE DATA SOURCES (NON-NEGOTIABLE)

State MUST be derived from evidence in these tables ONLY:

| Table | Purpose |
|-------|---------|
| `contacts` | Contact identity, persona, type |
| `activities` | PRIMARY source of truth for all lifecycle events |
| `documents` / `client_documents` | Evidence of completion (contracts, verifications, etc.) |
| `listings` | Listing context for seller journeys |
| `offers` | Offer context for buyer/seller journeys |
| `transactions` | Transaction context (journey freezes here) |
| `showings` | Tour evidence for buyer journeys |
| `conversations` | AI ISA interaction evidence |

**EVIDENCE RULE:** State is derived from evidence, NEVER from intent or UI interactions.

---

## JOURNEY TYPES

Two independent journey types may run concurrently for the same contact:

### 1. Buyer Journey
- Lifecycle stages: BUYER_CONTACT_CREATED → BUYER_LIFETIME_CUSTOMER
- Primary focus: Property search, financial verification, touring, offer submission
- Hard gates: Financial verification REQUIRED before search/tour/offer

### 2. Seller Journey
- Lifecycle stages: SELLER_CONTACT_CREATED → SELLER_LIFETIME_CUSTOMER
- Primary focus: Equity establishment, CMA, presentation, listing prep, going live
- Hard gates: Equity established, presentation delivered, decision made

**CONCURRENCY RULE:** A contact may be both a buyer AND seller simultaneously with independent journeys.

---

## PERSONA RULE (EXPLICIT)

**What Persona Controls:**
- Language complexity and vocabulary
- Educational content depth
- UI presentation style
- Tone and examples

**What Persona NEVER Controls:**
- Readiness requirements
- Authority boundaries
- Governance rules
- Financial verification gates
- Evidence requirements
- Lifecycle stage transitions

**Personas:**
- `sophisticated_investor` - Financial terms, market analysis, investment metrics
- `first_time_buyer` - Simplified explanations, step-by-step guidance, encouragement
- `relocating_professional` - Timeline focus, logistics, efficiency
- `downsizing_senior` - Patience, clarity, emotional support
- `luxury_client` - Premium service, discretion, white-glove treatment

---

## BUYER JOURNEY — LOGICAL STAGES

### Stage Definitions

| # | Stage | Evidence Required | Description |
|---|-------|-------------------|-------------|
| 1 | `BUYER_CONTACT_CREATED` | `contacts.contact_id` exists | Initial contact created |
| 2 | `BUYER_FINANCIAL_VERIFICATION_REQUIRED` | No verification events | Gate triggered, verification required |
| 3 | `BUYER_FINANCIALLY_VERIFIED` | `buyer.financial_verification_submitted` + valid proof | Pre-approval or POF confirmed |
| 4 | `BUYER_SEARCH_CONFIGURED` | `buyer.search_configured` event | Search preferences set |
| 5 | `BUYER_SEARCHING` | `buyer.search_executed` events | Active property search |
| 6 | `BUYER_TOURING` | `showings` records OR `buyer.tour_scheduled` events | Viewing properties |
| 7 | `BUYER_OFFER_ELIGIBLE` | Financial verification valid + toured 1+ properties | Ready to submit offers |
| 8 | `BUYER_OFFER_SUBMITTED` | `offers` record with status=submitted/pending | Offer in play |
| 9 | `BUYER_UNDER_CONTRACT` | `offers` record with status=accepted + `transactions` record | **JOURNEY FREEZES** |
| 10 | `BUYER_CLOSED` | `transactions.status=closed` + `transaction.closed` event | Deal completed |
| 11 | `BUYER_LIFETIME_CUSTOMER` | Post-close activities, referrals, repeat business | Ongoing relationship |

### Buyer Governance Rules

**Financial Verification Gate (HARD):**
- Search, tours, and offers are BLOCKED until `BUYER_FINANCIALLY_VERIFIED`
- Verification may expire (30-90 days depending on type)
- Expiration triggers rollback to `BUYER_FINANCIAL_VERIFICATION_REQUIRED`
- Re-verification required before resuming activities

**Rollback Triggers:**
- Offer rejection: `BUYER_OFFER_SUBMITTED` → `BUYER_OFFER_ELIGIBLE`
- Offer withdrawal: `BUYER_OFFER_SUBMITTED` → `BUYER_OFFER_ELIGIBLE`
- Contract termination: `BUYER_UNDER_CONTRACT` → `BUYER_SEARCHING` or `BUYER_DISENGAGED`
- Financing failure: `BUYER_UNDER_CONTRACT` → `BUYER_FINANCIAL_VERIFICATION_REQUIRED`
- Verification expiration: Any stage → `BUYER_FINANCIAL_VERIFICATION_REQUIRED`

**Rollback Behavior:**
- NEVER delete history
- Re-lock education and checklists
- Reset progress percentage
- Emit rollback event with reason
- Require re-validation of gates

**Journey Freeze Rule:**
- `BUYER_UNDER_CONTRACT` is READ-ONLY
- Journey advances ONLY on explicit termination events
- Transaction lifecycle governance is deferred to System 6.x
- Journey resumes on `transaction.terminated` or `transaction.closed` events

---

## SELLER JOURNEY — LOGICAL STAGES

### Stage Definitions

| # | Stage | Evidence Required | Description |
|---|-------|-------------------|-------------|
| 1 | `SELLER_CONTACT_CREATED` | `contacts.contact_id` exists | Initial contact created |
| 2 | `SELLER_EQUITY_ESTABLISHED` | `seller.equity_confirmed` event | Positive equity confirmed |
| 3 | `SELLER_PREP` | `seller.prep_plan_created` event | Repair/staging plan in progress |
| 4 | `SELLER_PRESENTATION_READY` | CMA + net sheet + presentation assembled | Ready to present |
| 5 | `SELLER_DECISION_PENDING` | `seller.presentation_delivered` event | Awaiting list/wait/decline decision |
| 6 | `SELLER_LISTING_PREP` | `seller.decision_list` event + listing agreement signed | Preparing for MLS |
| 7 | `SELLER_COMING_SOON_PREP` | `listings.stage=coming_soon_prep` | Pre-MLS marketing phase |
| 8 | `SELLER_ACTIVE_LISTING` | `listings.stage=active` | Live on MLS |
| 9 | `SELLER_SHOWINGS_ACTIVE` | `showings` records for listing | Tours happening |
| 10 | `SELLER_OFFER_RECEIVED` | `offers` record for listing | Offer(s) received |
| 11 | `SELLER_UNDER_CONTRACT` | `offers` record accepted + `transactions` record | **JOURNEY FREEZES** |
| 12 | `SELLER_CLOSED` | `transactions.status=closed` + `transaction.closed` event | Deal completed |
| 13 | `SELLER_LIFETIME_CUSTOMER` | Post-close activities, referrals, repeat business | Ongoing relationship |

### Seller Governance Rules

**Equity Gate:**
- Cannot proceed to `SELLER_PREP` without confirmed equity
- Negative equity triggers `SELLER_DISENGAGED` or special workflow

**Repair Failure Governance (EXPLICIT):**

**Pre-Listing Repair Failure:**
- Occurs during `SELLER_PREP` or `SELLER_COMING_SOON_PREP`
- Triggers: Contractor unavailable, budget exceeded, timeline conflict
- Rollback: `SELLER_PREP` → `SELLER_DECISION_PENDING` (re-evaluate list decision)
- Event: `seller.repair_plan_failed` with reason
- Re-locks: Presentation education, listing prep checklist
- Never deletes repair history

**Under-Contract Repair Failure:**
- Occurs during `SELLER_UNDER_CONTRACT` (after inspection)
- Triggers: Failed inspection, seller refuses repairs, re-negotiation breakdown
- Rollback: `SELLER_UNDER_CONTRACT` → `SELLER_ACTIVE_LISTING` (contract terminated)
- Event: `transaction.repair_negotiation_failed` with reason
- Re-locks: Offer review education, contract education
- Listing returns to active status

**Rollback Triggers:**
- List decision reversed: `SELLER_LISTING_PREP` → `SELLER_DECISION_PENDING`
- Listing cancelled: `SELLER_ACTIVE_LISTING` → `SELLER_DISENGAGED` or `SELLER_PREP`
- Listing expired: `SELLER_ACTIVE_LISTING` → `SELLER_DECISION_PENDING` (re-present)
- Contract termination: `SELLER_UNDER_CONTRACT` → `SELLER_ACTIVE_LISTING`
- Pre-listing repair failure: `SELLER_PREP` → `SELLER_DECISION_PENDING`
- Under-contract repair failure: `SELLER_UNDER_CONTRACT` → `SELLER_ACTIVE_LISTING`

**Rollback Behavior:**
- NEVER delete history
- Re-lock education and marketing content
- Reset progress percentage
- Emit rollback event with reason
- Require re-validation of presentation/decision

**Journey Freeze Rule:**
- `SELLER_UNDER_CONTRACT` is READ-ONLY
- Journey advances ONLY on explicit termination events
- Transaction lifecycle governance is deferred to System 6.x
- Journey resumes on `transaction.terminated` or `transaction.closed` events

---

## TRANSACTION AWARENESS (DEFERRAL RULE)

**Deferral Principle:**
- Journeys MAY enter `*_UNDER_CONTRACT`
- Journeys MUST freeze at this point
- Transaction lifecycle governance is EXPLICITLY DEFERRED to System 6.x
- Journey ONLY resumes on explicit termination events:
  - `transaction.terminated` → Resume journey
  - `transaction.closed` → Advance to `*_CLOSED`

**DO NOT define transaction stages here.**

---

## PROGRESS BAR COMPUTATION (STRICT)

### Algorithm

For a given `contact_id` + `journey_type`:

1. **Load Ordered Stages:** Query canonical stage definitions for journey type
2. **Validate Evidence:** For each stage, check activities/documents for required evidence
3. **Classify Stage:**
   - `complete` - Evidence present, stage passed
   - `current` - Evidence incomplete, stage active
   - `blocked` - Gate not satisfied, stage locked
   - `locked` - Future stage, not yet accessible
4. **Compute Progress:**
   ```
   progress_percentage = (completed_stages / total_stages) * 100
   ```
5. **Explain Blockers:** Generate plain-language explanation for any blocked stages

### Progress Rules

- Progress MAY move backward (rollback scenarios)
- Progress MUST explain blockers in persona-appropriate language
- Progress NEVER advances from UI interactions
- Progress is ALWAYS computed from evidence
- Progress is READ-ONLY (computed property)

### Example Progress States

**Buyer Example:**
```json
{
  "journey_type": "buyer",
  "contact_id": "uuid",
  "current_stage": "BUYER_FINANCIAL_VERIFICATION_REQUIRED",
  "progress_percentage": 15,
  "completed_stages": 2,
  "total_stages": 11,
  "blockers": [
    {
      "stage": "BUYER_FINANCIALLY_VERIFIED",
      "reason": "Financial verification required before search",
      "action": "Upload pre-approval letter or proof of funds",
      "persona_message": "We need to verify your financing before showing you homes."
    }
  ]
}
```

**Seller Example:**
```json
{
  "journey_type": "seller",
  "contact_id": "uuid",
  "current_stage": "SELLER_DECISION_PENDING",
  "progress_percentage": 30,
  "completed_stages": 4,
  "total_stages": 13,
  "blockers": [
    {
      "stage": "SELLER_LISTING_PREP",
      "reason": "Awaiting your decision to list",
      "action": "Review presentation and decide: list, wait, or decline",
      "persona_message": "Take your time reviewing the market analysis. When you're ready, let us know your decision."
    }
  ]
}
```

---

## EDUCATION / CHECKLIST / VIDEO GOVERNANCE

### Unlock Rules

- Education unlocks ONLY when stage is `current` or `complete`
- Future stages show locked state with "Coming Soon" messaging
- Rollbacks MUST re-lock education for stages no longer complete

### Content Types

| Type | Purpose | Unlock Trigger |
|------|---------|----------------|
| Education Articles | Explain concepts | Stage becomes current |
| Checklists | Track tasks | Stage becomes current |
| Videos | Visual guidance | Stage becomes current |
| Drip Sequences | Automated nurture | Stage becomes current + time trigger |

### Persona-Aware Content

- Same content, different wording
- Example: Financial verification education
  - `sophisticated_investor`: "Submit pre-approval or proof of liquid assets"
  - `first_time_buyer`: "Your lender will provide a pre-approval letter showing you're ready to buy"
  - `relocating_professional`: "Fast-track: Upload your pre-approval to unlock property search"

### Special Requirements

**CMA Education (MANDATORY):**
- MUST include appraisal disclaimer
- Example: "This analysis is not an appraisal. Final value is determined by a licensed appraiser hired by the buyer's lender."

**Repair Education (MANDATORY):**
- Distinguish pre-listing vs. under-contract repairs
- Explain consequences of repair failure at each stage

---

## AUTHORITY MATRIX (EXPANDED)

### Role Definitions

| Role | Authority Level | Can Advance Stages | Can Override Gates | Can Rollback |
|------|----------------|-------------------|-------------------|--------------|
| `contact` | 0 - None | ❌ No | ❌ No | ❌ No |
| `agent` | 1 - Standard | ❌ No | ❌ No | ⚠️ Limited (pre-contract) |
| `team_leader` | 2 - Elevated | ❌ No | ⚠️ Limited | ✅ Yes (pre-contract) |
| `broker` | 3 - High | ❌ No | ✅ Yes (with audit) | ✅ Yes |
| `admin` | 4 - Highest | ❌ No | ✅ Yes (with audit) | ✅ Yes |
| `compliance_manager` | Special | ❌ No | 🚫 Block Only | ❌ No |
| `lender` | External | ❌ No | ❌ No | ❌ No |
| `transaction_coordinator` | Support | ❌ No | ❌ No | ❌ No |
| `vendor` | External | ❌ No | ❌ No | ❌ No |

### Authority Rules

**Universal Rules:**
1. **No role bypasses evidence** - Stages only advance with proof
2. **Overrides require auditable events** - All overrides logged to activities
3. **Compliance may block but never advance** - Compliance manager freezes journeys only
4. **External roles emit intents only** - Lender/vendor actions trigger events, not stages

### Override Scenarios

**Agent Override (Limited):**
- Can mark tours complete if showing system fails
- Can manually log conversations if AI ISA is down
- CANNOT override financial verification gate

**Team Leader Override:**
- Can override search configuration requirements
- Can manually advance to `BUYER_OFFER_ELIGIBLE` if touring evidence is ambiguous
- CANNOT override financial verification gate
- CANNOT override under-contract freeze

**Broker/Admin Override:**
- Can override ANY gate with reason
- Must emit `journey.admin_override` event with justification
- Examples:
  - Skip financial verification for all-cash institutional buyer
  - Advance seller journey without CMA for FSBO conversion
  - Unfreeze journey stuck in bad state

**Compliance Block:**
- Compliance manager can freeze journey at any stage
- Emit `journey.compliance_freeze` event with reason
- Examples:
  - Fair Housing investigation
  - Fraud alert
  - Regulatory hold

### Multi-Party Update Rules

**Lender Actions:**
- Emit `buyer.financial_verification_submitted` event
- System evaluates evidence and advances if valid
- Lender CANNOT directly advance journey

**Agent Actions:**
- Emit intent-based events (e.g., `buyer.search_configured`)
- System validates readiness and advances if eligible
- Agent CANNOT skip gates

**Admin Actions:**
- Can emit override events to bypass gates
- Must include `override_reason` in metadata
- Creates audit trail in activities

---

## VOICE ASSISTANT SCOPE

### Who Can Use Voice Assistant

| Role | Access | Use Case |
|------|--------|----------|
| Contacts (Buyers/Sellers) | ✅ Yes | Check progress, ask questions, get guidance |
| Agents | ✅ Yes | Hands-free while driving, quick status checks |
| Team Leaders | ✅ Yes | Monitor team progress, identify blockers |
| Brokers | ✅ Yes | High-level pipeline review |
| Admins | ✅ Yes | System-wide monitoring |

### What Voice Assistant CAN Do

✅ **Allowed Actions:**
- Explain current journey stage
- List completed stages
- Explain blockers and next steps
- Suggest actions to unblock progress
- Answer education questions
- Search properties (if buyer is verified)
- Schedule tours (if buyer is verified)
- Retrieve listing details
- Explain persona-appropriate concepts
- Emit intent-based events to activities table

### What Voice Assistant CANNOT Do

🚫 **Forbidden Actions:**
- Directly advance journey stages
- Override gates or authority rules
- Bypass financial verification
- Unfreeze `*_UNDER_CONTRACT` journeys
- Delete history
- Modify schema
- Execute transactions

### Voice Assistant Behavior

**Event Emission:**
- Voice commands emit `voice.intent.*` events to activities
- Governance systems evaluate intents and decide if action is allowed
- Example: "Schedule a tour" → Checks if buyer is financially verified → Allows or blocks

**Blocker Explanation:**
- Voice assistant explains WHY action is blocked
- Example: "I can't schedule tours yet because your financial verification is pending. Please upload your pre-approval letter."

**Persona Awareness:**
- Voice assistant adapts language to persona
- Example for `first_time_buyer`: "Let's get your financing sorted first so you can start seeing homes!"
- Example for `sophisticated_investor`: "Financial verification required before property access per brokerage policy."

**Agent Use Case (On-the-Run):**
- Agent driving to showing: "What's the status of the Smith buyer?"
- Voice assistant: "The Smiths are financially verified and have toured 3 properties. They're ready to make an offer."
- Agent: "Send me the comparables for 123 Main Street"
- Voice assistant: "Sent to your email. 3 recent sales within 0.5 miles."

---

## ROLLBACK BEHAVIOR (EXPLICIT)

### Rollback Principles

1. **Never Delete History** - All events remain in activities table
2. **Reset Current Stage** - Update computed current stage to rollback target
3. **Re-Lock Education** - Mark future education as locked again
4. **Reset Progress** - Recompute progress percentage
5. **Emit Rollback Event** - Log reason for rollback
6. **Preserve Evidence** - Keep all documents and prior events

### Rollback Event Schema

```json
{
  "event_type": "journey.rollback",
  "contact_id": "uuid",
  "journey_type": "buyer",
  "from_stage": "BUYER_OFFER_SUBMITTED",
  "to_stage": "BUYER_OFFER_ELIGIBLE",
  "reason": "offer_rejected",
  "metadata": {
    "offer_id": "uuid",
    "rejection_reason": "Seller accepted higher offer",
    "relocked_education": ["offer_strategy", "negotiation_tactics"],
    "actor_role": "agent",
    "actor_id": "uuid"
  }
}
```

### Common Rollback Scenarios

**Buyer Rollbacks:**
1. Offer rejected → `BUYER_OFFER_ELIGIBLE`
2. Offer withdrawn → `BUYER_OFFER_ELIGIBLE`
3. Contract terminated → `BUYER_SEARCHING` or `BUYER_DISENGAGED`
4. Financing failed → `BUYER_FINANCIAL_VERIFICATION_REQUIRED`
5. Verification expired → `BUYER_FINANCIAL_VERIFICATION_REQUIRED`

**Seller Rollbacks:**
1. Pre-listing repair failed → `SELLER_DECISION_PENDING`
2. List decision reversed → `SELLER_DECISION_PENDING`
3. Listing cancelled → `SELLER_DISENGAGED`
4. Listing expired → `SELLER_DECISION_PENDING`
5. Contract terminated → `SELLER_ACTIVE_LISTING`
6. Under-contract repair failed → `SELLER_ACTIVE_LISTING`

---

## ACCEPTANCE CRITERIA

This contract MUST:

✅ Prevent schema hallucination by defining evidence sources  
✅ Enforce governance by specifying hard gates and authority rules  
✅ Support rollback by defining explicit rollback triggers and behavior  
✅ Align UI progress by computing progress from evidence only  
✅ Enable automation by allowing intent-based events from voice/AI  
✅ Enable voice interfaces by defining scope and blocker explanation  
✅ Distinguish repair failure types (pre-listing vs. under-contract)  
✅ Defer transaction lifecycle to System 6.x  
✅ Work with existing schema without modifications  

---

## COMPLIANCE STATEMENT

All systems implementing journey and progress logic MUST comply with this contract. Any deviation requires explicit documentation and broker/admin approval.

**Constitutional Status:** This contract is binding on all current and future systems.

---

**END OF CONTRACT**
