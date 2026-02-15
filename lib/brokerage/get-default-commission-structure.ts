Platform Stabilization + Hardcoded Removal + Event Layer Separation
Version: Production Correction Pass
Scope: All Offer, Lifecycle, Calculator, SLA, Compliance Logic
CONTEXT

You are working inside a:

Next.js 15

Supabase (Postgres)

TypeScript

Multi-tenant brokerage SaaS platform

System 7.2 (Brokerage Settings Resolver) exists.

lifecycle_events table has just been created.

You must refactor the entire system to remove:

Hardcoded commission values

Hardcoded state fallbacks

Hardcoded deadlines

Hardcoded property tax rates

Hardcoded provider assumptions

Hardcoded closing entity assumptions

Hardcoded TX fallback logic

Direct access to global_settings.additional_settings

System lifecycle writes to activities

🔴 ABSOLUTE NON-NEGOTIABLE RULES

❌ No direct reads from global_settings.additional_settings
❌ No hardcoded commission rates (0.03, 0.06, etc.)
❌ No hardcoded state fallbacks ("TX")
❌ No hardcoded SLA durations
❌ No hardcoded provider names
❌ No hardcoded property tax rates
❌ No hardcoded offer expiration windows
❌ No direct writes of system state to activities
❌ No assuming QuickBooks is the accounting provider
❌ No assuming Dotloop is the transaction provider
❌ No assuming title company is the closing entity

✅ SYSTEM STRUCTURE RULES
1️⃣ Canonical System Events → lifecycle_events

Replace ALL system lifecycle writes:

supabase.from("activities")


With:

supabase.from("lifecycle_events")


activities remains for:

CRM notes

Tasks

Manual interactions

lifecycle_events is the canonical event store for:

buyer.offer.*

transaction.*

compliance.*

listing.*

lifecycle state transitions

2️⃣ Offer Engine Must Match Actual Schema

Current schema:

offers (
  id,
  transaction_id,
  listing_id,
  contact_id,
  offer_number,
  offer_price,
  earnest_money,
  contingencies,
  status,
  submitted_at,
  response_deadline,
  responded_at
)


Refactor 7.1B to:

offer_amount → offer_price

buyer_id → contact_id

expires_at → response_deadline

Remove assumptions about non-existent columns

Store extra structured offer data in metadata JSON if needed

DO NOT modify schema unless absolutely required.

🔵 PHASE 1 — REMOVE ALL HARDCODED BUSINESS LOGIC
A. Commission Refactor

Files to refactor:

offer-management.ts

analytics.ts

transactions.ts

calculators.ts

transaction-management.service.ts

brokerKPIs.ts

Remove:

0.03
0.06
commissionRate || 0.03


Replace with:

const structure = await getDefaultCommissionStructure(brokerageId)


Create helper:

async function getDefaultCommissionStructure(brokerageId: string) {
  const supabase = createServiceClient()

  const { data } = await supabase
    .from("commission_structures")
    .select("*")
    .eq("brokerage_id", brokerageId)
    .eq("is_default", true)
    .single()

  if (!data) {
    throw new Error("No default commission structure configured")
  }

  return data
}


No fallback allowed.

B. State Refactor (Forms + Compliance + Guidelines)

Files:

ai-offer-creation.ts

documents.ts

ai-predictions.ts

Remove:

STATE_OFFER_FORMS
guidelines[state] || guidelines.TX
lead.state || "TX"


Replace with:

const state = await getRequiredPrimaryState(brokerageId)

const requirements = await supabase
  .from("state_compliance_requirements")
  .select("*")
  .eq("state", state)


If primary_state is null → throw error.

No Texas fallback.

C. Transfer Tax & Closing Costs Refactor

File: calculators.ts

Remove:

homeValue * 0.001
homeValue * 0.007
homeValue * 0.015


Replace with:

const state = await getRequiredPrimaryState(brokerageId)
const closingType = await getClosingEntityType(brokerageId)

const { data: taxRules } = await supabase
  .from("state_compliance_requirements")
  .select("*")
  .eq("state", state)
  .in("applies_to_closing_type", [closingType, "both"])


All cost logic must derive from table data.

D. SLA / Deadline Refactor

Files:

sla-metadata.ts

offer-management.ts

lead-readiness.ts

copilot.ts

ai-isa.ts

Remove ALL literals:

48
72
168
7
14


Replace with:

const { pipeline_settings } = await getBrokerageSettings(brokerageId)


Use:

offer_expiration_hours

stale_lead_warning_days

stale_lead_critical_days

financial_verification_sla_hours

first_tour_sla_hours

offer_submission_sla_hours

E. Property Tax & PMI Refactor

File: calculators.ts

Remove:

propertyTaxRate = 0.0125
pmi_rate literal


Replace with:

const { financial_defaults } = await getBrokerageSettings(brokerageId)


Use:

property_tax_rate

pmi_rate

pmi_threshold_percent

F. Accounting Provider Assumptions

Search entire repo for:

quickbooks

xero

skyslope accounting

brokermint accounting

Replace with:

const provider = await getAccountingProvider(brokerageId)


Branch behavior accordingly.

Never assume QuickBooks.

🔵 PHASE 2 — Offer Engine Realignment (7.1B)
Replace ALL lifecycle writes

Change:

supabase.from("activities")


To:

supabase.from("lifecycle_events")


Insert:

{
  brokerage_id,
  entity_type,
  entity_id,
  event_type,
  actor_user_id,
  metadata
}

Offer Status Rule

status column = UI reflection only

lifecycle derived from lifecycle_events

keep updating status for filtering

never use status as source of truth

Compliance Gate Rule

Acceptance MUST verify:

SELECT 1
FROM lifecycle_events
WHERE entity_type = 'offer'
AND entity_id = $1
AND event_type = 'buyer.offer.compliance.passed'


If not present → block acceptance.

🔵 PHASE 3 — Enforce Resolver Usage Everywhere

Search for:

from("global_settings")


Remove all direct reads.

Replace with:

await getBrokerageSettings(brokerageId)

🔵 PHASE 4 — Remove Default Provider Assumptions

In DEFAULT_SETTINGS:

transaction_provider: null


Add:

getRequiredTransactionProvider()


Throw error if not configured.

No silent dotloop default.

🔵 PHASE 5 — Closing Entity Routing

Anywhere system says:

"notify title agent"

Replace with:

const closingType = await getClosingEntityType(brokerageId)


If:

attorney → route to participant_type 'attorney'

title_company → use transaction_title_escrow

escrow_company → use escrow participant

No hardcoded language.

🔵 PHASE 6 — Replace All Hardcoded TX Fallbacks

Search:

|| "TX"
|| guidelines.TX
|| forms.TX


Replace with:

const state = await getPrimaryState(brokerageId)
if (!state) throw

🔵 PHASE 7 — System Event Naming Convention

All lifecycle events must follow:

namespace.domain.action.state


Examples:

buyer.offer.draft.created

buyer.offer.signature.requested

buyer.offer.accepted

transaction.compliance.scan.started

transaction.closing.disbursed

No vague event names.

🔵 FINAL VALIDATION CHECKLIST

After refactor:

Configuration

 No direct global_settings reads

 No hardcoded commission values

 No hardcoded state fallbacks

 No hardcoded SLA durations

 No hardcoded property tax

 No provider hardcoding

Events

 All system lifecycle writes go to lifecycle_events

 activities only used for CRM tasks

 Acceptance requires compliance.passed event

 Status column used only for UI reflection

Offer Engine

 Fields match actual offers schema

 No phantom columns referenced

 response_deadline used instead of expires_at

Multi-Tenant Safety

 All resolver functions require brokerageId

 No single-tenant assumptions anywhere