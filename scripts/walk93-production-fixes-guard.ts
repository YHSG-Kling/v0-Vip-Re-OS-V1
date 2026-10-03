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
 *  LANE 93D2 — the walk continued to a lifetime customer (fresh tag set wave93c):
 *   W10 an outside offer's EXECUTED CONTRACT is recorded on the listing side (acceptOffer →
 *       recordSellerResponse, session caller, filed document) BEFORE the one compliance gate runs.
 *   W11 one human-worded alert per person; no raw `entity: event` text; silent echoes cost no reads.
 *   W12 a seller-only nurture never enrols a buyer.   W13 no phone purchase for an email-bearing
 *       contact; a failed AI comp search books no cost.   W14 a system actor is NULL, never ''.
 *   W15 a milestone moment never overwrites transactions.stage.   W16 the portal resolves the
 *       client's agent by agents.id and records a first visit on a pending invite.   W17 an outside
 *       buyer is not 'our' buyer (buyer_stage defaults; representation is proven).   W18 bridge key.
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
// Two doors reach a transaction (lane 93D2): the ONE compliance gate creates it (runOfferComplianceLoop
// → submitOfferToCompliance → createTransactionFromOffer) and returns its id, or the already-passed
// offer goes through the bridge below. The RULE in both: nothing marks the winner or moves the listing
// until a transaction exists.
const iLoop = accept.indexOf("runOfferComplianceLoop(")
const iBridgeDoor = accept.indexOf("assertOfferReadyForTransaction(")
const gatePath = iLoop > 0 && iBridgeDoor > iLoop ? accept.slice(iLoop, iBridgeDoor) : ""
const bridgePath = iBridgeDoor > 0 ? accept.slice(iBridgeDoor) : ""
const ADVANCED_GUARD = /if \(turn\.outcome === "advanced" && turn\.transactionId\)/
const iAdvanced = gatePath.search(ADVANCED_GUARD)
check("gate door: the winner flag and UNDER_CONTRACT sit under the gate's 'advanced with a transaction id' branch",
  iAdvanced > 0 && gatePath.indexOf("is_winning_offer: true") > iAdvanced && gatePath.indexOf("transitionLifecycle(") > iAdvanced && !gatePath.includes("createTransactionFromOffer("))
const iWinner = bridgePath.indexOf("is_winning_offer: true")
const iBridge = bridgePath.indexOf("createTransactionFromOffer(")
const iTransition = bridgePath.indexOf("transitionLifecycle(")
check("bridge door: the bridge's own gate is asked before the offer is marked the winner", iWinner > 0)
check("bridge door: UNDER_CONTRACT is reached only after createTransactionFromOffer", iBridge > 0 && iTransition > iBridge)
check("POSITIVE CONTROL: a gate door that marks the winner before the advanced check would fail",
  (() => { const pre = `const turn = await runOfferComplianceLoop(s, {}); await x.update({ is_winning_offer: true }); if (turn.outcome === "advanced" && turn.transactionId) {}`; const i = pre.search(ADVANCED_GUARD); return i > 0 && !(pre.indexOf("is_winning_offer: true") > i) })())
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

// ── W10 ───────────────────────────────────────────────────────────────────────
console.log("\n[W10 · the listing side records the executed contract of an outside offer (lane 93D2)]")
// Live 2026-10-01 (wave-93c walk): an uploaded outside offer could never be accepted — the executed
// contract had no door on the listing side, so the gate refused and the deal went to a staff override.
check("acceptOffer takes the executed contract (a filed document + optional buyer attestation)",
  /executedContract\?:\s*\{\s*documentId:\s*string/.test(so) && /needs_executed_contract\?:\s*boolean/.test(so))
const iExec = accept.indexOf("if (params.executedContract)")
const iRecord = accept.indexOf("recordSellerResponse(")
const iCheck = accept.indexOf("checkCompliancePassed(offerId)")
check("the execution is recorded BEFORE the gate is asked (execution is the gate's precondition)", iExec > 0 && iRecord > iExec && iCheck > iRecord)
check("…through the ONE seller-response survivor, with the filed document, converting itself (no second acceptance path)",
  /recordSellerResponse\(\{[\s\S]{0,400}responseType:\s*"accepted"[\s\S]{0,200}documentId:\s*params\.executedContract\.documentId[\s\S]{0,300}callerConverts:\s*true/.test(accept)
  && /isOfferFullyExecuted\(/.test(accept))
check("the ONE compliance gate runs (runOfferComplianceLoop), a block returns its reason, and an unrun gate fails closed",
  iLoop > 0 && /turn\.outcome === "blocked"/.test(gatePath) && /needs_compliance:\s*true/.test(gatePath) && /the gate could not run/.test(gatePath))
check("POSITIVE CONTROL: the pre-93D2 accept (refuse on a missing compliance event, no executed-contract door) is flagged",
  (() => { const pre = `export async function acceptOffer(p) { const c = await checkCompliancePassed(offerId); if (!c.passed) return { success: false } }`; return pre.indexOf("if (params.executedContract)") < 0 })())
const rsr = code("app/actions/buyer-offer/record-seller-response.ts")
check("recordSellerResponse resolves the caller from the SESSION and refuses another tenant's offer",
  /const caller = await requireCaller\(\)/.test(rsr) && /offer\.brokerage_id !== caller\.brokerageId/.test(rsr))
check("a filed executed-contract document must be this tenant's and linked to this offer",
  /\.from\("documents"\)[\s\S]{0,300}\.eq\("brokerage_id", (?:caller\.brokerageId|offer\.brokerage_id as string)\)/.test(rsr)
  && rsr.indexOf("offer.brokerage_id !== caller.brokerageId") < rsr.indexOf(`.from("documents")`)
  && /linkedOffer !== offerId/.test(rsr))
check("callerConverts skips the loop the caller is about to run itself (no double conversion)", /responseType === "accepted" && !callerConverts/.test(rsr))
const omc = code("app/dashboard/listings/[id]/offers/offers-manager-client.tsx")
check("the offers screen asks for the signed PDF through the offer document door, then accepts with it",
  /needs_executed_contract/.test(omc) && /form\.append\("docType", "signed_contract"\)/.test(omc) && /upload-document/.test(omc) && /executedContract:\s*\{\s*documentId:/.test(omc))

// ── W11 ───────────────────────────────────────────────────────────────────────
console.log("\n[W11 · one human-worded alert per person, no raw event text (lane 93D2)]")
const RAW_TEMPLATE = /`\$\{\s*(?:params\.)?entityType\s*\}:\s*\$\{\s*(?:params\.)?event\s*\}`/
check("notification-engine renders no raw `${entityType}: ${event}` body", !RAW_TEMPLATE.test(ne))
check("POSITIVE CONTROL: the pre-93D2 fallback is flagged", RAW_TEMPLATE.test("return bodies[event] ?? `${entityType}: ${event}`"))
check("ONE alert per person per event (a per-user dedupe set guards the insert)", /const notified = new Set<string>\(\)/.test(ne) && /if \(notified\.has\(recipient\.user_id\)\) continue/.test(ne))
check("the new-contact alert names the person (the subject name reaches the CONTACT_CREATED body)",
  /\[KernelEvent\.CONTACT_CREATED\]:[\s\S]{0,200}was added to your CRM/.test(ne) && /subjectDisplayName\(supabase, params\)/.test(ne))
check("the enrichment-queued and agent-notified echoes are silent by default", /DEFAULT_SILENT_EVENTS[\s\S]{0,200}CONTACT_ENRICHMENT_QUEUED[\s\S]{0,80}CONTACT_AGENT_NOTIFIED/.test(ne) && /if \(DEFAULT_SILENT_EVENTS\.has\(event\)\) return \[\]/.test(ne))
check("a silent event costs no recipient reads, and the reactor still receives it",
  /const recipients = anyRule \? await resolveRecipients\(params\) : \[\]/.test(ne) && ne.indexOf("dispatchKernelEvent") > ne.indexOf("const recipients = anyRule"))
const crmSrc = code("lib/kernel/crm.ts")
const iNotify = crmSrc.indexOf("function notifyAssignedAgentForNextAction")
const notifyFn = iNotify >= 0 ? crmSrc.slice(iNotify, iNotify + 6000) : ""
check("crm.ts writes no second 'new contact' notification (the engine's CONTACT_CREATED line is the one)",
  iNotify >= 0 && !/\.from\("notifications"\)\s*\.insert/.test(notifyFn))

// ── W12 ───────────────────────────────────────────────────────────────────────
console.log("\n[W12 · a seller-only nurture never enrols a buyer (lane 93D2)]")
const { sequenceAdmitsAudience } = await import("../lib/campaign-sequences/auto-enroll")
check("RUN: a seller-audience sequence refuses a buyer, admits a seller; an unrestricted one admits both",
  sequenceAdmitsAudience({ contact_type: "seller", persona: null } as any, "buyer" as any, null) === false
  && sequenceAdmitsAudience({ contact_type: "seller", persona: null } as any, "seller" as any, null) === true
  && sequenceAdmitsAudience({ contact_type: null, persona: null } as any, "buyer" as any, null) === true)
const fan = code("lib/kernel/event-fanout.ts")
check("the event fan-out applies the SAME audience predicate before enrolling", /sequenceAdmitsAudience\(seq as any, who\.type, who\.persona\)/.test(fan) && /contact_type[\s\S]{0,40}persona/.test(fan))
const csq = code("app/actions/campaign-sequences.ts")
check("createCampaignSequence stores the audience it was given, validated", /isCampaignContactType\(/.test(csq) && /contact_type:/.test(csq))

// ── W13 ───────────────────────────────────────────────────────────────────────
console.log("\n[W13 · no phone purchase for a contact that already has an email (lane 93D2, cost-down)]")
const { contactPointsToBuy } = await import("../lib/enrichment/identifier-guard")
check("RUN: email on file → buy nothing; phone only → email; neither → both",
  contactPointsToBuy({ email: "a@b.c", phone: null }).length === 0
  && JSON.stringify(contactPointsToBuy({ email: null, phone: "5551234567" })) === JSON.stringify(["email_append"])
  && JSON.stringify(contactPointsToBuy({ email: " ", phone: null })) === JSON.stringify(["email_append", "phone_append"]))
const QUEUE_RULE = /\["skip_trace", \.\.\.contactPointsToBuy\(contact\)\]/
const orch = code("lib/lead-pipeline/enrichment-orchestrator.ts")
check("the queue writer and the drain both ask it (no phone leg for an email-bearing contact)",
  QUEUE_RULE.test(code("lib/enrichment/contact-enrichment-core.ts")) && /contactPointLegs && route\.providers\[0\] === 'versium'/.test(orch) && /!batchDataFallback && contactPointLegs/.test(orch))
check("POSITIVE CONTROL: the pre-93D2 queue (phone_append always) is flagged", !QUEUE_RULE.test(`const enrichments_needed = ["skip_trace", "phone_append", "email_append"]`))
const BOOK_ON_OK = /if \(callOk\) void logVendorUsage\(/
check("a failed AI comp search books no cost", BOOK_ON_OK.test(code("lib/cma/perplexity-comp-finder.ts")))
check("POSITIVE CONTROL: an unconditional booking is flagged", !BOOK_ON_OK.test(`void logVendorUsage({ vendor: "perplexity" })`))

// ── W14 ───────────────────────────────────────────────────────────────────────
console.log("\n[W14 · a system actor is NULL, never '' (lane 93D2)]")
const lc = code("lib/kernel/lifecycle.ts")
const em = code("lib/kernel/emit.ts")
const EMPTY_ACTOR_WRITE = /actor_user_id:\s*actorUserId\b/
check("transitionLifecycle writes the normalised actor in both inserts", !EMPTY_ACTOR_WRITE.test(lc) && (lc.match(/actor_user_id:\s*actorId\b/g) ?? []).length === 2 && /actorUserId\.trim\(\) \? actorUserId : null/.test(lc))
check("emitKernelEvent normalises '' to NULL (offer-bridge's OFFER_ACCEPTED / BUYER_UNDER_CONTRACT were refused 22P02)", /row\.actor_user_id = input\.actorUserId\?\.trim\(\) \? input\.actorUserId : null/.test(em))
check("POSITIVE CONTROL: the pre-93D2 write is flagged", EMPTY_ACTOR_WRITE.test(`actor_user_id: actorUserId,`))

// ── W15 ───────────────────────────────────────────────────────────────────────
console.log("\n[W15 · a milestone moment never overwrites the deal stage (lane 93D2)]")
const { CHECK_VOCABULARIES } = await import("./check-vocabularies")
const { TXN_STAGES_ACTIVE, TXN_STAGES_AFTER } = await import("../lib/enrichment/deal-vocabulary")
const derivedStages: string[] = [...TXN_STAGES_ACTIVE, ...TXN_STAGES_AFTER].sort()
check("the stage vocabulary lifecycle.ts derives from equals the live transactions_stage_check",
  JSON.stringify(derivedStages) === JSON.stringify([...(CHECK_VOCABULARIES.transactions?.stage ?? [])].sort()))
check("an off-vocabulary toState on a transaction is audit-only (no stage write, the event kept)",
  /new Set<string>\(\[\.\.\.TXN_STAGES_ACTIVE, \.\.\.TXN_STAGES_AFTER\]\)/.test(lc) && /entityDef\.table === "transactions" && !TRANSACTION_STAGE_VOCABULARY\.has\(toState\)/.test(lc))
check("POSITIVE CONTROL: the three callers' milestone sub-states are outside the vocabulary",
  ["milestone_completed", "milestone_overdue", "milestone_warning"].every((x) => !derivedStages.includes(x)))

// ── W16 ───────────────────────────────────────────────────────────────────────
console.log("\n[W16 · the portal names the client's agent and records the first visit (lane 93D2)]")
const rco = code("lib/identity/resolve-contact-owner.ts")
const OLD_OWNER = /\.eq\("user_id", owner/
check("resolveContactOwnerAgent reads agents by id (contacts.agent_id is an agents.id) and users by agents.user_id",
  /\.from\("agents"\)[\s\S]{0,120}\.eq\("id", ownerAgentId\)/.test(rco) && /\.eq\("id", agent\.user_id\)/.test(rco) && !OLD_OWNER.test(rco))
check("POSITIVE CONTROL: the pre-93D2 lookup (agents.user_id = an agents.id) is flagged", OLD_OWNER.test(`.from("agents").select("id").eq("user_id", ownerUserId)`))
const pfa = code("lib/portal/portal-first-access.ts")
const consumable = ((pfa.match(/FIRST_ACCESS_CONSUMABLE_STATUSES = \[([^\]]*)\]/)?.[1] ?? "").match(/"[a-z_]+"/g) ?? []).map((x) => x.slice(1, -1))
const inviteVocab = CHECK_VOCABULARIES.portal_contact_invites?.status ?? []
check("first access consumes 'sent' AND 'pending' invites — all in the live status CHECK, never a terminal one",
  consumable.includes("sent") && consumable.includes("pending") && consumable.every((x) => inviteVocab.includes(x)) && !consumable.some((x) => ["accepted", "expired", "revoked"].includes(x))
  && (pfa.match(/\.in\("status", \[\.\.\.FIRST_ACCESS_CONSUMABLE_STATUSES\]\)/g) ?? []).length === 2)
const SENT_ONLY = /\.eq\("status", "sent"\)/
check("POSITIVE CONTROL: the pre-93D2 'sent'-only read is flagged, and it is gone", SENT_ONLY.test(`.eq("status", "sent")`) && !SENT_ONLY.test(pfa))

// ── W17 ───────────────────────────────────────────────────────────────────────
console.log("\n[W17 · an outside buyer is not 'our' buyer — representation is proven (lane 93D2)]")
const { buyerStageShowsRepresentation } = await import("../lib/transactions/deal-type-resolver")
check("RUN: the column default and nulls are not representation; a moved ladder is; an unknown spelling is not",
  buyerStageShowsRepresentation("BUYER_CONTACT_CREATED") === false && buyerStageShowsRepresentation(null) === false
  && buyerStageShowsRepresentation("BUYER_TOURING") === true && buyerStageShowsRepresentation("touring") === false)
const OLD_STAGE_GATE = /\.from\("contacts"\)\.select\("buyer_stage"\)\.eq\("id", [^\n]+?\)\.maybeSingle\(\)[\s\S]{0,200}?(?:!!\(?[\w\s]*\(?\w+ as \{ buyer_stage|if \(!\(\w+ as \{ buyer_stage)/
const repSites = ["lib/transactions/offer-bridge.ts", "lib/kernel/offers.ts", "lib/kernel/resolve-event-contacts.ts"]
check("the three representation gates all call the ONE read (lib/transactions/buyer-representation.ts)",
  repSites.every((f) => /readBuyerRepresentation\(/.test(code(f))) && repSites.every((f) => !OLD_STAGE_GATE.test(code(f))),
  repSites.filter((f) => !/readBuyerRepresentation\(/.test(code(f)) || OLD_STAGE_GATE.test(code(f))).join(","))
check("POSITIVE CONTROL: both pre-93D2 one-liner shapes are flagged",
  OLD_STAGE_GATE.test(`const { data: buyerContact } = await supabase\n      .from("contacts").select("buyer_stage").eq("id", (offer as any).contact_id).maybeSingle()\n    ourBuyer = !!(buyerContact as { buyer_stage?: string | null } | null)?.buyer_stage`)
  && OLD_STAGE_GATE.test(`const { data: bc } = await svc.from("contacts").select("buyer_stage").eq("id", out.buyerContactId).maybeSingle()\n if (!(bc as { buyer_stage?: string | null } | null)?.buyer_stage) {`))
const brep = code("lib/transactions/buyer-representation.ts")
check("the one read also accepts an ACTIVE buyer-broker agreement and returns refusals instead of swallowing them",
  /\.from\("buyer_broker_agreements"\)[\s\S]{0,200}\.eq\("status", "active"\)/.test(brep) && /refusals\.push\(/.test(brep)
  && (CHECK_VOCABULARIES.buyer_broker_agreements?.status ?? []).includes("active"))

// ── W18 ───────────────────────────────────────────────────────────────────────
console.log("\n[W18 · the replay bridge normalises a Date.now() that follows an underscore (lane 93D2)]")
const br = read(".claude/skills/run-vip-re-os/mcp-bridge/bridge.ts")
check("callKey's epoch-ms normaliser is digit-bounded, not word-bounded", br.includes("(?<!\\d)\\d{13}(?!\\d)"))
check("POSITIVE CONTROL: the word-bounded regex misses `_1790878524453_`, the digit-bounded one does not",
  !/\b\d{13}\b/.test("x/_1790878524453_contract.pdf") && /(?<!\d)\d{13}(?!\d)/.test("x/_1790878524453_contract.pdf"))

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
console.log("  lane 93D2 denominators: 1 accept path (2 doors) · 1 seller-response survivor · 1 notification engine · 1 fan-out audience predicate · 2 enrichment legs · 2 lifecycle writers · 1 owner resolver (11 callers) · 1 first-access core · 3 representation gates → 1 read")
console.log("  blind spots: the GENERATED set is the live read of 2026-10-01 — a column made GENERATED later is not in it until added; a payload built far from its .from() (>2500 chars, or passed through another module) is not attributed to a table; the listing-side executed-contract path is held statically (W10) — its live run is the wave-93c walk, not this script; W17 cannot see a FOURTH representation gate written with a different shape; W11 reads notification-engine only, not every direct notifications writer")
console.log("\n" + "─".repeat(50))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log(failed === 0 ? " ✅ WALK93_PRODUCTION_FIXES_PASS" : " ❌ WALK93_PRODUCTION_FIXES_FAIL")
if (failed) for (const f of failures) console.log(`   · ${f}`)
process.exit(failed === 0 ? 0 : 1)
