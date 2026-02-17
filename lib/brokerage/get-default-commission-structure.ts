PHASE 2 CODEBASE REALIGNMENT (FINAL SAFE VERSION)

Platform: VIP Real Estate OS
Schema: build13 (authoritative)
Objective: Align entire codebase to schema. Remove hardcoded values. Prepare for Commission Engine 8.0.

🔒 CONSTITUTIONAL RULES (ENFORCE STRICTLY)
1️⃣ NO HARDCODED COMMISSION MATH

FORBIDDEN:

price * 0.03
salePrice * commissionRate
const commission = 15000


All commission logic must route through:

getDefaultCommissionStructure()


No exceptions.

2️⃣ PERCENT STORAGE RULE

Database:

base_percentage → whole number (3 = 3%)

split_percent → whole number (80 = 80%)

referral_value (percent type) → whole number

Resolver:

Convert to decimal using / 100

Do NOT double divide

3️⃣ AGENT IDENTITY RULE

Commission identity must use:

agents.id


Never:

users.id


FKs in build13 point to agents(id).

4️⃣ MULTI-TENANT RULE

Every query touching:

transactions

commissions

agent_commission_profiles

agent_cap_tracking

commission_structures

commission_distributions

listings

contacts

leads

teams

team_members

MUST include:

.eq("brokerage_id", brokerageId)


No exceptions.

5️⃣ SETTINGS ACCESS RULE

Never query:

global_settings.additional_settings


Directly.

Must use:

getBrokerageSettings()
getPrimaryState()
getPipelineSettings()
getFinancialDefaults()

📐 SCHEMA TRUTH (BUILD13)
Transactions

purchase_price (numeric 14,2)

commission_percentage (numeric 6,5)

close_date

contract_date (compliance-confirmed)

agent_id (primary)

seller_agent_id

buyer_agent_id

brokerage_id

Do NOT use:

sale_price

closing_date

transaction_type

🎯 EXECUTION STEPS
STEP 1 — Fix get-default-commission-structure.ts
Must:

Query agent_commission_profiles using:

.eq("agent_id", agentId)
.eq("brokerage_id", brokerageId)
.eq("is_active", true)


Query commission_structures:

.eq("brokerage_id", brokerageId)
.eq("is_default", true)
.eq("is_active", true)


Convert base_percentage:

const grossRate = structure.base_percentage / 100


Convert split_percent:

const splitDecimal = profile.split_percent / 100


Prefer new fee columns:

transactionFeeValue = profile.transaction_fee_value ?? profile.transaction_fee ?? 0


Return:

{
  agentBuyerSideRate,
  agentListingSideRate,
  brokerageBuyerSideRate,
  brokerageListingSideRate,
  transactionFeeType,
  deskFeeType,
  technologyFeeType,
  eoFeeType,
  royaltyType,
  referralType,
  residualType
}


Resolver returns whole dollars.
Engine will handle cents conversion later.

STEP 2 — Remove Deprecated Agents Columns

Remove ALL reads of:

agents.commission_split

agents.cap_amount

agents.transaction_fee

Commission terms belong ONLY in agent_commission_profiles.

STEP 3 — Remove Hardcoded Commission Math

Audit:

offer-management.ts

calculators

net sheet

analytics

multi-persona

Replace inline math with:

getDefaultCommissionStructure()


For preview-only usage.

No commission calculations outside engine.

STEP 4 — Fix Column Mismatches

Replace:

sale_price → purchase_price

closing_date → close_date

transaction_type → deal_type

Do NOT change schema.

Only change code.

STEP 5 — Add brokerage_id Filters

Audit entire:

app/actions/

lib/

Add brokerage_id filter everywhere required.

STEP 6 — Fix Agent Identity Usage

Remove patterns like:

agentId = agent?.id || user.id


Replace with:

if (!agent?.id) throw new Error("Agent record missing")
const agentId = agent.id


Commission must never fallback to users.id.

STEP 7 — Contract Date Governance (Light Phase 2 Version)

Do NOT auto-set contract_date on signature.

Create:

lib/transactions/contract-governance.ts


Rules:

contract_date can only be set when:

compliance_passed_at IS NOT NULL

all required signatures present

Allowed roles:

admin

broker

compliance_officer

TC

Must insert lifecycle_event:

transaction.contract_date.set

transaction.contract_date.overridden (if changed)

No direct updates elsewhere.

🧪 VERIFICATION CHECKS

After Phase 2:

grep -r "* 0.03" app/ lib/


→ 0 results

grep -r "sale_price" app/ lib/


→ 0 results

grep -r "closing_date" app/ lib/


→ 0 results

grep -r "additional_settings" app/ lib/ | grep -v resolver


→ 0 results

grep -r "commissions.*user_id" app/ lib/


→ 0 results

🚫 OUT OF SCOPE

Do NOT:

Build Commission Engine 8.0 yet

Modify schema

Remove seller_agent_id/buyer_agent_id

Create agent_roles table

Rewrite transactions structure

🧠 RESULT AFTER PHASE 2

You will have:

Clean code aligned to build13

No hardcoded money math

Correct percent handling

Proper agent identity usage

Multi-tenant safe queries

Resolver properly implemented

Contract date governance enforced