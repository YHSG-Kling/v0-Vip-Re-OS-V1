import "server-only"

// lib/platform/demo-tenant.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PERSISTENT DEMO SHOWCASE TENANT — one superadmin-provisioned, clearly
// flagged (brokerages.is_demo = true) demo brokerage full of believable but
// obviously fictional data, so sales can tour the WHOLE OS (website, CRM,
// deals, marketing) without ever touching a real tenant.
//
// Design rules:
//   • Provisioning goes through the SAME canonical path self-serve signup uses
//     (signupBrokerageAction → provisionTenantOwner → seedStarterAssistant →
//     day-one /site/[slug] website) — no forked provisioning logic here.
//   • The tenant never bills: its subscription is set to 'paused' (the comp
//     mechanism brokerage-management already uses) and its trial window is
//     pushed a decade out so trial-expiry crons never nag it.
//   • The dataset is DETERMINISTIC: every row has a fixed UUID and fixed
//     content; only timestamps are computed relative to "now" so the demo
//     always looks freshly worked. Re-seeding converges to the same state.
//   • Reset = delete ALL rows for the demo brokerage_id in the seeded tables,
//     then re-insert the plan. Rows also carry the DEMO_TAG in tags/notes as a
//     visible marker, but brokerage_id is the authoritative reset key.
//   • HARD GUARD: every destructive operation re-checks is_demo = true on the
//     target row (never trusts a passed id) before deleting anything.
//
// NOTE for the schema-drift guard: brokerages.is_demo was added by a live
// migration AFTER scripts/schema-snapshot.ts was last regenerated (2026-06-18).
// The references here are acknowledged in scripts/schema-drift-baseline.json
// until the snapshot is regenerated against the live schema.

import { createServiceClient } from "@/lib/supabase/service"
import { signupBrokerageAction } from "@/app/actions/auth/signup-brokerage"

// ── Identity ─────────────────────────────────────────────────────────────────

/** Stable public slug — powers /site/demo-showcase, the live demo website. */
export const DEMO_TENANT_SLUG = "demo-showcase"
/** The product's own showcase brokerage (product brand default: "VIP Agents"). */
export const DEMO_TENANT_NAME = "VIP Agents Showcase Realty"
/** RFC-2606 reserved domain — the invite bounces harmlessly; nobody real. */
export const DEMO_OWNER_EMAIL = "showcase.owner@demo-showcase.example.com"
/** Visible marker threaded through seeded rows (tags / notes). */
export const DEMO_TAG = "demo-showcase"

/** The tables seedDemoData owns, in FK-safe DELETE order (children first). */
export const DEMO_SEEDED_TABLES = [
  "messages",
  "conversations",
  "activities",
  "transactions",
  "listings",
  "leads",
  "contacts",
] as const
export type DemoSeededTable = (typeof DEMO_SEEDED_TABLES)[number]

export interface DemoTenantRef {
  id: string
  name: string | null
  slug: string | null
  status: string | null
  created_at: string | null
}

export interface EnsureDemoTenantResult {
  ok: boolean
  created: boolean
  brokerage?: DemoTenantRef
  error?: string
}

export interface SeedDemoDataResult {
  ok: boolean
  counts?: Record<DemoSeededTable, number>
  error?: string
}

export interface DemoTenantSnapshot {
  exists: boolean
  brokerage?: DemoTenantRef
  counts?: Record<DemoSeededTable, number>
  lastReset?: { action: string; actor_email: string | null; created_at: string } | null
}

// ── Deterministic ids + relative dates ───────────────────────────────────────

/** Fixed, valid-v4-shaped UUIDs: entity block + row number. Deterministic so a
 *  re-seed converges (wipe + insert of the SAME ids) and cross-references
 *  (contact → transaction → conversation) are plain literals. */
function demoUuid(entity: number, n: number): string {
  return `dde00000-0000-4000-a000-${String(entity).padStart(4, "0")}${String(n).padStart(8, "0")}`
}
const CONTACT = (n: number) => demoUuid(1, n)
const LEAD = (n: number) => demoUuid(2, n)
const LISTING = (n: number) => demoUuid(3, n)
const TXN = (n: number) => demoUuid(4, n)
const CONVO = (n: number) => demoUuid(5, n)
const MSG = (n: number) => demoUuid(6, n)
const ACT = (n: number) => demoUuid(7, n)

const DAY = 24 * 60 * 60 * 1000
const daysAgo = (d: number) => new Date(Date.now() - d * DAY).toISOString()
const daysAhead = (d: number) => new Date(Date.now() + d * DAY).toISOString()

// ── The seed plan (pure) ─────────────────────────────────────────────────────

export interface DemoSeedPlan {
  contacts: Array<Record<string, unknown>>
  leads: Array<Record<string, unknown>>
  listings: Array<Record<string, unknown>>
  transactions: Array<Record<string, unknown>>
  conversations: Array<Record<string, unknown>>
  messages: Array<Record<string, unknown>>
  activities: Array<Record<string, unknown>>
}

/**
 * PURE: the full showcase dataset. Names/addresses are professional but
 * obviously fictional (Exampleton, Samplewood, "Showcase Blvd", 555 phones,
 * example.com emails) — no real people, ever.
 *
 * agentId is the demo owner's agents.id (contacts/listings/transactions/
 * conversations agent_id are agents.id in this codebase — see
 * app/actions/contacts.ts createContact). ownerUserId is users.id, used for
 * activities.agent_id per the signup-brokerage precedent.
 */
export function buildDemoSeedPlan(
  brokerageId: string,
  agentId: string | null,
  ownerUserId: string | null,
): DemoSeedPlan {
  const base = { brokerage_id: brokerageId }
  const phone = (n: number) => `+1512555${String(100 + n).padStart(4, "0")}`
  const email = (first: string, last: string) => `${first}.${last}@example.com`.toLowerCase()

  // 12 contacts across the journey: new → nurture → active → under contract →
  // closed → lifetime customer, buyers + sellers + investor + sphere.
  const contacts = [
    { id: CONTACT(1),  first_name: "Ava",    last_name: "Exampleton", contact_type: "buyer",    status: "active", lead_temperature: "hot",  lifecycle_state: "converted",         budget_min: 450000, budget_max: 550000, city: "Austin", state: "TX", zip_code: "78701", source: "website",     engagement_score: 92, notes: `[${DEMO_TAG}] Pre-approved at $550K with Lone Star Lending. Wants Mueller or Cherrywood, needs a home office. Touring Saturdays.`, last_contacted_at: daysAgo(1), next_followup_at: daysAhead(2), created_at: daysAgo(45) },
    { id: CONTACT(2),  first_name: "Marcus", last_name: "Demoline",   contact_type: "buyer",    status: "active", lead_temperature: "warm", lifecycle_state: "assigned",          budget_min: 350000, budget_max: 425000, city: "Round Rock", state: "TX", zip_code: "78664", source: "open_house",  engagement_score: 71, notes: `[${DEMO_TAG}] Met at the Showcase Blvd open house. First-time buyer, relocating from Dallas in the fall.`, last_contacted_at: daysAgo(3), next_followup_at: daysAhead(4), created_at: daysAgo(30) },
    { id: CONTACT(3),  first_name: "Priya",  last_name: "Sampleford", contact_type: "buyer",    status: "new",    lead_temperature: "warm", lifecycle_state: "new",               budget_min: 500000, budget_max: 650000, city: "Austin", state: "TX", zip_code: "78745", source: "referral",    engagement_score: 55, notes: `[${DEMO_TAG}] Referred by the Placegoods. Physician at Demo Regional — schedule around night shifts.`, last_contacted_at: daysAgo(2), next_followup_at: daysAhead(1), created_at: daysAgo(9) },
    { id: CONTACT(4),  first_name: "Diego",  last_name: "Testwell",   contact_type: "buyer",    status: "active", lead_temperature: "cold", lifecycle_state: "long_term_nurture", budget_min: 300000, budget_max: 380000, city: "Pflugerville", state: "TX", zip_code: "78660", source: "website",     engagement_score: 28, notes: `[${DEMO_TAG}] Lease runs through next spring — on the 12-month nurture drip.`, last_contacted_at: daysAgo(21), next_followup_at: daysAhead(30), created_at: daysAgo(120) },
    { id: CONTACT(5),  first_name: "Sofia",  last_name: "Mocksley",   contact_type: "seller",   status: "active", lead_temperature: "hot",  lifecycle_state: "converted",         city: "Austin", state: "TX", zip_code: "78704", source: "sphere",      engagement_score: 95, notes: `[${DEMO_TAG}] Closed on Example Hollow — relocating to Denver for work. Send the closing gift + review request.`, last_contacted_at: daysAgo(2), next_followup_at: daysAhead(7), created_at: daysAgo(90) },
    { id: CONTACT(6),  first_name: "Ethan",  last_name: "Demoranch",  contact_type: "seller",   status: "active", lead_temperature: "warm", lifecycle_state: "assigned",          city: "Lakeway", state: "TX", zip_code: "78734", source: "farm_mail",   engagement_score: 64, notes: `[${DEMO_TAG}] Listing appointment held — reviewing the CMA for Sample Court. Wants $1.3M; comps support $1.25M.`, last_contacted_at: daysAgo(5), next_followup_at: daysAhead(3), created_at: daysAgo(40) },
    { id: CONTACT(7),  first_name: "Grace",  last_name: "Samplewell", contact_type: "seller",   status: "new",    lead_temperature: "warm", lifecycle_state: "new",               city: "Austin", state: "TX", zip_code: "78723", source: "website",     engagement_score: 47, notes: `[${DEMO_TAG}] Requested a home-value report on Demo Ridge Trail. Empty-nesters thinking about downsizing.`, last_contacted_at: daysAgo(4), next_followup_at: daysAhead(2), created_at: daysAgo(12) },
    { id: CONTACT(8),  first_name: "Liam",   last_name: "Placegood",  contact_type: "buyer",    status: "active", lead_temperature: "cold", lifecycle_state: "lifetime_customer", city: "Austin", state: "TX", zip_code: "78702", source: "past_client", engagement_score: 60, notes: `[${DEMO_TAG}] Bought in 2024. Home anniversary next month — sent two referrals since closing.`, last_contacted_at: daysAgo(35), next_followup_at: daysAhead(25), created_at: daysAgo(500) },
    { id: CONTACT(9),  first_name: "Nora",   last_name: "Exampleby",  contact_type: "seller",   status: "active", lead_temperature: "cold", lifecycle_state: "lifetime_customer", city: "Cedar Park", state: "TX", zip_code: "78613", source: "past_client", engagement_score: 52, notes: `[${DEMO_TAG}] Sold with us last year; now renting downtown. Check in each quarter — likely to buy again in 12–18 months.`, last_contacted_at: daysAgo(50), next_followup_at: daysAhead(40), created_at: daysAgo(420) },
    { id: CONTACT(10), first_name: "Omar",   last_name: "Demofield",  contact_type: "investor", status: "active", lead_temperature: "warm", lifecycle_state: "converted",         budget_min: 250000, budget_max: 900000, city: "Austin", state: "TX", zip_code: "78741", source: "referral",    engagement_score: 78, notes: `[${DEMO_TAG}] Buy-and-hold investor, 4 doors so far. Under contract on Model Home Loop; wants 2 more this year at 6%+ cap.`, last_contacted_at: daysAgo(1), next_followup_at: daysAhead(5), created_at: daysAgo(200) },
    { id: CONTACT(11), first_name: "Chloe",  last_name: "Testerly",   contact_type: "both",     status: "active", lead_temperature: "cold", lifecycle_state: "long_term_nurture", city: "Austin", state: "TX", zip_code: "78731", source: "sphere",      engagement_score: 33, notes: `[${DEMO_TAG}] Sphere — kids' school connection. Move-up seller/buyer when rates dip; keep on the newsletter.`, last_contacted_at: daysAgo(28), next_followup_at: daysAhead(45), created_at: daysAgo(160) },
    { id: CONTACT(12), first_name: "Ben",    last_name: "Samplewood", contact_type: "buyer",    status: "active", lead_temperature: "hot",  lifecycle_state: "converted",         budget_min: 450000, budget_max: 520000, city: "Austin", state: "TX", zip_code: "78749", source: "sign_call",   engagement_score: 88, notes: `[${DEMO_TAG}] Under contract on Model Home Loop — inspection scheduled Thursday, lender docs in underwriting.`, last_contacted_at: daysAgo(1), next_followup_at: daysAhead(1), created_at: daysAgo(25) },
  ].map((c, i) => ({
    ...base,
    ...c,
    agent_id: agentId,
    email: email(c.first_name, c.last_name),
    phone: phone(i + 1),
    address: null,
    tags: [DEMO_TAG, c.contact_type],
    updated_at: daysAgo(1),
  }))

  // 6 leads working their way toward the CRM — varied stage/temperature/source.
  const leads = [
    { id: LEAD(1), first_name: "Tara",   last_name: "Demopolis",  lead_type: "buyer",  lead_stage: "new",       lead_temperature: "hot",  lead_score: 86, urgency_level: "hot",   source: "website",     city: "Austin", state: "TX", zip_code: "78704", lifecycle_state: "raw",            notes: `[${DEMO_TAG}] Filled out the home-search form twice this week — searching South Austin under $500K.`, created_at: daysAgo(1) },
    { id: LEAD(2), first_name: "Victor", last_name: "Sampleson",  lead_type: "seller", lead_stage: "new",       lead_temperature: "warm", lead_score: 64, urgency_level: "warm", source: "home_value",  city: "Buda", state: "TX", zip_code: "78610", lifecycle_state: "unconsented",    notes: `[${DEMO_TAG}] Ran the home-value tool on 44 Placeholder Pass. No consent yet — awaiting opt-in.`, created_at: daysAgo(2) },
    { id: LEAD(3), first_name: "Ingrid", last_name: "Mockford",   lead_type: "buyer",  lead_stage: "qualified", lead_temperature: "hot",  lead_score: 90, urgency_level: "hot",   source: "open_house",  city: "Austin", state: "TX", zip_code: "78745", lifecycle_state: "isa_qualifying", notes: `[${DEMO_TAG}] AI ISA qualified: pre-approval in hand, 60-day timeline, touring this weekend.`, created_at: daysAgo(6) },
    { id: LEAD(4), first_name: "Hank",   last_name: "Exampleman", lead_type: "seller", lead_stage: "qualified", lead_temperature: "warm", lead_score: 72, urgency_level: "warm", source: "farm_mail",   city: "Manor", state: "TX", zip_code: "78653", lifecycle_state: "isa_qualifying", notes: `[${DEMO_TAG}] Responded to the farm postcard — estate sale, needs probate guidance before listing.`, created_at: daysAgo(10) },
    { id: LEAD(5), first_name: "Renee",  last_name: "Testfield",  lead_type: "buyer",  lead_stage: "new",       lead_temperature: "cold", lead_score: 35, urgency_level: "cold",    source: "social",      city: "Kyle", state: "TX", zip_code: "78640", lifecycle_state: "raw",            notes: `[${DEMO_TAG}] Instagram lead magnet download (first-time buyer guide). Browsing 6+ months out.`, created_at: daysAgo(14) },
    { id: LEAD(6), first_name: "Paulo",  last_name: "Demovista",  lead_type: "buyer",  lead_stage: "converted", lead_temperature: "warm", lead_score: 70, urgency_level: "warm", source: "referral",    city: "Austin", state: "TX", zip_code: "78702", lifecycle_state: "representation",      notes: `[${DEMO_TAG}] Converted to contact after discovery call — see CRM record.`, converted_at: daysAgo(3), created_at: daysAgo(18) },
  ].map((l, i) => ({
    ...base,
    ...l,
    email: email(l.first_name, l.last_name),
    phone: phone(50 + i),
    tags: [DEMO_TAG],
    is_active: true,
    updated_at: daysAgo(1),
  }))

  // 6 listings across the market lifecycle (status values from the live CHECK:
  // draft | coming_soon | active | pending | sold — lifecycle_stage in lockstep
  // per lib/listings/listing-status-sync.ts).
  const listings = [
    { id: LISTING(1), address: "1200 Showcase Blvd",    city: "Austin",  state: "TX", zip: "78704", status: "active",      lifecycle_stage: "MLS_ACTIVE",         list_price: 585000,  property_type: "single_family", bedrooms: 4, bathrooms: 3,   sqft: 2610, year_built: 2015, mls_number: "DEMO-1001", seller_contact_id: null,       listing_date: daysAgo(21), public_remarks: "Bright corner-lot two-story with a dedicated office, chef's island kitchen, and a shaded backyard deck minutes from the demo district.", slug: "demo-1200-showcase-blvd" },
    { id: LISTING(2), address: "8 Sample Court",        city: "Lakeway", state: "TX", zip: "78734", status: "active",      lifecycle_stage: "MLS_ACTIVE",         list_price: 1250000, property_type: "single_family", bedrooms: 5, bathrooms: 4.5, sqft: 4380, year_built: 2019, mls_number: "DEMO-1002", seller_contact_id: CONTACT(6), listing_date: daysAgo(12), public_remarks: "Hill-country modern with panoramic lake views, infinity-edge pool, and a three-car garage in gated Sample Court.", slug: "demo-8-sample-court" },
    { id: LISTING(3), address: "77 Demo Ridge Trail",   city: "Austin",  state: "TX", zip: "78723", status: "coming_soon", lifecycle_stage: "COMING_SOON_ACTIVE", list_price: 430000,  property_type: "townhouse",      bedrooms: 3, bathrooms: 2.5, sqft: 1840, year_built: 2021, mls_number: "DEMO-1003", seller_contact_id: CONTACT(7), listing_date: daysAhead(7), public_remarks: "Coming soon: lock-and-leave townhome steps from the Demo Ridge trailhead — photography this week.", slug: "demo-77-demo-ridge-trail" },
    { id: LISTING(4), address: "3405 Model Home Loop",  city: "Austin",  state: "TX", zip: "78749", status: "pending",     lifecycle_stage: "UNDER_CONTRACT",     list_price: 497500,  property_type: "single_family", bedrooms: 3, bathrooms: 2,   sqft: 2120, year_built: 2008, mls_number: "DEMO-1004", seller_contact_id: null,       listing_date: daysAgo(38), public_remarks: "Updated single-story on a cul-de-sac — new roof, remodeled primary bath, walkable to Model Park. Under contract in 9 days.", slug: "demo-3405-model-home-loop" },
    { id: LISTING(5), address: "92 Example Hollow",     city: "Austin",  state: "TX", zip: "78704", status: "sold",        lifecycle_stage: "CLOSED",             list_price: 599000,  sold_price: 615000, sold_date: daysAgo(20), property_type: "single_family", bedrooms: 4, bathrooms: 3, sqft: 2450, year_built: 2012, mls_number: "DEMO-1005", seller_contact_id: CONTACT(5), listing_date: daysAgo(75), public_remarks: "SOLD $16K over ask in 6 days with 4 offers — south-of-the-river charmer with a casita.", slug: "demo-92-example-hollow" },
    { id: LISTING(6), address: "510 Placeholder Plaza #204", city: "Austin", state: "TX", zip: "78701", status: "draft",   lifecycle_stage: null,                 list_price: 350000,  property_type: "condo",         bedrooms: 1, bathrooms: 1,   sqft: 745,  year_built: 2017, mls_number: null,       seller_contact_id: CONTACT(9), listing_date: null, public_remarks: "Draft — downtown condo intake in progress; staging consult booked.", slug: "demo-510-placeholder-plaza-204" },
  ].map((l) => ({
    ...base,
    ...l,
    agent_id: agentId,
    primary_photo_url: "/placeholder.jpg",
    created_at: l.listing_date && l.listing_date < daysAgo(0) ? l.listing_date : daysAgo(10),
    updated_at: daysAgo(1),
  }))

  // 4 transactions across the post-contract state machine
  // (lib/transactions/transaction-stages.ts vocabulary).
  const transactions = [
    { id: TXN(1), deal_name: "3405 Model Home Loop — Samplewood purchase", deal_type: "buyer",  stage: "INSPECTION",        status: "under_contract", contact_id: CONTACT(12), buyer_contact_id: CONTACT(12), seller_contact_id: null,       listing_id: LISTING(4), property_address: "3405 Model Home Loop", property_city: "Austin", property_state: "TX", property_zip: "78749", purchase_price: 492000, earnest_money: 5000,  commission_percentage: 3, estimated_commission: 14760, contract_date: daysAgo(9),  inspection_deadline: daysAhead(2),  estimated_close_date: daysAhead(28), close_date: daysAhead(28), health_score: 82 },
    { id: TXN(2), deal_name: "92 Example Hollow — Mocksley sale",          deal_type: "seller", stage: "CLOSED",            status: "closed",         contact_id: CONTACT(5),  buyer_contact_id: null,        seller_contact_id: CONTACT(5), listing_id: LISTING(5), property_address: "92 Example Hollow",    property_city: "Austin", property_state: "TX", property_zip: "78704", purchase_price: 615000, earnest_money: 6000,  commission_percentage: 3, estimated_commission: 18450, contract_date: daysAgo(52), inspection_deadline: daysAgo(45),   estimated_close_date: daysAgo(20),  close_date: daysAgo(20),  health_score: 100 },
    { id: TXN(3), deal_name: "The Exampleton condo purchase",              deal_type: "buyer",  stage: "FINANCING_PENDING", status: "clear_to_close", contact_id: CONTACT(1),  buyer_contact_id: CONTACT(1),  seller_contact_id: null,       listing_id: null,       property_address: "1818 Mock Mesa Dr",    property_city: "Austin", property_state: "TX", property_zip: "78731", purchase_price: 539000, earnest_money: 5500,  commission_percentage: 3, estimated_commission: 16170, contract_date: daysAgo(24), financing_deadline: daysAhead(5),   estimated_close_date: daysAhead(14), close_date: daysAhead(14), health_score: 74 },
    { id: TXN(4), deal_name: "Demofield investment — duplex acquisition",  deal_type: "buyer",  stage: "UNDER_CONTRACT",    status: "under_contract", contact_id: CONTACT(10), buyer_contact_id: CONTACT(10), seller_contact_id: null,       listing_id: null,       property_address: "640 Sample Springs Rd", property_city: "Austin", property_state: "TX", property_zip: "78741", purchase_price: 725000, earnest_money: 10000, commission_percentage: 3, estimated_commission: 21750, contract_date: daysAgo(3),  inspection_deadline: daysAhead(7),  estimated_close_date: daysAhead(42), close_date: daysAhead(42), health_score: 88 },
  ].map((t) => ({ ...base, ...t, agent_id: agentId, created_at: t.contract_date, updated_at: daysAgo(1) }))

  // 3 conversations + threaded messages so the communication hub has life.
  const conversations = [
    { id: CONVO(1), contact_id: CONTACT(1),  type: "sms",   status: "active", message_count: 4, unread_count: 1, last_message_at: daysAgo(0.05), created_at: daysAgo(24) },
    { id: CONVO(2), contact_id: CONTACT(5),  type: "email", status: "active", message_count: 3, unread_count: 0, last_message_at: daysAgo(2),    created_at: daysAgo(30) },
    { id: CONVO(3), contact_id: CONTACT(12), type: "sms",   status: "active", message_count: 3, unread_count: 1, last_message_at: daysAgo(0.2),  created_at: daysAgo(9) },
  ].map((c) => ({ ...base, ...c, agent_id: agentId, updated_at: daysAgo(0.05) }))

  const msg = (
    n: number, convo: string, contact: string, dir: "inbound" | "outbound",
    body: string, at: string, extra: Record<string, unknown> = {},
  ) => ({
    ...base,
    id: MSG(n),
    conversation_id: convo,
    contact_id: contact,
    agent_id: agentId,
    direction: dir,
    sender_type: dir === "inbound" ? "contact" : "agent",
    body,
    status: dir === "inbound" ? "unread" : "read",
    type: "sms",
    created_at: at,
    updated_at: at,
    ...extra,
  })
  const messages = [
    msg(1, CONVO(1), CONTACT(1),  "outbound", "Hi Ava — appraisal came back at value on Mock Mesa! Lender says we're on track for clear-to-close next week.", daysAgo(1)),
    msg(2, CONVO(1), CONTACT(1),  "inbound",  "That's amazing news!! What do you need from me?", daysAgo(0.9)),
    msg(3, CONVO(1), CONTACT(1),  "outbound", "Just keep your funds ready for wire and don't open any new credit. I'll send the closing checklist tonight.", daysAgo(0.8)),
    msg(4, CONVO(1), CONTACT(1),  "inbound",  "Perfect, thank you! Can we do the final walkthrough Friday morning?", daysAgo(0.05)),
    msg(5, CONVO(2), CONTACT(5),  "outbound", "Sofia — congratulations again on Example Hollow closing $16K over ask. Your net sheet and closing packet are attached.", daysAgo(3), { type: "email", subject: "Your closing packet — 92 Example Hollow" }),
    msg(6, CONVO(2), CONTACT(5),  "inbound",  "You made this so easy. We'll be recommending you to everyone in the neighborhood!", daysAgo(2.5), { type: "email", subject: "Re: Your closing packet — 92 Example Hollow" }),
    msg(7, CONVO(2), CONTACT(5),  "outbound", "That means the world. When you're settled in Denver I'd love to intro you to a great agent there.", daysAgo(2), { type: "email", subject: "Re: Your closing packet — 92 Example Hollow" }),
    msg(8, CONVO(3), CONTACT(12), "outbound", "Ben — inspection is confirmed for Thursday 9am at Model Home Loop. I'll be there; you're welcome to come for the last 30 min.", daysAgo(0.6)),
    msg(9, CONVO(3), CONTACT(12), "inbound",  "Great, I'll swing by at 10:30. Any word on the survey?", daysAgo(0.4)),
    msg(10, CONVO(3), CONTACT(12), "outbound", "Survey ordered — title says Monday. So far no red flags on the sellers' disclosure.", daysAgo(0.2)),
  ]

  // A handful of activities/notes so timelines aren't empty.
  const activities = [
    { id: ACT(1), activity_type: "call",    title: "Buyer consult — Priya Sampleford",      contact_id: CONTACT(3),  status: "completed", notes: `[${DEMO_TAG}] 40-min discovery call. Budget $500–650K, needs 20-min hospital commute. Sending curated search tonight.`, completed_at: daysAgo(2), created_at: daysAgo(2) },
    { id: ACT(2), activity_type: "showing", title: "Toured 1200 Showcase Blvd with Marcus", contact_id: CONTACT(2),  status: "completed", notes: `[${DEMO_TAG}] Loved the office + yard; hesitant on the busy corner. Showing two more Saturday.`, completed_at: daysAgo(3), created_at: daysAgo(3) },
    { id: ACT(3), activity_type: "note",    title: "CMA delivered to Ethan Demoranch",      contact_id: CONTACT(6),  status: "completed", notes: `[${DEMO_TAG}] Recommended list $1.25M (comps: Sample Cove $1.21M, Lakeview Demo $1.28M). He's sleeping on it.`, completed_at: daysAgo(5), created_at: daysAgo(5) },
    { id: ACT(4), activity_type: "task",    title: "Order closing gift for the Mocksleys",  contact_id: CONTACT(5),  status: "pending",   notes: `[${DEMO_TAG}] Local coffee subscription + cutting board engraved with the Example Hollow address.`, completed_at: null, created_at: daysAgo(4) },
    { id: ACT(5), activity_type: "note",    title: "Inspection scheduled — Model Home Loop", contact_id: CONTACT(12), status: "completed", notes: `[${DEMO_TAG}] Demo Home Inspections, Thursday 9am. Option period ends in 2 days — watch the deadline.`, completed_at: daysAgo(1), created_at: daysAgo(1) },
    { id: ACT(6), activity_type: "email",   title: "Home anniversary note — Placegoods",    contact_id: CONTACT(8),  status: "completed", notes: `[${DEMO_TAG}] One-year anniversary email with updated equity estimate. Replied within the hour — two referrals so far.`, completed_at: daysAgo(7), created_at: daysAgo(7) },
  ].map((a) => ({ ...base, ...a, agent_id: ownerUserId, updated_at: daysAgo(1) }))

  return { contacts, leads, listings, transactions, conversations, messages, activities }
}

// ── DB helpers ───────────────────────────────────────────────────────────────

type Service = ReturnType<typeof createServiceClient>

/** THE single source of truth for "which brokerage is the demo tenant":
 *  the row flagged is_demo = true. */
async function findDemoBrokerage(svc: Service): Promise<DemoTenantRef | null> {
  const { data } = await svc
    .from("brokerages")
    .select("id, name, slug, status, created_at")
    .eq("is_demo", true)
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle()
  return (data as DemoTenantRef | null) ?? null
}

/**
 * HARD GUARD for every destructive op: the target id must be THE brokerage
 * whose row is flagged is_demo = true — re-checked against the DB, never
 * trusted from the caller.
 */
async function assertIsDemoBrokerage(svc: Service, brokerageId: string): Promise<{ ok: boolean; error?: string }> {
  if (!brokerageId) return { ok: false, error: "No brokerage id" }
  const demo = await findDemoBrokerage(svc)
  if (!demo) return { ok: false, error: "No demo tenant exists (no brokerage has is_demo = true)" }
  if (demo.id !== brokerageId) {
    return { ok: false, error: `REFUSED: brokerage ${brokerageId} is not flagged is_demo — destructive demo ops only run against the flagged demo tenant` }
  }
  return { ok: true }
}

// ── ensureDemoTenant ─────────────────────────────────────────────────────────

/**
 * Find the demo brokerage (is_demo = true) or provision one through the SAME
 * canonical path self-serve signup uses (signupBrokerageAction), then flag it
 * is_demo, pin the stable slug, and neutralize billing (subscription paused,
 * trial pushed a decade out). Idempotent — safe to call repeatedly.
 */
export async function ensureDemoTenant(): Promise<EnsureDemoTenantResult> {
  const svc = createServiceClient()

  const existing = await findDemoBrokerage(svc)
  if (existing) return { ok: true, created: false, brokerage: existing }

  // Canonical provisioning: brokerage row + slug'd /site website + tenant owner
  // (auth user + users/agents/teams rows) + starter assistant + trial
  // subscription + onboarding curriculum — exactly what a real signup gets.
  // Tier "team" so the owner carries an agents row (the seeded CRM rows hang
  // off agents.id).
  const signup = await signupBrokerageAction({
    brokerageName: DEMO_TENANT_NAME,
    adminFirstName: "Demi",
    adminLastName: "Showcase",
    adminEmail: DEMO_OWNER_EMAIL,
    tier: "team",
    brokerageCity: "Austin",
    brokerageState: "TX",
  })
  if (!signup.ok || !signup.brokerageId) {
    return { ok: false, created: false, error: `Demo provisioning failed: ${signup.error ?? "unknown"}` }
  }
  const brokerageId = signup.brokerageId
  const now = new Date().toISOString()

  // Flag + pin identity. Stable slug first; if another tenant somehow owns
  // 'demo-showcase', fall back to keeping the signup-generated slug.
  const { error: flagErr } = await svc
    .from("brokerages")
    .update({
      is_demo: true,
      slug: DEMO_TENANT_SLUG,
      signup_source: "superadmin",
      onboarding_status: "completed",
      trial_ends_at: daysAhead(3650),
      updated_at: now,
    })
    .eq("id", brokerageId)
  if (flagErr) {
    const { error: retryErr } = await svc
      .from("brokerages")
      .update({
        is_demo: true,
        signup_source: "superadmin",
        onboarding_status: "completed",
        trial_ends_at: daysAhead(3650),
        updated_at: now,
      })
      .eq("id", brokerageId)
    if (retryErr) return { ok: false, created: true, error: `Provisioned but could not flag is_demo: ${retryErr.message}` }
  }

  // Never bills: pause the trial subscription (the same comp mechanism
  // brokerage-management uses; there is no Stripe customer at signup).
  await svc
    .from("subscriptions")
    .update({ status: "paused", updated_at: now })
    .eq("brokerage_id", brokerageId)

  const brokerage = await findDemoBrokerage(svc)
  return { ok: true, created: true, brokerage: brokerage ?? { id: brokerageId, name: DEMO_TENANT_NAME, slug: DEMO_TENANT_SLUG, status: "active", created_at: now } }
}

// ── seedDemoData ─────────────────────────────────────────────────────────────

/**
 * Wipe + re-seed the demo dataset for the given brokerage. HARD-GUARDED: the
 * id must match the is_demo = true row (re-checked here) or nothing is
 * deleted. Deterministic ids make this fully idempotent.
 */
export async function seedDemoData(brokerageId: string): Promise<SeedDemoDataResult> {
  const svc = createServiceClient()

  const guard = await assertIsDemoBrokerage(svc, brokerageId)
  if (!guard.ok) return { ok: false, error: guard.error }

  // Resolve the owner identity the rows hang off (created by canonical
  // provisioning): agents.id for CRM/deals rows, users.id for activities.
  const [{ data: agentRow }, { data: ownerRow }] = await Promise.all([
    svc.from("agents").select("id, user_id").eq("brokerage_id", brokerageId).order("created_at", { ascending: true }).limit(1).maybeSingle(),
    svc.from("users").select("id").eq("brokerage_id", brokerageId).eq("user_type", "admin").order("created_at", { ascending: true }).limit(1).maybeSingle(),
  ])
  const agentId = (agentRow as { id: string } | null)?.id ?? null
  const ownerUserId = (ownerRow as { id: string } | null)?.id ?? (agentRow as { user_id?: string } | null)?.user_id ?? null

  // WIPE — children before parents, always scoped to the demo brokerage_id.
  for (const table of DEMO_SEEDED_TABLES) {
    const { error } = await svc.from(table).delete().eq("brokerage_id", brokerageId)
    if (error) return { ok: false, error: `Wipe failed on ${table}: ${error.message}` }
  }

  // SEED — parents before children.
  const plan = buildDemoSeedPlan(brokerageId, agentId, ownerUserId)
  const inserts: Array<[DemoSeededTable, Array<Record<string, unknown>>]> = [
    ["contacts", plan.contacts],
    ["leads", plan.leads],
    ["listings", plan.listings],
    ["transactions", plan.transactions],
    ["conversations", plan.conversations],
    ["messages", plan.messages],
    ["activities", plan.activities],
  ]
  const counts = {} as Record<DemoSeededTable, number>
  for (const t of DEMO_SEEDED_TABLES) counts[t] = 0
  for (const [table, rows] of inserts) {
    const { error } = await svc.from(table).insert(rows as never)
    if (error) return { ok: false, error: `Seed failed on ${table}: ${error.message}` }
    counts[table] = rows.length
  }
  return { ok: true, counts }
}

// ── resetDemoTenant ──────────────────────────────────────────────────────────

/** Ensure the demo tenant exists, then wipe + re-seed it. Idempotent. */
export async function resetDemoTenant(): Promise<EnsureDemoTenantResult & { counts?: Record<DemoSeededTable, number> }> {
  const ensured = await ensureDemoTenant()
  if (!ensured.ok || !ensured.brokerage) return ensured
  const seeded = await seedDemoData(ensured.brokerage.id)
  if (!seeded.ok) return { ...ensured, ok: false, error: seeded.error }
  return { ...ensured, counts: seeded.counts }
}

// ── getDemoTenantSnapshot ────────────────────────────────────────────────────

/** Read-only status for the superadmin card: existence, row counts, last reset. */
export async function getDemoTenantSnapshot(): Promise<DemoTenantSnapshot> {
  const svc = createServiceClient()
  const brokerage = await findDemoBrokerage(svc)
  if (!brokerage) return { exists: false }

  const counts = {} as Record<DemoSeededTable, number>
  await Promise.all(
    DEMO_SEEDED_TABLES.map(async (table) => {
      const { count } = await svc
        .from(table)
        .select("id", { count: "exact", head: true })
        .eq("brokerage_id", brokerage.id)
      counts[table] = count ?? 0
    }),
  )

  const { data: lastReset } = await svc
    .from("superadmin_audit_log")
    .select("action, actor_email, created_at")
    .eq("target_type", "brokerage")
    .eq("target_id", brokerage.id)
    .like("action", "demo_tenant.%")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  return {
    exists: true,
    brokerage,
    counts,
    lastReset: (lastReset as DemoTenantSnapshot["lastReset"]) ?? null,
  }
}
