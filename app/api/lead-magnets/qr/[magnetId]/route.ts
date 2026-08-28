import { NextRequest, NextResponse } from "next/server"
import { trackMagnetEvent } from "@/lib/kernel/lead-magnets"

// ─── TOMBSTONE: THE POST HALF IS DELETED (wave H5) ───────────────────────────
//
// `POST /api/lead-magnets/qr/[magnetId]` was a SECOND door onto exactly one
// minter — lib/kernel/lead-magnets.ts:generateQRCode → lib/marketing/
// tracked-qr.ts:mintTrackedQr — and it was the WORSE of the two doors.
//
// SURVIVOR: app/actions/lead-magnets-actions.ts:313 generateQRCodeAction, which
// the real UI calls (app/components/features/lead-magnets/QRCodeGenerator.tsx:63).
// NOTHING WAS MERGED because the survivor was missing nothing: it reaches the
// same generateQRCode with the same four arguments and additionally returns the
// rendered PNG. What it has that this route did not is the GATE.
//
// WHY IT HAD TO GO RATHER THAN GAIN A CALLER (CLAUDE.md §4). This handler read
// `brokerageId` and `agentId` FROM THE REQUEST BODY and passed them straight to
// a minter that writes on the SERVICE client. Its only check was that SOME user
// was signed in — it never asked whether that user belonged to the brokerage
// named in the body, and it never verified the magnet was that tenant's. That
// is the body-supplied-brokerageId-on-a-service-client shape §4 names as the
// IDOR found repeatedly here: any signed-in agent could mint a `qr_codes` row
// stamped to another tenant's brokerage_id and any agent_id they chose. The
// survivor derives both from getAgentContext() and re-reads
// lead_capture_forms scoped by brokerage_id before minting anything.
//
// NO EXTERNAL CALLER CAN EXIST FOR IT: the handler authenticated on a Supabase
// SESSION (supabase.auth.getUser()), never a bearer token, so the only possible
// caller was this app's own UI — which calls the server action instead. That is
// the same "loop, not a door" test the census applies to /api/agentic-os/voice.
//
// THE GET HALF BELOW IS LEFT STANDING, DELIBERATELY AND WITH ITS DEFECT NAMED:
// it takes `brokerageId` from the QUERY STRING with NO authentication at all
// and returns another tenant's qr_codes row (slug, target_url, scan_count).
// Its two stated jobs are already served elsewhere — the scan event by
// /api/qr/scan and app/qr/[slug]/page.tsx (the two real scan doors, which
// record it), and the record lookup by generateQRCodeAction's own return value.
// It is not deleted here because, being unauthenticated, an out-of-tree caller
// CANNOT be disproved from this repo, and §1 says unresolved means leave it
// standing. UNRESOLVED, and it needs a tenancy decision, not a guess.

// GET /api/lead-magnets/qr/[magnetId]
// Returns the QR code record for a given magnet
// Also fires a qr_scan tracking event if ?track=1 is passed (used by QR redirect pages)
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ magnetId: string }> }
) {
  try {
    const { magnetId } = await params
    const { searchParams } = new URL(req.url)
    const brokerageId = searchParams.get("brokerageId") ?? ""
    const track = searchParams.get("track") === "1"

    if (!brokerageId) {
      return NextResponse.json({ success: false, error: "brokerageId required" }, { status: 400 })
    }

    if (track && brokerageId) {
      const ipAddress = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined
      const userAgent = req.headers.get("user-agent") ?? undefined
      trackMagnetEvent({
        magnetId,
        brokerageId,
        eventType: "qr_scan",
        ipAddress,
        userAgent,
      }).catch(() => {})
    }

    // ── THE RECORD IS GATED; THE SCAN IS NOT (integrator, wave 16) ───────────
    // The lane above named this endpoint's defect and left it standing because
    // §1 forbids deleting what you cannot prove unreachable. That reasoning is
    // right about DELETION and does not apply to the LEAK: an unauthenticated
    // handler that hands a caller-named brokerage's qr_codes row (slug, target
    // URL, scan_count) off a SERVICE client is cross-tenant disclosure whether
    // or not anything calls it, and the fix for that is the gate, not removal.
    //
    // The two halves are split because they have different audiences. RECORDING
    // A SCAN IS ANONYMOUS BY NATURE — it comes from a stranger's phone, has no
    // session, and is already fired above — so any out-of-tree caller that
    // exists to report scans keeps working unchanged, and still gets a truthful
    // answer about what happened. RETURNING THE RECORD is an operator act, so
    // it now requires a session whose own users.brokerage_id equals the
    // brokerage asked about — the caller's query string cannot vouch for
    // itself (§4). A refused users read fails CLOSED rather than falling
    // through to the service client.
    const { createClient } = await import("@/lib/supabase/server")
    const authClient = await createClient()
    const { data: { user: authUser } } = await authClient.auth.getUser()
    let callerBrokerageId: string | null = null
    if (authUser) {
      const { data: callerRow, error: callerErr } = await authClient
        .from("users").select("brokerage_id").eq("id", authUser.id).maybeSingle()
      if (callerErr) {
        console.error("[API] GET /api/lead-magnets/qr: caller lookup refused:", callerErr.message)
        return NextResponse.json(
          { success: false, error: "Could not verify your access to this brokerage." },
          { status: 500 },
        )
      }
      callerBrokerageId = (callerRow?.brokerage_id as string | undefined) ?? null
    }
    if (callerBrokerageId !== brokerageId) {
      // Deliberately not 403-with-detail: the tracking outcome is reported
      // honestly, and nothing about another tenant's code is disclosed —
      // including whether one exists, which a 404-vs-200 split would leak.
      return NextResponse.json(
        { success: true, tracked: track, record: null,
          note: "The QR record is returned only to a signed-in member of the brokerage that owns it." },
        { status: 200 },
      )
    }

    const { createServiceClient } = await import("@/lib/supabase/service")
    const supabase = createServiceClient()

    // LOOK THE CODE UP BY ITS KEY, NOT BY A SUBSTRING OF ITS URL.
    // This searched `target_url ILIKE %magnetId%`, and a lead-magnet QR's URL
    // carries the code's own SLUG, never the magnet id — so the match could not
    // succeed and this endpoint answered "QR code not found" for every magnet
    // that had one. The mint path keys the row `lead_magnet:<magnetId>`
    // (lib/marketing/tracked-qr.ts), which is exact, indexed by the same label
    // uniqueness the minter relies on, and immune to the URL being re-pointed.
    const { data: qr, error } = await supabase
      .from("qr_codes")
      .select("id, slug, target_url, scan_count, label, is_active")
      .eq("brokerage_id", brokerageId)
      .eq("label", `lead_magnet:${magnetId}`)
      .maybeSingle()

    // A refused read is not "there is no code" — supabase-js resolves a failed
    // query, so reporting both as 404 would hide an outage as an empty result.
    if (error) {
      console.error("[API] GET /api/lead-magnets/qr:", error.message)
      return NextResponse.json(
        { success: false, error: "Could not look up the QR code for this lead magnet." },
        { status: 500 },
      )
    }
    if (!qr) {
      return NextResponse.json({ success: false, error: "QR code not found" }, { status: 404 })
    }

    return NextResponse.json({ success: true, qr })
  } catch (err) {
    console.error("[API] GET /api/lead-magnets/qr/[magnetId]:", err)
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    )
  }
}
