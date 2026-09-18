#!/usr/bin/env tsx
/**
 * scripts/writerless-arrivals-simulator.ts   (npm run test:writerless-arrivals)
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 14 / LANE T — THE FIVE ALWAYS-NULL READS WAVE 13 IDENTIFIED AND DID NOT
 * BUILD, because each needed a DECISION or a SURFACE rather than a one-line
 * writer. Sibling proof to scripts/writerless-gate-simulator.ts (wave 13), which
 * closed the four that only needed a writer — and which deliberately left
 * `lead_intelligence.pre_approved` in the census as its own canary. That canary
 * is item 2 here.
 *
 * 1. agent_api_credentials.api_secret / integration_credentials.api_secret
 *    Nothing captured a secret, so any provider needing a key+SECRET pair
 *    resolved `apiSecret: null` and could never authenticate — Vibe CTV
 *    (lib/providers/vibe.ts:57, :213) and the Twilio probe
 *    (lib/agentic-os/connector-probe.ts:247). TWO findings, not one:
 *      · the secret was NOT missing from the product — connection-manager's
 *        platform_credentials tier hard-coded `apiSecret: null` and DISCARDED
 *        `config.auth_token`, which connectApiKeyProvider and connectPhoneAction
 *        both write and two other readers already read. Merged onto ONE reading.
 *      · the two legacy COLUMNS still had no writer: connectCrmAction now
 *        captures the pair, encrypted through the tree's one secret scheme.
 *    And app/actions/dispatch-showing.ts:209 — a DUPLICATE reader pointed at the
 *    wrong store, which could never have worked at all — is deleted onto the
 *    survivor with a tombstone.
 *
 * 2. lead_intelligence.pre_approved (+ pre_approval_amount, financial_readiness)
 *    A +30 intent branch that could never fire. DERIVED, not deleted, from two
 *    live written facts: contacts.lender_status (4 writers) and
 *    buyer_financial_profiles (a real agent surface). ONE reading shared by the
 *    writer and the scorer — lib/leads/pre-approval.ts.
 *
 * 3. compliance_alerts.resolved / comp_risk_flags.is_resolved
 *    Read as `.eq(…, false)`, never set true, so `overallStatus` stuck at
 *    'at_risk' forever. Resolve path + both surfaces built, and WHO/WHEN is
 *    recorded — on the alerts side in its own long-declared, never-written
 *    resolved_at/resolved_by, on the risk-flag side in audit_log.
 *
 * 4. approval_items.item_id
 *    The reviewer saw "video_script — " with nothing to open. Resolved by
 *    CARRYING THE ID BACK, not by scanning after persistence — the ordering
 *    ruling is argued in lib/content-guardian/index.ts and asserted here.
 *
 * 5. listing_agreements.seller_transaction_fee
 *    Six net-sheet readers, zero writers — every seller's net proceeds, INCLUDING
 *    IN THEIR OWN PORTAL, overstated by the brokerage's flat fee. The column's
 *    only plausible writer, markAgreementSigned, was itself an orphan: the sole
 *    INSERT into listing_agreements anywhere, with no caller. BUILT (the orphan
 *    doctrine's verdict when nothing else supplies the capability).
 *
 * LAYERS
 *   STATIC    each write object is parsed with the repo's ONE parser
 *             (schema-drift-guard) and must NAME the column; and the column must
 *             exist in the live schema snapshot — a phantom name refuses the
 *             whole statement (PGRST204), so a "writer" that names one writes
 *             nothing.
 *   PURE      the two new readings, exercised in BOTH directions. This is where
 *             the NUMBER MOVES: the +30 branch fires on a real fact and stays
 *             silent on absence, and the secret arrives from the shape that
 *             actually holds it.
 *   GATE      the at_risk → compliant transition, re-derived under the service's
 *             own rule, is reachable now that the set can shrink.
 *   ORPHAN    the tombstone names its survivor; the callerless recorder has a
 *             caller; nothing was deleted to move a number.
 *   CONTROLS  every absence/presence assertion is mutated and must go RED.
 *             A broken matcher and a clean tree both report success.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import { blankComments } from "./strip-comments"
import { secretFromConfig, CONFIG_SECRET_KEYS } from "../lib/connections/credential-secret"
import { readPreApproval } from "../lib/leads/pre-approval"

process.env.SCHEMA_DRIFT_AS_LIBRARY = "1"
const sd = await import("./schema-drift-guard")

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail = "") => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
/** A control that must go RED. Counted, so a control that silently passes is a failure. */
const control = (n: string, wentRed: boolean) => {
  if (wentRed) { pass++; console.log(`  ✓ CONTROL ${n} — went RED as required`) }
  else { fail++; fails.push(`CONTROL ${n}`); console.log(`  ✗ CONTROL ${n} — stayed GREEN, so the check above proves nothing`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

/**
 * The top-level keys of the write object at a `.from("<table>").<op>({ … })`
 * site, read with the SHARED parser rather than a regex of this file's own — two
 * parsers that disagree about what a write is would make this proof worthless.
 *
 * Every `.from(table)` occurrence is tried, not just the first: a function that
 * SELECTS from a table before UPDATING it (the comp-risk-flag ownership check
 * does exactly that) would otherwise report "no write site" — which reads
 * identically to a genuinely missing writer.
 */
function writeKeysIn(text: string, table: string, op: "insert" | "update" | "upsert"): string[] | null {
  const from = new RegExp(`\\.from\\(\\s*["'\`]${table}["'\`]\\s*\\)`, "g")
  let m: RegExpExecArray | null
  while ((m = from.exec(text)) !== null) {
    const start = m.index + m[0].length
    // BOUNDED BY THE NEXT `.from(`, not by a character count. The first draft of
    // this helper searched a fixed 900-char window and happily matched the
    // `.update({…})` belonging to the NEXT table in the file — so a table with no
    // write of its own reported one, which is the exact "reports success while
    // blind" failure CLAUDE.md §2 is about. The parser control below is what
    // caught it.
    const nextFrom = /\.from\(\s*["'`]/.exec(text.slice(start))
    const end = start + (nextFrom ? nextFrom.index : Math.min(900, text.length - start))
    const window = text.slice(start, end)
    const opAt = new RegExp(`^[\\s\\S]*?\\.${op}\\(\\s*\\{`).exec(window)
    if (!opAt) continue
    const brace = start + opAt[0].length - 1
    const close = sd.matchBrace(text, brace)
    if (close <= brace) continue
    return sd.parseObjectTopLevelKeys(text.slice(brace, close + 1))
  }
  return null
}
const writeKeysAt = (file: string, table: string, op: "insert" | "update" | "upsert") =>
  writeKeysIn(blankComments(src(file)), table, op)

/** A column that is not in the live schema refuses the WHOLE statement (PGRST204). */
const isLiveColumn = (table: string, col: string) => (SCHEMA_SNAPSHOT[table] ?? []).includes(col)

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE SECRET HALF OF A KEY PAIR
// ─────────────────────────────────────────────────────────────────────────────
function secretLayer() {
  console.log("\n[1 — THE SECRET NOW ARRIVES: from the shape that holds it, and into the columns that had no writer]")

  // ── 1a. The merge: the secret that was being thrown away ──────────────────
  const cm = blankComments(src("lib/integrations/connection-manager.ts"))
  check("connection-manager no longer hard-codes `apiSecret: null` on the platform_credentials tier",
    !/apiSecret:\s*null/.test(cm))
  check("…it reads the pair's second half out of the row's config, through the ONE reading",
    /apiSecret:\s*secretFromConfig\(\s*data\.config\s*\)/.test(cm))
  check("the two legacy stores' api_secret COLUMN is still read (the merge did not orphan it)",
    (cm.match(/apiSecret:\s*decryptSecret\(data\.api_secret\)/g) ?? []).length === 2)
  check("credentials are read through the BACKWARD-COMPATIBLE decrypt (plaintext passes through)",
    /import\s*\{\s*decryptSecret\s*\}\s*from\s*"@\/lib\/security\/secret-crypto"/.test(cm))

  // The writers whose secret was being discarded must still be writing it.
  check("connectApiKeyProvider still writes the secret into config (field-spec `phone` → auth_token)",
    /config:\s*\{\s*auth_token:\s*trim\("authToken"\)/.test(blankComments(src("lib/connections/field-spec.ts"))))
  check("connectPhoneAction still writes config.auth_token",
    /config:\s*\{\s*auth_token:\s*params\.authToken\.trim\(\)/.test(blankComments(src("app/actions/phone-connect.ts"))))

  // ── 1b. ONE VOCABULARY: three spellings of "the secret in config" merged ───
  const health = blankComments(src("app/api/cron/connector-health/route.ts"))
  const sms = blankComments(src("lib/providers/messaging/resolve-sms-provider.ts"))
  check("the cron's private two-key ladder is gone, replaced by the shared reading",
    /apiSecret:\s*secretFromConfig\(r\.config\)/.test(health) && !/\?\.auth_token as string\)\s*\?\?/.test(health))
  check("the SMS resolver's private ladder is gone too",
    /secretFromConfig\(cfg\)/.test(sms) && !/\(cfg\.api_password as string \| undefined\)/.test(sms))
  check("all three readers import the same module",
    [cm, health, sms].every((t) => /from "@\/lib\/connections\/credential-secret"/.test(t)))

  // ── 1c. PURE — the reading itself, both directions ────────────────────────
  check("the Connection Center's shape resolves (auth_token)",
    secretFromConfig({ auth_token: "tok", from_number: "+15551112222" }) === "tok")
  check("the legacy column-name shape resolves (api_secret)", secretFromConfig({ api_secret: "s" }) === "s")
  check("the OAuth client-credentials spelling resolves (client_secret)",
    secretFromConfig({ client_secret: "cs" }) === "cs")
  check("auth_token WINS over the others when several are present (the only one a live writer produces)",
    secretFromConfig({ client_secret: "cs", api_secret: "s", auth_token: "tok" }) === "tok")
  check("a key-only provider yields NULL, never '' (a '' secret makes every `!!apiSecret` gate lie)",
    secretFromConfig({ from_number: "+1" }) === null && secretFromConfig({ auth_token: "  " }) === null)
  check("a null / non-object config is null, not a throw",
    secretFromConfig(null) === null && secretFromConfig("nope") === null && secretFromConfig(undefined) === null)
  check("the accepted key set is CLOSED — an arbitrary user-typed key is not a credential",
    secretFromConfig({ my_password: "hunter2", secret: "x" }) === null && CONFIG_SECRET_KEYS.length === 4)

  // ── 1d. THE CAPTURE PATH — the two columns' first writer ──────────────────
  const crmAgent = writeKeysAt("app/actions/crm-connect.ts", "agent_api_credentials", "upsert")
  check("connectCrmAction's agent-scoped upsert exists and parses", crmAgent !== null)
  check("agent_api_credentials.api_secret is WRITTEN", !!crmAgent?.includes("api_secret"), (crmAgent ?? []).join(","))
  check("…and it is a live column (not a PGRST204 phantom)", isLiveColumn("agent_api_credentials", "api_secret"))
  const crmBrokerage = writeKeysAt("app/actions/crm-connect.ts", "integration_credentials", "upsert")
  check("connectCrmAction's brokerage-scoped upsert exists and parses", crmBrokerage !== null)
  check("integration_credentials.api_secret is WRITTEN", !!crmBrokerage?.includes("api_secret"), (crmBrokerage ?? []).join(","))
  check("…and it is a live column", isLiveColumn("integration_credentials", "api_secret"))

  const crm = blankComments(src("app/actions/crm-connect.ts"))
  check("the secret is stored through THIS TREE'S secret scheme, not a second one",
    /encryptSecret\(rawSecret\)/.test(crm) && /from "@\/lib\/security\/secret-crypto"/.test(crm))
  check("a BLANK box is stored as null, never as '' (an '' secret passes every `!!apiSecret` gate)",
    /rawSecret\s*\?\s*encryptSecret\(rawSecret\)\s*:\s*null/.test(crm))
  check("the secret is NEVER logged or echoed back to the caller",
    !/console\.(log|error|warn)\([^)]*apiSecret/i.test(crm) && !/error:\s*[^\n]*rawSecret/.test(crm))
  check("the form actually collects it (an action param with no field is still no writer)",
    /apiSecret:\s*secrets\[p\]/.test(blankComments(src("app/settings/crm/crm-connect-form.tsx"))) &&
    /placeholder="API secret/.test(src("app/settings/crm/crm-connect-form.tsx")))
  check("…as a password input, not a plain one",
    /type="password"[\s\S]{0,120}placeholder="API secret/.test(src("app/settings/crm/crm-connect-form.tsx")))

  // ── 1e. THE DUPLICATE READER, DELETED ONTO ITS SURVIVOR ───────────────────
  const dispatch = src("app/actions/dispatch-showing.ts")
  const dispatchCode = blankComments(dispatch)
  check("dispatch-showing no longer reads integration_credentials at all",
    !/from\(\s*["']integration_credentials["']\s*\)/.test(dispatchCode))
  check("…the SMS branch resolves through the survivor instead",
    /resolveSMSProviderForActor\(/.test(dispatchCode))
  check("…and the SendGrid read went onto the SAME cascade the ShowingTime branch already used",
    /resolveScopedConnection\(\s*"sendgrid"/.test(dispatchCode))
  check("a TOMBSTONE names the survivor at file:line (a deletion that names nothing is a deletion to move a number)",
    /TOMBSTONE[\s\S]{0,400}resolve-sms-provider\.ts:\d+/.test(dispatch) &&
    /SURVIVOR/.test(dispatch))
  check("the tombstone records WHY it could never have worked (from_number is not a column on that table)",
    /from_number[\s\S]{0,200}not a column on it/.test(dispatch))
  check("the SMS dispatcher still has its manual deep-link fallback (nothing became unreachable)",
    /dispatchViaSms\(dispatchCtx, twilio\)/.test(dispatchCode))

  // CONTROLS — mutate the source and prove each finder still bites.
  control("the discarded-secret literal restored",
    /apiSecret:\s*null/.test(cm.replace(/apiSecret: secretFromConfig\(data\.config\)/, "apiSecret: null")))
  control("the capture param removed from the write object",
    writeKeysIn(crm.replace(/api_secret: apiSecret,/g, ""), "agent_api_credentials", "upsert")?.includes("api_secret") !== true)
  control("a blank secret stored as '' rather than null",
    !/rawSecret\s*\?\s*encryptSecret\(rawSecret\)\s*:\s*null/.test(crm.replace(/rawSecret \? encryptSecret\(rawSecret\) : null/, 'encryptSecret(rawSecret ?? "")')))
  control("the duplicate reader restored", /from\(\s*["']integration_credentials["']\s*\)/.test(dispatchCode + '\n.from("integration_credentials")'))
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE +30 THAT COULD NEVER FIRE
// ─────────────────────────────────────────────────────────────────────────────
function preApprovalLayer() {
  console.log("\n[2 — THE SCORE NOW MOVES: a +30 branch that could never fire, derived from a fact the system holds]")

  const li = writeKeysAt("app/actions/lead-intelligence.ts", "lead_intelligence", "upsert")
  check("the sole lead_intelligence writer exists and parses", li !== null)
  for (const c of ["pre_approved", "pre_approval_amount", "financial_readiness"]) {
    check(`lead_intelligence.${c} is WRITTEN`, !!li?.includes(c), (li ?? []).join(","))
    check(`…lead_intelligence.${c} is a live column`, isLiveColumn("lead_intelligence", c))
  }
  const liSrc = blankComments(src("app/actions/lead-intelligence.ts"))
  check("the writer derives from the SHARED reading, not its own inline rule",
    /readPreApproval\(\{\s*lenderStatus:/.test(liSrc) && /from "@\/lib\/leads\/pre-approval"/.test(liSrc))
  check("the lender_status fact is threaded from the CONTACT row the caller already resolved",
    /lender_status\s*\?\?\s*null,/.test(liSrc))
  check("the amount comes from buyer_financial_profiles, keyed on contact_id (NOT contacts.contact_id)",
    /from\("buyer_financial_profiles"\)[\s\S]{0,300}\.eq\("contact_id", leadId\)/.test(liSrc))
  check("a REFUSED financial read is reported, never swallowed as 'no profile'",
    /if \(financialError\)[\s\S]{0,400}console\.error\("\[v0\] buyer_financial_profiles read failed/.test(liSrc))

  const scorer = blankComments(src("lib/services/lead-management.service.ts"))
  check("the READER asks the same shared reading (one definition of 'pre-approved')",
    /readPreApproval\(\{/.test(scorer) && /from "@\/lib\/leads\/pre-approval"/.test(scorer))
  check("the +30 branch still exists and was NOT deleted to move a number",
    /score \+= 30/.test(scorer))
  check("…and it now fires on the record's OWN written fact, not only the enrichment row",
    /financing\.preApproved \|\| intelligence\?\.pre_approved === true/.test(scorer))

  // The FACT's writers must be real, or this derivation is one writerless column
  // pointed at another.
  const capture = blankComments(src("lib/contact-pipeline/contact-capture.ts"))
  check("contacts.lender_status has a live writer (capture + import)",
    (capture.match(/lender_status:\s*params\.lender_status/g) ?? []).length >= 2)
  check("…and a second live writer (the credit co-pilot)",
    /lender_status:\s*params\.lender_status/.test(blankComments(src("app/actions/credit-copilot.ts"))))
  check("buyer_financial_profiles has a live writer behind a real surface",
    /from\("buyer_financial_profiles"\)[\s\S]{0,120}\.upsert\(/.test(blankComments(src("app/actions/buyer-financial.ts"))))

  // ── PURE — THE NUMBER MOVES, in both directions ──────────────────────────
  const POINTS = 30
  const scoreOf = (r: ReturnType<typeof readPreApproval>) => (r.preApproved ? POINTS : 0)

  const nothing = readPreApproval({})
  check("nothing known → NOT pre-approved, no amount, no readiness word (an honest zero)",
    nothing.preApproved === false && nothing.preApprovalAmount === null &&
    nothing.financialReadiness === null && nothing.basis === "none")
  check("…and it scores 0 — the branch stays silent on absence", scoreOf(nothing) === 0)

  const approved = readPreApproval({ lenderStatus: "pre_approved" })
  check("the live vocabulary word → pre_approved", approved.preApproved === true && approved.basis === "lender_status")
  check("…AND THE NUMBER MOVES: 0 → 30 on a fact the system actually holds",
    scoreOf(approved) - scoreOf(nothing) === 30)

  const needs = readPreApproval({ lenderStatus: "needs_pre_approval" })
  check("'needs_pre_approval' is NOT pre-approved (the opposite fact must not score)",
    needs.preApproved === false && scoreOf(needs) === 0 && needs.financialReadiness === "needs_pre_approval")

  const cash = readPreApproval({ lenderStatus: "cash" })
  check("a CASH buyer is recorded as cash and does NOT score the pre-approval branch",
    cash.preApproved === false && cash.financialReadiness === "cash" && scoreOf(cash) === 0)
  const cashProfile = readPreApproval({ financial: { is_cash_buyer: true, pre_approval_amount: 500_000 } })
  check("…and a cash flag on the financial profile cannot back-door the boolean either",
    cashProfile.preApproved === false && cashProfile.financialReadiness === "cash")

  const amount = readPreApproval({ financial: { pre_approval_amount: 450_000, pre_approval_expires_at: "2999-01-01" } })
  check("a live pre-approval AMOUNT alone establishes the fact, and carries the number",
    amount.preApproved === true && amount.preApprovalAmount === 450_000 && amount.basis === "financial_profile")

  const expired = readPreApproval({ financial: { pre_approval_amount: 450_000, pre_approval_expires_at: "2000-01-01" } })
  check("an EXPIRED pre-approval is not a pre-approval, and its amount is NOT quoted as current",
    expired.preApproved === false && expired.preApprovalAmount === null)
  const noExpiry = readPreApproval({ financial: { pre_approval_amount: 1, pre_approval_expires_at: null } })
  check("…but a missing expiry is an ABSENCE, not a lapse", noExpiry.preApproved === true)

  const both = readPreApproval({ lenderStatus: "pre_approved", financial: { pre_approval_amount: 600_000, pre_approval_expires_at: "2999-01-01" } })
  check("status + profile together carry the word AND the number",
    both.preApproved === true && both.preApprovalAmount === 600_000 && both.financialReadiness === "pre_approved")

  check("a value outside the live CHECK vocabulary is IGNORED, not written through",
    readPreApproval({ lenderStatus: "Pre-Approved!" }).financialReadiness === null)
  check("every readiness word this can emit is inside the live CHECK vocabulary",
    [approved, needs, cash, both].every((r) =>
      r.financialReadiness === null || ["cash", "pre_approved", "needs_pre_approval", "unknown"].includes(r.financialReadiness)))
  check("a zero / negative / unparseable amount is NULL, never a number quoted at a buyer",
    readPreApproval({ financial: { pre_approval_amount: 0 } }).preApprovalAmount === null &&
    readPreApproval({ financial: { pre_approval_amount: -5 } }).preApprovalAmount === null &&
    readPreApproval({ financial: { pre_approval_amount: "abc" } }).preApprovalAmount === null)

  control("the derivation removed from the writer", !/readPreApproval\(\{\s*lenderStatus:/.test(liSrc.replace(/readPreApproval\(\{ lenderStatus:/, "noSuchCall({ lenderStatus:")))
  control("the +30 branch deleted rather than made reachable", !/score \+= 30/.test(scorer.replace("score += 30", "")))
  control("cash silently treated as pre-approved", readPreApproval({ lenderStatus: "cash" }).preApproved !== true)
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE FLAG NOBODY COULD CLEAR
// ─────────────────────────────────────────────────────────────────────────────
function resolveLayer() {
  console.log("\n[3 — THE GATE NOW MOVES: at_risk was permanent because nothing could clear an alert]")

  const svc = blankComments(src("lib/application/compliance-monitoring.ts"))
  const alertWrite = writeKeysIn(svc, "compliance_alerts", "update")
  check("a compliance_alerts UPDATE now exists at all", alertWrite !== null)
  for (const c of ["resolved", "resolved_at", "resolved_by"]) {
    check(`compliance_alerts.${c} is WRITTEN`, !!alertWrite?.includes(c), (alertWrite ?? []).join(","))
    check(`…compliance_alerts.${c} is a live column`, isLiveColumn("compliance_alerts", c))
  }
  check("WHO is a users.id, not an agents.id (the two id spaces are disjoint — 23503)",
    /resolved_by:\s*actor\.userId/.test(svc))

  const flagWrite = writeKeysIn(svc, "comp_risk_flags", "update")
  check("a comp_risk_flags UPDATE now exists", flagWrite !== null)
  check("comp_risk_flags.is_resolved is WRITTEN", !!flagWrite?.includes("is_resolved"), (flagWrite ?? []).join(","))
  check("…and it is a live column", isLiveColumn("comp_risk_flags", "is_resolved"))
  const auditWrite = writeKeysIn(svc, "audit_log", "insert")
  check("the clearing is recorded in the ONE audit ledger", auditWrite !== null)
  for (const c of ["user_id", "action", "entity_type", "entity_id", "after"]) {
    check(`audit_log.${c} is written and live`, !!auditWrite?.includes(c) && isLiveColumn("audit_log", c))
  }
  check("comp_risk_flags carries NO phantom actor column (adding three would be three NEW writerless columns)",
    !flagWrite?.includes("resolved_by") && !flagWrite?.includes("resolution_note"))
  check("ATTRIBUTION FIRST on the path with no actor column — a failed ledger write leaves the flag OPEN",
    /if \(!audit\.ok\)[\s\S]{0,220}left open/.test(svc))

  check("TENANT COMES FROM THE SESSION, never from the call (the IDOR shape found repeatedly here)",
    /getAgentContext\(\)/.test(svc) && !/brokerageId:\s*params\.brokerageId/.test(svc))
  check("the alert clear is pinned to the caller's OWN brokerage",
    /\.eq\("brokerage_id", actor\.brokerageId\)/.test(svc))
  check("a comp risk flag with no tenant of its own is owned through its CMA, and refused when neither resolves",
    /from\("cma_reports"\)[\s\S]{0,220}\.eq\("brokerage_id", actor\.brokerageId\)/.test(svc) &&
    /if \(!owned\) return \{ success: false/.test(svc))
  check("a second click cannot rewrite the first person's name off a flag they already cleared",
    /\.eq\("resolved", false\)/.test(svc) && /\.eq\("is_resolved", false\)/.test(svc))
  check("a refused clear is REPORTED, not swallowed (supabase-js resolves refusals)",
    /if \(error\) return \{ success: false, error: error\.message \}/.test(svc))

  // The READERS this feeds must still be reading it, or the write is decorative.
  check("the at_risk rule still reads only UNRESOLVED alerts",
    /from\("compliance_alerts"\)[\s\S]{0,200}\.eq\("resolved", false\)/.test(svc))
  check("the CMA report still reads only UNRESOLVED comp risks",
    /from\("comp_risk_flags"\)[\s\S]{0,200}\.eq\("is_resolved", false\)/.test(blankComments(src("app/actions/seller-cma.ts"))))

  // ── THE SURFACES (a resolve action nobody can reach is not a resolve path) ─
  const tab = src("app/components/compliance/transaction-compliance-tab.tsx")
  check("the transaction compliance panel LISTS the alerts, not just a count",
    /summary\.alerts\.map\(/.test(tab))
  check("…each with the clear action", /handleResolveAlert\(txnId, a\.id\)/.test(tab))
  check("…and a refusal is shown to the person rather than the row silently vanishing",
    /setAlertMsg\(res\.error/.test(tab))
  const cma = src("app/dashboard/listings/[id]/cma/tabs/cma-report-tab.tsx")
  check("the CMA report's risk-flag card has the clear action", /handleResolveFlag\(flag\.id\)/.test(cma))
  check("…and its refusal is surfaced too", /setFlagMsg\(res\.error/.test(cma))

  // ── THE GATE MOVES — the service's own rule, re-derived over a shrinking set
  // The rule at checkComplianceStatusService: ANY unresolved alert ⇒ at_risk.
  const overallStatus = (openAlerts: number, allChecklistsCompliant: boolean) =>
    openAlerts > 0 ? "at_risk" : allChecklistsCompliant ? "compliant" : "pending"
  check("BEFORE: two open alerts ⇒ at_risk", overallStatus(2, true) === "at_risk")
  check("clearing ONE is not enough — still at_risk (the gate must not move early)",
    overallStatus(1, true) === "at_risk")
  check("AND THE GATE MOVES: clearing the LAST one finally leaves at_risk",
    overallStatus(0, true) === "compliant")
  check("…without inventing a pass: an outstanding checklist still reads 'pending', not 'compliant'",
    overallStatus(0, false) === "pending")
  check("the surface re-derives the SAME rule rather than keeping a second one",
    /alerts\.length > 0 \? "at_risk"/.test(blankComments(tab)))

  // ── THE MIGRATION ────────────────────────────────────────────────────────
  const mig = "supabase/migrations/m515-the-two-open-flag-reads-that-finally-have-something-to-close.sql"
  check("m515 exists", existsSync(join(process.cwd(), mig)))
  const sql = existsSync(join(process.cwd(), mig)) ? src(mig) : ""
  check("m515 indexes BOTH open-flag predicates now that the sets can shrink",
    /idx_comp_risk_flags_open[\s\S]{0,200}where is_resolved = false/i.test(sql) &&
    /idx_compliance_alerts_open[\s\S]{0,200}where resolved = false/i.test(sql))
  check("m515 adds NO columns (a migration that adds a writerless column is the defect, not the fix)",
    !/add column/i.test(sql))
  check("m515 marks NOTHING resolved and backfills no actor",
    !/set\s+resolved\s*=\s*true/i.test(sql) && !/set\s+is_resolved\s*=\s*true/i.test(sql))
  check("m515 refuses to pass if it did not land (an AFTER assertion, not a hope)",
    /raise exception[\s\S]{0,120}m515 did not land/i.test(sql))

  control("the resolve write reduced to the bare boolean, losing WHO and WHEN",
    writeKeysIn(svc.replace(/resolved_by: actor\.userId,/, ""), "compliance_alerts", "update")?.includes("resolved_by") !== true)
  control("the reader's unresolved filter dropped (every alert would read as open forever)",
    !/from\("compliance_alerts"\)[\s\S]{0,200}\.eq\("resolved", false\)/.test(svc.replace(/\.eq\("resolved", false\)/g, "")))
  control("the gate rule inverted so a cleared board still reads at_risk", overallStatus(0, true) !== "at_risk")
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE FLAGGED ITEM WITH NOTHING TO OPEN
// ─────────────────────────────────────────────────────────────────────────────
function approvalSubjectLayer() {
  console.log("\n[4 — THE LINK NOW ARRIVES: a reviewer was shown a flagged item and no way to open it]")

  const guard = blankComments(src("lib/content-guardian/index.ts"))
  const keys = writeKeysIn(guard, "approval_items", "insert")
  check("the approval_items insert exists and parses", keys !== null)
  check("approval_items.item_id is WRITTEN", !!keys?.includes("item_id"), (keys ?? []).join(","))
  check("…and it is a live column", isLiveColumn("approval_items", "item_id"))
  check("the row's id comes back, so a caller that persists AFTER the scan can stamp it",
    /\.select\("id"\)\s*\.single\(\)/.test(guard) && /approvalItemId/.test(guard))

  // THE ORDERING RULING — argued, chosen, and enforced.
  const guardRaw = src("lib/content-guardian/index.ts")
  check("the ordering problem is RESOLVED explicitly, with the rejected option named",
    /SCAN AFTER PERSISTENCE/.test(guardRaw) && /REJECTED/.test(guardRaw) && /CHOSEN/.test(guardRaw))
  check("compliance-first is PRESERVED: the scan still runs before anything is persisted",
    guard.indexOf("detectFairHousingViolations(content)") < guard.indexOf('from("approval_items")'))
  check("the stamp only ever fills a BLANK — a queue entry that already points somewhere is not repointed",
    /\.is\("item_id", null\)/.test(guard))
  check("the stamp NEVER throws (the entity is already saved by then)",
    /attachApprovalSubject[\s\S]{0,900}catch \(err\)[\s\S]{0,160}return false/.test(guard))
  check("a refused stamp is read, not swallowed", /subject stamp failed/.test(guardRaw))

  // BOTH callers.
  const kernelListings = blankComments(src("lib/kernel/listings.ts"))
  check("the caller that ALREADY has the entity passes it, so no second write is needed",
    /subjectId:\s*input\.listingId/.test(kernelListings))
  const intake = blankComments(src("app/actions/ai-listing-intake.ts"))
  check("the caller that persists AFTERWARDS selects the new row's id",
    /from\("listing_marketing_content"\)[\s\S]{0,300}\.select\("id"\)/.test(intake))
  check("…and stamps the subject with it",
    /attachApprovalSubject\([\s\S]{0,160}savedContent\?\.id/.test(intake))
  check("…unconditionally — a per-call-site guard is how the id gets dropped again",
    !/if \([^)]*approvalItemId[^)]*\)\s*\{?\s*await attachApprovalSubject/.test(intake))

  // The READER renders honestly when there genuinely is nothing to open.
  const agg = blankComments(src("lib/kernel/approval-queue-aggregator.ts"))
  check("the queue still reads item_id", /select\("id, agent_id, item_type, item_id/.test(agg))
  check("…and a row with none says so instead of trailing off into a dangling em-dash",
    /no linked item/.test(agg) && !/— \$\{String\(row\.item_id \?\? ""\)\}/.test(agg))

  control("item_id dropped from the insert",
    writeKeysIn(guard.replace(/item_id: subjectId \?\? null,/, ""), "approval_items", "insert")?.includes("item_id") !== true)
  control("the stamp allowed to overwrite an existing link",
    !/\.is\("item_id", null\)/.test(guard.replace(/\.is\("item_id", null\)/, "")))
  // The ORDER assertion above must be able to fail: swap the two so the persist
  // site precedes the scan, and the same comparison must go RED.
  control("the scan moved after persistence (compliance-first inverted)", (() => {
    const scanAt = guard.indexOf("detectFairHousingViolations(content)")
    const writeAt = guard.indexOf('from("approval_items")')
    const inverted = guard.slice(0, scanAt) + 'from("approval_items")' + guard.slice(scanAt) 
    return !(inverted.indexOf("detectFairHousingViolations(content)") < inverted.indexOf('from("approval_items")')) && scanAt < writeAt
  })())
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE SELLER'S MONEY
// ─────────────────────────────────────────────────────────────────────────────
function sellerFeeLayer() {
  console.log("\n[5 — MONEY SHOWN TO A SELLER: six readers subtracted a fee no writer ever supplied]")

  const engine = blankComments(src("app/actions/seller-listing/execution-engine.ts"))
  const keys = writeKeysIn(engine, "listing_agreements", "insert")
  check("the sole listing_agreements INSERT in the tree exists and parses", keys !== null)
  check("listing_agreements.seller_transaction_fee is WRITTEN", !!keys?.includes("seller_transaction_fee"), (keys ?? []).join(","))
  check("…and it is a live column", isLiveColumn("listing_agreements", "seller_transaction_fee"))
  check("the commission terms it sits beside are still written (nothing was displaced)",
    ["listing_commission_rate", "buyer_commission_rate", "commission_flat_amount"].every((c) => !!keys?.includes(c)))

  check("NULL when none was agreed, never 0 — 0 asserts a negotiated zero",
    /sellerTransactionFee =\s*\n?\s*rawFee === undefined \|\| rawFee === null \? null : Number\(rawFee\)/.test(engine) ||
    /rawFee === undefined \|\| rawFee === null \? null : Number\(rawFee\)/.test(engine))
  check("a negative or non-finite fee is REFUSED before it reaches a seller's net sheet",
    /!Number\.isFinite\(Number\(rawFee\)\) \|\| Number\(rawFee\) < 0/.test(engine))
  const engineRaw = src("app/actions/seller-listing/execution-engine.ts")
  check("the AGENT-side fee columns are named as the thing this must never be defaulted from",
    /agents\.transaction_fee[\s\S]{0,200}AGENT-side/.test(engineRaw))

  // ── ALL SIX READERS still read it — the number now arrives at every one ───
  const readers: Array<[string, string]> = [
    ["lib/kernel/offer-net-sheet.ts", "the offer net sheet"],
    ["lib/workflow/intelligence/multi-offer-matrix.ts", "the multi-offer matrix"],
    ["app/actions/cma-presentation/net-sheet-calculator.ts", "the net-sheet calculator"],
    ["app/actions/seller-cma.ts", "the CMA + net-sheet pages"],
    ["app/actions/portal-seller.ts", "THE SELLER'S OWN PORTAL"],
    ["app/dashboard/listings/[id]/offers/page.tsx", "the offers page"],
  ]
  for (const [file, what] of readers) {
    check(`${what} still reads seller_transaction_fee (${file})`,
      /seller_transaction_fee/.test(blankComments(src(file))))
  }

  // ── THE ORPHAN VERDICT — the writer had no caller, and now has one ───────
  const recordable = blankComments(src("lib/listing-lifecycle/recordable-events.ts"))
  check("markAgreementSigned is a recordable action", /"markAgreementSigned"/.test(recordable))
  check("…offered at the stage where the agreement is OUT for signature",
    /LISTING_AGREEMENT_INITIATED:\s*\["markAgreementSigned", "cancelListing"\]/.test(recordable))
  check("…and it is not stranded — allMappedActions() would catch a definition with no stage",
    /allMappedActions/.test(recordable))
  check("the seller fee is COLLECTED on that form (a param with no field is still no writer)",
    /key: "sellerTransactionFee"/.test(recordable))
  check("…as optional, so 'no fee agreed' stays NULL instead of being typed as 0",
    /key: "sellerTransactionFee",[\s\S]{0,140}required: false/.test(recordable))
  check("uploadMode is offered in the RECORDER's own vocabulary",
    /options: \["manual_upload", "provider_pull"\]/.test(recordable))

  const dispatcher = blankComments(src("app/actions/seller-listing/record-lifecycle-event.ts"))
  check("the dispatcher actually calls it (the orphan now has a caller)",
    /case "markAgreementSigned":[\s\S]{0,700}return markAgreementSigned\(\{/.test(dispatcher))
  check("…passing the fee through", /sellerTransactionFee: num\("sellerTransactionFee"\)/.test(dispatcher))
  check("…and NOT passing identity — the recorder resolves it from the session",
    !/markAgreementSigned\(\{[\s\S]{0,300}brokerageId:/.test(dispatcher))
  check("the generic form renders a number field, so the box is really reachable",
    /type=\{f\.type === "number" \? "number" : "text"\}/.test(src("app/components/dashboard/listings/lifecycle/record-event-card.tsx")))

  check("the recorder still runs the compliance gate it carries (the reason it must not be deleted)",
    /auditListingDocuments\(/.test(engine) && /scanListingPacketCompleteness\(/.test(engine))

  control("the fee dropped from the insert",
    writeKeysIn(engine.replace(/seller_transaction_fee:\s*sellerTransactionFee,/, ""), "listing_agreements", "insert")?.includes("seller_transaction_fee") !== true)
  control("the recorder unwired from the stage map again",
    !/LISTING_AGREEMENT_INITIATED:\s*\["markAgreementSigned", "cancelListing"\]/.test(
      recordable.replace('LISTING_AGREEMENT_INITIATED:   ["markAgreementSigned", "cancelListing"]', 'LISTING_AGREEMENT_INITIATED:   ["cancelListing"]')))
  control("the fee field made required (forcing a brokerage that charges nothing to type 0)",
    !/key: "sellerTransactionFee",[\s\S]{0,140}required: false/.test(
      recordable.replace(/key: "sellerTransactionFee",([\s\S]{0,140}?)required: false/, 'key: "sellerTransactionFee",$1required: true')))
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PARSER ITSELF — a finder that cannot see is worse than no finder
// ─────────────────────────────────────────────────────────────────────────────
function parserControls() {
  console.log("\n[CONTROLS — the finder still recognises the defect it was written for]")
  const sample = `
    await supabase.from("t_one").insert({ a: 1, b: { nested: 2 }, c: "x" })
    await supabase.from("t_two").select("id").eq("x", 1)
    await supabase.from("t_two").update({ d: true })
  `
  check("the parser reads top-level keys and does not descend into nested objects",
    JSON.stringify(writeKeysIn(sample, "t_one", "insert")) === JSON.stringify(["a", "b", "c"]))
  check("a table SELECTED before it is UPDATED is still found (the first .from() is not the write)",
    JSON.stringify(writeKeysIn(sample, "t_two", "update")) === JSON.stringify(["d"]))
  check("a table with no such write returns NULL, which is itself a finding",
    writeKeysIn(sample, "t_one", "update") === null && writeKeysIn(sample, "t_absent", "insert") === null)
  check("a COMMENTED-OUT write is not counted as a writer",
    writeKeysIn(blankComments(`// await supabase.from("t_x").insert({ a: 1 })`), "t_x", "insert") === null)
  check("the live-column check rejects a phantom and accepts a real one",
    !isLiveColumn("compliance_alerts", "definitely_not_a_column") && isLiveColumn("compliance_alerts", "resolved"))
  check("the snapshot this proof judges against is not empty (a blind snapshot passes everything)",
    Object.keys(SCHEMA_SNAPSHOT).length > 100)
}

function main() {
  secretLayer()
  preApprovalLayer()
  resolveLayer()
  approvalSubjectLayer()
  sellerFeeLayer()
  parserControls()
  console.log("\n──────────────────────────────────────────────────")
  console.log(" BLIND SPOTS, published beside the number: this proof is STATIC + PURE.")
  console.log("   · It reads SOURCE and the generated live-schema snapshot; it opens no")
  console.log("     database, so it proves each write NAMES a live column, not that a row")
  console.log("     landed. m515 IS APPLIED — verified live 2026-09-05 against")
  console.log("     hrvaqgvukzxfskkcrwbt: idx_comp_risk_flags_open and")
  console.log("     idx_compliance_alerts_open both exist in pg_indexes. (This line read")
  console.log("     'written and NOT applied' for several waves after it stopped being")
  console.log("     true — a migration claim ages into a lie the moment the integrator")
  console.log("     applies it, which is the whole reason test:migration-claim exists.)")
  console.log("   · Vibe CTV cannot be exercised end-to-end in-sandbox (no Vibe OAuth")
  console.log("     client); its credential now RESOLVES, which is the half that was")
  console.log("     writerless. Live 2xx remains unverified, as wave 11 already recorded.")
  console.log("   · leads.lender_status stays writerless — reported, not fixed. See report.")
  if (fails.length) { console.log("\nFAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ WRITERLESS_ARRIVALS_FAIL"); process.exit(1) }
  console.log(" ✅ WRITERLESS_ARRIVALS_PASS — the secret, the pre-approval, the clearance, the review link and the seller's fee all ARRIVE, and the score and the compliance gate MOVE")
}
main()
