import { type NextRequest, NextResponse } from "next/server"
import { createHmac, createPublicKey, timingSafeEqual, verify as cryptoVerify } from "crypto"

// =====================================================
// GOHIGHLEVEL (LEADCONNECTOR) WEBHOOK HANDLER — the one GHL inbound path.
//
// CONSOLE POINTER (owner ruling: webhook URLs are researched to the latest
// provider path as part of connection self-heal): any GHL workflow custom
// webhook or marketplace-app webhook URL must point at
//
//     https://<app-domain>/api/webhooks/gohighlevel
//
// The canonical URL is published to platform staff via
// lib/providers/webhook-contract.ts → the superadmin connectors page.
//
// TOMBSTONE (orphan doctrine §1.1, adjudicated 2026-08-27): the duplicate
// app/api/webhooks/ghl/route.ts is DELETED — this file is the survivor. Both
// verified the same X-GHL-Signature HMAC against the same GHL_WEBHOOK_SECRET
// and both ended in a no-op ack (the loser via lib/ghl-integration.ts's
// handleIncomingMessage, itself a documented no-op). Nothing functional was
// unique to the loser, so nothing needed porting; this path survives because
// the product ruling ("GHL is sync-out only") and its guard
// (scripts/enrichment-suppression-simulator.ts) already name THIS file.
// Losing its only importer exposed lib/ghl-integration.ts as a whole-module
// duplicate of services/goHighLevelService.ts — deleted the same day, §1.3
// tombstone at the top of that service.
//
// CURRENT PROVIDER PROTOCOL (researched 2026-08-27):
//   · Native LeadConnector/marketplace webhooks sign the raw body and send
//     `x-ghl-signature` — since HighLevel's 2026 App Marketplace security
//     update this is an Ed25519 signature verified against HighLevel's
//     published public key (see GoHighLevel/highlevel-api-sdk README +
//     marketplace.gohighlevel.com Webhook Integration Guide). The legacy
//     `x-wh-signature` (RSA-SHA256) is deprecated 2026-09-01.
//   · Workflow "custom webhook" actions carry whatever header the workflow
//     configures — this repo's documented config is X-GHL-Signature as an
//     HMAC-SHA256 hex digest of the raw body keyed by GHL_WEBHOOK_SECRET.
// Verification below accepts EITHER proof on the one header, fail closed:
//   1. HMAC-SHA256(raw body, GHL_WEBHOOK_SECRET) hex — the shared-secret
//      workflow config (unchanged behaviour);
//   2. Ed25519 over the raw body against GHL_WEBHOOK_ED25519_PUBLIC_KEY
//      (PEM, pasted from HighLevel's docs) — a native LC webhook, base64
//      signature. Env unset = scheme unavailable, never assumed.
// Neither env set, or neither proof valid → 401. An unconfigured deploy can't
// be exploited by arbitrary POSTs.
//
// GHL is SYNC-OUT ONLY (product decision, unchanged): the app pushes contact/
// detail updates OUT (services/goHighLevelService.ts via
// lib/crm/sync.ts:syncContactToCRM) and imports contacts by
// scheduled PULL (lib/crm/import-pull.ts) — it does not ingest CRM push
// events. The verified ack below exists so GHL stops retrying; no internal
// events are fired.
// =====================================================

function verifyHmacSharedSecret(rawBody: string, signatureHeader: string): boolean {
  const secret = process.env.GHL_WEBHOOK_SECRET
  if (!secret) return false
  const computed = createHmac("sha256", secret).update(rawBody, "utf-8").digest("hex")
  try {
    const a = Buffer.from(computed, "hex")
    const b = Buffer.from(signatureHeader, "hex")
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function verifyEd25519(rawBody: string, signatureHeader: string): boolean {
  const pem = process.env.GHL_WEBHOOK_ED25519_PUBLIC_KEY
  if (!pem) return false
  try {
    const key = createPublicKey(pem)
    return cryptoVerify(null, Buffer.from(rawBody, "utf-8"), key, Buffer.from(signatureHeader, "base64"))
  } catch {
    return false
  }
}

function verifyGoHighLevelSignature(rawBody: string, signatureHeader: string | null): boolean {
  if (!process.env.GHL_WEBHOOK_SECRET && !process.env.GHL_WEBHOOK_ED25519_PUBLIC_KEY) {
    console.warn("[gohighlevel-webhook] no GHL webhook verification env set — rejecting request")
    return false
  }
  if (!signatureHeader) return false
  return (
    verifyHmacSharedSecret(rawBody, signatureHeader) ||
    verifyEd25519(rawBody, signatureHeader)
  )
}

export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text()
    const signatureHeader = request.headers.get("x-ghl-signature")

    if (!verifyGoHighLevelSignature(rawBody, signatureHeader)) {
      return NextResponse.json({ error: "Invalid or missing webhook signature" }, { status: 401 })
    }

    // GHL is SYNC-OUT ONLY. The app pushes contact/detail updates OUT to GoHighLevel; it
    // does NOT ingest CRM events back IN (no CRM syncs into the app — product decision).
    // We still verify the signature above so an unconfigured deploy isn't an open endpoint,
    // then acknowledge with a no-op so GHL stops retrying. No internal events are fired.
    console.info("[gohighlevel-webhook] inbound event ignored — GHL is one-way OUT only")
    return NextResponse.json({ success: true, message: "Ignored — GHL is sync-out only" }, { status: 200 })
  } catch (error) {
    console.error("[v0] Error processing GHL webhook:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
