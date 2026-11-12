/**
 * scripts/addendum-signatures-guard.ts — test:addendum-signatures (wave 152, lane 152F). In-memory + an injected SANDBOX e-sign
 * provider: no database, no network, no live provider. Every provider call here is SIMULATED.
 *
 * Owner (verbatim, wave 152): "the requested signatures on a proposed addendum door needs to be built as it says not implemented."
 *
 * WHAT IT HOLDS (directive 152F proofs):
 *   A · THE RULES, PURE — the request vocabulary (= m953's CHECK; the open set = m953's partial unique index and covers
 *       final-compliance-check's open list), the up-only ladder, the provider-event words, the SIGNER ROUTING (represented
 *       principals sign in our envelope; a side another brokerage represents signs through its agent; attorneys review; a commission
 *       change waits for the broker; nobody signs for a client; one address one party), required-signature reading.
 *   B · THE DOOR, END TO END — proposal UI's actions (the real "use server" door) → the REAL dispatch core
 *       (lib/esign/dispatch-packet.ts) → the sandbox provider: correct parties in order, wrong actor blocked, missing signer → review
 *       (nothing written, nothing sent), the send ledgered (LAW 5), REPLAY never cuts a second envelope (pre-check AND the 23505 race).
 *   C · THE CALLBACK — through the real webhook loop (lib/forms/esign-execution-loop.ts): delivered / viewed stamped once; a
 *       partial envelope is NOT executed; completion reads the provider's signer list, retrieves and hashes the signed copy, records
 *       the EXECUTED version through lane 152E's ONE recorder (governing terms change; the closing date moves; the deal team is told),
 *       closes the proposal; a replay records nothing twice.
 *   D · A SIDE REPRESENTED BY ANOTHER BROKERAGE — the seller is routed through the verified listing agent: our buyer's envelope
 *       completing is NOT execution; an ALTERED signed copy is refused and flagged; the counter-signed copy filed later executes only
 *       if it shows both signatures.
 *   E · FAILURE AND RECOVERY — send failure (tenant-safe words, request `failed`, the proposal intact, a resend works); no e-sign
 *       connection (honest "connection required", nothing written, then a download hand-off that never claims a send); declined;
 *       void (at the provider first; a refused void leaves it live); broker approval held for a finance admin; a sender not clear to
 *       transact; the compliance recheck receives exactly the changed terms (spy on the recorder's own seam).
 *   F · THE SWEEP — the poll executes an envelope whose webhook never came; expiry; one nudge; one escalation to deal_coordinator.
 *   G · WIRING + REGISTRATION — the UI reaches the door, no placeholder remains (positive control), one dispatch core, executed rows
 *       only through the recorder, no env / key read, the registry row, package + chain, m953's stamp / CHECK / index.
 *
 * Every absence assertion carries a POSITIVE CONTROL; code-token scans read STRIPPED source. Blind spots are printed at the end.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { registerHooks } from "node:module"
import { createHash } from "node:crypto"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase, type MemClient } from "./in-memory-supabase"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const ROOT = process.cwd()
const raw = (p: string) => { try { return readFileSync(join(ROOT, p), "utf8") } catch { return "" } }
const code = (p: string) => stripComments(raw(p))
const bare = (p: string) => blankStrings(stripComments(raw(p)))
const quiet = async <T,>(f: () => Promise<T>): Promise<T> => { const e = console.error, w = console.warn, l = console.log; console.error = () => {}; console.warn = () => {}; console.log = () => {}; try { return await f() } finally { console.error = e; console.warn = w; console.log = l } }
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")

// ── THE WORLD: server-only stubbed; every vendor / session reach replaced by a recorder; the dispatch core, the recorder, the
//    governing reader, the webhook loop and the action ledger are REAL. ─────────────────────────────────────────────────────────
const G = globalThis as any
G.__152F = {
  db: null as any, caller: null as any, choice: null as any, readiness: { transactable: true, blockers: [], message: null },
  events: [] as any[], signals: [] as any[], uploads: [] as any[], bytesByUrl: new Map<string, Uint8Array>(), sandbox: null as any,
}
const STUBS: Record<string, string> = {
  "server-only": "export{}",
  "@/lib/supabase/service": "export const createServiceClient = () => globalThis.__152F.db",
  "@/lib/auth/require-caller": "export const requireCaller = async () => globalThis.__152F.caller; export const requireCallerTenant = async () => globalThis.__152F.caller",
  "@/lib/integrations/resolve-esign-provider": "export const resolveESignChoice = async () => globalThis.__152F.choice; export const resolveESignProviderForActor = async (ctx) => { if (!globalThis.__152F.sandbox) throw new Error('no provider'); return { provider: globalThis.__152F.sandbox, providerName: ctx.provider ?? 'docusign', resolvedScope: 'brokerage', isDefault: false } }",
  "@/lib/agentic-os/connector-gateway": "export const PROVIDER_HEALTH_POLICY = {}; export const deriveProviderHealth = () => 'healthy'; export const loadProviderHealth = async () => null; export const callConnector = async (r) => { const b = globalThis.__152F.bytesByUrl.get(r.url); return b ? { ok: true, status: 200, data: Buffer.from(b), headers: {}, drift: null, error: null } : { ok: false, status: 404, data: null, headers: {}, drift: null, error: 'not found' } }",
  "@/lib/storage/document-buckets": "export const GENERATED_DOCUMENT_BUCKET = 'generated-documents'; export const PERSONAL_VIDEO_BUCKET = 'personal-videos'; export const bucketClassReason = () => null; export const isDocumentClassBucket = () => true; export const issueBucketObjectUrl = async (c, p) => ({ ok: true, url: 'https://x.supabase.co/storage/v1/object/sign/' + p.bucket + '/' + p.objectPath + '?token=fresh', kind: 'signed', ttlSeconds: 3600 })",
  "@/lib/documents/upload-document": "export const uploadDocument = async (p) => { const id = globalThis.crypto.randomUUID(); globalThis.__152F.uploads.push({ id, ...p }); globalThis.__152F.db.tables.documents.push({ id, brokerage_id: p.brokerageId, transaction_id: p.transactionId ?? null, storage_url: p.storageUrl, document_type: p.documentType, metadata: { file_name: p.fileName, ...(p.metadata ?? {}) }, signature_completeness: null }); return { success: true, documentId: id } }",
  "@/lib/compliance/agent-readiness-gate": "export const checkAgentTransactable = async () => globalThis.__152F.readiness",
  "@/lib/events/lifecycle-event-core": "export const recordLifecycleEvent = async (svc, brokerageId, input) => { globalThis.__152F.events.push({ brokerageId, ...input }); return { ok: true, eventId: 'e' + globalThis.__152F.events.length, deduped: false } }",
  "@/lib/kernel/manager-signals": "export const SIGNAL_HANDLERS = {}; export const consumeManagerSignals = async () => []; export const publishManagerSignal = async (input) => { const dup = input.entityId && globalThis.__152F.signals.some((s) => s.toManager === input.toManager && s.signalType === input.signalType && s.entityId === input.entityId); if (!dup) globalThis.__152F.signals.push(input); return { ok: true, signalId: 's' + globalThis.__152F.signals.length } }",
}
registerHooks({
  resolve(spec: string, ctx: any, next: any) {
    const stub = STUBS[spec]
    if (stub !== undefined) return { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
    return next(spec, ctx)
  },
})

// ── ids ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const B = "11111111-1111-4111-8111-111111111111"
const U_AGENT = "a0000000-0000-4000-8000-000000000001", U_OTHER = "a0000000-0000-4000-8000-000000000002", U_BROKER = "a0000000-0000-4000-8000-000000000003"
const AG = "b0000000-0000-4000-8000-000000000001", AG_OTHER = "b0000000-0000-4000-8000-000000000002"
const BUYER = "c0000000-0000-4000-8000-0000000000b1", SELLER = "c0000000-0000-4000-8000-0000000000c1", BUYER2 = "c0000000-0000-4000-8000-0000000000b2"
const OFFER = "d0000000-0000-4000-8000-000000000001", OFFER_OUT = "d0000000-0000-4000-8000-000000000002"
const TXN = "e0000000-0000-4000-8000-000000000001"
const DOC_UNSIGNED = "f0000000-0000-4000-8000-000000000001", DOC_UNSIGNED_OUT = "f0000000-0000-4000-8000-000000000002"
const DOC_COUNTER_BOTH = "f0000000-0000-4000-8000-000000000003", DOC_COUNTER_BUYER_ONLY = "f0000000-0000-4000-8000-000000000004"
const DOC_UNSIGNED_COMM = "f0000000-0000-4000-8000-000000000005"
const LA_EMAIL = "listing.agent@otherbrokerage.example"

function makeSandbox() {
  const recipients = new Map<string, Array<{ name: string; email: string; role: string }>>()
  const signed = new Map<string, Set<string>>()
  let seq = 0
  const sb = {
    calls: [] as Array<[string, any]>, failSend: false, failVoid: false, recipients, signed,
    sign(env: string, email: string) { const s = signed.get(env) ?? new Set<string>(); s.add(email); signed.set(env, s) },
    async createTransaction(req: any) { sb.calls.push(["create", req]); return { success: true, externalTransactionId: `ENV-${++seq}` } },
    async attachForms(req: any) { sb.calls.push(["attach", req]); return { success: true, attachedCount: req.forms.length } },
    async sendForSignature(req: any) { sb.calls.push(["send", req]); if (sb.failSend) return { success: false, error: "DocuSign sendEnvelope 400: INVALID_EMAIL_ADDRESS_FOR_RECIPIENT" }; recipients.set(req.externalTransactionId, req.signers); return { success: true } },
    async getSignatureStatus(env: string) { const r = recipients.get(env) ?? []; const s = signed.get(env) ?? new Set(); const n = r.filter((x) => s.has(x.email)).length; return { success: true, total: r.length, signed: n, pending: r.length - n, percentComplete: r.length ? Math.round((n / r.length) * 100) : 0 } },
    async syncDocuments(req: any) {
      const env = req.externalTransactionId; const r = recipients.get(env) ?? []; const s = signed.get(env) ?? new Set()
      const all = r.length > 0 && r.every((x) => s.has(x.email))
      return { success: true, documents: [{ externalDocumentId: `${env}-doc`, documentName: "Addendum.pdf", folderName: "", isSigned: all, url: all ? `https://provider.example/${env}/signed.pdf` : undefined, signers: r.map((x) => ({ name: x.name, email: x.email, role: x.role, signedAt: s.has(x.email) ? "2026-11-10T15:00:00.000Z" : undefined })) }] }
    },
    async voidTransaction(req: any) { sb.calls.push(["void", req]); return sb.failVoid ? { success: false, error: "envelope already completed" } : { success: true } },
    async uploadDocument() { return { success: false } }, async listForms() { return { success: true, forms: [] } },
    count: (k: string) => sb.calls.filter((c) => c[0] === k).length,
  }
  return sb
}

function seed(): MemClient {
  const mem = memSupabase({
    brokerages: [{ id: B, name: "Test Realty" }],
    users: [
      { id: U_AGENT, brokerage_id: B, user_type: "agent", email: "agent@testrealty.example" },
      { id: U_OTHER, brokerage_id: B, user_type: "agent", email: "other@testrealty.example" },
      { id: U_BROKER, brokerage_id: B, user_type: "broker", email: "broker@testrealty.example" },
    ],
    agents: [{ id: AG, user_id: U_AGENT, brokerage_id: B, status: "active" }, { id: AG_OTHER, user_id: U_OTHER, brokerage_id: B, status: "active" }],
    contacts: [
      { id: BUYER, brokerage_id: B, first_name: "Bea", last_name: "Buyer", email: "bea.buyer@mail.example" },
      { id: SELLER, brokerage_id: B, first_name: "Sam", last_name: "Seller", email: "sam.seller@mail.example" },
      { id: BUYER2, brokerage_id: B, first_name: "Nora", last_name: "NoEmail", email: null },
    ],
    offers: [
      { id: OFFER, brokerage_id: B, agent_id: AG, contact_id: BUYER, listing_id: null, parent_offer_id: null, offer_type: "standard", current_round: 1, status: "accepted", property_address: "12 Oak St", transaction_id: TXN, metadata: {}, created_at: "2026-10-01T00:00:00Z" },
      { id: OFFER_OUT, brokerage_id: B, agent_id: AG, contact_id: BUYER, listing_id: null, parent_offer_id: null, offer_type: "standard", current_round: 1, status: "accepted", property_address: "9 Elm Rd", transaction_id: null, created_at: "2026-10-02T00:00:00Z",
        metadata: { outside_listing_agent_email: LA_EMAIL, outside_listing_agent_name: "Lena Lister", outside_loop: { counterparty: { email: LA_EMAIL, verified_by: "mls_published" } } } },
    ],
    transactions: [{ id: TXN, brokerage_id: B, agent_id: AG, offer_id: OFFER, buyer_contact_id: BUYER, seller_contact_id: SELLER, property_address: "12 Oak St", property_state: "TX", contract_date: "2026-10-01", contract_closing_date: "2026-12-01", stage: "under_contract" }],
    transaction_participants: [{ id: "tp-1", brokerage_id: B, transaction_id: TXN, role: "buyer_attorney", name: "Ada Attorney", email: "ada@lawfirm.example" }],
    contract_term_versions: [
      { id: "ctv-offer-1", brokerage_id: B, root_offer_id: OFFER, transaction_id: TXN, offer_id: OFFER, document_id: null, version_no: 1, source: "offer", status: "executed", terms: { purchase_price: 500000, closing_date: "2026-12-01" }, executed_at: "2026-10-01T12:00:00Z", recorded_by: U_AGENT, evidence: {}, created_at: "2026-10-01T12:00:00Z" },
      { id: "ctv-offer-2", brokerage_id: B, root_offer_id: OFFER_OUT, transaction_id: null, offer_id: OFFER_OUT, document_id: null, version_no: 1, source: "offer", status: "executed", terms: { purchase_price: 410000, closing_date: "2026-12-15" }, executed_at: "2026-10-02T12:00:00Z", recorded_by: U_AGENT, evidence: {}, created_at: "2026-10-02T12:00:00Z" },
    ],
    documents: [
      { id: DOC_UNSIGNED, brokerage_id: B, transaction_id: TXN, storage_url: "https://x.supabase.co/storage/v1/object/sign/documents/b/c/unsigned.pdf?token=old", metadata: { file_name: "Closing date addendum.pdf" }, signature_completeness: null },
      { id: DOC_UNSIGNED_OUT, brokerage_id: B, transaction_id: null, storage_url: "https://x.supabase.co/storage/v1/object/sign/documents/b/c/unsigned-out.pdf?token=old", metadata: { file_name: "Repair credit addendum.pdf" }, signature_completeness: null },
      { id: DOC_UNSIGNED_COMM, brokerage_id: B, transaction_id: TXN, storage_url: "https://x.supabase.co/storage/v1/object/sign/documents/b/c/comm.pdf?token=old", metadata: { file_name: "Commission addendum.pdf" }, signature_completeness: null },
      { id: DOC_COUNTER_BOTH, brokerage_id: B, transaction_id: null, storage_url: "https://x.supabase.co/storage/v1/object/sign/documents/b/c/countersigned.pdf?token=t", metadata: { file_name: "Countersigned.pdf" }, signature_completeness: { signatures: [{ signer_role: "buyer", signed: true }, { signer_role: "seller", signed: true }] } },
      { id: DOC_COUNTER_BUYER_ONLY, brokerage_id: B, transaction_id: null, storage_url: "https://x.supabase.co/storage/v1/object/sign/documents/b/c/buyer-only.pdf?token=t", metadata: { file_name: "Buyer only.pdf" }, signature_completeness: { signatures: [{ signer_role: "buyer", signed: true }] } },
    ],
    signature_requests: [], notifications: [], agent_action_ledger: [], document_field_extractions: [],
  }, { uuidIds: true, stampCreatedAt: true })
  ;(mem as any).storage = { from: (bucket: string) => ({ upload: async (path: string) => ({ data: { path, bucket }, error: null }) }) }
  return mem
}

const asAgent = (uid = U_AGENT, userType = "agent") => ({ ok: true, userId: uid, brokerageId: B, userType, platformRole: null, teamId: null })
const API_CHOICE = { ok: true, kind: "api", providerName: "docusign", resolved: null as any }

async function main() {
  const R = await import("../lib/esign/addendum-signature-rules")
  const C = await import("../lib/esign/addendum-signature-request")
  const D = await import("../app/actions/buyer-offer/request-addendum-signatures")
  const L = await import("../lib/forms/esign-execution-loop")
  const T = await import("../lib/offers/governing-terms")
  const { recordContractTermsVersion } = T
  const { CHECK_VOCABULARIES } = await import("./check-vocabularies")

  // ═══ A · THE RULES, PURE ═══════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n[A · the rules, pure: vocabulary, ladder, provider words, signer routing, required signatures, tenant words]")
  const mig = raw("supabase/migrations/m953-addendum-signature-requests-on-the-proposed-version.sql")
  const migBody = mig.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
  const checkVals = [...(/signature_requests_request_status_check\s*CHECK\s*\(\s*request_status\s+IN\s*\(([^)]*)\)/s.exec(migBody)?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1])
  const indexVals = [...(/signature_requests_one_live_per_version_uidx[\s\S]*?request_status\s+IN\s*\(([^)]*)\)/.exec(migBody)?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1])
  const live = (CHECK_VOCABULARIES as any).signature_requests?.request_status as string[] | undefined
  check("THE VOCABULARY: SIGNATURE_REQUEST_STATUSES is exactly m953's CHECK, and every live CHECK value is still in it (the migration only ADDS)",
    JSON.stringify([...R.SIGNATURE_REQUEST_STATUSES].sort()) === JSON.stringify([...checkVals].sort()) && !!live && live.every((v) => (R.SIGNATURE_REQUEST_STATUSES as readonly string[]).includes(v)),
    `code=${R.SIGNATURE_REQUEST_STATUSES.join(",")} m953=${checkVals.join(",")} live=${live?.join(",")}`)
  const fcc = code("lib/transactions/final-compliance-check.ts")
  const fccOpen = [...(/from\("signature_requests"\)[\s\S]{0,200}?\.in\("request_status",\s*\[([^\]]*)\]/.exec(fcc)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1])
  check("THE OPEN SET is m953's one-live-per-proposal index AND covers every status final-compliance-check counts as an open closing item (an addendum out for signature blocks the close)",
    JSON.stringify([...R.LIVE_SIGNATURE_REQUEST_STATUSES].sort()) === JSON.stringify([...indexVals].sort()) && fccOpen.length > 0 && fccOpen.every((s) => (R.LIVE_SIGNATURE_REQUEST_STATUSES as readonly string[]).includes(s)) && (R.LIVE_SIGNATURE_REQUEST_STATUSES as readonly string[]).every((s) => fccOpen.includes(s)),
    `index=${indexVals.join(",")} final-compliance=${fccOpen.join(",")}`)
  const adv = R.canAdvanceSignatureRequest
  check("THE LADDER: up only; equal is a no-op; a completed request is never voided; a terminal outcome is never overwritten; any live request may fail",
    adv("pending", "sent").ok && adv("sent", "partially_signed").ok && adv("partially_signed", "completed").ok && (adv("sent", "sent") as any).noop === true
    && !adv("completed", "cancelled").ok && !adv("declined", "sent").ok && !adv("partially_signed", "sent").ok && adv("sent", "declined").ok && adv("pending", "failed").ok && !adv("sent", "bogus" as any).ok)
  const pe = R.providerEventOutcome
  check("PROVIDER WORDS: voided → cancelled (the survivor's spelling); declined / expired terminal; a bounce fails; delivered / viewed are STAMPS (the status stays sent); a completion word decides nothing by itself",
    pe("envelope-voided", "voided").to === "cancelled" && pe("envelope-declined", null).to === "declined" && pe(null, "expired").to === "expired" && pe("recipient-autoresponded", null).to === "failed"
    && pe("recipient-delivered", "sent").stamp === "delivered_at" && pe("envelope-viewed", null).stamp === "viewed_at" && pe("envelope-delivered", null).to === null && pe("envelope-completed", "completed").to === null && pe("recipient-completed", null).stamp === null)
  const base = {
    representedSides: ["buyer", "seller"] as Array<"buyer" | "seller">,
    principals: [{ side: "buyer", role: "buyer", name: "Bea Buyer", email: "bea@mail.example", source: "contact" }, { side: "seller", role: "seller", name: "Sam Seller", email: "sam@mail.example", source: "contact" }] as any[],
    counterpartyAgents: [], attorneys: [{ name: "Ada", email: "ada@law.example", role: "buyer_attorney" }], includeAttorneys: true, changedTermKeys: ["closing_date"],
    senderEmail: "agent@testrealty.example", brokerApproval: null, senderMayApproveCommission: false, confirmedCounterpartyAgent: false,
  }
  const both = R.planAddendumSignatureRouting(base)
  check("ROUTING — both sides ours: both principals sign in our envelope in order (buyer 1, seller 2); the attorney REVIEWS and is never a required party signature; sequential is stated, not assumed",
    both.ready && both.recipients.filter((r) => r.kind === "party_signature").map((r) => `${r.order}:${r.role}`).join(",") === "1:buyer,2:seller" && both.recipients.some((r) => r.kind === "attorney_review" && r.email === "ada@law.example")
    && both.required.length === 2 && both.required.every((r) => r.route === "envelope") && both.routed.length === 0 && both.signingOrder === "sequential")
  const outside = R.planAddendumSignatureRouting({ ...base, representedSides: ["buyer"], principals: [base.principals[0]], counterpartyAgents: [{ side: "seller", name: "Lena", email: LA_EMAIL, verified: true }], includeAttorneys: false })
  check("ROUTING — the seller is another brokerage's client: NEVER in our envelope; their signature is required and routed through their verified agent",
    outside.ready && outside.recipients.length === 1 && outside.recipients[0].role === "buyer" && outside.routed[0]?.agentEmail === LA_EMAIL && outside.required.some((r) => r.side === "seller" && r.route === "counterparty_agent"))
  const unverified = R.planAddendumSignatureRouting({ ...base, representedSides: ["buyer"], principals: [base.principals[0]], counterpartyAgents: [{ side: "seller", name: null, email: "who@else.example", verified: false }] })
  const confirmed = R.planAddendumSignatureRouting({ ...base, representedSides: ["buyer"], principals: [base.principals[0]], counterpartyAgents: [{ side: "seller", name: null, email: "who@else.example", verified: false }], confirmedCounterpartyAgent: true })
  check("ROUTING — an UNVERIFIED agent address holds the send until the sender confirms it", !unverified.ready && unverified.blockers.some((b) => b.code === "counterparty_unverified") && confirmed.ready)
  const noEmail = R.planAddendumSignatureRouting({ ...base, principals: [{ ...base.principals[0], email: null }, base.principals[1]] })
  check("ROUTING — a required signer with no address → REVIEW, in the contract's words (\"Select the required signing parties before sending this addendum.\")",
    !noEmail.ready && noEmail.blockers[0].code === "missing_signer" && noEmail.blockers[0].message.startsWith(R.SELECT_SIGNERS_MESSAGE) && R.SELECT_SIGNERS_MESSAGE === "Select the required signing parties before sending this addendum.")
  const selfSign = R.planAddendumSignatureRouting({ ...base, principals: [{ ...base.principals[0], email: "agent@testrealty.example" }, base.principals[1]] })
  const dup = R.planAddendumSignatureRouting({ ...base, principals: [base.principals[0], { ...base.principals[1], email: "bea@mail.example" }] })
  check("ROUTING — NOBODY SIGNS FOR A CLIENT: the sender's own address as a principal's is refused; one address cannot sign for two parties",
    selfSign.blockers.some((b) => b.code === "sender_is_signer") && !selfSign.ready && dup.blockers.some((b) => b.code === "duplicate_signer") && !dup.ready)
  const comm = R.planAddendumSignatureRouting({ ...base, changedTermKeys: ["buyer_agent_commission_pct"] })
  const commAdmin = R.planAddendumSignatureRouting({ ...base, changedTermKeys: ["buyer_agent_commission_pct"], senderMayApproveCommission: true })
  const commApproved = R.planAddendumSignatureRouting({ ...base, changedTermKeys: ["commission_payer"], brokerApproval: { approvedBy: U_BROKER, approvedAt: "2026-11-10T00:00:00Z" } })
  check("ROUTING — BROKER APPROVAL ≠ A PARTY SIGNATURE: a commission change is HELD for the broker (hold-for-human), satisfied by a finance admin's own send or a recorded approval — and never adds a signer",
    !comm.ready && comm.blockers.some((b) => b.code === "broker_approval_required") && commAdmin.ready && commApproved.ready && comm.recipients.length === both.recipients.length)
  const nobody = R.planAddendumSignatureRouting({ ...base, representedSides: [], principals: [] })
  check("ROUTING — a contract this brokerage represents nobody on is refused (no client to send to)", !nobody.ready && nobody.blockers.some((b) => b.code === "no_represented_party"))
  const rq = both.required
  const partial = R.requiredSignaturesFrom(rq, [{ email: "bea@mail.example", signedAt: "x" }, { email: "sam@mail.example", signedAt: null }], false)
  const full = R.requiredSignaturesFrom(rq, [{ email: "BEA@mail.example", signedAt: "x" }, { email: "sam@mail.example", signedAt: "y" }], false)
  const viaCount = R.requiredSignaturesFrom(rq, [], true)
  const routedRead = R.requiredSignaturesFrom(outside.required, [{ email: "bea@mail.example", signedAt: "x" }], true)
  check("REQUIRED SIGNATURES: a partial envelope is not complete; addresses match case-insensitively; the provider's own count stands in only when it lists no signers; a routed side is never satisfied by our envelope",
    !partial.envelopeComplete && partial.missing.length === 1 && full.envelopeComplete && viaCount.envelopeComplete && routedRead.envelopeComplete && routedRead.missing.some((r) => r.route === "counterparty_agent"))
  const words = R.SIGNATURE_REQUEST_STATUSES.map((s) => R.describeAddendumRequest(s, { failure: "the e-sign provider did not accept it" }))
  check("TENANT WORDS: every status has a plain sentence; none names a vendor, a credential, a table or an HTTP code; a hand-off never says it was sent",
    words.every((w) => w.label && !/docusign|dotloop|skyslope|authentisign|signature_requests|contract_term_versions|api[_ ]?key|token|\b[45]\d\d\b/i.test(`${w.label} ${w.detail} ${w.action ?? ""}`))
    && /nothing was sent/i.test(R.describeAddendumRequest("pending", { handoff_mode: "download" }).detail) && !/^sent/i.test(R.describeAddendumRequest("pending", { handoff_mode: "download" }).label))

  // ═══ B · THE DOOR, END TO END ════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n[B · the door: propose → review → send through the REAL dispatch core → the sandbox provider; wrong actor; missing signer; replay]")
  G.__152F.db = seed()
  G.__152F.sandbox = makeSandbox()
  API_CHOICE.resolved = { provider: G.__152F.sandbox, providerName: "docusign", resolvedScope: "brokerage", isDefault: false }
  G.__152F.choice = API_CHOICE
  const db = () => G.__152F.db as MemClient
  const sb = () => G.__152F.sandbox as ReturnType<typeof makeSandbox>
  G.__152F.caller = asAgent()
  const proposed = await quiet(() => D.proposeContractAddendum({ transactionId: TXN, kind: "addendum", documentId: DOC_UNSIGNED, terms: { closing_date: "2026-12-20" }, effectiveOn: "2026-11-12",
    termEvidence: { closing_date: { page: 1, field: "Closing Date", quote: "Closing shall occur on or before December 20, 2026" } } }))
  const pRow = db().tables.contract_term_versions.find((v) => v.id === proposed.versionId)
  check("PROPOSE: the door records a PROPOSED addendum through the ONE recorder (status proposed, the unsigned document on it) — it does not govern",
    proposed.success && pRow?.status === "proposed" && pRow?.source === "addendum" && pRow?.document_id === DOC_UNSIGNED && pRow?.evidence?.recorded_via === "propose_contract_addendum", JSON.stringify(proposed))
  const govBefore = await T.governingContractTerms(db() as any, B, { transactionId: TXN })
  check("…and the contract still says what it said: the governing closing date is unchanged, the proposal is listed as PENDING",
    govBefore.ok && govBefore.governing.values.closing_date === "2026-12-01" && govBefore.governing.pending.length === 1)
  G.__152F.caller = asAgent(U_OTHER)
  const wrong = await quiet(() => D.requestAddendumSignatures({ versionId: proposed.versionId! }))
  const wrongReview = await quiet(() => D.reviewAddendumSignatureRequest({ versionId: proposed.versionId! }))
  check("WRONG ACTOR BLOCKED: another agent of the same brokerage cannot review or send it — nothing written, nothing reached the provider",
    !wrong.success && /contract's agent or a brokerage admin/.test(wrong.error ?? "") && !wrongReview.success && db().tables.signature_requests.length === 0 && sb().count("create") === 0)
  G.__152F.caller = { ok: false, reason: "unauthenticated", error: "Unauthorized" }
  const anon = await quiet(() => D.requestAddendumSignatures({ versionId: proposed.versionId! }))
  check("NO SESSION, NO DOOR: the gate refuses before the service client is touched", !anon.success && anon.error === "Unauthorized" && sb().count("create") === 0)
  G.__152F.caller = asAgent()
  const review = await quiet(() => D.reviewAddendumSignatureRequest({ versionId: proposed.versionId!, choices: { includeAttorneys: true } }))
  check("REVIEW: buyer then seller from the deal's own contacts, the deal's attorney copied for review, a connected e-sign route — and nothing written",
    !!review.review && review.review.plan.ready && review.review.plan.recipients.filter((r) => r.kind === "party_signature").map((r) => r.email).join(",") === "bea.buyer@mail.example,sam.seller@mail.example"
    && review.review.plan.recipients.some((r) => r.kind === "attorney_review") && review.review.provider.state === "connected" && db().tables.signature_requests.length === 0, JSON.stringify(review.error ?? review.review?.plan.blockers))
  const sent = await quiet(() => D.requestAddendumSignatures({ versionId: proposed.versionId!, choices: { includeAttorneys: false } }))
  const reqRow = db().tables.signature_requests.find((r) => r.id === sent.requestId)
  const sendCall = sb().calls.find((c) => c[0] === "send")?.[1]
  const attachCall = sb().calls.find((c) => c[0] === "attach")?.[1]
  check("SEND: the REAL dispatch core cut ONE envelope on the sandbox provider with the right parties in order, attached the addendum by a FRESH link (the stored one expires), and the request row says sent with the envelope",
    sent.success && sent.status === "sent" && sb().count("create") === 1 && sb().count("send") === 1 && sendCall?.signers?.map((s: any) => `${s.role}:${s.email}`).join(",") === "buyer:bea.buyer@mail.example,seller:sam.seller@mail.example"
    && /token=fresh/.test(attachCall?.forms?.[0]?.formUrl ?? "") && reqRow?.request_status === "sent" && reqRow?.provider_envelope_id === "ENV-1" && reqRow?.contract_term_version_id === proposed.versionId && reqRow?.transaction_id === TXN,
    JSON.stringify({ sent, calls: sb().calls.map((c) => c[0]) }))
  const ledger = db().tables.agent_action_ledger.find((r) => r.action === "contract.addendum_signatures.request")
  check("LAW 5 EVIDENCE: the send is ledgered (who: the agent; what: contract.addendum_signatures.request; which provider + envelope; risk LEGAL) and the lifecycle event names the proposal and the request",
    !!ledger && ledger.status === "executed" && ledger.provider === "docusign" && ledger.provider_ref === "ENV-1" && G.__152F.events.some((e: any) => e.event_type === "contract_sent_for_signature" && e.payload?.signature_request_id === sent.requestId),
    JSON.stringify(ledger))
  const replay = await quiet(() => D.requestAddendumSignatures({ versionId: proposed.versionId! }))
  check("REPLAY: sending again returns the request already out — the same id, NO second envelope, no second row", replay.success && replay.replayed === true && replay.requestId === sent.requestId && sb().count("create") === 1 && db().tables.signature_requests.length === 1)
  // the race the pre-check cannot see: a second claim lands while the first is in flight → m953's unique index (modelled) → 23505
  {
    const raceDb = seed()
    const prop = await quiet(() => C.proposeContractAddendumVersion(raceDb as any, { userId: U_AGENT, brokerageId: B, userType: "agent", teamId: null }, { ref: { transactionId: TXN }, kind: "addendum", documentId: DOC_UNSIGNED, terms: { closing_date: "2026-12-22" }, effectiveOn: null, termEvidence: null }))
    const vId = prop.ok ? prop.versionId : ""
    raceDb.tables.signature_requests.push({ id: "11111111-2222-4333-8444-555555555555", brokerage_id: B, contract_term_version_id: vId, request_status: "sent", provider_envelope_id: "ENV-RACE", evidence: {}, created_at: "2026-11-10T00:00:00Z" })
    let hidden = true
    const racy = new Proxy(raceDb as any, { get(t, k) {
      if (k !== "from") return t[k]
      return (table: string) => {
        if (table === "signature_requests" && hidden) {
          hidden = false // the pre-check reads before the other request's row is visible
          const empty: any = new Proxy({}, { get: (_o, p) => (p === "then" ? (res: any) => Promise.resolve({ data: [], error: null }).then(res) : () => empty) })
          return empty
        }
        return t.from(table)
      }
    } })
    const uniqDb = memSupabase(raceDb.tables, { uuidIds: true, stampCreatedAt: true, unique: { signature_requests: [["contract_term_version_id"]] } })
    const racyU = new Proxy(uniqDb as any, { get(t, k) { if (k !== "from") return t[k]; return (table: string) => (table === "signature_requests" && hidden ? (racy as any).from(table) : t.from(table)) } })
    hidden = true
    const sb2 = makeSandbox()
    const raced = await quiet(() => C.requestAddendumSignatures(racyU, { userId: U_AGENT, brokerageId: B, userType: "agent", teamId: null }, { versionId: vId }, {
      esignChoice: async () => ({ ok: true, kind: "api", providerName: "docusign" }), readiness: async () => ({ transactable: true, blockers: [], message: null }),
      dispatch: async () => { sb2.calls.push(["create", {}]); return { ok: true, status: "sent", envelopeId: "ENV-X" } }, documentUrl: async (_s, u) => u, event: async () => ({}),
    }))
    check("REPLAY RACE: when the pre-check misses a concurrent request, the claim is refused 23505 (m953's one-live-per-proposal index) and the request already out is returned — the provider is never called",
      raced.ok && raced.replayed === true && raced.requestId === "11111111-2222-4333-8444-555555555555" && sb2.calls.length === 0, JSON.stringify(raced))
  }

  // ═══ C · THE CALLBACK ═══════════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n[C · the callback through the real webhook loop: progress stamps, partial ≠ executed, verified completion, replay-safe]")
  const env1 = "ENV-1"
  const prog = await quiet(() => L.recordEnvelopeProgress(db(), { provider: "docusign", envelopeId: env1, event: "recipient-delivered", status: "sent" }))
  const prog2 = await quiet(() => L.recordEnvelopeProgress(db(), { provider: "docusign", envelopeId: env1, event: "recipient-delivered", status: "sent" }))
  const afterProg = db().tables.signature_requests.find((r) => r.id === sent.requestId)
  check("DELIVERED is a stamp, once: the request stays `sent`, the first instant stands on a redelivery (changed: false)",
    prog.matched && prog.changed && !prog2.changed && afterProg?.request_status === "sent" && !!afterProg?.evidence?.delivered_at)
  const progOther = await quiet(() => L.recordEnvelopeProgress(db(), { provider: "docusign", envelopeId: "ENV-NOT-OURS", event: "recipient-delivered", status: "sent" }))
  check("…an envelope that is not an addendum request is untouched by the progress hook (matched: false — the route falls through to `ignored` as before)", !progOther.matched)
  sb().sign(env1, "bea.buyer@mail.example")
  const partialRun = await quiet(() => L.evaluateEnvelopeExecution(db(), { brokerageId: B, providerSource: "docusign", externalEnvelopeId: env1 }))
  const afterPartial = db().tables.signature_requests.find((r) => r.id === sent.requestId)
  check("PARTIAL ≠ EXECUTED: one signer done (DocuSign's recipient-completed) moves the request to partially_signed and records NO executed version; the proposal stays proposed",
    partialRun.evaluated && !partialRun.fullyExecuted && afterPartial?.request_status === "partially_signed" && !db().tables.contract_term_versions.some((v) => v.status === "executed" && v.source === "addendum") && db().tables.contract_term_versions.find((v) => v.id === proposed.versionId)?.status === "proposed")
  sb().sign(env1, "sam.seller@mail.example")
  const signedBytes = new TextEncoder().encode("%PDF-1.7 signed addendum ENV-1 — both parties")
  G.__152F.bytesByUrl.set(`https://provider.example/${env1}/signed.pdf`, signedBytes)
  const done = await quiet(() => L.evaluateEnvelopeExecution(db(), { brokerageId: B, providerSource: "docusign", externalEnvelopeId: env1 }))
  const execRows = db().tables.contract_term_versions.filter((v) => v.status === "executed" && v.source === "addendum")
  const finalReq = db().tables.signature_requests.find((r) => r.id === sent.requestId)
  const signedDoc = db().tables.documents.find((d) => d.id === execRows[0]?.document_id)
  check("COMPLETION: every signer done → the signed copy retrieved, hashed (sha256 pinned) and filed; the EXECUTED version recorded through the ONE recorder from THAT copy; the request completed with the version; the proposal closed as executed",
    done.fullyExecuted && execRows.length === 1 && execRows[0].evidence?.recorded_via === "addendum_signature_request" && execRows[0].evidence?.signed_sha256 === sha(signedBytes)
    && finalReq?.request_status === "completed" && finalReq?.evidence?.executed_version_no === execRows[0].version_no && finalReq?.evidence?.signed_sha256 === sha(signedBytes)
    && db().tables.contract_term_versions.find((v) => v.id === proposed.versionId)?.status === "void" && db().tables.contract_term_versions.find((v) => v.id === proposed.versionId)?.evidence?.closed_as === "executed",
    JSON.stringify({ done, finalStatus: finalReq?.request_status, refused: finalReq?.evidence?.record_refused_detail }))
  const ev0 = (execRows[0]?.evidence ?? {}) as Record<string, any>
  check("LOCATED EVIDENCE CARRIED (152E's hold): the executed version carries evidence.effective_on and the per-term page / field / quote stated on the proposal (term_evidence_stated → term_evidence), so no changed term is left unlocated",
    ev0.effective_on === "2026-11-12" && !!ev0.term_evidence?.closing_date && JSON.stringify(ev0.term_evidence.closing_date).includes("Closing Date") && JSON.stringify(ev0.term_evidence.closing_date).includes("December 20, 2026") && !ev0.term_evidence_unlocated,
    JSON.stringify({ effective_on: ev0.effective_on, term_evidence: ev0.term_evidence, unlocated: ev0.term_evidence_unlocated }))
  check("…the signatures on that copy are the PROVIDER's attestation, per signer, named as such (never inferred)",
    signedDoc?.signature_completeness?.source === "esign_provider_attested" && signedDoc?.signature_completeness?.signatures?.map((s: any) => s.signer_role).sort().join(",") === "buyer,seller" && signedDoc?.signature_completeness?.signatures?.every((s: any) => s.source === "esign_provider" && s.envelope_id === env1))
  const govAfter = await T.governingContractTerms(db() as any, B, { transactionId: TXN })
  const txAfter = db().tables.transactions.find((t) => t.id === TXN)
  check("GOVERNING TERMS REASSESSED: the contract now says 2026-12-20, governed by the executed addendum (the original offer's value superseded, kept on file); nothing is pending",
    govAfter.ok && govAfter.governing.values.closing_date === "2026-12-20" && govAfter.governing.governingVersion?.source === "addendum" && govAfter.governing.pending.length === 0 && govAfter.governing.conflicts.some((c: any) => c.key === "closing_date"))
  check("CLOSING RECHECK + PARTICIPANTS TOLD: the executed change moved the deal's CONTRACTUAL closing date through the governed writer and the deal team was notified of the executed change",
    txAfter?.contract_closing_date === "2026-12-20" && db().tables.notifications.some((n) => n.type === "contract_change_executed") && db().tables.notifications.some((n) => n.type === "esign.addendum.completed"),
    JSON.stringify({ closing: txAfter?.contract_closing_date, types: [...new Set(db().tables.notifications.map((n) => n.type))] }))
  const bellsBefore = db().tables.notifications.length
  const replayDone = await quiet(() => L.evaluateEnvelopeExecution(db(), { brokerageId: B, providerSource: "docusign", externalEnvelopeId: env1 }))
  check("REPLAYED COMPLETION: a redelivered webhook records nothing twice — one executed version, one filed copy, no new bell",
    replayDone.evaluated && db().tables.contract_term_versions.filter((v) => v.status === "executed" && v.source === "addendum").length === 1 && G.__152F.uploads.length === 1 && db().tables.notifications.length === bellsBefore)
  const tenantOf = await quiet(() => L.resolveEnvelopeBrokerageId(db(), env1))
  check("THE WEBHOOK FINDS THE TENANT: an addendum envelope resolves through its signature request (it used to resolve nothing and park as a dead letter)", tenantOf === B)

  // ═══ D · A SIDE ANOTHER BROKERAGE REPRESENTS ═════════════════════════════════════════════════════════════════════════════
  console.log("\n[D · outside listing: routed through the listing agent; altered copy refused; the counter-signed copy executes]")
  const pOut = await quiet(() => D.proposeContractAddendum({ offerId: OFFER_OUT, kind: "addendum", documentId: DOC_UNSIGNED_OUT, terms: { closing_cost_contribution: 2500 }, effectiveOn: null,
    termEvidence: { closing_cost_contribution: { page: 1, field: "Seller Credit", quote: "Seller shall credit Buyer $2,500 at closing" } } }))
  const rOut = await quiet(() => D.reviewAddendumSignatureRequest({ versionId: pOut.versionId! }))
  check("OUTSIDE LISTING: our buyer signs in our envelope; the seller is routed through the MLS-verified listing agent — the seller is never in our envelope",
    pOut.success && !!rOut.review && rOut.review.plan.ready && rOut.review.plan.recipients.length === 1 && rOut.review.plan.recipients[0].email === "bea.buyer@mail.example" && rOut.review.plan.routed[0]?.agentEmail === LA_EMAIL && rOut.review.plan.routed[0]?.verified === true,
    JSON.stringify(rOut.error ?? rOut.review?.plan))
  const sOut = await quiet(() => D.requestAddendumSignatures({ versionId: pOut.versionId! }))
  const envOut = db().tables.signature_requests.find((r) => r.id === sOut.requestId)?.provider_envelope_id as string
  sb().sign(envOut, "bea.buyer@mail.example")
  const outBytes = new TextEncoder().encode("%PDF-1.7 buyer-signed addendum OUT")
  G.__152F.bytesByUrl.set(`https://provider.example/${envOut}/signed.pdf`, outBytes)
  await quiet(() => L.evaluateEnvelopeExecution(db(), { brokerageId: B, providerSource: "docusign", externalEnvelopeId: envOut }))
  const outReq = db().tables.signature_requests.find((r) => r.id === sOut.requestId)
  check("OUR SIDE DONE ≠ EXECUTED: the buyer-signed copy is pinned and the request waits on the other side (partially_signed, awaiting their agent) — no executed version",
    outReq?.request_status === "partially_signed" && outReq?.evidence?.awaiting === "counterparty_agent" && outReq?.evidence?.signed_sha256 === sha(outBytes)
    && !db().tables.contract_term_versions.some((v) => v.status === "executed" && v.root_offer_id === OFFER_OUT && v.source === "addendum"))
  G.__152F.bytesByUrl.set(`https://provider.example/${envOut}/signed.pdf`, new TextEncoder().encode("%PDF-1.7 buyer-signed addendum OUT — EDITED after signing"))
  const altered = await quiet(() => C.syncAddendumSignatureRequest(db() as any, { brokerageId: B, requestId: sOut.requestId!, source: "webhook" }))
  check("ALTERED SIGNED PDF: a copy whose hash differs from the one first retrieved is REFUSED and FLAGGED to compliance — the pinned copy stands, nothing recorded",
    !altered.ok && (altered as any).integrity === "mismatch" && db().tables.signature_requests.find((r) => r.id === sOut.requestId)?.evidence?.signed_sha256 === sha(outBytes)
    && G.__152F.signals.some((s: any) => s.signalType === "addendum_signed_copy_mismatch" && s.toManager === "compliance_officer"))
  const buyerOnly = await quiet(() => D.fileSignedAddendumCopy({ requestId: sOut.requestId!, documentId: DOC_COUNTER_BUYER_ONLY, executedOn: "2026-11-10" }))
  check("A FILED COPY WITHOUT THE SELLER'S SIGNATURE is not executed — the recorder's reason comes back and the request does not move",
    !buyerOnly.success && /seller/.test(buyerOnly.error ?? "") && db().tables.signature_requests.find((r) => r.id === sOut.requestId)?.request_status === "partially_signed", JSON.stringify(buyerOnly))
  const counter = await quiet(() => D.fileSignedAddendumCopy({ requestId: sOut.requestId!, documentId: DOC_COUNTER_BOTH, executedOn: "2026-11-10" }))
  const govOut = await T.governingContractTerms(db() as any, B, { offerId: OFFER_OUT })
  check("THE COUNTER-SIGNED COPY returned through their agent executes it: the version is recorded from that copy, the request completes, the governing seller credit (closing_cost_contribution) is 2500",
    counter.success && counter.executed === true && db().tables.signature_requests.find((r) => r.id === sOut.requestId)?.request_status === "completed" && govOut.ok && govOut.governing.values.closing_cost_contribution === 2500,
    JSON.stringify(counter))

  // ═══ E · FAILURE AND RECOVERY ════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n[E · send failure; no e-sign connection; download hand-off; declined; void; broker approval; readiness; the recheck seam]")
  G.__152F.db = seed(); G.__152F.sandbox = makeSandbox(); API_CHOICE.resolved = { provider: G.__152F.sandbox, providerName: "docusign" }; G.__152F.caller = asAgent()
  const p2 = await quiet(() => D.proposeContractAddendum({ transactionId: TXN, kind: "amendment", documentId: DOC_UNSIGNED, terms: { closing_date: "2026-12-28" }, effectiveOn: null }))
  sb().failSend = true
  const failedSend = await quiet(() => D.requestAddendumSignatures({ versionId: p2.versionId!, choices: { includeAttorneys: false } }))
  const failedRow = db().tables.signature_requests.find((r) => r.id === failedSend.requestId)
  check("SEND FAILURE IS RECOVERABLE: the request is `failed` with a tenant-safe reason (the provider's raw error kept internal), retryable, the proposal still proposed",
    !failedSend.success && failedSend.state === "failed" && failedSend.retryable === true && failedRow?.request_status === "failed" && failedRow?.evidence?.failure === "the e-sign provider did not accept it"
    && /INVALID_EMAIL/.test(failedRow?.evidence?.failure_detail ?? "") && !/INVALID_EMAIL|DocuSign|400/.test(failedSend.error ?? "") && db().tables.contract_term_versions.find((v) => v.id === p2.versionId)?.status === "proposed")
  check("…and the failed send is ledgered as failed (LAW 5), not as executed", db().tables.agent_action_ledger.some((r) => r.action === "contract.addendum_signatures.request" && r.status === "failed"))
  sb().failSend = false
  const resend = await quiet(() => D.requestAddendumSignatures({ versionId: p2.versionId!, choices: { includeAttorneys: false } }))
  check("…a resend goes out as a NEW request (a failed request does not hold the proposal's one live slot)", resend.success && resend.status === "sent" && resend.requestId !== failedSend.requestId && db().tables.signature_requests.filter((r) => r.contract_term_version_id === p2.versionId).length === 2)
  // declined (terminal, through the real loop's terminal recorder)
  const env2 = db().tables.signature_requests.find((r) => r.id === resend.requestId)?.provider_envelope_id as string
  const term = await quiet(() => L.recordEnvelopeTerminalState(db(), { provider: "docusign", envelopeId: env2, state: "declined", reason: "declined" }))
  const lateView = await quiet(() => L.recordEnvelopeProgress(db(), { provider: "docusign", envelopeId: env2, event: "envelope-viewed", status: null }))
  check("DECLINED: the provider's decline lands on the request (terminal), the deal coordinator hears it, the proposal is untouched — a late `viewed` after it changes nothing",
    term.addenda === 1 && db().tables.signature_requests.find((r) => r.id === resend.requestId)?.request_status === "declined" && !lateView.changed
    && G.__152F.signals.some((s: any) => s.signalType === "addendum_signature_request_stopped" && s.toManager === "deal_coordinator") && db().tables.contract_term_versions.find((v) => v.id === p2.versionId)?.status === "proposed")
  // void: refused at the provider → still live; accepted → cancelled
  const third = await quiet(() => D.requestAddendumSignatures({ versionId: p2.versionId!, choices: { includeAttorneys: false } }))
  sb().failVoid = true
  const vFail = await quiet(() => D.voidAddendumSignatureRequest({ requestId: third.requestId!, reason: "price changed" }))
  check("VOID REFUSED AT THE PROVIDER: the request stays live and the sender is told it is still out (nothing is marked void that is not)",
    !vFail.success && /still out for signature/.test(vFail.error ?? "") && db().tables.signature_requests.find((r) => r.id === third.requestId)?.request_status === "sent")
  sb().failVoid = false
  const vOk = await quiet(() => D.voidAddendumSignatureRequest({ requestId: third.requestId!, reason: "price changed" }))
  check("VOID: voided AT THE PROVIDER first (the account that sent it), then recorded `cancelled` with the reason; ledgered",
    vOk.success && vOk.providerVoided === true && sb().count("void") === 2 && db().tables.signature_requests.find((r) => r.id === third.requestId)?.request_status === "cancelled"
    && db().tables.agent_action_ledger.some((r) => r.action === "contract.addendum_signatures.void" && r.status === "executed"))
  const withdrawn = await quiet(() => D.withdrawProposedAddendum({ versionId: p2.versionId!, reason: "terms changed — a revised addendum follows" }))
  check("A CHANGE AFTER SEND = void + a NEW proposal: the old proposal is withdrawn (void, kept in history), never edited", withdrawn.success && db().tables.contract_term_versions.find((v) => v.id === p2.versionId)?.status === "void" && db().tables.contract_term_versions.find((v) => v.id === p2.versionId)?.terms?.closing_date === "2026-12-28")
  // no e-sign connection
  const p3 = await quiet(() => D.proposeContractAddendum({ transactionId: TXN, kind: "addendum", documentId: DOC_UNSIGNED, terms: { closing_date: "2027-01-05" }, effectiveOn: null }))
  G.__152F.choice = { ok: false, error: "E-sign defaults to DocuSign, but no DocuSign connection was found for you, your team or your brokerage. Connect DocuSign (or another e-sign provider) in Settings → Integrations." }
  const before3 = db().tables.signature_requests.length, calls3 = sb().calls.length
  const rev3 = await quiet(() => D.reviewAddendumSignatureRequest({ versionId: p3.versionId! }))
  const noProv = await quiet(() => D.requestAddendumSignatures({ versionId: p3.versionId! }))
  check("NO E-SIGN CONNECTION: honest `connection required` — nothing written, nothing sent, no vendor or credential named, ONE action (an admin connects one, or download and hand off) — and a download link is offered",
    rev3.review?.provider.state === "connection_required" && !noProv.success && noProv.state === "connection_required" && db().tables.signature_requests.length === before3 && sb().calls.length === calls3
    && !/docusign|dotloop|credential|api key/i.test(noProv.error ?? "") && /Settings → Integrations/.test(noProv.error ?? "") && /Nothing was sent/.test(noProv.error ?? "") && /token=fresh/.test(rev3.review?.documentUrl ?? ""))
  const ho = await quiet(() => D.startAddendumSignatureHandoff({ versionId: p3.versionId! }))
  const hoRow = db().tables.signature_requests.find((r) => r.id === ho.requestId)
  check("DOWNLOAD AND HAND OFF: a pending request with no envelope and no provider — it says nothing was sent from the platform; it never reads as sent",
    ho.success && hoRow?.request_status === "pending" && !hoRow?.provider_envelope_id && hoRow?.evidence?.handoff_mode === "download" && /nothing was sent/i.test(ho.detail ?? "") && sb().calls.length === calls3)
  const hoFiled = await quiet(() => D.fileSignedAddendumCopy({ requestId: ho.requestId!, documentId: DOC_COUNTER_BOTH, executedOn: "2026-11-09" }))
  check("…the fully signed copy filed later executes it through the recorder (both signatures read on the document)", hoFiled.success && hoFiled.executed === true && db().tables.signature_requests.find((r) => r.id === ho.requestId)?.request_status === "completed", JSON.stringify(hoFiled))
  G.__152F.choice = API_CHOICE
  // broker approval (hold-for-human)
  const pc = await quiet(() => D.proposeContractAddendum({ transactionId: TXN, kind: "addendum", documentId: DOC_UNSIGNED_COMM, terms: { buyer_agent_commission_pct: 2.5 }, effectiveOn: null }))
  const heldSend = await quiet(() => D.requestAddendumSignatures({ versionId: pc.versionId!, choices: { includeAttorneys: false } }))
  const agentApprove = await quiet(() => D.approveAddendumForSignature({ versionId: pc.versionId! }))
  G.__152F.caller = asAgent(U_BROKER, "broker")
  const brokerApprove = await quiet(() => D.approveAddendumForSignature({ versionId: pc.versionId! }))
  G.__152F.caller = asAgent()
  const afterApprove = await quiet(() => D.requestAddendumSignatures({ versionId: pc.versionId!, choices: { includeAttorneys: false } }))
  check("BROKER APPROVAL: a commission change is HELD (nothing written or sent); the agent cannot approve it; a finance admin's approval is recorded on the proposal and the agent's send then goes",
    !heldSend.success && heldSend.state === "needs_review" && /broker approves/.test(heldSend.error ?? "") && !agentApprove.success && brokerApprove.success
    && db().tables.contract_term_versions.find((v) => v.id === pc.versionId)?.evidence?.broker_approval?.approved_by === U_BROKER && afterApprove.success, JSON.stringify({ heldSend, afterApprove }))
  // missing signer through the door (a buyer with no email)
  db().tables.transactions[0].buyer_contact_id = BUYER2
  const pm = await quiet(() => D.proposeContractAddendum({ transactionId: TXN, kind: "addendum", documentId: DOC_UNSIGNED, terms: { closing_date: "2027-01-10" }, effectiveOn: null }))
  const calls4 = sb().calls.length, rows4 = db().tables.signature_requests.length
  const missing = await quiet(() => D.requestAddendumSignatures({ versionId: pm.versionId! }))
  check("MISSING SIGNERS → REVIEW: the buyer has no address — the door answers \"Select the required signing parties before sending this addendum.\", writes no request and reaches no provider",
    !missing.success && missing.state === "needs_review" && (missing.error ?? "").startsWith("Select the required signing parties before sending this addendum.") && db().tables.signature_requests.length === rows4 && sb().calls.length === calls4)
  db().tables.transactions[0].buyer_contact_id = BUYER
  G.__152F.readiness = { transactable: false, blockers: ["license expired"], message: "Your license needs renewing before you can send contract documents." }
  const notClear = await quiet(() => D.requestAddendumSignatures({ versionId: pm.versionId! }))
  G.__152F.readiness = { transactable: true, blockers: [], message: null }
  check("A SENDER NOT CLEAR TO TRANSACT is refused by the canonical readiness gate before anything is written", !notClear.success && /license/i.test(notClear.error ?? "") && db().tables.signature_requests.length === rows4)
  // the compliance recheck receives exactly the changed terms (the recorder's own seam), and a recorder refusal HOLDS a provider-completed request
  {
    const db2 = seed(); const sb3 = makeSandbox()
    const actor = { userId: U_AGENT, brokerageId: B, userType: "agent", teamId: null }
    const prop = await quiet(() => C.proposeContractAddendumVersion(db2 as any, actor, { ref: { transactionId: TXN }, kind: "addendum", documentId: DOC_UNSIGNED, terms: { closing_date: "2026-12-30" }, effectiveOn: null, termEvidence: null }))
    const vId = prop.ok ? prop.versionId : ""
    const deps: any = {
      esignChoice: async () => ({ ok: true, kind: "api", providerName: "docusign" }), readiness: async () => ({ transactable: true, blockers: [], message: null }), documentUrl: async (_s: any, u: string) => u,
      dispatch: async (_svc: any, input: any) => { await sb3.createTransaction({}); await sb3.sendForSignature({ externalTransactionId: "ENV-1", signers: input.signers }); return { ok: true, status: "sent", envelopeId: "ENV-1", providerName: "docusign" } },
      provider: async () => sb3, fetchBytes: async () => ({ ok: true, bytes: new TextEncoder().encode("%PDF signed") }),
      storeSignedCopy: async (svc: any, i: any) => { const id = globalThis.crypto.randomUUID(); svc.tables.documents.push({ id, brokerage_id: i.brokerageId, storage_url: "x", metadata: {}, signature_completeness: null }); return { ok: true, documentId: id } },
      event: async () => ({}), signal: async (s: any) => { G.__152F.signals.push(s); return { ok: true } },
    }
    const recheck: any[] = []
    const sentX = await quiet(() => C.requestAddendumSignatures(db2 as any, actor, { versionId: vId, choices: { includeAttorneys: false } }, deps))
    sb3.sign("ENV-1", "bea.buyer@mail.example"); sb3.sign("ENV-1", "sam.seller@mail.example")
    const doneX = await quiet(() => C.syncAddendumSignatureRequest(db2 as any, { brokerageId: B, requestId: sentX.ok ? sentX.requestId : "", source: "cron" }, { ...deps, recordExecuted: (svc: any, input: any) => recordContractTermsVersion(svc, input, { consequenceDeps: { runClosingCompliance: async (_s: any, i: any) => { recheck.push(i); return { ran: true, openBlocking: 0, reason: null } } } }) }))
    check("COMPLIANCE & CLOSING RECHECK: the executed version runs the closing-compliance re-review with trigger contract_addendum and EXACTLY the changed terms (the recorder's own seam observed)",
      doneX.ok && doneX.executed === true && recheck.length === 1 && recheck[0].trigger === "contract_addendum" && JSON.stringify(recheck[0].changedTerms) === JSON.stringify(["closing_date"]) && recheck[0].transactionId === TXN, JSON.stringify({ doneX, recheck }))
    // a held completion: the proposal changed after send (fingerprint) → completed, not recorded, compliance signalled; a filed retry with a DIFFERENT file is refused
    const db3 = seed(); const sb4 = makeSandbox()
    const prop3 = await quiet(() => C.proposeContractAddendumVersion(db3 as any, actor, { ref: { transactionId: TXN }, kind: "addendum", documentId: DOC_UNSIGNED, terms: { closing_date: "2027-02-01" }, effectiveOn: null, termEvidence: null }))
    const v3 = prop3.ok ? prop3.versionId : ""
    const deps3 = { ...deps, dispatch: async (_svc: any, input: any) => { await sb4.sendForSignature({ externalTransactionId: "ENV-9", signers: input.signers }); return { ok: true, status: "sent", envelopeId: "ENV-9", providerName: "docusign" } }, provider: async () => sb4 }
    const s3 = await quiet(() => C.requestAddendumSignatures(db3 as any, actor, { versionId: v3, choices: { includeAttorneys: false } }, deps3))
    db3.tables.contract_term_versions.find((v) => v.id === v3)!.terms = { closing_date: "2027-03-01" } // mutated out of band after send
    sb4.sign("ENV-9", "bea.buyer@mail.example"); sb4.sign("ENV-9", "sam.seller@mail.example")
    const held = await quiet(() => C.syncAddendumSignatureRequest(db3 as any, { brokerageId: B, requestId: s3.ok ? s3.requestId : "", source: "webhook" }, deps3))
    const heldRow = db3.tables.signature_requests.find((r) => r.id === (s3.ok ? s3.requestId : ""))
    check("A CHANGE AFTER SEND IS NEVER EXECUTED: the proposal differs from what was signed → the signed request is HELD (completed, not recorded), compliance is signalled, no executed version",
      held.ok && (held as any).held && heldRow?.request_status === "completed" && !heldRow?.evidence?.executed_version_id && /changed after it was sent/.test(heldRow?.evidence?.record_refused ?? "")
      && !db3.tables.contract_term_versions.some((v) => v.status === "executed" && v.source === "addendum") && G.__152F.signals.some((s: any) => s.signalType === "addendum_execution_held"))
    const swap = await quiet(() => C.fileSignedAddendumCopy(db3 as any, actor, { requestId: s3.ok ? s3.requestId : "", documentId: DOC_COUNTER_BOTH, executedOn: "2026-11-10" }, deps3))
    check("…and a DIFFERENT file offered in place of the provider's signed copy is refused (the provider's copy is the record)", !swap.ok && (swap as any).integrity === "mismatch")
  }

  // ═══ F · THE SWEEP ═══════════════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n[F · the sweep: poll without a webhook, expiry, one nudge, one escalation]")
  {
    const db5 = seed(); const sb5 = makeSandbox()
    const actor = { userId: U_AGENT, brokerageId: B, userType: "agent", teamId: null }
    const t0 = new Date("2026-11-11T12:00:00Z")
    const mk = async (terms: Record<string, unknown>, env: string) => {
      const p = await quiet(() => C.proposeContractAddendumVersion(db5 as any, actor, { ref: { transactionId: TXN }, kind: "addendum", documentId: DOC_UNSIGNED, terms, effectiveOn: null, termEvidence: null }))
      const vId = p.ok ? p.versionId : ""
      const r = await quiet(() => C.requestAddendumSignatures(db5 as any, actor, { versionId: vId, choices: { includeAttorneys: false } }, {
        now: () => t0, esignChoice: async () => ({ ok: true, kind: "api", providerName: "docusign" }), readiness: async () => ({ transactable: true, blockers: [], message: null }), documentUrl: async (_s: any, u: string) => u, event: async () => ({}),
        dispatch: async (_svc: any, input: any) => { await sb5.sendForSignature({ externalTransactionId: env, signers: input.signers }); return { ok: true, status: "sent", envelopeId: env, providerName: "docusign" } },
      }))
      return r.ok ? r.requestId : ""
    }
    const rPoll = await mk({ closing_date: "2026-12-11" }, "ENV-P")
    sb5.sign("ENV-P", "bea.buyer@mail.example"); sb5.sign("ENV-P", "sam.seller@mail.example")
    const signals5: any[] = []
    const sweepDeps: any = {
      provider: async () => sb5, fetchBytes: async () => ({ ok: true, bytes: new TextEncoder().encode("%PDF poll") }), event: async () => ({}), signal: async (s: any) => { signals5.push(s); return { ok: true } },
      storeSignedCopy: async (svc: any, i: any) => { const id = globalThis.crypto.randomUUID(); svc.tables.documents.push({ id, brokerage_id: i.brokerageId, storage_url: "x", metadata: {}, signature_completeness: null }); return { ok: true, documentId: id } },
    }
    const s1 = await quiet(() => C.sweepAddendumSignatureRequests(db5 as any, { ...sweepDeps, now: () => new Date(t0.getTime() + 3_600_000) }))
    check("POLL: an envelope whose webhook never came is completed by the sweep reading the provider — executed once", s1.polled >= 1 && s1.executed === 1 && db5.tables.signature_requests.find((r) => r.id === rPoll)?.request_status === "completed")
    const rStall = await mk({ closing_date: "2026-12-12" }, "ENV-S")
    const nudge = await quiet(() => C.sweepAddendumSignatureRequests(db5 as any, { ...sweepDeps, now: () => new Date(t0.getTime() + 50 * 3_600_000) }))
    const nudgeAgain = await quiet(() => C.sweepAddendumSignatureRequests(db5 as any, { ...sweepDeps, now: () => new Date(t0.getTime() + 60 * 3_600_000) }))
    const esc = await quiet(() => C.sweepAddendumSignatureRequests(db5 as any, { ...sweepDeps, now: () => new Date(t0.getTime() + 100 * 3_600_000) }))
    check("STALL: ONE nudge to the sender past the chase window (not repeated), then ONE escalation to the deal coordinator's queue — no message to a client",
      nudge.nudged === 1 && nudgeAgain.nudged === 0 && esc.escalated === 1 && signals5.filter((s) => s.signalType === "addendum_signature_stalled" && s.toManager === "deal_coordinator").length === 1
      && db5.tables.notifications.filter((n) => n.type === "signature_chase" && n.user_id === U_AGENT).length === 1 && !!rStall)
    const expire = await quiet(() => C.sweepAddendumSignatureRequests(db5 as any, { ...sweepDeps, now: () => new Date(t0.getTime() + 15 * 86_400_000) }))
    check("EXPIRY: past its date the request is `expired` and the deal coordinator hears it — the contract is unchanged",
      expire.expired === 1 && db5.tables.signature_requests.find((r) => r.id === rStall)?.request_status === "expired" && signals5.some((s) => s.signalType === "addendum_signature_request_stopped"))
  }

  // ═══ G · WIRING + REGISTRATION ═══════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n[G · wiring, no placeholder, one dispatch core, the recorder only, registration, m953]")
  const door = code("app/actions/buyer-offer/request-addendum-signatures.ts")
  const exportsAll = [...door.matchAll(/^export\s+(\S+\s+\S+)/gm)].map((m) => m[1])
  check("THE DOOR: every export is an async function (a public endpoint); the session gate runs before the service client in every one",
    exportsAll.length >= 9 && exportsAll.every((e) => e.startsWith("async function")) && (door.match(/const g = await gate\(\)/g) ?? []).length === (door.match(/createServiceClient\(\)/g) ?? []).length
    && door.split(/export async function/).slice(1).every((body) => !body.includes("createServiceClient()") || body.indexOf("gate()") < body.indexOf("createServiceClient()")))
  const ui = code("app/dashboard/offers/outside-offer-threads.tsx")
  check("THE UI REACHES IT: the addendum surface imports and CALLS propose / review / request / void / hand-off / file / approve / withdraw",
    ["proposeContractAddendum(", "reviewAddendumSignatureRequest(", "requestAddendumSignatures(", "voidAddendumSignatureRequest(", "startAddendumSignatureHandoff(", "fileSignedAddendumCopy(", "approveAddendumForSignature(", "withdrawProposedAddendum("].every((t) => ui.includes(t))
    && /<AddendumSignaturePanel /.test(ui))
  const placeholder = /not\s+(yet\s+)?implemented|coming soon|todo:|placeholder door/i
  const scanned = ["app/dashboard/offers/outside-offer-threads.tsx", "app/actions/buyer-offer/request-addendum-signatures.ts", "lib/esign/addendum-signature-request.ts", "lib/esign/addendum-signature-rules.ts"]
  // STRIPPED source: the headers quote the owner's ruling and wave 151's "NOT IMPLEMENTED" verdict as history (CLAUDE.md §2 —
  // a quoted origin is not a placeholder); user-facing copy lives in string literals, which stripping keeps.
  check("NO DISCONNECTED PLACEHOLDER remains on the addendum surface, the door or its core (stripped source — every string the user can see is still scanned)", scanned.every((f) => !placeholder.test(code(f))))
  check("POSITIVE CONTROL: the placeholder finder recognises the wave-151 wording, and STRIPPED source still shows it in a string the user would see (a comment alone is history)",
    placeholder.test("A 'request signatures on a proposed addendum' door is EVALUATED—NOT IMPLEMENTED") && placeholder.test(stripComments(`// history\nconst label = "Request signatures (not implemented)"`))
    && !placeholder.test(stripComments(`// wave 151: the door was NOT IMPLEMENTED\nconst label = "Send for signatures"`)))
  const core = bare("lib/esign/addendum-signature-request.ts")
  check("ONE DISPATCH CORE: the core reaches a provider SEND only through dispatchEsignPacket — it never calls createTransaction / attachForms / sendForSignature itself (no second e-sign abstraction)",
    /dispatchEsignPacket\(/.test(core) && !/\.(createTransaction|attachForms|sendForSignature)\(/.test(core))
  check("POSITIVE CONTROL: the same finder catches a direct provider send", /\.(createTransaction|attachForms|sendForSignature)\(/.test(blankStrings("await client.sendForSignature(req)")))
  const ctvInsert = /from\("contract_term_versions"\)\s*\.insert\(/
  check("THE EXECUTED VERSION is written ONLY by lane 152E's recorder: the core never inserts a contract_term_versions row (it calls recordContractTermsVersion)",
    !ctvInsert.test(code("lib/esign/addendum-signature-request.ts")) && /recordContractTermsVersion\(/.test(code("lib/esign/addendum-signature-request.ts")))
  check("POSITIVE CONTROL: the insert finder recognises a direct insert", ctvInsert.test(`svc.from("contract_term_versions").insert({})`))
  const rawInCopy = /(?:fail\(\s*"[a-z_]+",\s*`|message:\s*`)[^`]*\$\{[^}]*\.(?:message|reason)\b[^}]*\}/
  check("TENANT COPY CARRIES NO RAW ERROR: no refusal the door returns interpolates a database / provider `.message` or `.reason` — the detail is logged (unreadable / unsaved) and the tenant hears the contract's sentence",
    !rawInCopy.test(code("lib/esign/addendum-signature-request.ts")))
  check("POSITIVE CONTROL: the finder recognises the defect it was written for", rawInCopy.test("return fail(\"unreadable\", `The parties could not be read (${cErr.message}).`)") && rawInCopy.test("return { ok: false, message: `could not be started (${claimErr.message})` }"))
  check("NO KEY, NO ENV, NO MODEL in this lane's code: provider credentials stay behind the resolver (activation is OWNER-HELD)",
    scanned.every((f) => !/process\.env|api[_-]?key|\bclaude-|\bgpt-|licence/i.test(code(f))))
  const loop = code("lib/forms/esign-execution-loop.ts")
  check("THE WEBHOOK LOOP: the envelope resolver reads signature_requests; completion routes an addendum envelope to the verified sync; the terminal recorder and the progress hook reach the addendum request",
    /\["signature_requests",\s*"provider_envelope_id"\]/.test(loop) && /isAddendumEnvelope\(/.test(loop) && /syncAddendumSignatureRequest\(/.test(loop) && (loop.match(/applyAddendumProviderEvent\(/g) ?? []).length >= 2 && /export async function recordEnvelopeProgress/.test(loop))
  check("THE ROUTES: DocuSign, SkySlope and Authentisign hand non-completion events to recordEnvelopeProgress (signature-verified first, as before)",
    ["docusign", "skyslope", "authentisign"].every((p) => { const r = code(`app/api/webhooks/${p}/route.ts`); return /recordEnvelopeProgress\(/.test(r) && r.indexOf("verify") < r.indexOf("recordEnvelopeProgress(") }))
  check("THE POLL: the e-sign doc-sync sweep runs the addendum leg, and the cron that runs the sweep is scheduled",
    /sweepAddendumSignatureRequests\(/.test(code("lib/transactions/esign-doc-sync-sweep.ts")) && /\/api\/cron\/esign-doc-sync/.test(raw("lib/kernel/cron-dispatch.ts")))
  const reg = code("lib/kernel/manager-registry.ts")
  check("REGISTRY: the domain is owned by deal_coordinator, co-owned by compliance_officer, proved by test:addendum-signatures",
    /addendum_signature_request:\s*\{\s*manager:\s*"deal_coordinator",\s*proof:\s*"test:addendum-signatures",\s*coOwners:\s*\[[^\]]*"compliance_officer"/.test(reg))
  const pkg = JSON.parse(raw("package.json"))
  check("PACKAGE: test:addendum-signatures is registered and the guard chain RUNS it (not 'ends with it' — sibling lanes append after it; CLAUDE.md §2)",
    pkg.scripts?.["test:addendum-signatures"] === "tsx scripts/addendum-signatures-guard.ts" && /(^| && )npm run test:addendum-signatures( && |$)/.test((pkg.scripts?.guard ?? "").trimEnd()))
  check("POSITIVE CONTROL: the chain finder refuses a prefix-only name and admits a mid-chain run", !/(^| && )npm run test:addendum-signatures( && |$)/.test("npm run test:addendum-signatures-x") && /(^| && )npm run test:addendum-signatures( && |$)/.test("npm run test:a && npm run test:addendum-signatures && npm run test:b"))
  check("m953: line 1 is the lane's WRITTEN-NOT-APPLIED stamp OR the integrator's APPLIED LIVE stamp (the rule, never the pre-apply waypoint); the FK to contract_term_versions, the evidence column, the one-live partial unique index and a ROLLBACK note are present",
    (mig.split("\n")[0] === "-- WRITTEN, NOT APPLIED (wave 152, lane 152F) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN and storage.objects policies are owner SQL" || /^-- ── APPLIED LIVE \d{4}-\d{2}-\d{2} via Supabase MCP \(project [a-z]+\) — wave 152, lane 152F ──$/.test(mig.split("\n")[0]))
    && /contract_term_version_id uuid NULL REFERENCES public\.contract_term_versions\(id\)/.test(migBody) && /evidence jsonb NOT NULL DEFAULT/.test(migBody) && /CREATE UNIQUE INDEX IF NOT EXISTS signature_requests_one_live_per_version_uidx/.test(migBody) && /-- ROLLBACK/.test(mig))

  console.log("\nBLIND SPOTS (published, not hidden):")
  console.log("  · every provider call is the SANDBOX seam — no live DocuSign / Dotloop / SkySlope / Authentisign envelope was cut (SIMULATED); activation and credentials are OWNER-HELD")
  console.log("  · the 23505 race is modelled with a full-column unique key on the in-memory client; the live index is PARTIAL (open statuses only) — read from m953, not exercised against Postgres")
  console.log("  · a Dotloop webhook resolves its tenant from client_documents, so a Dotloop-sent addendum completes through the 4-hourly poll, not the callback")
  console.log("  · the provider contract carries no parallel routing (DocuSign's adapter numbers routingOrder by position) — the plan states sequential order rather than offering parallel")
  console.log("  · the signed copy's FIRST retrieval is the integrity anchor (an authenticated pull from the sending account); a provider-side certificate / checksum is not read — the interface exposes none")
  console.log("  · a filed copy (hand-off / counterparty) is verified by the recorder's signature reading of the document, not by a provider hash — there is no provider copy to compare it with")
  console.log(`  · m953 is ${/APPLIED LIVE/.test(mig.split("\n")[0]) ? "APPLIED LIVE (its line-1 stamp; the columns are in the regenerated schema caches)" : "WRITTEN, NOT APPLIED: until the integrator applies it the live table has no contract_term_version_id / evidence column, and every send would be refused (PGRST204) — the door must not ship ahead of the migration"}`)

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { for (const f of failures) console.log(`  ✗ ${f}`); process.exit(1) }
}

main().catch((e) => { console.error(e); console.log(`\nRESULT: ${passed} passed, ${failed + 1} failed`); process.exit(1) })
