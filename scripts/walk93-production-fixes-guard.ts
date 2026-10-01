#!/usr/bin/env tsx
/**
 * scripts/walk93-production-fixes-guard.ts   (npm run test:walk93-production-fixes) — pure, no network, no DB.
 *
 * WAVE 93 (lane 93D). The full-platform walk (prospect → tenant → lead → contact → listing → offer,
 * real functions through the MCP replay bridge against the live project) was refused live at each of
 * the defects below. Every one is a RULE, held here on comment-stripped source (CLAUDE.md §2), each
 * finder with a positive control.
 *
 *   W1 GENERATED COLUMNS ARE NEVER WRITTEN. contacts.phone_digits and leads.phone_digits are GENERATED
 *      ALWAYS (read live 2026-10-01); writing either — even null — is refused 428C9 and PostgREST
 *      refuses the WHOLE row. The walk found four writers (manual contact create, direct lead insert,
 *      tenant contact import, website-widget intake). No insert/update payload headed for contacts or
 *      leads may carry the key.
 *   W2 THE OFFER UPLOAD DOOR PROVES ITS IDS. listing_id and contact_id arrive in the form body; the
 *      route proves both are the caller's tenant and that the contact is not the listing's own seller
 *      BEFORE anything is stored; uploaded_by (FK users) is the session user, never an agents.id.
 *   W3 A LISTING IS BORN WITH A TYPE THE CHECK ADMITS. No "residential" default (never in
 *      listings_property_type_check); a supplied value goes through canonicalPropertyType; the
 *      fan-out's agentUserId is a users.id (agents.user_id), never input.agentId.
 *   W4 ACCEPTING AN OFFER ASKS THE TRANSACTION GATE FIRST, and the listing moves UNDER_CONTRACT only
 *      after the hard-required transaction exists.
 *   W5 THE ONE COMPLIANCE-PASSED WRITER STAMPS THE COLUMN THE BRIDGE READS (offers.compliance_passed_at,
 *      only where unset, counted).
 *   W6 THE BROKERAGE-LEVEL NOTIFICATION POOL IS THE ROSTER — TENANT_ADMIN_USER_TYPES spread, never retyped.
 *   W7 A PORTAL CLIENT'S FIRST SIGN-IN IS NOT SEATED AS AN AGENT — ensureContactPortalUser adopts the
 *      bare trigger-default row; its own insert writes '' (not null) into the NOT NULL name columns.
 *   W8 the walk's metering / ledger fixes hold (vendor usage booked only on a successful send;
 *      lifecycle echoes skip a tenant-less raw row; sessionless AI books NULL ids, not sentinels).
 *   W9 the one migration (m684, both sections) states its status on line 1; registration.
 *
 * Owner: data_steward (identity classes, generated columns, the ledgers). Prose co-owners: deal_coordinator
 * (the offer → transaction gate), ai_isa (the notification pool).
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(p, "utf8")
const code = (p: string) => stripComments(read(p))
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

// ── W1 ────────────────────────────────────────────────────────────────────────
console.log("\n[W1 · generated columns are never written]")
// The GENERATED set, read live 2026-10-01 (information_schema.columns.is_generated = 'ALWAYS').
// Every table named here must be LIVE — a retired name would read as enforced (CLAUDE.md §2).
const GENERATED: Record<string, string[]> = { contacts: ["phone_digits"], leads: ["phone_digits"] }
const { LIVE_TABLES } = await import("./live-tables")
check("every table in the GENERATED set is a live table", Object.keys(GENERATED).every((t) => LIVE_TABLES.includes(t)), Object.keys(GENERATED).filter((t) => !LIVE_TABLES.includes(t)).join(","))
/** Finder: a payload key or payload assignment of a generated column whose nearest preceding
 *  `.from("<table>")` (within the same statement window) is a table that generates it. A TYPE
 *  annotation (`phone_digits: string | null`) is not a write. */
const FROM_RE = /\.from\(\s*["'`]([a-z_]+)["'`]\s*\)/g
function generatedWrites(src: string): string[] {
  const hits: string[] = []
  for (const [table, cols] of Object.entries(GENERATED)) {
    for (const col of cols) {
      // (a) an object-literal KEY inside a write: `.from("<t>")…insert|update|upsert({ … col: … })`
      const keyRe = new RegExp(`\\b${col}\\s*:\\s*(?!string\\b|number\\b|boolean\\b|unknown\\b|any\\b)`, "g")
      let m: RegExpExecArray | null
      while ((m = keyRe.exec(src))) {
        const before = src.slice(Math.max(0, m.index - 2500), m.index)
        const froms = [...before.matchAll(FROM_RE)]
        const last = froms[froms.length - 1]
        if (last && last[1] === table && /^\s*\.(insert|update|upsert)\(/.test(before.slice((last.index ?? 0) + last[0].length))) {
          hits.push(`${table}.${col}@${m.index}`); continue
        }
        // (c) a key inside a payload PUSHED INTO AN ARRAY that a batched writer later hands to the table:
        //     `rows.push({ … col: … })` then `insertInBatches(svc, "<t>", rows)` (the base tenant-import
        //     shape — the first two modes missed it; lane 93D positive control on 5d89d9e07).
        const pushes = [...before.matchAll(/\b(\w+)\.push\(\s*\{/g)]
        const arr = pushes[pushes.length - 1]?.[1]
        if (arr) {
          const after = src.slice(m.index, m.index + 4000)
          const batched = new RegExp(`\\w+\\(\\s*\\w+\\s*,\\s*["'\`]${table}["'\`]\\s*,\\s*${arr}\\b`)
          if (batched.test(after)) hits.push(`${table}.${col}@${m.index}`)
        }
      }
      // (b) a PAYLOAD ASSIGNMENT later handed to a write on the table: `x.col = …` then `.from("<t>").update|insert(x)`
      const asgRe = new RegExp(`\\b(\\w+)\\.${col}\\s*=(?!=)`, "g")
      while ((m = asgRe.exec(src))) {
        const after = src.slice(m.index, m.index + 2500)
        const target = new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)\\s*\\.(insert|update|upsert)\\(\\s*${m[1]}\\b`)
        if (target.test(after)) hits.push(`${table}.${col}@${m.index}`)
      }
    }
  }
  return hits
}
const runtime = [...walk("app"), ...walk("lib")]
const offenders = runtime.map((p) => [p, generatedWrites(code(p))] as const).filter(([, h]) => h.length)
check(`no app/lib payload headed for contacts/leads carries a generated column (${runtime.length} files, comment-stripped)`, offenders.length === 0, offenders.map(([p, h]) => `${p}: ${h.join(" ")}`).join(" | "))
check("POSITIVE CONTROL: the finder flags the five pre-93D writer shapes (incl. the batched push)",
  generatedWrites(`await supabase.from("contacts").insert({ first_name: f, phone: p, phone_digits: digits, city })`).length === 1
  && generatedWrites(`const { error } = await supabase.from("leads").insert({ phone: x, phone_digits: phone_digits, lead_type: "buyer" })`).length === 1
  && generatedWrites(`const { data } = await svc.from("contacts").select("id, phone_digits").eq("id", id)\n updatePayload.phone_digits = phoneDigits\n await svc.from("contacts").update(updatePayload)`).length >= 1
  && generatedWrites(`await supabase.from("contacts").update({ phone: raw, phone_digits: d }).eq("id", id)`).length === 1
  && generatedWrites(`const payloads = []\n for (const r of rows) { payloads.push({ line: r.line, payload: { email: r.email, phone_digits: r.phoneDigits } }) }\n await insertInBatches(svc, "contacts", payloads)`).length === 1)
check("NEGATIVE CONTROL: a pushed payload batched into a NON-generating table is not a write",
  generatedWrites(`const payloads = []\n payloads.push({ payload: { phone_digits: d } })\n await insertInBatches(svc, "listings", payloads)`).length === 0)
check("NEGATIVE CONTROL: a read-filter, a type annotation and a non-generating table are not writes",
  generatedWrites(`svc.from("contacts").select("email, phone_digits").eq("phone_digits", d)`).length === 0
  && generatedWrites(`type Row = { phone_digits: string | null }`).length === 0
  && generatedWrites(`svc.from("tenant_phone_numbers").insert({ phone_digits: d })`).length === 0)

// ── W2 ────────────────────────────────────────────────────────────────────────
console.log("\n[W2 · the offer upload door proves its ids]")
const up = code("app/api/offers/upload/route.ts")
const iListing = up.indexOf(`.from("listings").select("brokerage_id, seller_contact_id")`)
const iContact = up.indexOf(`.from("contacts").select("brokerage_id")`)
const iStore = up.indexOf("putAndSign(")
const iInsert = up.indexOf(`.from("offers")`)
check("the listing AND the contact are read and compared to the session tenant before storage or insert",
  iListing > 0 && iContact > 0 && iStore > 0 && iInsert > 0 && iListing < iStore && iContact < iStore && iListing < iInsert
  && /listingRow\.brokerage_id !== brokerageId/.test(up) && /buyerRow\.brokerage_id !== brokerageId/.test(up))
check("a lookup that cannot run refuses (fail closed) and the listing's own seller is refused as the buyer",
  /if \(listingRowError\)/.test(up) && /if \(buyerRowError\)/.test(up) && /listingRow\.seller_contact_id === contactId/.test(up))
check("offers.uploaded_by is the session user (users FK), never the agents.id", /uploaded_by:\s*user\.id/.test(up) && !/uploaded_by:\s*agentId/.test(up))
check("POSITIVE CONTROL: the pre-93D shape is flagged", /uploaded_by:\s*agentId/.test(`uploaded_by:          agentId,`))

// ── W3 ────────────────────────────────────────────────────────────────────────
console.log("\n[W3 · a listing is born with a type the CHECK admits]")
const lk = code("lib/kernel/listings.ts")
const la = code("lib/application/listings.ts")
const RESIDENTIAL_DEFAULT = /property_type:\s*[^,\n]*["']residential["']/
check("neither listing writer defaults property_type to 'residential'", !RESIDENTIAL_DEFAULT.test(lk) && !RESIDENTIAL_DEFAULT.test(la))
check("POSITIVE CONTROL: the finder flags both pre-93D defaults",
  RESIDENTIAL_DEFAULT.test(`property_type:     input.propertyType ?? "residential",`) && RESIDENTIAL_DEFAULT.test(`property_type:      params.propertyType || "residential",`))
check("both writers fold a supplied type through canonicalPropertyType and refuse an unknown one by name",
  [lk, la].every((s) => /canonicalPropertyType\(/.test(s) && /Unknown property type/.test(s)))
const { canonicalPropertyType } = await import("../lib/constants")
const { SCHEMA_SNAPSHOT } = await import("./schema-snapshot")
check("RUN: 'Single Family' folds to single_family; 'residential' is refused (null)", canonicalPropertyType("Single Family") === "single_family" && canonicalPropertyType("residential") === null)
check("the listing fan-out's agentUserId is the agent's users.id (agents.user_id), not input.agentId",
  /agentUserId:\s*\(agentRow\?\.user_id/.test(lk) && !/agentUserId:\s*input\.agentId/.test(lk) && (SCHEMA_SNAPSHOT as any).agents?.includes("user_id"))

// ── W4 ────────────────────────────────────────────────────────────────────────
console.log("\n[W4 · accept asks the transaction gate first; the listing moves only after the transaction]")
const so = code("app/actions/seller-offers.ts")
const accept = so.slice(so.indexOf("export async function acceptOffer("), so.indexOf("export async function sendCounterOffer("))
const iGate = accept.indexOf("assertOfferReadyForTransaction(")
const iWinner = accept.indexOf("is_winning_offer: true")
const iBridge = accept.indexOf("createTransactionFromOffer(")
const iTransition = accept.indexOf("transitionLifecycle(")
check("the bridge's own gate is asked before the offer is marked the winner", iGate > 0 && iWinner > 0 && iGate < iWinner)
check("UNDER_CONTRACT is reached only after createTransactionFromOffer", iBridge > 0 && iTransition > iBridge)
check("POSITIVE CONTROL: the pre-93D order (transition before the bridge) would fail this check",
  (() => { const pre = `transitionLifecycle({}); await createTransactionFromOffer({})`; return pre.indexOf("transitionLifecycle(") < pre.indexOf("createTransactionFromOffer(") })())

// ── W5 ────────────────────────────────────────────────────────────────────────
console.log("\n[W5 · the one compliance-passed writer stamps the bridge's column]")
const cg = code("lib/buyer-offer/compliance-gate.ts")
const emit = cg.slice(cg.indexOf("export async function emitCompliancePassed("), cg.indexOf("export async function validateAcceptanceEligibility("))
check("emitCompliancePassed stamps offers.compliance_passed_at only where unset, tenant-pinned, and counted",
  /\.from\("offers"\)\s*\.update\(\{\s*compliance_passed_at:\s*now\s*\}\)/.test(emit) && /\.is\("compliance_passed_at", null\)/.test(emit) && /\.eq\("brokerage_id", offer\.brokerage_id\)/.test(emit) && /\.select\("id"\)/.test(emit) && /if \(stampError\)/.test(emit))
const bridge = code("lib/transactions/offer-bridge.ts")
check("the bridge gate still reads offers.compliance_passed_at (the column the stamp feeds)", /if \(!o\.compliance_passed_at\)/.test(bridge))

// ── W6 ────────────────────────────────────────────────────────────────────────
console.log("\n[W6 · the brokerage notification pool is the roster]")
const ne = code("lib/kernel/notification-engine.ts")
const RETYPED = /\.in\(\s*"user_type",\s*\[\s*"admin"/
check("notification-engine spreads TENANT_ADMIN_USER_TYPES and retypes no role list", /\.in\("user_type", \[\.\.\.TENANT_ADMIN_USER_TYPES\]\)/.test(ne) && !RETYPED.test(ne))
check("POSITIVE CONTROL: the pre-93D literal is flagged", RETYPED.test(`.in("user_type", ["admin", "broker", "compliance_officer", "team_lead"])`))
const { TENANT_ADMIN_USER_TYPES } = await import("../lib/auth/resolve-user-role")
check("the roster it now reaches includes broker_owner and broker_admin (the two the literal dropped)", TENANT_ADMIN_USER_TYPES.has("broker_owner") && TENANT_ADMIN_USER_TYPES.has("broker_admin"))

// ── W7 ────────────────────────────────────────────────────────────────────────
console.log("\n[W7 · a portal client's first sign-in is not seated as an agent]")
const pic = code("lib/portal/portal-invite-core.ts")
const ens = pic.slice(pic.indexOf("export async function ensureContactPortalUser("), pic.indexOf("export async function createSystemPortalInvite("))
check("the bare trigger-default row (agent, no brokerage, not a contact, no agents seat) is adopted as the contact",
  /existing\.user_type === "agent" && !existing\.brokerage_id && existing\.is_contact !== true/.test(ens) && /\.from\("agents"\)\.select\("id"\)\.eq\("user_id", authUserId\)/.test(ens) && /user_type:\s*"contact"/.test(ens) && /\.is\("brokerage_id", null\)/.test(ens))
check("its own insert writes '' into the NOT NULL name columns (never null)", /first_name:\s*contact\.first_name \?\? ""/.test(ens) && /last_name:\s*contact\.last_name \?\? ""/.test(ens))

// ── W8 ────────────────────────────────────────────────────────────────────────
console.log("\n[W8 · metering and ledgers]")
const disp = code("lib/providers/dispatch.ts")
check("vendor usage is booked only on a successful email / SMS send", /if \(result\.success\) void logVendorUsage\(/.test(disp) && /if \(raw\.success\) void logVendorUsage\(/.test(disp))
check("a tenant-less raw row skips the lifecycle echo (lifecycle_events.brokerage_id is NOT NULL)", /if \(!row\.brokerage_id\) return false/.test(code("lib/kernel/scraping.ts")))
const pipe = code("lib/ai/pipeline.ts")
check("sessionless AI books NULL ids, never the 'anonymous'/'platform' sentinels (22P02 on uuid columns)",
  /user\?\.id \?\? null/.test(pipe) && /options\?\.brokerageId \?\? null/.test(pipe) && !/["']anonymous["']/.test(pipe.slice(pipe.indexOf("export async function runPipelineSimple"))))

// ── W9 ────────────────────────────────────────────────────────────────────────
console.log("\n[W9 · migrations + registration]")
// The RULE, not the waypoint (CLAUDE.md §2): line 1 states the file's status once — written-not-applied
// while in flight, APPLIED LIVE once the integrator applies it (test:migration-claim owns the truth).
const STATUS_HEADER = /^-- ── (WRITTEN, NOT APPLIED — the integrator applies it|APPLIED LIVE \d{4}-\d{2}-\d{2} via Supabase MCP apply_migration)/
// ONE file, the lane's one pre-assigned number (§1 parked platform leads, §2 name-less sign-ups).
const MIG = "supabase/migrations/m684-parked-platform-leads-and-name-less-sign-ups.sql"
check(`${MIG.split("/").pop()} exists with a status header on line 1`, existsSync(MIG) && STATUS_HEADER.test(read(MIG).split("\n")[0]))
const migSql = existsSync(MIG) ? stripComments(read(MIG).replace(/^\s*--.*$/gm, "")) : ""
check("it carries both sections: the parked-lead CHECK and the '' name insert in handle_new_auth_user",
  /ALTER COLUMN brokerage_id DROP NOT NULL/.test(migSql) && /coalesce\(source_origin, ''\) = 'platform'/.test(migSql)
  && /FUNCTION public\.handle_new_auth_user/.test(migSql) && /COALESCE\(NULLIF\(parsed_first, ''\), ''\)/.test(migSql))
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
check("package.json registers test:walk93-production-fixes", pkg.scripts["test:walk93-production-fixes"] === "tsx scripts/walk93-production-fixes-guard.ts")
check("the guard chain runs it", (pkg.scripts.guard ?? "").includes("npm run test:walk93-production-fixes"))
const { MAINTENANCE_DOMAINS } = await import("../lib/kernel/manager-registry")
check("MAINTENANCE_DOMAINS owns it", Object.values(MAINTENANCE_DOMAINS).some((d: any) => d.proof === "test:walk93-production-fixes"))

console.log(`\n  denominators: ${runtime.length} app/lib runtime files scanned for generated-column writes · ${Object.keys(GENERATED).length} generating tables · 2 listing writers · 1 upload door · 1 accept path · 1 compliance writer`)
console.log("  blind spots: the GENERATED set is the live read of 2026-10-01 — a column made GENERATED later is not in it until added; a payload built far from its .from() (>2500 chars, or passed through another module) is not attributed to a table; the listing-side signature path (no manual executed-contract recorder for an uploaded outside offer) is a product gap this guard does NOT hold — see the lane 93D notes")
console.log("\n" + "─".repeat(50))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log(failed === 0 ? " ✅ WALK93_PRODUCTION_FIXES_PASS" : " ❌ WALK93_PRODUCTION_FIXES_FAIL")
if (failed) for (const f of failures) console.log(`   · ${f}`)
process.exit(failed === 0 ? 0 : 1)
