#!/usr/bin/env tsx
/**
 * scripts/access-matrix-guard.ts — `npm run test:access-matrix`   (wave 151, lane 151B)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OWNER ACCESS MATRIX (directive §151B, owner decisions L3–L6 / S3 / S4, wave 151): every row proven with a positive
 * control, on the in-memory client THROUGH THE REAL MODULES, plus the migration TEXT this lane wrote projected onto the LIVE
 * catalogue captured 2026-11-09 (pg_policies, project hrvaqgvukzxfskkcrwbt — quoted verbatim below, dated; memSupabase has no
 * RLS, so the database half is judged on text exactly the way scripts/cross-office-rls-guard.ts judges it).
 *
 *   A  AGENTS NEVER SEE THE LEAD QUEUE — list (the search), count (the stats door), autocomplete (the header box), detail URL
 *      (the lead page's gate), export (no CSV door over leads exists), server actions (every leads.ts export that reads leads
 *      is scoped) — each executed or censused on STRIPPED source, each with a positive control.
 *   B  A TEAM LEAD SEES THE CONTACTS OF THE TEAMS THEY LEAD — the ONE roster (agents.team_id + active team_members + the
 *      lead's own agents row), both membership sources, the tenant-principal collapse (m526), a lead of no team gets nothing,
 *      a refused read refuses; the search follows it; m963 installs the same rule (projected: brokerage-wide 1 → 0).
 *   C  A CONTACT SEES ONLY ITS OWN — contact_read_self ties contact_user_id to auth.uid(); the search refuses the seat;
 *      m964 keeps users rows with staff seats + own row + the assigned agent (projected: every-seat tenant-wide reads 1 → 0);
 *      every portal read of a users row selects display columns only.
 *   D  A VENDOR SEES ONLY ITS ASSIGNED WORK + THE EXISTING ENTITLEMENT — vendor_has_contact_access / _transaction_access carry
 *      the assignment AND vendors.access_level 'brokerage_full_access' pinned to the SAME tenant (the vocabulary the live CHECK
 *      already holds — never a billing object); m965 closes the tenant-wide assignment / booking / grant / document reads
 *      (projected 8 → 0) and gives the lender rail's vendor_assignments a session read.
 *   E  LENDER IS A VENDOR CATEGORY — not a storable user type (live CHECK), not an invitable role, the bench categories are
 *      vendor categories, no code compares user_type to 'lender', the lender gate anchors on vendor_assignments + category.
 *   F  THE ASSIGNED PHOTOGRAPHER — delivers for exactly the listing of its booking: rows land for REVIEW (never published, never
 *      on listings.photos), with source / rights / booking provenance, the agent is notified; refused by name for another
 *      listing's folder, another vendor's booking, a non-listing booking, an unaccepted or unapproved booking, a non-photographer,
 *      a non-photo file, a missing or stale attestation, a refused read; idempotent on a re-send; m966 widens the ONE constant.
 *   G  HEADER / NAVIGATION — every role the database admits to transactions has a Transactions entry in its own navigation,
 *      the header derives its shortcut from that navigation, contact and vendor have none.
 *   H  GLOBAL SEARCH — transactions and contacts are scoped (books readers + TC tenant-wide, team lead its team, agent its own,
 *      every agent column), the lead queue stays invisible to an agent, contact and vendor seats are refused.
 *   I  PERSONAS — no persona is refused as an audience basis (inclusion or exclusion), only the null basis; every tenant staff
 *      seat reads research attributes by purpose; the rule sits at the ACTION, never at the label.
 *
 * BLIND SPOTS (published at the end): memSupabase has no RLS / CHECK; the migrations are judged on text; the UI is censused, not
 * rendered; the storage.objects policies are owner SQL (OWNER-SQL §M) and are not judged here.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { stripComments } from "./strip-comments"
import { stripSqlComments } from "./strip-sql-comments"
import { walkTs } from "./runtime-roots"
import { memSupabase, type MemClient } from "./in-memory-supabase"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

const STUB: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => { throw new Error('access-matrix: a scoped reader must never reach the service client') }",
  "@/lib/supabase/server": "export const createClient = async () => { throw new Error('access-matrix: no session client in the proof') }",
  "next/cache": "export const revalidatePath = () => {}; export const revalidateTag = () => {}",
  "@/lib/ai/models": "export async function generateTextRouted(){ throw new Error('no model in the proof') }",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const body = STUB[spec]
    if (body !== undefined) return { url: `data:text/javascript,${encodeURIComponent(body)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

let pass = 0, fail = 0
const fails: string[] = []
const open: string[] = []
const check = (n: string, c: boolean, d?: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) } }
const publish = (line: string) => { open.push(line); console.log(`  · OPEN ${line}`) }
const ROOT = process.cwd()
const raw = (p: string) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), "utf8") : "")
const src = (p: string) => stripComments(raw(p))
const ids = (hits: Array<{ id: string }>) => hits.map((h) => h.id).sort().join(",")
const rows = (c: MemClient, t: string) => (c.tables[t] ?? []) as any[]

// ── the world ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const A = "aaaaaaaa-0000-4000-8000-0000000000a1", B = "bbbbbbbb-0000-4000-8000-0000000000b1", TT = "cccccccc-0000-4000-8000-0000000000c1"
const LS_P = "dddddddd-0000-4000-8000-00000000ls01", LS_O = "dddddddd-0000-4000-8000-00000000ls02"
const V1 = "eeeeeeee-0000-4000-8000-0000000000v1", V2 = "eeeeeeee-0000-4000-8000-0000000000v2"
const STORAGE = "https://x.supabase.co/storage/v1/object/public/listing-media"
const photo = (tenant: string, listing: string, name: string) => `${STORAGE}/${tenant}/${listing}/${name}`

function world(opts: { refuse?: Record<string, string> } = {}): MemClient {
  return memSupabase({
    brokerages: [{ id: A, plan_tier: "brokerage" }, { id: B, plan_tier: "brokerage" }, { id: TT, plan_tier: "team" }],
    users: [
      { id: "u-broker", brokerage_id: A, user_type: "broker", location_id: null },
      { id: "u-admin", brokerage_id: A, user_type: "admin", location_id: null },
      { id: "u-tc", brokerage_id: A, user_type: "tc", location_id: null },
      { id: "u-co", brokerage_id: A, user_type: "compliance_officer", location_id: null },
      { id: "u-a1", brokerage_id: A, user_type: "agent", location_id: null },
      { id: "u-a2", brokerage_id: A, user_type: "agent", location_id: null },
      { id: "u-a3", brokerage_id: A, user_type: "agent", location_id: null },
      { id: "u-a4", brokerage_id: A, user_type: "agent", location_id: null },
      { id: "u-a5", brokerage_id: A, user_type: "agent", location_id: null },
      { id: "u-l", brokerage_id: A, user_type: "agent", location_id: null },
      { id: "u-tl", brokerage_id: A, user_type: "team_lead", location_id: null },
      { id: "u-notl", brokerage_id: A, user_type: "team_lead", location_id: null },
      { id: "u-other", brokerage_id: A, user_type: "agent", location_id: null },
      { id: "u-contact", brokerage_id: A, user_type: "contact", location_id: null },
      { id: "u-vendor", brokerage_id: A, user_type: "vendor", location_id: null },
      { id: "u-ph", brokerage_id: A, user_type: "vendor", location_id: null },
      { id: "u-ttl", brokerage_id: TT, user_type: "team_lead", location_id: null },
      { id: "u-tt1", brokerage_id: TT, user_type: "agent", location_id: null },
      { id: "u-bb", brokerage_id: B, user_type: "broker", location_id: null },
    ],
    locations: [], organization_members: [],
    user_role_assignments: [
      { id: "ura-ph", user_id: "u-ph", vendor_id: V1, role: "vendor", brokerage_id: A },
      { id: "ura-v2", user_id: "u-vendor", vendor_id: V2, role: "vendor", brokerage_id: A },
    ],
    teams: [
      { id: "t-1", brokerage_id: A, team_lead_id: "u-tl", location_id: null, deleted_at: null, name: "North" },
      { id: "t-2", brokerage_id: A, team_lead_id: "u-other", location_id: null, deleted_at: null, name: "South" },
      { id: "t-tt", brokerage_id: TT, team_lead_id: "u-ttl", location_id: null, deleted_at: null, name: "The Team" },
    ],
    team_members: [{ id: "tm-1", team_id: "t-1", agent_id: "ag-a4", brokerage_id: A, is_active: true }],
    agents: [
      { id: "ag-a1", brokerage_id: A, user_id: "u-a1", team_id: null, location_id: null },
      { id: "ag-a2", brokerage_id: A, user_id: "u-a2", team_id: null, location_id: null },
      { id: "ag-a3", brokerage_id: A, user_id: "u-a3", team_id: "t-1", location_id: null },
      { id: "ag-a4", brokerage_id: A, user_id: "u-a4", team_id: null, location_id: null },
      { id: "ag-a5", brokerage_id: A, user_id: "u-a5", team_id: "t-2", location_id: null },
      { id: "ag-tl", brokerage_id: A, user_id: "u-tl", team_id: null, location_id: null },
      { id: "ag-l", brokerage_id: A, user_id: "u-l", team_id: null, location_id: null },
      { id: "ag-tt1", brokerage_id: TT, user_id: "u-tt1", team_id: "t-tt", location_id: null },
    ],
    contacts: [
      { id: "c-a1", brokerage_id: A, agent_id: "ag-a1", team_id: null, location_id: null, first_name: "Ann", last_name: "Smith", email: "ann@x.test", phone: null, city: "Austin", deleted_at: null },
      { id: "c-a2", brokerage_id: A, agent_id: "ag-a2", team_id: null, location_id: null, first_name: "Anna", last_name: "Jones", email: "anna@x.test", phone: null, city: "Austin", deleted_at: null },
      { id: "c-t1", brokerage_id: A, agent_id: "ag-a3", team_id: "t-1", location_id: null, first_name: "Annika", last_name: "Team", email: "t1@x.test", phone: null, city: "Austin", deleted_at: null },
      { id: "c-t1b", brokerage_id: A, agent_id: "ag-a4", team_id: null, location_id: null, first_name: "Annette", last_name: "Roster", email: "t1b@x.test", phone: null, city: "Austin", deleted_at: null },
      { id: "c-t2", brokerage_id: A, agent_id: "ag-a5", team_id: "t-2", location_id: null, first_name: "Anneliese", last_name: "Other", email: "t2@x.test", phone: null, city: "Austin", deleted_at: null },
      { id: "c-own", brokerage_id: A, agent_id: "ag-tl", team_id: null, location_id: null, first_name: "Annelle", last_name: "Own", email: "own@x.test", phone: null, city: "Austin", deleted_at: null },
      { id: "c-pool", brokerage_id: A, agent_id: null, team_id: null, location_id: null, first_name: "Pool", last_name: "Nobody", email: "pool@x.test", phone: null, city: "Austin", deleted_at: null },
      { id: "c-tt", brokerage_id: TT, agent_id: "ag-tt1", team_id: "t-tt", location_id: null, first_name: "Annis", last_name: "Teamtier", email: "tt@x.test", phone: null, city: "Tampa", deleted_at: null },
      { id: "c-b", brokerage_id: B, agent_id: null, team_id: null, location_id: null, first_name: "Ann", last_name: "Foreign", email: "ann@b.test", phone: null, city: "Dallas", deleted_at: null },
    ],
    leads: [
      { id: "l-pool", brokerage_id: A, agent_id: null, first_name: "Annie", last_name: "Pool", email: "lpool@x.test", phone: null, city: "Austin", lead_stage: "new" },
      { id: "l-a1", brokerage_id: A, agent_id: "ag-a1", first_name: "Annabel", last_name: "Mine", email: "mine@x.test", phone: null, city: "Austin", lead_stage: "qualified" },
      { id: "l-a2", brokerage_id: A, agent_id: "ag-a2", first_name: "Annalise", last_name: "Theirs", email: "theirs@x.test", phone: null, city: "Austin", lead_stage: "qualified" },
      { id: "l-t1", brokerage_id: A, agent_id: "ag-a3", first_name: "Annora", last_name: "Team", email: "lt1@x.test", phone: null, city: "Austin", lead_stage: "qualified" },
    ],
    listings: [
      { id: "ls-1", brokerage_id: A, agent_id: "ag-a1", team_id: null, location_id: null, address: "12 Annapolis St", city: "Austin", state: "TX", zip: "78701", status: "active", mls_number: "M1", deleted_at: null, photos: [] },
      { id: LS_P, brokerage_id: A, agent_id: "ag-l", team_id: null, location_id: null, address: "1 Lens Ln", city: "Austin", state: "TX", zip: "78702", status: "coming_soon", mls_number: "M7", deleted_at: null, photos: [] },
      { id: LS_O, brokerage_id: A, agent_id: "ag-a2", team_id: null, location_id: null, address: "2 Other St", city: "Austin", state: "TX", zip: "78703", status: "active", mls_number: "M8", deleted_at: null, photos: [] },
      { id: "ls-b", brokerage_id: B, agent_id: null, team_id: null, location_id: null, address: "9 Annapolis Rd", city: "Dallas", state: "TX", zip: "75001", status: "active", mls_number: "M9", deleted_at: null, photos: [] },
    ],
    transactions: [
      { id: "tx-a1", brokerage_id: A, agent_id: "ag-a1", seller_agent_id: null, buyer_agent_id: null, deal_name: "Ann buys", client_name: "Ann Smith", property_address: "12 Annapolis St", property_city: "Austin", stage: "under_contract", status: "active", deleted_at: null },
      { id: "tx-a2", brokerage_id: A, agent_id: null, seller_agent_id: "ag-a2", buyer_agent_id: null, deal_name: "Anna sells", client_name: "Anna Jones", property_address: "40 Annette Ct", property_city: "Austin", stage: "inspection", status: "active", deleted_at: null },
      { id: "tx-t1", brokerage_id: A, agent_id: null, seller_agent_id: null, buyer_agent_id: "ag-a3", deal_name: "Annika buys", client_name: "Annika Team", property_address: "5 Annex Way", property_city: "Austin", stage: "under_contract", status: "active", deleted_at: null },
      { id: "tx-tl", brokerage_id: A, agent_id: "ag-tl", seller_agent_id: null, buyer_agent_id: null, deal_name: "Annelle own", client_name: "Annelle Own", property_address: "3 Annex Pl", property_city: "Austin", stage: "under_contract", status: "active", deleted_at: null },
      { id: "tx-t2", brokerage_id: A, agent_id: "ag-a5", seller_agent_id: null, buyer_agent_id: null, deal_name: "Anneliese other", client_name: "Anneliese Other", property_address: "7 Annex Rd", property_city: "Austin", stage: "closing", status: "active", deleted_at: null },
      { id: "tx-b", brokerage_id: B, agent_id: null, seller_agent_id: null, buyer_agent_id: null, deal_name: "Ann foreign", client_name: "Ann Foreign", property_address: "9 Annapolis Rd", property_city: "Dallas", stage: "closing", status: "active", deleted_at: null },
    ],
    vendors: [
      { id: V1, brokerage_id: A, category: "photographer", name: "Lens & Light", access_level: "transaction_only" },
      { id: V2, brokerage_id: A, category: "stager", name: "Stage Right", access_level: "transaction_only" },
    ],
    vendor_bookings: [
      { id: "bk-ok", vendor_id: V1, brokerage_id: A, listing_id: LS_P, transaction_id: null, status: "confirmed", approval_status: null, service_type: "photography" },
      { id: "bk-done", vendor_id: V1, brokerage_id: A, listing_id: LS_P, transaction_id: null, status: "completed", approval_status: "approved", service_type: "photography" },
      { id: "bk-booked", vendor_id: V1, brokerage_id: A, listing_id: LS_P, transaction_id: null, status: "booked", approval_status: null, service_type: "photography" },
      { id: "bk-pending", vendor_id: V1, brokerage_id: A, listing_id: LS_P, transaction_id: null, status: "confirmed", approval_status: "pending", service_type: "photography" },
      { id: "bk-txn", vendor_id: V1, brokerage_id: A, listing_id: null, transaction_id: "tx-a1", status: "confirmed", approval_status: null, service_type: "photography" },
      { id: "bk-v2", vendor_id: V2, brokerage_id: A, listing_id: LS_P, transaction_id: null, status: "confirmed", approval_status: null, service_type: "staging" },
    ],
    listing_media: [], notifications: [], agent_action_ledger: [],
  }, { refuse: opts.refuse })
}

// ── the LIVE catalogue, captured 2026-11-09 (pg_policies / pg_get_functiondef, whitespace collapsed) ─────────────────
interface Pol { table: string; policy: string; cmd: string; qual: string; with_check: string }
const LIVE_2026_11_09: Pol[] = [
  { table: "contacts", policy: "agent_read_own_contacts", cmd: "SELECT", qual: "((( SELECT users.user_type FROM users WHERE (users.id = auth.uid())) = 'agent'::text) AND (agent_id = ( SELECT agents.id FROM agents WHERE (agents.user_id = auth.uid()) LIMIT 1)))", with_check: "" },
  { table: "contacts", policy: "contact_read_self", cmd: "SELECT", qual: "((( SELECT users.user_type FROM users WHERE (users.id = auth.uid())) = 'contact'::text) AND (contact_user_id = auth.uid()))", with_check: "" },
  { table: "contacts", policy: "contacts_vendor_scoped_read", cmd: "SELECT", qual: "((current_user_type() = 'vendor'::text) AND vendor_has_contact_access(id))", with_check: "" },
  { table: "contacts", policy: "team_lead_read_team_contacts", cmd: "SELECT", qual: "((brokerage_id = current_user_brokerage_id()) AND (EXISTS ( SELECT 1 FROM users WHERE ((users.id = auth.uid()) AND (users.user_type = ANY (ARRAY['team_lead'::text, 'team_leader'::text]))))))", with_check: "" },
  { table: "users", policy: "users_same_brokerage_select", cmd: "SELECT", qual: "(is_platform_staff() OR (id = auth.uid()) OR (brokerage_id = current_user_brokerage_id()))", with_check: "" },
  { table: "vendor_assignments", policy: "vendor_assignments_tenant_select", cmd: "SELECT", qual: "(brokerage_id = current_user_brokerage_id())", with_check: "" },
  { table: "vendor_assignments", policy: "vendor_assignments_tenant_update", cmd: "UPDATE", qual: "(brokerage_id = current_user_brokerage_id())", with_check: "(brokerage_id = current_user_brokerage_id())" },
  { table: "vendor_assignments", policy: "vendor_assignments_tenant_delete", cmd: "DELETE", qual: "(brokerage_id = current_user_brokerage_id())", with_check: "" },
  { table: "vendor_bookings", policy: "vb_brokerage", cmd: "ALL", qual: "(brokerage_id = current_user_brokerage_id())", with_check: "(brokerage_id = current_user_brokerage_id())" },
  { table: "vendor_bookings", policy: "vendor_bookings_vendor_read_own", cmd: "SELECT", qual: "(vendor_id IN ( SELECT user_role_assignments.vendor_id FROM user_role_assignments WHERE ((user_role_assignments.user_id = auth.uid()) AND (user_role_assignments.vendor_id IS NOT NULL))))", with_check: "" },
  { table: "vendor_contact_assignments", policy: "vca_tenant_read", cmd: "SELECT", qual: "((brokerage_id = current_user_brokerage_id()) OR is_platform_admin())", with_check: "" },
  { table: "vendor_contact_assignments", policy: "vca_vendor_read_own", cmd: "SELECT", qual: "(vendor_id IN ( SELECT user_role_assignments.vendor_id FROM user_role_assignments WHERE ((user_role_assignments.user_id = auth.uid()) AND (user_role_assignments.vendor_id IS NOT NULL))))", with_check: "" },
  { table: "documents", policy: "documents_tenant_select", cmd: "SELECT", qual: "(brokerage_id = current_user_brokerage_id())", with_check: "" },
  { table: "documents", policy: "documents_tenant_update", cmd: "UPDATE", qual: "(brokerage_id = current_user_brokerage_id())", with_check: "(brokerage_id = current_user_brokerage_id())" },
  { table: "documents", policy: "documents_tenant_delete", cmd: "DELETE", qual: "(brokerage_id = current_user_brokerage_id())", with_check: "" },
  { table: "transactions", policy: "transactions_vendor_scoped_read", cmd: "SELECT", qual: "((current_user_type() = 'vendor'::text) AND vendor_has_transaction_access(id))", with_check: "" },
  // tenant-wide BY DESIGN (published OPEN, never counted as a finding): the public marketing bucket's rows and the bench
  { table: "listing_media", policy: "listing_media_tenant_select", cmd: "SELECT", qual: "(brokerage_id = current_user_brokerage_id())", with_check: "" },
  { table: "vendors", policy: "vendors_tenant_select", cmd: "SELECT", qual: "((brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id()))", with_check: "" },
]
const TENANT_WIDE_BY_DESIGN = new Set(["listing_media.listing_media_tenant_select", "vendors.vendors_tenant_select"])
const LIVE_FN_VENDOR_CONTACT_ACCESS = "WITH v AS ( SELECT vendor_id FROM public.user_role_assignments WHERE user_id = auth.uid() AND vendor_id IS NOT NULL LIMIT 1 ), ven AS ( SELECT id, brokerage_id, access_level FROM public.vendors WHERE id = (SELECT vendor_id FROM v) ), c AS (SELECT brokerage_id FROM public.contacts WHERE id = p_contact_id) SELECT EXISTS ( SELECT 1 FROM public.vendor_contact_assignments vca WHERE vca.contact_id = p_contact_id AND vca.vendor_id = (SELECT vendor_id FROM v) AND vca.status = 'active' AND (vca.expires_at IS NULL OR vca.expires_at > now()) ) OR ( (SELECT access_level FROM ven) = 'brokerage_full_access' AND (SELECT brokerage_id FROM ven) = (SELECT brokerage_id FROM c) )"
const LIVE_FN_VENDOR_TXN_ACCESS = "WITH v AS ( SELECT vendor_id FROM public.user_role_assignments WHERE user_id = auth.uid() AND vendor_id IS NOT NULL LIMIT 1 ), ven AS ( SELECT id, brokerage_id, access_level FROM public.vendors WHERE id = (SELECT vendor_id FROM v) ), t AS (SELECT brokerage_id FROM public.transactions WHERE id = p_transaction_id) SELECT EXISTS ( SELECT 1 FROM public.vendor_contact_assignments vca WHERE vca.transaction_id = p_transaction_id AND vca.vendor_id = (SELECT vendor_id FROM v) AND vca.status = 'active' AND (vca.expires_at IS NULL OR vca.expires_at > now()) ) OR ( (SELECT access_level FROM ven) = 'brokerage_full_access' AND (SELECT brokerage_id FROM ven) = (SELECT brokerage_id FROM t) )"
const LIVE_IS_TENANT_STAFF_SEAT = ["agent", "isa", "tc", "team_lead", "broker", "broker_admin", "broker_owner", "admin", "compliance_officer", "title_agent", "support", "superadmin"]

// ── the judges (text) ─────────────────────────────────────────────────────────────────────────────────────────────────
const norm = (s: string) => s.replace(/\s+/g, " ").replace(/public\./g, "").trim()
/** Strip one layer of parentheses that wraps the WHOLE expression (repeatedly). */
function stripOuter(s: string): string {
  let t = s.trim()
  for (;;) {
    if (!t.startsWith("(")) return t
    let depth = 0
    for (let i = 0; i < t.length; i++) {
      if (t[i] === "(") depth++
      else if (t[i] === ")") { depth--; if (depth === 0) { if (i === t.length - 1) { t = t.slice(1, -1).trim(); break } return t } }
    }
    if (depth !== 0) return t
  }
}
/** Top-level OR disjuncts of a predicate. */
function disjuncts(expr: string): string[] {
  const s = stripOuter(norm(expr))
  const out: string[] = []
  let depth = 0, start = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === "(") depth++
    else if (ch === ")") depth--
    else if (depth === 0 && s.slice(i, i + 4) === " OR ") { out.push(s.slice(start, i)); start = i + 4; i += 3 }
  }
  out.push(s.slice(start))
  return out.map((d) => stripOuter(d))
}
const BARE_TENANT = /^brokerage_id\s*=\s*current_user_brokerage_id\(\)$/
/** A read every seat of the tenant satisfies — the bare tenant predicate as the whole qual or as a top-level OR arm. */
const everySeatTenantWide = (qual: string): boolean => disjuncts(qual).some((d) => BARE_TENANT.test(d))
const CONFINING = /\b(current_user_brokerage_id|has_brokerage_access|vendor_has_contact_access|vendor_has_transaction_access|is_current_user_vendor|is_assigned_vendor_on_transaction|is_self_contact|is_own_agent_user_id|is_platform_admin|is_platform_staff)\s*\(|auth\.uid\(\)/
/** cross-office-rls-guard's judge, verbatim: a contacts read that admits 'team_lead' by seat and names no team. */
const teamLeadBrokerageWide = (p: Pol) => p.table === "contacts" && /'team_lead'/.test(p.qual) && !/\b(team_id|current_user_led_team_id|current_user_team_id|team_members)\b/.test(p.qual)

interface Parsed { kind: "alter" | "create"; table: string; policy: string; cmd: string | null; using: string | null; withCheck: string | null }
function balanced(s: string, open: number): string {
  let depth = 0
  for (let i = open; i < s.length; i++) { if (s[i] === "(") depth++; else if (s[i] === ")") { depth--; if (depth === 0) return s.slice(open + 1, i) } }
  return s.slice(open + 1)
}
/** Every ALTER / CREATE POLICY statement of a (comment-stripped) migration — a function body with ';' inside $function$ is skipped. */
function parsePolicies(sql: string): Parsed[] {
  const out: Parsed[] = []
  const re = /\b(ALTER|CREATE)\s+POLICY\s+(\w+)\s+ON\s+(?:public\.)?(\w+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(sql))) {
    const end = sql.indexOf(";", m.index)
    const stmt = sql.slice(m.index, end < 0 ? sql.length : end)
    const u = stmt.search(/\bUSING\s*\(/i), w = stmt.search(/\bWITH\s+CHECK\s*\(/i)
    const cmd = stmt.match(/\bFOR\s+(SELECT|INSERT|UPDATE|DELETE|ALL)\b/i)?.[1]?.toUpperCase() ?? null
    out.push({ kind: m[1].toUpperCase() === "ALTER" ? "alter" : "create", policy: m[2], table: m[3], cmd, using: u >= 0 ? balanced(stmt, stmt.indexOf("(", u)) : null, withCheck: w >= 0 ? balanced(stmt, stmt.indexOf("(", w)) : null })
  }
  return out
}
function project(cat: Pol[], parsed: Parsed[]): Pol[] {
  const out = cat.map((p) => {
    const a = parsed.find((x) => x.kind === "alter" && x.table === p.table && x.policy === p.policy)
    return a ? { ...p, qual: a.using ?? p.qual, with_check: a.withCheck ?? p.with_check } : p
  })
  for (const c of parsed) if (c.kind === "create" && !out.some((p) => p.table === c.table && p.policy === c.policy)) out.push({ table: c.table, policy: c.policy, cmd: c.cmd ?? "ALL", qual: c.using ?? "", with_check: c.withCheck ?? "" })
  return out
}
const MIGRATIONS = {
  m963: "supabase/migrations/m963-team-lead-reads-contacts-of-the-teams-they-lead.sql",
  m964: "supabase/migrations/m964-users-rows-stay-with-staff-seats-own-row-and-the-assigned-agent.sql",
  m965: "supabase/migrations/m965-vendor-seats-read-only-their-assigned-work.sql",
  m966: "supabase/migrations/m966-photographer-delivery-is-a-third-photo-source.sql",
}
const LANE_STAMP = /^-- WRITTEN, NOT APPLIED \(wave 151, lane 151B\)|^-- ── APPLIED LIVE /

// ── source census helpers ─────────────────────────────────────────────────────────────────────────────────────────────
/** The bodies of every `export async function` in a stripped "use server" file, keyed by name. */
function exportBodies(stripped: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /export async function (\w+)\s*\(/g
  const hits: Array<{ name: string; at: number }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(stripped))) hits.push({ name: m[1], at: m.index })
  hits.forEach((h, i) => { out[h.name] = stripped.slice(h.at, hits[i + 1]?.at ?? stripped.length) })
  return out
}
const LEAD_READ = /\.from\(\s*["']leads["']\s*\)/
const LEAD_GATE = /\b(applyLeadRowScope|resolveLeadVisibility|resolveLeadVisibilityForSession|leadRowInScope|resolveScopedLeadIds)\s*\(/
const CSV_DOOR = /text\/csv|Content-Disposition|\.csv\b|toCsv|csvStringify|stringifyCsv/i
const LENDER_TYPE = /user_type\s*(?:===|!==|==|!=)\s*["'`]lender["'`]|["'`]lender["'`]\s*(?:===|!==|==|!=)\s*[\w.?!\]()]*user_type|\.eq\(\s*["']user_type["']\s*,\s*["']lender["']\s*\)|user_type\s*:\s*["']lender["']/
const TRANSACTIONS_HREF = /(^|\/)(dashboard\/transactions|transaction\/deals|lender\/transactions)(\/|\?|$)/
function findTransactions(items: any[] | undefined): any | null {
  for (const item of items ?? []) {
    if (item.href && (item.id === "transactions" || TRANSACTIONS_HREF.test(item.href))) return item
    const c = findTransactions(item.children)
    if (c) return c
  }
  return null
}
const PORTAL_USERS_COLUMNS = new Set(["id", "first_name", "last_name", "email", "brokerage_id", "user_type", "platform_role", "phone", "is_contact"])

async function main() {
  const search = await import("../lib/search/scoped-record-search")
  const lv = await import("../lib/auth/lead-visibility")
  const photos = await import("../lib/listings/owner-photo-upload")
  const hierarchy = await import("../lib/kernel/resolve-user-office")
  const nav = await import("../app/config/navigation-config")
  const tiers = await import("../lib/kernel/tier-role-matrix")
  const lender = await import("../lib/kernel/lender-linkage")
  const cats = await import("../lib/kernel/vendor-categories")
  const basis = await import("../lib/ads/audience-persona-basis")
  const store = await import("../lib/enrichment/protected-research-store")
  const run = (db: MemClient, userId: string, brokerageId: string, userType: string, q = "ann") =>
    search.searchScopedRecords(db as never, { userId, brokerageId, userType, platformRole: null }, q)

  // ═══ A ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n[A — agents see Contacts, never the Lead queue: list · count · autocomplete · detail · export · server actions]")
  const ag = await run(world(), "u-a1", A, "agent")
  check("LIST / AUTOCOMPLETE — an agent's search returns ONLY the lead assigned to their agents row (never the pool, never a colleague's)", ag.ok && ids(ag.leads) === "l-a1", JSON.stringify(ag.ok ? ids(ag.leads) : ag))
  check("…and only their own contacts and their own deals", ag.ok && ids(ag.contacts) === "c-a1" && ids(ag.transactions) === "tx-a1", JSON.stringify(ag.ok ? [ids(ag.contacts), ids(ag.transactions)] : ag))
  const agVis = await lv.resolveLeadVisibility(world() as never, { userId: "u-a1", userType: "agent", platformRole: null, brokerageId: A })
  check("DETAIL URL / COUNT — the lead-desk rule REFUSES an agent outright (forbidden), so the lead page redirects and the stats door counts nothing", !agVis.allowed && agVis.status === "forbidden", JSON.stringify(agVis))
  const tlVis = await lv.resolveLeadVisibility(world() as never, { userId: "u-tl", userType: "team_lead", platformRole: null, brokerageId: A })
  check("POSITIVE CONTROL — the same rule ADMITS a team lead, team-scoped, with the pool outside the scope (a two-team tenant)", tlVis.allowed && tlVis.scope.kind === "team" && !lv.leadRowInScope(tlVis.scope, { brokerage_id: A, agent_id: null }) && lv.leadRowInScope(tlVis.scope, { brokerage_id: A, agent_id: "ag-a3" }), JSON.stringify(tlVis))
  const listPage = src("app/leads/page.tsx"), detailPage = src("app/leads/[leadId]/page.tsx")
  check("DETAIL URL — app/leads/[leadId]/page.tsx gates on resolveLeadVisibility + leadRowInScope and REDIRECTS otherwise (stripped source)", /resolveLeadVisibility\(/.test(detailPage) && /leadRowInScope\(/.test(detailPage) && /redirect\(/.test(detailPage))
  check("LIST — app/leads/page.tsx reads leads through resolveLeadVisibility (stripped source)", /resolveLeadVisibility\(/.test(listPage))
  const leadActions = exportBodies(src("app/actions/leads.ts"))
  const readers = Object.entries(leadActions).filter(([, body]) => LEAD_READ.test(body))
  const ungated = readers.filter(([, body]) => !LEAD_GATE.test(body)).map(([n]) => n)
  check(`SERVER ACTIONS — every app/actions/leads.ts export that reads leads is scoped by the ONE rule (${readers.length} readers, ${ungated.length} ungated)`, readers.length >= 8 && ungated.length === 0, ungated.join(", "))
  check("COUNT — getLeadStats is one of those scoped readers", !!leadActions.getLeadStats && LEAD_READ.test(leadActions.getLeadStats) && LEAD_GATE.test(leadActions.getLeadStats))
  check("POSITIVE CONTROL — an export that reads leads without the rule is flagged", (() => { const b = exportBodies(`export async function leak() { const { data } = await svc.from("leads").select("*"); return data }\nexport async function ok() { return applyLeadRowScope(svc.from("leads").select("id"), scope) }`); return LEAD_READ.test(b.leak) && !LEAD_GATE.test(b.leak) && LEAD_GATE.test(b.ok) })())
  const exportDoors = [...walkTs(join(ROOT, "app/actions")), ...walkTs(join(ROOT, "app/api"))]
    .filter((f) => { const s = stripComments(readFileSync(f, "utf8")); return LEAD_READ.test(s) && CSV_DOOR.test(s) })
  check(`EXPORT — no server action or route both reads leads and serves a CSV / download (${exportDoors.length} found)`, exportDoors.length === 0, exportDoors.join(", "))
  check("POSITIVE CONTROL — the export finder sees a CSV door over leads", LEAD_READ.test(`svc.from("leads")`) && CSV_DOOR.test(`headers.set("Content-Type", "text/csv")`))

  // ═══ B ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n[B — a team lead sees the Contacts of the teams they lead: the ONE roster, the principal collapse, m963]")
  const ts = await lv.resolveTeamLeadContactScope(world() as never, { userId: "u-tl", brokerageId: A })
  check("the team lead's contact scope is the TEAM: the led team, its agents by agents.team_id AND by active team_members, plus the lead's own agents row",
    ts.ok && ts.scope.kind === "team" && ts.scope.teamIds.join() === "t-1" && ["ag-a3", "ag-a4", "ag-tl"].every((a) => (ts.scope as any).agentIds.includes(a)), JSON.stringify(ts))
  check("…and NOT the other team's agent nor an unteamed colleague", ts.ok && ts.scope.kind === "team" && !ts.scope.agentIds.includes("ag-a5") && !ts.scope.agentIds.includes("ag-a1"))
  const f = ts.ok ? lv.teamContactOrFilter(ts.scope) : null
  check("the ONE applicator spells the scope as team_id ∪ agent_id, never a bare tenant filter", !!f && /team_id\.in\.\(t-1\)/.test(f) && /agent_id\.in\.\(/.test(f) && !/brokerage_id/.test(f), String(f))
  const tl = await run(world(), "u-tl", A, "team_lead")
  check("SEARCH — the team lead's contacts are the team's (team contact, roster contact, own book) — never c-a1 / c-a2 / c-t2 / the pool", tl.ok && ids(tl.contacts) === "c-own,c-t1,c-t1b", JSON.stringify(tl.ok ? ids(tl.contacts) : tl))
  check("SEARCH — the team lead's deals are the team's (buyer-column deal of a team agent + own) — never the other team's", tl.ok && ids(tl.transactions) === "tx-t1,tx-tl", JSON.stringify(tl.ok ? ids(tl.transactions) : tl))
  check("…and the reach says TEAM in words, never \"your whole workspace\"", tl.ok && /team/.test(tl.reach.contacts) && !/whole workspace/.test(tl.reach.contacts), tl.ok ? tl.reach.contacts : "")
  const hier = await hierarchy.resolveViewerHierarchy(world() as never, { userId: "u-tl", brokerageId: A })
  check("POSITIVE CONTROL — the single-office roster rule alone WOULD widen a team lead to the whole tenant (so the team scope is load-bearing)", hier.ok && hier.scope.aggregate, JSON.stringify(hier))
  const ttl = await lv.resolveTeamLeadContactScope(world() as never, { userId: "u-ttl", brokerageId: TT })
  check("the TENANT PRINCIPAL (team tier, one live team, led by the caller — m526) collapses to the tenant", ttl.ok && ttl.scope.kind === "brokerage" && ttl.scope.via === "tenant_principal", JSON.stringify(ttl))
  const ttSearch = await run(world(), "u-ttl", TT, "team_lead")
  check("…and their search reads the whole team-tier workspace", ttSearch.ok && ids(ttSearch.contacts) === "c-tt" && /whole workspace/.test(ttSearch.reach.contacts), JSON.stringify(ttSearch.ok ? ttSearch.reach : ttSearch))
  const notl = await lv.resolveTeamLeadContactScope(world() as never, { userId: "u-notl", brokerageId: A })
  check("a team_lead SEAT that leads no team gets nothing extra (the anchor is teams.team_lead_id, not the user_type)", notl.ok && notl.scope.kind === "none")
  const notlSearch = await run(world(), "u-notl", A, "team_lead")
  check("…and their search returns no contacts, saying why", notlSearch.ok && notlSearch.contacts.length === 0 && /no team is anchored/.test(notlSearch.reach.contacts), JSON.stringify(notlSearch.ok ? notlSearch.reach : notlSearch))
  const refused = await lv.resolveTeamLeadContactScope(world({ refuse: { team_members: "permission denied for table team_members" } }) as never, { userId: "u-tl", brokerageId: A })
  check("a REFUSED roster read refuses the scope (never an empty roster = no restriction)", !refused.ok)
  const refusedSearch = await run(world({ refuse: { team_members: "permission denied for table team_members" } }), "u-tl", A, "team_lead")
  check("…and refuses the whole search, in words", !refusedSearch.ok && /could not confirm your team/.test(refusedSearch.error), JSON.stringify(refusedSearch))
  const m963raw = raw(MIGRATIONS.m963), m963 = stripSqlComments(m963raw)
  check("m963 exists and carries the lane stamp on line 1", !!m963raw && LANE_STAMP.test(m963raw.split("\n")[0]))
  const p963 = parsePolicies(m963)
  const tlPol = p963.find((p) => p.table === "contacts" && p.policy === "team_lead_read_team_contacts")
  check("m963 rewrites contacts.team_lead_read_team_contacts (ALTER POLICY only — MCP-applicable) and names the fact, both rosters, the own book and the principal", !!tlPol && tlPol.kind === "alter" && !!tlPol.using && /team_lead_id\s*=\s*auth\.uid\(\)/.test(tlPol.using) && /team_members/.test(tlPol.using) && /a\.team_id IN/.test(tlPol.using) && /a\.user_id\s*=\s*auth\.uid\(\)/.test(tlPol.using) && /is_tenant_principal_team_lead\(\)/.test(tlPol.using) && /current_user_brokerage_id\(\)/.test(tlPol.using) && !/user_type/.test(tlPol.using), tlPol?.using?.slice(0, 200))
  check("m963 never uses the LIMIT-1 helper current_user_led_team_id() (every led team counts)", !/current_user_led_team_id/.test(m963))
  const beforeB = LIVE_2026_11_09.filter(teamLeadBrokerageWide).map((p) => `${p.table}.${p.policy}`)
  const afterB = project(LIVE_2026_11_09, p963).filter(teamLeadBrokerageWide).map((p) => `${p.table}.${p.policy}`)
  check(`PROJECTED — the live team-lead contacts read is brokerage-wide today (${beforeB.length}) and team-scoped after m963 (${afterB.length})`, beforeB.length === 1 && afterB.length === 0, `${beforeB} → ${afterB}`)

  // ═══ C ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n[C — a Contact sees only its own: contact_read_self, the search refuses the seat, m964 keeps users rows narrow]")
  const selfPol = LIVE_2026_11_09.find((p) => p.policy === "contact_read_self")!
  check("LIVE contact_read_self ties the row to the caller (contact_user_id = auth.uid()) and the seat to 'contact'", /contact_user_id\s*=\s*auth\.uid\(\)/.test(selfPol.qual) && /'contact'/.test(selfPol.qual))
  const ct = await run(world(), "u-contact", A, "contact")
  check("SEARCH — a contact seat is refused (search is the team's workspace)", !ct.ok)
  const m964raw = raw(MIGRATIONS.m964), m964 = stripSqlComments(m964raw)
  check("m964 exists and carries the lane stamp on line 1", !!m964raw && LANE_STAMP.test(m964raw.split("\n")[0]))
  const p964 = parsePolicies(m964)
  const uPol = p964.find((p) => p.table === "users" && p.policy === "users_same_brokerage_select")
  check("m964 rewrites users.users_same_brokerage_select: platform staff · own row · tenant STAFF seats · the assigned / booking agent for a non-staff seat", !!uPol && !!uPol.using && /is_platform_staff\(\)/.test(uPol.using) && /id\s*=\s*auth\.uid\(\)/.test(uPol.using) && /is_tenant_staff_seat\(\)/.test(uPol.using) && /is_own_agent_user_id\(id\)/.test(uPol.using) && /vendor_bookings/.test(uPol.using) && /assigned_by_agent_id/.test(uPol.using))
  check("…and the bare tenant arm (every seat reads every row) is GONE", !!uPol?.using && !everySeatTenantWide(uPol.using))
  check("CONTROL — the judge flags the LIVE users qual's bare tenant arm, and a tenant arm AND-ed with a seat gate is not bare", everySeatTenantWide(LIVE_2026_11_09.find((p) => p.table === "users")!.qual) && !everySeatTenantWide("((brokerage_id = current_user_brokerage_id()) AND is_tenant_staff_seat())") && everySeatTenantWide("(brokerage_id = current_user_brokerage_id())") && everySeatTenantWide("((brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id()))"))
  const portalUsersReads: string[] = []
  for (const f of walkTs(join(ROOT, "app/portal"))) {
    const s = stripComments(readFileSync(f, "utf8"))
    const re = /\.from\(\s*["']users["']\s*\)\s*\.select\(\s*["'`]([^"'`]*)["'`]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(s))) {
      const cols = m[1].split(",").map((c) => c.trim()).filter(Boolean)
      if (cols.some((c) => !PORTAL_USERS_COLUMNS.has(c))) portalUsersReads.push(`${f.replace(ROOT + "/", "")}: ${m[1]}`)
    }
  }
  check(`every session read of a users row under app/portal selects display / scope columns only — never password_hash, role, or * (${portalUsersReads.length} wider)`, portalUsersReads.length === 0, portalUsersReads.join("; "))
  check("POSITIVE CONTROL — the column finder sees a wide read", (() => { const m = /\.from\(\s*["']users["']\s*\)\s*\.select\(\s*["'`]([^"'`]*)["'`]/.exec(`supabase.from("users").select("id, password_hash")`); return !!m && m[1].split(",").map((c) => c.trim()).some((c) => !PORTAL_USERS_COLUMNS.has(c)) })())

  // ═══ D ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n[D — a Vendor sees only its assigned work, plus the EXISTING entitlement (vendors.access_level), tenant-isolated; m965]")
  check("LIVE vendor_has_contact_access: an ACTIVE vendor_contact_assignments grant for the caller's vendor, OR the brokerage_full_access entitlement pinned to the SAME tenant", /vendor_contact_assignments vca/.test(LIVE_FN_VENDOR_CONTACT_ACCESS) && /vca\.status = 'active'/.test(LIVE_FN_VENDOR_CONTACT_ACCESS) && /'brokerage_full_access' AND \(SELECT brokerage_id FROM ven\) = \(SELECT brokerage_id FROM c\)/.test(LIVE_FN_VENDOR_CONTACT_ACCESS))
  check("LIVE vendor_has_transaction_access: the same two arms, pinned to the deal's tenant", /vca\.transaction_id = p_transaction_id/.test(LIVE_FN_VENDOR_TXN_ACCESS) && /'brokerage_full_access' AND \(SELECT brokerage_id FROM ven\) = \(SELECT brokerage_id FROM t\)/.test(LIVE_FN_VENDOR_TXN_ACCESS))
  const accessLevels = (CHECK_VOCABULARIES as any).vendors?.access_level as string[] | undefined
  check("the entitlement vocabulary EXISTS in the live CHECK cache (vendors.access_level: transaction_only · team_full_access · brokerage_full_access) — nothing invented, no billing object", Array.isArray(accessLevels) && ["transaction_only", "brokerage_full_access"].every((v) => accessLevels.includes(v)), JSON.stringify(accessLevels))
  const vd = await run(world(), "u-vendor", A, "vendor")
  check("SEARCH — a vendor seat is refused (search is the team's workspace)", !vd.ok)
  const m965raw = raw(MIGRATIONS.m965), m965 = stripSqlComments(m965raw)
  check("m965 exists and carries the lane stamp on line 1", !!m965raw && LANE_STAMP.test(m965raw.split("\n")[0]))
  check("m965 creates no table and no billing object (policies + ONE function body only)", !/CREATE\s+TABLE|ALTER\s+TABLE|stripe|price|plan_id/i.test(m965))
  const fnBody = m965.slice(m965.indexOf("vendor_has_transaction_access"), m965.indexOf("$function$;"))
  check("m965's vendor_has_transaction_access keeps BOTH live arms and ADDS the lender rail's vendor_assignments (not cancelled, the deal's tenant)", /vendor_contact_assignments vca/.test(fnBody) && /'brokerage_full_access'/.test(fnBody) && /\(SELECT brokerage_id FROM ven\) = \(SELECT brokerage_id FROM t\)/.test(fnBody) && /vendor_assignments va/.test(fnBody) && /va\.status IS DISTINCT FROM 'cancelled'/.test(fnBody) && /va\.brokerage_id = \(SELECT brokerage_id FROM t\)/.test(fnBody))
  const p965 = parsePolicies(m965)
  const VENDOR_ARM = /\b(is_current_user_vendor|is_assigned_vendor_on_transaction|vendor_has_transaction_access|is_self_contact)\s*\(/
  const rewritten = p965.filter((p) => ["vendor_assignments", "vendor_bookings", "vendor_contact_assignments", "documents"].includes(p.table))
  check(`m965 rewrites the four tenant-wide surfaces (${rewritten.length} statements) and every USING / WITH CHECK carries the STAFF gate or an own-vendor / own-contact arm`, rewritten.length >= 9 && rewritten.every((p) => [p.using, p.withCheck].filter((x): x is string => !!x).every((x) => /is_tenant_staff_seat\(\)/.test(x) || VENDOR_ARM.test(x))), rewritten.map((p) => `${p.table}.${p.policy}`).join(", "))
  check("…a vendor keeps its own bookings writable (accept / decline / complete): vendor_bookings_vendor_update_own is CREATED, pinned to its vendor and tenant on both sides", rewritten.some((p) => p.kind === "create" && p.policy === "vendor_bookings_vendor_update_own" && p.cmd === "UPDATE" && /is_current_user_vendor\(vendor_id\)/.test(p.using ?? "") && /is_current_user_vendor\(vendor_id\)/.test(p.withCheck ?? "") && /current_user_brokerage_id/.test(p.withCheck ?? "")))
  const allParsed = [...p963, ...p964, ...p965]
  const flag = (cat: Pol[]) => cat.filter((p) => !TENANT_WIDE_BY_DESIGN.has(`${p.table}.${p.policy}`) && (everySeatTenantWide(p.qual) || (p.with_check && everySeatTenantWide(p.with_check)))).map((p) => `${p.table}.${p.policy}`)
  const beforeD = flag(LIVE_2026_11_09), afterCat = project(LIVE_2026_11_09, allParsed), afterD = flag(afterCat)
  check(`PROJECTED — every-seat tenant-wide reads / writes on the matrix surfaces: ${beforeD.length} live today → ${afterD.length} after m963–m965`, beforeD.length === 9 && afterD.length === 0, `before: ${beforeD.join(", ")}; after: ${afterD.join(", ")}`)
  check("PROJECTED — nothing became UNCONFINED: every rewritten predicate still names the tenant or the caller", afterCat.every((p) => CONFINING.test(p.qual) && (!p.with_check || CONFINING.test(p.with_check))))
  for (const k of TENANT_WIDE_BY_DESIGN) publish(`${k} stays tenant-wide for every seat BY DESIGN (public marketing media; the bench / directory) — not a finding, stated`)
  publish("vendors.access_level 'team_full_access' is read by neither live helper (narrows to assigned — the safe direction); widening it is a product decision, not taken")
  const portalAuth = src("lib/kernel/portal-auth.ts")
  check("the vendor gate (requireVendorActor) anchors on user_role_assignments.vendor_id for the SESSION user, never a body id alone", /requireVendorActor/.test(portalAuth) && /from\("user_role_assignments"\)/.test(portalAuth) && /\.eq\("user_id", user\.id\)/.test(portalAuth))

  // ═══ E ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n[E — lender is a VENDOR category: not a user type, not a seat, not an office-staff category]")
  const userTypes = (CHECK_VOCABULARIES as any).users?.user_type as string[]
  check("the live users.user_type CHECK (generated cache) has NO 'lender' and NO 'title_agent' — the seat is 'vendor'", Array.isArray(userTypes) && !userTypes.includes("lender") && !userTypes.includes("title_agent") && userTypes.includes("vendor"), JSON.stringify(userTypes))
  check("the invite menu's partner roles are exactly ['vendor'] — no lender seat is invitable on any tier", JSON.stringify([...tiers.PARTNER_ROLES]) === JSON.stringify(["vendor"]) && !(tiers.WORKSPACE_STAFF_ROLES as readonly string[]).includes("lender"))
  check("…and a 'lender' seat is refused with the vendor-directory answer, no upgrade offered", /vendor directory/.test(tiers.roleRefusalReason("lender") ?? "") && !/upgrade/i.test(tiers.roleRefusalReason("lender") ?? ""))
  check("the lender bench categories are vendors.category values, and each is a lender to the resolver", (lender.LENDER_BENCH_CATEGORIES as readonly string[]).every((c) => (cats.VENDOR_CATEGORIES as readonly string[]).includes(c) && lender.isLenderVendorCategory(c)))
  check("POSITIVE CONTROL — a photographer is NOT a lender to the resolver", !lender.isLenderVendorCategory("photographer"))
  const lenderTypeSites = [...walkTs(join(ROOT, "app")), ...walkTs(join(ROOT, "lib"))]
    .filter((f) => LENDER_TYPE.test(stripComments(readFileSync(f, "utf8")))).map((f) => f.replace(ROOT + "/", ""))
  check(`no code under app/ or lib/ compares users.user_type to 'lender' or writes one (${lenderTypeSites.length} sites)`, lenderTypeSites.length === 0, lenderTypeSites.join(", "))
  check("POSITIVE CONTROL — the finder sees every spelling", LENDER_TYPE.test(`if (u.user_type === "lender") x()`) && LENDER_TYPE.test(`.eq("user_type", "lender")`) && LENDER_TYPE.test(`insert({ user_type: "lender" })`) && !LENDER_TYPE.test(`vendors.category === "lender"`))
  check("the lender gate anchors on the vendor rail: requireLenderVendorActor reads vendor_assignments AND the vendor's category", (() => { const i = portalAuth.indexOf("export async function requireLenderVendorActor"); const body = portalAuth.slice(i, portalAuth.indexOf("export async function", i + 10)); return i >= 0 && /from\("vendor_assignments"\)/.test(body) && /isLenderVendorCategory\(/.test(body) })())

  // ═══ F ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n[F — the ASSIGNED photographer delivers for exactly its booked listing: review, provenance, notice; refused elsewhere]")
  const att = { accepted: true, version: photos.PHOTOGRAPHER_DELIVERY_ATTESTATION_VERSION }
  const fdb = world()
  const ok = await photos.recordPhotographerDelivery(fdb as never, { brokerageId: A, vendorId: V1, userId: "u-ph", bookingId: "bk-ok", fileUrls: [photo(A, LS_P, "front.jpg"), photo(A, LS_P, "kitchen.PNG")], attestation: att })
  check("HAPPY PATH — a confirmed photographer booking records both photos", ok.ok && ok.mediaIds.length === 2 && ok.listingId === LS_P, JSON.stringify(ok))
  const media = rows(fdb, "listing_media")
  check("…as listing_media PHOTO rows for REVIEW: approval_required, is_approved = false, usage_intent both", media.length === 2 && media.every((m) => m.media_type === "photo" && m.approval_required === true && m.is_approved === false && m.listing_id === LS_P && m.brokerage_id === A))
  check("…with PROVENANCE: photo_source vendor_delivery, uploader = the photographer = attested_by, the attestation version, the booking", media.every((m) => m.photo_source === "vendor_delivery" && m.uploaded_by === "u-ph" && m.ownership_attested_by === "u-ph" && !!m.ownership_attested_at && m.ownership_attestation_version === photos.PHOTOGRAPHER_DELIVERY_ATTESTATION_VERSION && m.vendor_booking_id === "bk-ok"))
  check("…NEVER published: listings.photos (the public gallery) is untouched", JSON.stringify(rows(fdb, "listings").find((l) => l.id === LS_P)?.photos) === "[]")
  const note = rows(fdb, "notifications")
  check("…and the LISTING AGENT is notified (agents.user_id, never agents.id) with the listing as the entity", note.length === 1 && note[0].user_id === "u-l" && note[0].type === "listing_media_delivered" && note[0].entity_type === "listing" && note[0].entity_id === LS_P && note[0].brokerage_id === A && ok.ok && ok.notifiedUserId === "u-l", JSON.stringify(note))
  const again = await photos.recordPhotographerDelivery(fdb as never, { brokerageId: A, vendorId: V1, userId: "u-ph", bookingId: "bk-ok", fileUrls: [photo(A, LS_P, "front.jpg")], attestation: att })
  check("IDEMPOTENT — re-sending a delivered file records nothing new and says it was skipped", again.ok && again.mediaIds.length === 0 && again.skipped === 1 && rows(fdb, "listing_media").length === 2)
  const done = await photos.recordPhotographerDelivery(world() as never, { brokerageId: A, vendorId: V1, userId: "u-ph", bookingId: "bk-done", fileUrls: [photo(A, LS_P, "late.webp")], attestation: att })
  check("a COMPLETED (and procurement-approved) booking still takes a late delivery", done.ok && done.mediaIds.length === 1)
  const refusals: Array<[string, Parameters<typeof photos.recordPhotographerDelivery>[1], string, Record<string, string> | undefined]> = [
    ["another LISTING's folder (same tenant) → path", { brokerageId: A, vendorId: V1, userId: "u-ph", bookingId: "bk-ok", fileUrls: [photo(A, LS_O, "x.jpg")], attestation: att }, "path", undefined],
    ["a FOREIGN tenant's folder → path", { brokerageId: A, vendorId: V1, userId: "u-ph", bookingId: "bk-ok", fileUrls: [photo(B, LS_P, "x.jpg")], attestation: att }, "path", undefined],
    ["one good file + one outside the folder → path (all or nothing)", { brokerageId: A, vendorId: V1, userId: "u-ph", bookingId: "bk-ok", fileUrls: [photo(A, LS_P, "ok.jpg"), photo(A, LS_O, "x.jpg")], attestation: att }, "path", undefined],
    ["another VENDOR's booking → booking", { brokerageId: A, vendorId: V1, userId: "u-ph", bookingId: "bk-v2", fileUrls: [photo(A, LS_P, "x.jpg")], attestation: att }, "booking", undefined],
    ["a TRANSACTION booking with no listing → not_listing_booking", { brokerageId: A, vendorId: V1, userId: "u-ph", bookingId: "bk-txn", fileUrls: [photo(A, LS_P, "x.jpg")], attestation: att }, "not_listing_booking", undefined],
    ["a booking NOT YET ACCEPTED (booked) → status", { brokerageId: A, vendorId: V1, userId: "u-ph", bookingId: "bk-booked", fileUrls: [photo(A, LS_P, "x.jpg")], attestation: att }, "status", undefined],
    ["a booking whose procurement approval is PENDING → approval", { brokerageId: A, vendorId: V1, userId: "u-ph", bookingId: "bk-pending", fileUrls: [photo(A, LS_P, "x.jpg")], attestation: att }, "approval", undefined],
    ["a STAGER vendor on its own listing booking → category", { brokerageId: A, vendorId: V2, userId: "u-vendor", bookingId: "bk-v2", fileUrls: [photo(A, LS_P, "x.jpg")], attestation: att }, "category", undefined],
    ["a PDF in the right folder → file_type", { brokerageId: A, vendorId: V1, userId: "u-ph", bookingId: "bk-ok", fileUrls: [photo(A, LS_P, "brochure.pdf")], attestation: att }, "file_type", undefined],
    ["NO attestation → attestation", { brokerageId: A, vendorId: V1, userId: "u-ph", bookingId: "bk-ok", fileUrls: [photo(A, LS_P, "x.jpg")], attestation: null }, "attestation", undefined],
    ["a STALE attestation version → attestation", { brokerageId: A, vendorId: V1, userId: "u-ph", bookingId: "bk-ok", fileUrls: [photo(A, LS_P, "x.jpg")], attestation: { accepted: true, version: "2020-01-01.v0" } }, "attestation", undefined],
    ["no files → nothing", { brokerageId: A, vendorId: V1, userId: "u-ph", bookingId: "bk-ok", fileUrls: [], attestation: att }, "nothing", undefined],
    ["no vendor identity → no_identity", { brokerageId: A, vendorId: "", userId: "u-ph", bookingId: "bk-ok", fileUrls: [photo(A, LS_P, "x.jpg")], attestation: att }, "no_identity", undefined],
    ["a REFUSED bookings read → booking (said as a refusal, never 'not yours')", { brokerageId: A, vendorId: V1, userId: "u-ph", bookingId: "bk-ok", fileUrls: [photo(A, LS_P, "x.jpg")], attestation: att }, "booking", { vendor_bookings: "permission denied for table vendor_bookings" }],
    ["a REFUSED media write → write (nothing recorded, said)", { brokerageId: A, vendorId: V1, userId: "u-ph", bookingId: "bk-ok", fileUrls: [photo(A, LS_P, "x.jpg")], attestation: att }, "write", { listing_media: "new row violates check constraint listing_media_photo_source_check" }],
  ]
  const refusalErrors: Record<string, string> = {}
  for (const [name, input, refusal, refuse] of refusals) {
    const db = world({ refuse })
    const r = await photos.recordPhotographerDelivery(db as never, input)
    const wrote = rows(db, "listing_media").length + rows(db, "notifications").length
    check(`REFUSED — ${name}`, !r.ok && r.refusal === refusal && wrote === 0, JSON.stringify(r))
    if (!r.ok) refusalErrors[name] = r.error
  }
  check("the refused-READ refusal is worded as a read failure ('could not be read'), never laundered into 'not one of yours'", /could not be read/.test(refusalErrors["a REFUSED bookings read → booking (said as a refusal, never 'not yours')"] ?? "") && /not one of yours/.test(refusalErrors["another VENDOR's booking → booking"] ?? ""))
  check("the ONE source constant carries the third source, and the written rows use it", (photos.LISTING_PHOTO_SOURCES as readonly string[]).includes("vendor_delivery") && media.every((m) => (photos.LISTING_PHOTO_SOURCES as readonly string[]).includes(m.photo_source)))
  const m966raw = raw(MIGRATIONS.m966), m966 = stripSqlComments(m966raw)
  check("m966 exists and carries the lane stamp on line 1", !!m966raw && LANE_STAMP.test(m966raw.split("\n")[0]))
  const checkList = [...(m966.match(/listing_media_photo_source_check\s*CHECK\s*\(\s*photo_source\s+IN\s*\(([^)]*)\)/)?.[1] ?? "").matchAll(/'([^']+)'/g)].map((x) => x[1]).sort()
  check("m966's CHECK list == LISTING_PHOTO_SOURCES exactly (the code constant is the source; the vocabulary guard parses this shape as pending)", checkList.join(",") === [...photos.LISTING_PHOTO_SOURCES].sort().join(","), checkList.join(","))
  check("m966's attested CHECK binds a vendor_delivery row to its uploader-attestation and its booking", /listing_media_vendor_delivery_attested_check/.test(m966) && /ownership_attested_by = uploaded_by/.test(m966) && /vendor_booking_id IS NOT NULL/.test(m966) && /vendor_booking_id uuid REFERENCES public\.vendor_bookings\(id\)/.test(m966))
  const pm = src("app/actions/photo-management.ts")
  const door = pm.slice(pm.indexOf("export async function submitPhotographerDelivery"), pm.indexOf("export async function", pm.indexOf("export async function submitPhotographerDelivery") + 10))
  check("THE DOOR — submitPhotographerDelivery takes NO tenant from the body, gates with requireVendorActor BEFORE the service client, records through the ONE writer under withActionLedger", door.length > 0 && !/brokerageId\s*:\s*string/.test(door.slice(0, door.indexOf(")"))) && door.indexOf("requireVendorActor(") > 0 && door.indexOf("requireVendorActor(") < door.indexOf("createServiceClient()") && /recordPhotographerDelivery\(/.test(door) && /withActionLedger\(/.test(door) && /HUMAN_REQUESTED/.test(door))
  const jobs = src("app/vendor/jobs/jobs-client.tsx")
  check("THE SURFACE — the vendor jobs page offers the delivery only for a listing booking of a photographer vendor in a deliverable status, shows the rights statement and calls the door", /submitPhotographerDelivery\(/.test(jobs) && /PHOTOGRAPHER_DELIVERY_ATTESTATION_TEXT/.test(jobs) && /LISTING_MEDIA_DELIVERY_VENDOR_CATEGORIES/.test(jobs) && /DELIVERABLE_BOOKING_STATUSES/.test(jobs) && /checkUpload\(/.test(jobs))
  check("…and never a second attestation wording (the statement is imported, not retyped)", !/I photographed this property/.test(jobs))
  check("the staff ingest (processVendorPhotos) is unchanged: photo_source NULL = not recorded, no attestation (two actors, two doors)", /export async function processVendorPhotos/.test(pm) && !/photo_source/.test(exportBodies(pm).processVendorPhotos ?? ""))

  // ═══ G ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n[G — the header / global navigation exposes Transactions to the roles the database admits]")
  const NAV = (nav as any).NAVIGATION_BY_ROLE as Record<string, { sidebarItems?: any[] }>
  const MUST = ["agent", "broker", "team_lead", "admin", "compliance_officer", "tc", "lender"]
  const missing = MUST.filter((r) => !findTransactions(NAV[r]?.sidebarItems))
  check(`every authorized role's own navigation carries a Transactions entry (${MUST.length} roles: tenant staff + the lender partner's assigned deals; missing: ${missing.length})`, missing.length === 0, missing.join(", "))
  publish("title_agent's deals surface is Title Orders (/title/orders — its assigned closings as an order book); there is no /title/transactions route, so the title partner carries no Transactions shortcut by design")
  check("…and the admin's entry is the brokerage's deals page (transactions_brokerage_staff_read admits 'admin' at the database)", findTransactions(NAV.admin?.sidebarItems)?.href === "/dashboard/transactions")
  check("a CONTACT and a VENDOR have none (the database gives a contact no transactions read; a vendor's deals are its assigned work on its own surfaces)", !findTransactions(NAV.contact?.sidebarItems) && !findTransactions(NAV.vendor?.sidebarItems))
  const header = src("app/components/layout/header.tsx")
  check("the header DERIVES its shortcut from the role's navigation (findTransactionsNavItem over navigation.sidebarItems) and renders a Link — no second roster", /findTransactionsNavItem\(navigation\?\.sidebarItems\)/.test(header) && /data-header-transactions/.test(header) && /<Link/.test(header) && !/user_type|userType/.test(header.replace(/UserContext|userContext/g, "")))
  const headerRe = raw("app/components/layout/header.tsx").match(/const TRANSACTIONS_HREF = (\/.*\/)\n/)?.[1]
  check("…and this proof's href rule is the header's own, verbatim (the two cannot drift)", headerRe === TRANSACTIONS_HREF.toString(), headerRe)
  check("POSITIVE CONTROL — the finder sees a nested entry and ignores a non-transactions href", !!findTransactions([{ id: "x", children: [{ id: "transactions", href: "/dashboard/transactions" }] }]) && !findTransactions([{ id: "y", href: "/dashboard/listings" }]))

  // ═══ H ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n[H — global search: scoped Transactions and Contacts; the Lead queue invisible to an agent]")
  const br = await run(world(), "u-broker", A, "broker")
  check("a broker (books reader) sees every deal of the tenant, never tenant B's", br.ok && ids(br.transactions) === "tx-a1,tx-a2,tx-t1,tx-t2,tx-tl", JSON.stringify(br.ok ? ids(br.transactions) : br))
  for (const [u, t] of [["u-tc", "tc"], ["u-co", "compliance_officer"], ["u-admin", "admin"]] as const) {
    const r = await run(world(), u, A, t)
    check(`a ${t} (transactions_brokerage_staff_read) sees every deal of the tenant`, r.ok && ids(r.transactions) === "tx-a1,tx-a2,tx-t1,tx-t2,tx-tl", JSON.stringify(r.ok ? ids(r.transactions) : r))
  }
  const a2 = await run(world(), "u-a2", A, "agent")
  check("an agent on the SELLER column sees that deal and no other", a2.ok && ids(a2.transactions) === "tx-a2")
  const a3 = await run(world(), "u-a3", A, "agent")
  check("an agent on the BUYER column sees that deal and no other — and only the lead assigned to them", a3.ok && ids(a3.transactions) === "tx-t1" && ids(a3.leads) === "l-t1")
  check("the box renders the four kinds from the action's result — Transactions included, Leads last", (() => { const box = src("app/components/layout/global-search.tsx"); const i = box.indexOf("key: 'transactions'"), j = box.indexOf("key: 'leads'"); return i > 0 && j > i && /searchWorkspaceRecords\(/.test(box) })())
  const mutant = await run(world(), "u-a1", A, "broker")
  check("MUTANT — an agent searched through the broker rule WOULD see the pool and every deal (the scoping is load-bearing)", mutant.ok && mutant.leads.some((l) => l.id === "l-pool") && mutant.transactions.length === 5)

  // ═══ I ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n[I — personas and raw research attributes: no global refusal; the rule sits at the ACTION]")
  check("ADS_INELIGIBLE_PERSONAS and EXCLUSION_INELIGIBLE_PERSONAS are the null basis alone (other) — no persona is refused as a basis", [...basis.ADS_INELIGIBLE_PERSONAS].join() === "other" && [...basis.EXCLUSION_INELIGIBLE_PERSONAS].join() === "other")
  const everyPersona = [...basis.ADS_ELIGIBLE_PERSONAS] as string[]
  const refusedIncl = everyPersona.filter((p) => !basis.resolveAudiencePersonaBasis({ type: "persona_segment", filters: { personas: [p] } } as never).ok)
  const refusedExcl = everyPersona.filter((p) => !basis.resolveAudiencePersonaBasis({ type: "persona_segment", filters: { personas: [p] } } as never, "exclusion" as never).ok)
  check(`every canonical persona (${everyPersona.length}) resolves as an INCLUSION and an EXCLUSION basis (refused: ${refusedIncl.length} / ${refusedExcl.length})`, everyPersona.length >= 10 && refusedIncl.length === 0 && refusedExcl.length === 0)
  check("POSITIVE CONTROL — the null basis (other) is still refused as no_basis (the census is not refuse-nothing)", (() => { const r = basis.resolveAudiencePersonaBasis({ type: "persona_segment", filters: { personas: ["other"] } } as never); return !r.ok && (r as any).refusalKind === "no_basis" })())
  const STAFF = ["agent", "team_lead", "broker", "admin", "compliance_officer", "tenant_support", "tc"]
  check("every research purpose admits every tenant staff class at its scope (agent assigned, team lead team) — raw attributes are READ by purpose, never deleted", Object.values(store.PROTECTED_READ_MATRIX).every((row) => STAFF.every((r) => r in (row as Record<string, string>))) && (store.PROTECTED_READ_MATRIX as any).research.agent === "assigned" && (store.PROTECTED_READ_MATRIX as any).research.team_lead === "team")
  check("…and the reader roster excludes only the non-staff seats (contact, vendor, isa) — a scope, not a persona or attribute refusal", !["contact", "vendor", "isa"].some((t) => store.PROTECTED_RESEARCH_READER_USER_TYPES.has(t)) && store.PROTECTED_RESEARCH_READER_USER_TYPES.has("agent"))
  const personaGuard = src("scripts/persona-compliance-guard.ts")
  check("the persona guard asserts the owner's rule (R1 / R3 re-assertions present) and no blanket refusal of a persona label", /R1 — EVERY situation persona/.test(raw("scripts/persona-compliance-guard.ts")) && /EXCLUSION_INELIGIBLE_PERSONAS/.test(personaGuard))

  console.log("\n[blind spots — published beside the numbers]")
  for (const b of [
    "memSupabase enforces no RLS and no CHECK: the database half (m963–m966) is judged on migration TEXT projected onto the live catalogue captured 2026-11-09; the live probe pattern is in each file's footer (set_config request.jwt.claims)",
    "the storage.objects policies for the listing-media bucket are owner SQL (docs/operations/OWNER-SQL.md §M) and are not judged here — until applied, any authenticated seat may PUT into any listing folder (the writer still refuses to RECORD such a file)",
    "the UI (header, box, jobs dialog) is censused on stripped source, not rendered; the photographer's upload itself is a browser → storage call outside this proof",
    "the helper bodies quoted (vendor_has_contact_access, vendor_has_transaction_access, is_tenant_staff_seat) are trusted from one pg_get_functiondef read on 2026-11-09",
  ]) console.log(`  · ${b}`)
  if (open.length) console.log(`OPEN (published, not failed): ${open.length}`)
  if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ACCESS_MATRIX_FAIL"); process.exit(1) }
  console.log(" ACCESS_MATRIX_PASS — agents see contacts and never the lead queue; a team lead sees the teams they lead; a contact its own; a vendor its assigned work and its entitlement; a lender is a vendor; the assigned photographer delivers for its listing only, for review; the header and the search expose scoped transactions")
}

main().catch((e) => { console.error(e); process.exit(1) })
