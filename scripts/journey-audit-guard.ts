/**
 * scripts/journey-audit-guard.ts — test:journey-audit (wave 149, lane 149J).
 *
 * Owner ruling 20 (2026-11-03): "Finish every open loop and every 'not done' note from the parallel agents." The lane-J
 * brief adds the journey audit: across platform staff / prospects, onboarding / billing, solo / team / brokerage, seats,
 * marketing, lead / contact classification, search / listings, forms / e-sign / compliance, offers / transactions,
 * CDA / closing / commissions, portals, vendors, education / reputation / rewards, support and mobile / accessibility —
 * "no advertised capability silently fails or falsely reports success".
 *
 * What this proof holds (STRIPPED source — scripts/strip-comments.ts; a tombstone is not a door, CLAUDE.md §2):
 *   J. every journey's DOORS resolve — the file exists and exports the named async door;
 *   K. every door REPORTS a refusal — its body carries a refusal shape (`success: false` / `ok: false` / an `error`
 *      return / a throw), so a refused step cannot read as done;
 *   L. no door FALSELY reports success — no `catch` block in its body returns `success: true` / `ok: true`;
 *   M. every "use server" door is GATED — its body (or the file-local gate it calls) reaches a session read before it acts
 *      (CLAUDE.md §4 — tenant from the session);
 *   N. the wave-149 closures this lane made hold as RULES, driven where they are pure:
 *      N1 C17 capability grants (lib/voice-admin/intent-interface.ts checkIntentAuthority + lib/auth/role-grants.ts withTenantRoleGrants);
 *      N2 the persona study's evidence cadence (lib/lead-pipeline/enrichment-retry.ts cadence section, wired before buildContactPersona);
 *      N3 the portal unsubscribe (lib/notifications/buyer-preferences.ts portalChannelWithdrawals → writeOptOut 'portal');
 *      N4 the lot-size unit (app/actions/listings-kernel.ts LOT_SIZE_UNITS === m954's CHECK list);
 *   P. POSITIVE CONTROLS — each finder above is shown catching the defect it exists for (a missing export, a door with no
 *      refusal, a catch that reports success, an ungated door, a grant that would lift the contact floor).
 * Blind spots are printed at the end. The summary line is `RESULT: n passed, m failed`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { blankStrings, stripComments } from "./strip-comments"

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) passed++
  else failed++
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`)
}
const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null)

// ── the journeys and their doors (each a real, advertised entry point) ────────────────────────────────────────────────
export interface Door { file: string; symbol: string }
export const JOURNEYS: Record<string, Door[]> = {
  "platform staff / prospects": [
    { file: "lib/platform/prospect-capture.ts", symbol: "upsertPlatformProspect" },
    { file: "app/actions/superadmin/manual-subscriber.ts", symbol: "manualProvisionSubscriberAction" },
    { file: "app/actions/superadmin/impersonation.ts", symbol: "enterTenantAction" },
  ],
  "onboarding / billing": [
    { file: "app/actions/billing.ts", symbol: "startSubscriptionCheckout" },
    { file: "app/actions/billing.ts", symbol: "cancelSubscription" },
    { file: "app/actions/onboarding-decisions.ts", symbol: "adoptAssistantIdentityAction" },
  ],
  "solo / team / brokerage": [
    { file: "app/actions/team-branding.ts", symbol: "saveTeamBranding" },
    { file: "app/actions/admin/invitations.ts", symbol: "markBrokerageSetupCompleteAction" },
  ],
  "seats": [
    { file: "app/actions/admin/invitations.ts", symbol: "resendInvitationAction" },
    { file: "app/actions/admin/invitations.ts", symbol: "revokeInvitationAction" },
  ],
  "marketing": [
    { file: "app/actions/lead-magnets-actions.ts", symbol: "createMagnetFunnelAction" },
    { file: "app/actions/reputation-kernel.ts", symbol: "createReviewRequestAction" },
  ],
  "lead / contact classification": [
    { file: "app/actions/leads.ts", symbol: "qualifyLead" },
    { file: "app/actions/contact-persona.ts", symbol: "deriveContactPersona" },
  ],
  "search / listings": [
    { file: "app/actions/listings-kernel.ts", symbol: "saveListingDraftAction" },
    { file: "app/actions/listings-kernel.ts", symbol: "launchListingAction" },
    { file: "app/actions/self-book-showing.ts", symbol: "bookShowingSlotAction" },
  ],
  "forms / e-sign / compliance": [
    { file: "app/actions/forms-kernel.ts", symbol: "launchEsignAction" },
    { file: "app/actions/buyer-offer/submit-for-signature.ts", symbol: "submitForSignature" },
  ],
  "offers / transactions": [
    { file: "app/actions/seller-offers.ts", symbol: "acceptOffer" },
    { file: "app/actions/transactions.ts", symbol: "createTransaction" },
  ],
  "CDA / closing / commissions": [
    { file: "app/actions/cda-portal.ts", symbol: "submitCdaForApprovalAction" },
    { file: "app/actions/cda-portal.ts", symbol: "approveCdaAction" },
  ],
  "portals": [
    { file: "app/actions/portal-settings.ts", symbol: "updateContactProfile" },
    { file: "app/actions/portal-messages.ts", symbol: "sendPortalMessage" },
  ],
  "vendors": [
    { file: "app/actions/vendor-portal.ts", symbol: "acceptVendorBookingAction" },
    { file: "app/actions/vendor-invite.ts", symbol: "acceptVendorInviteAction" },
  ],
  "education / reputation / rewards": [
    { file: "app/actions/education-kernel.ts", symbol: "assignResourceAction" },
    { file: "app/actions/reputation-kernel.ts", symbol: "sendThankYouNoteAction" },
  ],
  "support": [
    { file: "app/actions/support.ts", symbol: "createSupportTicket" },
    { file: "app/actions/support.ts", symbol: "updateTicketStatus" },
  ],
  "mobile / accessibility": [
    { file: "app/actions/push-subscriptions.ts", symbol: "subscribePush" },
    { file: "app/actions/portal-settings.ts", symbol: "fileDataSubjectRequestFromPortal" },
  ],
}

// ── finders (exported so the positive controls feed them fixtures) ────────────────────────────────────────────────────
/** The body of `export async function <symbol>` (or `export const <symbol> = async`) in comment-stripped, string-blanked
 *  source, by brace matching from the first `{` after the signature's closing paren. null = not exported. */
export function doorBody(code: string, symbol: string): string | null {
  const re = new RegExp(`export\\s+(?:async\\s+function\\s+${symbol}\\b|const\\s+${symbol}\\s*=\\s*async\\b)`)
  const m = re.exec(code)
  if (!m) return null
  // the parameter list may contain object types with braces — skip to the matching ')' of the first '('
  let i = code.indexOf("(", m.index + m[0].length - 1)
  if (i < 0) return null
  let depth = 0
  for (; i < code.length; i++) {
    if (code[i] === "(") depth++
    else if (code[i] === ")") { depth--; if (depth === 0) break }
  }
  // the return-type annotation may also contain braces: the body is the first '{' at type-depth 0 after `)` that is
  // preceded by `=>`, `)` or a type, i.e. the LAST top-level `{` before the body's statements. Walk generics/objects.
  let j = i + 1
  let angle = 0
  let typeBrace = 0
  let sawColon = false
  for (; j < code.length; j++) {
    const c = code[j]
    if (c === ":" && angle === 0 && typeBrace === 0) sawColon = true
    if (c === "<") angle++
    else if (c === ">" && code[j - 1] !== "=") angle = Math.max(0, angle - 1)
    else if (c === "{") {
      if (sawColon && (angle > 0 || isTypeBrace(code, j))) { typeBrace++; continue }
      if (typeBrace === 0) break
      typeBrace++
    } else if (c === "}") { if (typeBrace > 0) typeBrace-- }
  }
  if (j >= code.length) return null
  let d = 0
  for (let k = j; k < code.length; k++) {
    if (code[k] === "{") d++
    else if (code[k] === "}") { d--; if (d === 0) return code.slice(j, k + 1) }
  }
  return null
}
/** A `{` that opens an object TYPE in a return annotation (`Promise<{ ok: boolean }>`, `): { ok: true } | …`): the next
 *  non-space token is `identifier?:` / `identifier:` / `[` / `}` / `readonly`, and the brace before the body never is. */
function isTypeBrace(code: string, at: number): boolean {
  const ahead = code.slice(at + 1, at + 120).trimStart()
  if (/^(readonly\s+)?[A-Za-z_$][\w$]*\??\s*:/.test(ahead)) {
    // a body can also start `{ const x: T = …` — that is a statement, never `name:` at column 0 of the block
    return !/^(const|let|var|return|if|for|while|try|await|throw|switch)\b/.test(ahead)
  }
  return /^(\[|\})/.test(ahead)
}
export const REFUSAL_SHAPE = /success:\s*false|ok:\s*false|\berror\s*:|\bthrow\b|\brefused\b|kind:\s*["'`]?refused|NextResponse\.json\([^)]*status:\s*4\d\d|if\s*\(\s*error\b[\s\S]{0,200}?return null/
export function reportsRefusal(body: string): boolean { return REFUSAL_SHAPE.test(body) }
/** catch blocks (by brace matching) whose own text returns a success. */
export function falseSuccessCatches(body: string): string[] {
  const out: string[] = []
  const re = /\bcatch\s*(\([^)]*\))?\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    let d = 0
    const start = m.index + m[0].length - 1
    for (let k = start; k < body.length; k++) {
      if (body[k] === "{") d++
      else if (body[k] === "}") {
        d--
        if (d === 0) {
          const block = body.slice(start, k + 1)
          if (/return\s*\{[^}]*\b(success|ok)\s*:\s*true/.test(block)) out.push(block.slice(0, 120).replace(/\s+/g, " "))
          break
        }
      }
    }
  }
  return out
}
/** `if (error) { … return { … } }` blocks that hand back a result carrying no refusal — a refused write read as done
 *  (the shape upsertPlatformProspect had: the existing row returned as if the update landed). */
export function falseSuccessOnError(body: string): string[] {
  const out: string[] = []
  const re = /\bif\s*\(\s*!?\s*\w*[eE]rr(?:or)?\b[^)]*\)\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    let d = 0
    const start = m.index + m[0].length - 1
    for (let k = start; k < body.length; k++) {
      if (body[k] === "{") d++
      else if (body[k] === "}") {
        d--
        if (d === 0) {
          const block = body.slice(start, k + 1)
          const ret = /return\s*\{([\s\S]*)\}/.exec(block)
          if (ret && !/\berror\b|\b(success|ok)\s*:\s*false|\brefus|\bblocked\b|\breason\b|\bstatus\b/.test(ret[1])) out.push(block.slice(0, 140).replace(/\s+/g, " "))
          break
        }
      }
    }
  }
  return out
}
export const SESSION_GATE = /\b(getUser|requireAuth|getAgentContext|resolveCallerContext|requireContactAccess|requirePlatform\w*|requireBrokerageAdmin\w*|requireTenant\w*|getAuthContext|requireVendorActor|requireTitleActor|requireLenderVendorActor|requireOverrideActor|resolveCaller\w*|requireSession\w*|requireStaff\w*|requireSuperadmin\w*|requireRole\w*|requireUser\w*|getServerSession|resolveSessionActor|resolveSeat\w*|getCurrentUser\w*|requireAdmin\w*|requireFinance\w*|authorize\w*|gate\w*)\s*\(/
/** The door's body, or a file-local function the body calls, reaches a session read. */
export function gated(code: string, body: string): boolean {
  if (SESSION_GATE.test(body)) return true
  const called = new Set([...body.matchAll(/\b([a-z][A-Za-z0-9_]{3,})\s*\(/g)].map((x) => x[1]))
  for (const fn of called) {
    const def = new RegExp(`(?:async\\s+)?function\\s+${fn}\\b[\\s\\S]{0,1600}`).exec(code)
    if (def && SESSION_GATE.test(def[0])) return true
    const arrow = new RegExp(`const\\s+${fn}\\s*=\\s*async[\\s\\S]{0,1600}`).exec(code)
    if (arrow && SESSION_GATE.test(arrow[0])) return true
  }
  return false
}
const codeOf = (src: string) => blankStrings(stripComments(src))

// ── J–M: the journeys ─────────────────────────────────────────────────────────────────────────────────────────────────
let doorCount = 0
for (const [journey, doors] of Object.entries(JOURNEYS)) {
  console.log(`\n[${journey}]`)
  for (const d of doors) {
    doorCount++
    const src = read(d.file)
    const name = `${d.file} ${d.symbol}`
    if (src === null) { check(`J ${name} — the file exists`, false, "file missing"); continue }
    const code = codeOf(src)
    const body = doorBody(code, d.symbol)
    check(`J ${name} resolves`, body !== null, body === null ? "not exported as an async door" : "")
    if (!body) continue
    check(`K ${d.symbol} reports a refusal`, reportsRefusal(body))
    const lies = falseSuccessCatches(body)
    check(`L ${d.symbol} never reports success from a catch`, lies.length === 0, lies.join(" | "))
    const errLies = falseSuccessOnError(body)
    check(`L2 ${d.symbol} never hands back a result from a refused read/write`, errLies.length === 0, errLies.join(" | "))
    const useServer = /^\s*["']use server["']/.test(stripComments(src))
    if (useServer) check(`M ${d.symbol} is session-gated`, gated(code, body))
  }
}

// ── N: the wave-149 closures as rules ────────────────────────────────────────────────────────────────────────────────
async function rules() {
  console.log("\n[N1 · C17 honours tenant capability GRANTS (adds a feature, never a scope, never a floor)]")
  const ii = await import("../lib/voice-admin/intent-interface")
  const { FEATURE_FLAGS } = await import("../lib/security/permission-matrix")
  const cat = ii.intentCatalogue()
  const adminOnly = cat.find((r) => r.feature && !(FEATURE_FLAGS[r.feature] ?? []).includes("isa") && (FEATURE_FLAGS[r.feature] ?? []).includes("admin") && !r.governedBy?.match(/money|books/))
  check("a catalogue route exists that an isa seat lacks and an admin holds", !!adminOnly, adminOnly?.key ?? "none")
  if (adminOnly) {
    const seat = { userId: "u1", userType: "isa", platformRole: null, agentId: null }
    const plain = ii.checkIntentAuthority(adminOnly, seat)
    const granted = ii.checkIntentAuthority(adminOnly, { ...seat, grantedRoles: ["admin"] })
    const platformGrant = ii.checkIntentAuthority(adminOnly, { ...seat, grantedRoles: ["superadmin"] })
    check("POSITIVE CONTROL: the isa seat alone is refused by role", plain.outcome === "refused_role", plain.outcome)
    check("the same seat with an admin GRANT in this tenant is admitted (or reaches a later gate)", granted.outcome !== "refused_role", granted.outcome)
    check("a grant never widens the data scope (it stays the seat's)", granted.dataScope === plain.dataScope, `${granted.dataScope} vs ${plain.dataScope}`)
    check("a tenant grant naming a platform role is NOT honoured (platform staff are platform_role)", platformGrant.outcome === "refused_role", platformGrant.outcome)
  }
  const staffRoute = cat.find((r) => r.family !== "client_portal" && r.key !== "property_search")
  if (staffRoute) {
    const contactWithGrant = ii.checkIntentAuthority(staffRoute, { userId: "c1", userType: "contact", platformRole: null, agentId: null, grantedRoles: ["admin"] })
    check("POSITIVE CONTROL: a grant cannot lift the contact floor", contactWithGrant.outcome === "refused_role" || contactWithGrant.outcome === "refused_never_spoken" || contactWithGrant.outcome === "refused_risk", contactWithGrant.outcome)
  }
  const grantsSrc = codeOf(read("lib/auth/role-grants.ts") ?? "")
  check("withTenantRoleGrants reads the ONE grants reader and READS its error (refused → seat alone)",
    /readRoleGrants\(/.test(grantsSrc) && /if\s*\(\s*!r\.ok\s*\)/.test(grantsSrc) && /g\.brokerage_id\s*===\s*brokerageId/.test(grantsSrc))
  for (const door of ["app/api/agentic-os/voice/route.ts", "app/actions/command-center.ts", "app/api/agent-assistant/tool-call/route.ts"]) {
    check(`${door} attaches the tenant grants before C17 decides`, /withTenantRoleGrants\(/.test(codeOf(read(door) ?? "")))
  }

  console.log("\n[N2 · the persona study re-derives on NEW EVIDENCE only]")
  const pc = await import("../lib/lead-pipeline/enrichment-retry")
  const f1 = pc.personaEvidenceFingerprint({ a: 1, b: { c: [1, 2] } })
  check("the fingerprint is key-order stable", f1 === pc.personaEvidenceFingerprint({ b: { c: [1, 2] }, a: 1 }))
  check("a changed fact changes the fingerprint", f1 !== pc.personaEvidenceFingerprint({ a: 2, b: { c: [1, 2] } }))
  check("no prior study → run", pc.personaRederivationVerdict({ fingerprint: f1, stored: null, personaRowExists: null }).run === true)
  check("changed evidence → run", pc.personaRederivationVerdict({ fingerprint: f1, stored: { fingerprint: "x" }, personaRowExists: true }).run === true)
  check("same evidence + a persona row → SKIP", pc.personaRederivationVerdict({ fingerprint: f1, stored: { fingerprint: f1 }, personaRowExists: true }).run === false)
  check("same evidence, row unknown/missing → run (cannot prove redundant)", pc.personaRederivationVerdict({ fingerprint: f1, stored: { fingerprint: f1 }, personaRowExists: null }).run === true)
  check("stored fingerprint reads only a well-formed blob", pc.storedPersonaEvidence({ persona_evidence: { fingerprint: "ab", at: null } })?.fingerprint === "ab" && pc.storedPersonaEvidence({ persona_evidence: "x" }) === null)
  const orch = codeOf(read("lib/lead-pipeline/enrichment-orchestrator.ts") ?? "")
  const vAt = orch.indexOf("personaRederivationVerdict(")
  const bAt = orch.indexOf("buildContactPersona(", vAt)
  check("the orchestrator asks the cadence BEFORE it builds the persona", vAt > 0 && bAt > vAt)
  check("the fingerprint is stored only after a study that WROTE its row (tenant-pinned, counted)",
    /if\s*\(\s*built\.written\s*\)[\s\S]{0,400}persona_evidence[\s\S]{0,300}\.eq\(\s*['"]brokerage_id['"]/.test(stripComments(read("lib/lead-pipeline/enrichment-orchestrator.ts") ?? "")))

  console.log("\n[N3 · the portal unsubscribe rides the ONE opt-out writer]")
  const bp = await import("../lib/notifications/buyer-preferences")
  check("an explicit email:false / sms:false is a withdrawal", JSON.stringify(bp.portalChannelWithdrawals({ notification_preferences: { email: false, sms: false, push: false } })) === JSON.stringify(["email", "sms"]))
  check("POSITIVE CONTROL: a missing key, a true and push are never withdrawals", bp.portalChannelWithdrawals({ notification_preferences: { email: true, push: false } }).length === 0 && bp.portalChannelWithdrawals(null).length === 0)
  const ps = stripComments(read("app/actions/portal-settings.ts") ?? "")
  check("updateContactProfile records each withdrawal through writeOptOut with source 'portal'",
    /portalChannelWithdrawals\(updates\.metadata\)/.test(ps) && /writeOptOut\([^)]*source:\s*["']portal["']/.test(ps))
  check("a refused unsubscribe is SAID (never 'saved')", /the \$\{[^}]+\} unsubscribe did not record/.test(ps) || /unsubscribe did not record/.test(ps))
  check("the writer is tenant-pinned to the session's contact (requireContactAccess → access.brokerageId)", /writeOptOut\(svc,\s*access\.brokerageId/.test(ps))

  console.log("\n[N4 · the lot-size unit is recorded, never inferred]")
  const lk = stripComments(read("app/actions/listings-kernel.ts") ?? "")
  const codeList = /const LOT_SIZE_UNITS = \[([^\]]*)\]/.exec(lk)?.[1]?.match(/["']([a-z_]+)["']/g)?.map((s) => s.slice(1, -1)) ?? []
  const migFile = readdirSync("supabase/migrations").find((f) => /^m954-/.test(f))
  const mig = migFile ? stripSqlComments(readFileSync(`supabase/migrations/${migFile}`, "utf8")) : ""
  const migList = /lot_size_unit IN \(([^)]*)\)/.exec(mig)?.[1]?.match(/'([a-z_]+)'/g)?.map((s) => s.slice(1, -1)) ?? []
  check("m954 exists and its line 1 is the lane stamp or the APPLIED stamp", !!migFile && /^-- (WRITTEN, NOT APPLIED \(wave 149, lane 149J\)|── APPLIED LIVE )/.test(readFileSync(`supabase/migrations/${migFile}`, "utf8").split("\n")[0]))
  check("the action's unit list equals m954's CHECK list", codeList.length > 0 && JSON.stringify([...codeList].sort()) === JSON.stringify([...migList].sort()), `${codeList} vs ${migList}`)
  check("lot_size_unit is on the hand-edit allow-list and refused without the value it describes",
    /"lot_size_unit"/.test(lk) && /recorded together with the lot size it describes/.test(lk))
}
async function rulesN5() {
  console.log("\n[N5 · the agent's own mailbox carries the one-click unsubscribe (Gmail), and says when it cannot (Outlook)]")
  // The helper is module-private (an export with no app caller is an orphan); its own source is transpiled and driven here.
  const adapterSrc = read("lib/providers/email/personal-email-adapter.ts") ?? ""
  const fnSrc = /function personalMailUnsubscribeHeaders\([\s\S]*?\n\}\n/.exec(adapterSrc)?.[0] ?? "function personalMailUnsubscribeHeaders() { return ['missing'] }"
  const ts = await import("typescript")
  const js = ts.transpileModule(`${fnSrc}\nmodule.exports = personalMailUnsubscribeHeaders`, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const mod = { exports: null as unknown as (h: Record<string, string>) => string[] }
  new Function("module", js)(mod)
  const pe = { personalMailUnsubscribeHeaders: mod.exports }
  const hdrs = pe.personalMailUnsubscribeHeaders({ "List-Unsubscribe": "<https://x.example/u/t>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click", "X-Other": "y" })
  check("only the RFC 2369 / 8058 pair is carried", JSON.stringify(hdrs) === JSON.stringify(["List-Unsubscribe: <https://x.example/u/t>", "List-Unsubscribe-Post: List-Unsubscribe=One-Click"]), JSON.stringify(hdrs))
  check("POSITIVE CONTROL: a CR/LF-bearing value (header injection) is dropped", pe.personalMailUnsubscribeHeaders({ "List-Unsubscribe": "<https://x>\r\nBcc: victim@example.com" }).length === 0)
  const adapter = stripComments(read("lib/providers/email/personal-email-adapter.ts") ?? "")
  check("the Gmail RFC 5322 builder writes the extra headers", /extraHeaders,\s*\}\)/.test(adapter) && /for \(const h of args\.extraHeaders \?\? \[\]\) headers\.push\(h\)/.test(adapter))
  check("an Outlook send reports provider_cannot when headers were asked (never assumed carried)", /"provider_cannot" as const/.test(adapter))
  const messaging = stripComments(read("lib/providers/messaging/index.ts") ?? "")
  check("the Tier-1 path hands the assembled headers to the personal mailbox", /sendPersonalEmail\(\{[\s\S]{0,400}headers:\s*params\.headers/.test(messaging))
}
function stripSqlComments(s: string) { return s.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n") }

// ── P: positive controls ─────────────────────────────────────────────────────────────────────────────────────────────
function controls() {
  console.log("\n[P · positive controls — each finder catches the defect it exists for]")
  const fx = codeOf(`"use server"
export async function goodDoor(id: string): Promise<{ success: boolean; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.ok) return { success: false, error: "Unauthorized" }
  return { success: true }
}
export async function liarDoor(id: string) {
  try { await work(id) } catch (e) { return { success: true } }
  return { success: true }
}
export async function ungatedDoor(id: string) {
  const { error } = await svc.from("x").delete().eq("id", id)
  if (error) return { success: false, error: error.message }
  return { success: true }
}
async function helperGate() { return requireContactAccess("x") }
export async function indirectDoor() { const a = await helperGate(); if (!a) return { ok: false }; return { ok: true } }
`)
  check("a missing export is NOT resolved", doorBody(fx, "noSuchDoor") === null)
  check("a declared door resolves through a typed return annotation", doorBody(fx, "goodDoor") !== null)
  check("a door with no refusal shape is caught", !reportsRefusal(doorBody(fx, "liarDoor") ?? "x"))
  check("a lib door whose refused write returns null is credited; a bare null is not", reportsRefusal("{ const { error } = await w(); if (error) { log(error.message); return null } }") && !reportsRefusal("{ if (!x) return null; return y }"))
  check("a catch that returns success is caught", falseSuccessCatches(doorBody(fx, "liarDoor") ?? "").length === 1)
  const oldProspect = codeOf(`export async function upsertOld(svc: any) {
  const { data, error } = await svc.from("p").update({}).eq("id", "1").select("id")
  if (error) {
    console.error("refused", error.message)
    return { id: "1", created: false, email: null, phone: null }
  }
  return { id: "1", created: false, email: null, phone: null }
}`)
  check("the pre-149 prospect shape (a refused update returned as the saved row) is caught", falseSuccessOnError(doorBody(oldProspect, "upsertOld") ?? "").length === 1)
  check("an error branch that returns its refusal is not flagged", falseSuccessOnError("{ if (error) { return { success: false, error: error.message } } }").length === 0)
  check("an honest door has no false-success catch", falseSuccessCatches(doorBody(fx, "goodDoor") ?? "").length === 0)
  check("an ungated door is caught", !gated(fx, doorBody(fx, "ungatedDoor") ?? ""))
  check("a door gated through a file-local helper is credited", gated(fx, doorBody(fx, "indirectDoor") ?? ""))
  const tomb = codeOf(`// TOMBSTONE: export async function ghostDoor() {}\nexport const x = 1`)
  check("a tombstone naming a door is not a door (stripped source)", doorBody(tomb, "ghostDoor") === null)
}

;(async () => {
  await rules()
  await rulesN5()
  controls()
  console.log(`\n${Object.keys(JOURNEYS).length} journeys · ${doorCount} doors audited.`)
  console.log("Blind spots:")
  console.log("  · Static: a door is judged by its own body and the file-local helpers it calls (1,600 chars each). A gate or a refusal")
  console.log("    reached through an IMPORTED helper is not followed — such a door would read ungated; none of the listed doors does.")
  console.log("  · The door list is a census of each journey's advertised entry points, not every action in it (the full action")
  console.log("    surface is test:ui-capability-surface's). A journey whose listed doors pass can still hold a defect elsewhere.")
  console.log("  · A refusal SHAPE proves the door can say no; whether the UI renders that refusal is test:ui-delivery's and the")
  console.log("    capability-surface audit's. No browser runs here; no database runs here (memSupabase proofs own the DB legs).")
  console.log("  · N1–N4 drive the PURE halves; the live grant read, the opt-out write and the orchestrator step are proven by")
  console.log("    shape on stripped source (their DB effects are the integrator's live VERIFY + the owning proofs').")
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
})()
