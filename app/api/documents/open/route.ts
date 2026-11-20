import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { openDocumentReference, signDocumentLink, DOCUMENT_OPEN_PATH } from "@/lib/storage/signed-doc-url"
import { loadDealWorkAccess } from "@/lib/auth/deal-work-ownership"
import { TENANT_ADMIN_USER_TYPES, BROKERAGE_FINANCE_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"
import { resolveExternalPartnerIdentity, externalPartnerTransactionLane } from "@/lib/kernel/portal-auth"
import { isClientVisibleDealDocument } from "@/lib/kernel/deal-document-visibility"
import { encryptSecret, decryptSecret, isEncrypted } from "@/lib/security/secret-crypto"

/**
 * GET /api/documents/open?ref=docref://<bucket>/<path> — THE ONE OPEN DOOR for a private document (wave 154, lane 154M;
 * open-loop rows 146A-SO-02 / 146Z-NC-02). A row stores a reference, never a bearer link; every view comes here.
 *
 *   1. the actor comes from the SESSION (auth.getUser → users.brokerage_id / user_type) — nothing from the query string but the
 *      reference, which only LOCATES the row (CLAUDE.md §4);
 *   2. the row is located by its reference INSIDE that tenant; the access rule for the row's kind is applied
 *      (lib/auth/deal-work-ownership.ts loadDealWorkAccess for a deal's documents; lib/kernel/portal-auth.ts for an external
 *      party's lane; a contact's own rows) — lib/storage/signed-doc-url.ts mayOpenDocumentRow;
 *   3. only then a 302 to a signed URL whose lifetime is DOC_VIEW_TTL_SECONDS. Nothing is persisted.
 * OUTSIDE RECIPIENTS (`&g=` — round 2): a person with no seat (a lead, an outside listing agent, an appraiser, a contact opening
 * an emailed personal video) presents a SHARE GRANT minted at send time and sealed by lib/security/secret-crypto.ts. It opens
 * only a closed list of purposes, only the row it names (re-read now), and still mints only a 5-minute link; any custody kind
 * ignores it. A bad grant with no session is the same 404 as an unknown reference.
 * The object itself must belong to the row's tenant (lib/storage/signed-doc-url.ts pathBoundToTenant) — a row cannot point the
 * door at another tenant's object.
 * An unknown reference, another tenant's and a forbidden one answer the SAME 404. A refused read or signer is a 503 with no
 * link — never a public fallback. No session → the sign-in page, which returns here.
 * Survivor pattern: lib/forms/tenant-form-packets.ts issueTenantPacketUrl (per-view minting after an access decision).
 */
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const rawRef = url.searchParams.get("ref")
  // An outside recipient's SHARE GRANT (lib/storage/signed-doc-url.ts mintDocumentShareGrant) — opened only by the sealer below.
  const rawGrant = url.searchParams.get("g")
  const supabase = await createClient()
  const svc = createServiceClient()

  let userId = ""
  let brokerageId = ""
  let userType: string | null = null
  const answer = await openDocumentReference(
    {
      db: svc as never,
      actor: async () => {
        const { data: auth } = await supabase.auth.getUser()
        if (!auth?.user) return { ok: false, reason: "unauthenticated" }
        const { data: u, error } = await svc.from("users").select("brokerage_id, user_type").eq("id", auth.user.id).maybeSingle()
        if (error) return { ok: false, reason: "refused", detail: `the session seat could not be read: ${error.message}` }
        const row = (u ?? null) as { brokerage_id: string | null; user_type: string | null } | null
        // A seat with no tenant has no rows to open: an actor whose tenant pin matches nothing.
        userId = auth.user.id
        brokerageId = row?.brokerage_id ?? ""
        userType = row?.user_type ?? null
        return { ok: true, actor: { userId, brokerageId, userType } }
      },
      rules: {
        tenantAdminUserTypes: TENANT_ADMIN_USER_TYPES,
        financeReaderUserTypes: new Set([...BROKERAGE_FINANCE_ADMIN_USER_TYPES, "compliance_officer"]),
        clientVisibleDealDocument: isClientVisibleDealDocument,
        dealRead: async (transactionId) => {
          const r = await loadDealWorkAccess(svc as never, { userId, brokerageId, userType, transactionId })
          return r.ok ? { ok: true, read: r.access.capabilities.read } : { ok: false, error: r.error }
        },
        partnerLane: async (transactionId) => {
          const who = await resolveExternalPartnerIdentity(supabase)
          if (!who.ok) return who.reason === "refused" ? { ok: false, error: who.detail } : { ok: true, granted: false }
          const lane = await externalPartnerTransactionLane(supabase, who.identity, transactionId)
          if (lane.ok) return { ok: true, granted: true }
          if (lane.reason === "refused") return { ok: false, error: lane.detail }
          // A plain (non-lender) vendor's lane is its OWN assignment to the deal, keyed on the session's vendor id.
          if (!who.identity.vendorId) return { ok: true, granted: false }
          const { data: a, error } = await svc.from("vendor_assignments").select("id").eq("vendor_id", who.identity.vendorId).eq("transaction_id", transactionId).limit(1)
          if (error) return { ok: false, error: error.message }
          return { ok: true, granted: (a ?? []).length > 0 }
        },
      },
      sign: (bucket, path, ttlSeconds) => signDocumentLink(svc as never, bucket, path, ttlSeconds),
      sealer: { seal: encryptSecret, open: decryptSecret, isSealed: isEncrypted },
    },
    rawRef,
    rawGrant,
  )

  const noStore = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }
  if (answer.status === 302) return NextResponse.redirect(answer.location, { status: 302, headers: noStore })
  if (answer.status === 401) {
    const back = `${DOCUMENT_OPEN_PATH}?ref=${encodeURIComponent(rawRef ?? "")}`
    return NextResponse.redirect(new URL(`/auth/login?redirect=${encodeURIComponent(back)}`, url.origin), { status: 302, headers: noStore })
  }
  if (answer.status === 503) {
    console.error(`[documents/open] refused to open a document: ${answer.reason}`)
    return new NextResponse("This document can't be opened right now. Please try again shortly.", { status: 503, headers: noStore })
  }
  return new NextResponse("This document isn't available.", { status: 404, headers: noStore })
}
