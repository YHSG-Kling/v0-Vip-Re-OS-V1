/**
 * app/api/webhooks/meta-dm/route.ts
 *
 * ══ THE ONE META MESSAGING WEBHOOK ═══════════════════════════════════════════
 * CONSOLE POINTER (owner ruling: "any webhook url needs to be researched to
 * find the latest path which is part of the connection self heal"): the Meta
 * App Dashboard → Webhooks → Callback URL for the Messenger + Instagram
 * `messages` subscriptions MUST point at
 *
 *     https://<app-domain>/api/webhooks/meta-dm
 *
 * (Lead Ads `leadgen` keeps its own path: /api/webhooks/meta-leadgen. Both use
 * the SAME verify token, META_WEBHOOK_VERIFY_TOKEN, because one Meta app has
 * one webhook configuration.) The canonical URL is published to platform staff
 * via lib/providers/webhook-contract.ts → the superadmin connectors page.
 *
 * TOMBSTONE (orphan doctrine §1.1, adjudicated 2026-08-27): the parallel
 * first-generation handler app/api/webhooks/meta/route.ts is DELETED — this
 * file is the survivor. Both implemented the same Meta subscription handshake
 * (hub.mode / hub.verify_token / hub.challenge echo — still the current
 * protocol per developers.facebook.com Graph API webhooks docs, verified
 * 2026-08-27; current Graph API v25.0, the webhook handshake + signature
 * scheme are version-independent) against DIFFERENT env vars and wrote
 * DIFFERENT tables for the same messaging events — the duplicate-pair defect.
 * What the loser had that mattered was MERGED here first:
 *   · PSID→contact identity: contacts.metadata.{facebook_psid|instagram_psid}
 *     match + minimal-contact capture (source facebook_dm/instagram_dm), now
 *     TENANT-SCOPED to the resolved brokerage (the loser ran it cross-tenant
 *     with a conditional predicate);
 *   · META_VERIFY_TOKEN accepted as handshake fallback so a dashboard
 *     configured against the loser's env var keeps verifying.
 * What NEITHER had — X-Hub-Signature-256 payload verification, which current
 * Meta protocol sends on every POST (sha256= prefix, HMAC-SHA256 of the raw
 * body keyed by the App Secret) — is BUILT here per §1.2: META_APP_SECRET
 * (fallback FACEBOOK_APP_SECRET, same pair lib/social/token-refresh.ts uses).
 * The loser's communication-spine call was NOT ported: the unified inbox reads
 * conversations(type 'social_dm') + messages, the tables this route writes,
 * and the spine remains alive via the whatsapp/linkedin/twitter routes.
 *
 * OWNERSHIP MODEL (owner correction, 2026-07 audit): the Meta app is only the
 * SHELL — TENANTS connect their OWN pages/IG accounts through it (that's what
 * social_media_accounts rows are). Meta delivers every connected page's DMs to
 * this ONE webhook; the page→tenant mapping routes each thread home.
 *
 *   GET  — Meta's subscription handshake (hub.challenge echo against
 *          META_WEBHOOK_VERIFY_TOKEN, fallback META_VERIFY_TOKEN; unset =
 *          honest 404 not-configured).
 *   POST — DM events. Signature policy, fail closed:
 *            · app secret set + signature valid   → ingest
 *            · app secret set + signature INVALID → 401 (not Meta — no retry
 *              obligation to a forger)
 *            · app secret unset                   → 503, NOTHING ingested
 *          2026-09-03: the verifier moved to lib/meta/verify-signature.ts —
 *          the ONE Meta verifier, now shared with meta-leadgen and whatsapp
 *          (both of which accepted UNVERIFIED POSTs until then). The
 *          unset-secret answer changed from "200 ack, ingest nothing" to 503:
 *          the silent ack dropped every DM forever with no signal anywhere,
 *          while a 503 shows in the App Dashboard delivery log and Meta's
 *          retry schedule re-delivers once the secret is set. The handshake
 *          token spelling is unified there too (META_WEBHOOK_VERIFY_TOKEN
 *          survives; META_VERIFY_TOKEN / WHATSAPP_VERIFY_TOKEN accepted as
 *          documented fallbacks).
 *          The receiving PAGE/IG account maps to a tenant via
 *          social_media_accounts (account_id); a DM for a page no tenant
 *          connected is ACKED and skipped (Meta requires 200) with nothing
 *          fabricated. Each sender thread upserts ONE conversations row (type
 *          'social_dm' — the unified inbox lists by conversations.type),
 *          latest message in context_data, every DM landing in messages.
 *
 * Replies flow OUT through the tenant's connected account tooling — this
 * route only ingests.
 */
import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { metaSubscriptionHandshake, verifyMetaSignature } from "@/lib/meta/verify-signature"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  // The handshake (META_WEBHOOK_VERIFY_TOKEN, hub.challenge echo, honest 404
  // when unset; META_VERIFY_TOKEN fallback merged from the deleted
  // first-generation route — tombstone above) lives in the ONE verifier.
  return metaSubscriptionHandshake(req)
}

// TOMBSTONE (2026-09-03): the local `verifyMetaSignature` (X-Hub-Signature-256
// = "sha256=" + hex(HMAC-SHA256(raw body, app secret)), timing-safe) moved to
// lib/meta/verify-signature.ts:verifyMetaSignature so meta-leadgen and
// whatsapp verify with the SAME code instead of none. Nothing was dropped:
// the malformed-input → false behaviour is safeHexEqual there.

interface DmEvent {
  pageId: string
  senderId: string
  text: string
  platform: "facebook" | "instagram"
  timestamp: number | null
}

/** Tolerant extraction across Messenger + IG webhook shapes. */
function extractDmEvents(body: any): DmEvent[] {
  const out: DmEvent[] = []
  const objectKind = String(body?.object ?? "")
  const platform: "facebook" | "instagram" = objectKind === "instagram" ? "instagram" : "facebook"
  for (const entry of (Array.isArray(body?.entry) ? body.entry : [])) {
    const pageId = String(entry?.id ?? "")
    for (const m of (Array.isArray(entry?.messaging) ? entry.messaging : [])) {
      const text = m?.message?.text
      const senderId = String(m?.sender?.id ?? "")
      // Skip echoes of our own outbound + non-text payloads (attachments v2).
      if (!pageId || !senderId || !text || m?.message?.is_echo) continue
      if (senderId === pageId) continue
      out.push({ pageId, senderId, text: String(text).slice(0, 4000), platform, timestamp: m?.timestamp ?? null })
    }
  }
  return out
}

/**
 * PSID→contact identity, merged from the deleted first-generation route
 * (tombstone in the header). TENANT-SCOPED: the caller has already resolved
 * the brokerage from the receiving page, so the metadata-PSID match runs
 * inside that one tenant — never the loser's cross-tenant conditional
 * predicate. No match → capture a minimal contact so the thread has an
 * identity; a REFUSED capture returns null and the DM still lands on the
 * conversation (the thread must not be lost to a contact-side refusal).
 */
async function resolveDmContact(
  svc: ReturnType<typeof createServiceClient>,
  brokerageId: string,
  ev: DmEvent,
): Promise<string | null> {
  const psidField = ev.platform === "instagram" ? "instagram_psid" : "facebook_psid"
  const { data: existing, error: matchError } = await svc
    .from("contacts")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .contains("metadata", { [psidField]: ev.senderId })
    .limit(1)
    .maybeSingle()
  if (matchError) {
    console.error("[meta-dm] contact PSID match refused:", matchError.message)
    return null
  }
  if (existing?.id) return existing.id as string

  const source = ev.platform === "instagram" ? "instagram_dm" : "facebook_dm"
  const { data: created, error: createError } = await svc
    .from("contacts")
    .insert({
      brokerage_id: brokerageId,
      first_name: "Social",
      last_name: "Lead",
      contact_type: "lead",
      source,
      metadata: { [psidField]: ev.senderId },
    })
    .select("id")
    .single()
  if (createError || !created) {
    console.error("[meta-dm] contact capture refused:", createError?.message ?? "(no row)")
    return null
  }
  return created.id as string
}

export async function POST(req: NextRequest) {
  // Raw body FIRST — the signature is over the exact bytes Meta sent.
  const rawBody = await req.text()

  // Fail closed BEFORE any parse: 503 when this deploy holds no App Secret
  // (cannot verify anyone — see the header for why that is no longer a silent
  // 200), 401 on a missing/bad signature (a forger, not Meta — Meta always
  // signs, so there is no retry obligation).
  const verdict = verifyMetaSignature(rawBody, req.headers.get("x-hub-signature-256"))
  if (!verdict.ok) return new NextResponse(verdict.reason, { status: verdict.status })

  // Verified. Meta retries aggressively on non-200 — from here, always ack.
  let events: DmEvent[] = []
  try {
    events = extractDmEvents(JSON.parse(rawBody))
  } catch { /* malformed body — ack and move on */ }

  if (events.length > 0) {
    const svc = createServiceClient()
    for (const ev of events) {
      try {
        // The receiving page → the tenant that connected it.
        const { data: account } = await svc.from("social_media_accounts")
          .select("brokerage_id, account_name, agent_id")
          .eq("account_id", ev.pageId)
          .eq("is_active", true)
          .limit(1)
          .maybeSingle()
        const brokerageId = (account as any)?.brokerage_id as string | undefined
        if (!brokerageId) continue // no tenant owns this page — ack, skip, never fabricate

        // conversations.agent_id is NOT NULL (live contract) — attach the
        // thread to the account's owner, else the brokerage's first active
        // agent; a tenant with neither is skipped honestly.
        let threadAgentId = ((account as any)?.agent_id as string | null) ?? null
        if (!threadAgentId) {
          const { data: fallbackAgent } = await svc.from("agents")
            .select("id").eq("brokerage_id", brokerageId).eq("is_active", true)
            .order("created_at", { ascending: true }).limit(1).maybeSingle()
          threadAgentId = ((fallbackAgent as any)?.id as string | null) ?? null
        }
        if (!threadAgentId) continue

        // Identity for the thread (merged capability — see resolveDmContact).
        const resolvedContactId = await resolveDmContact(svc, brokerageId, ev)

        // One conversation per (page, sender) thread — the unified inbox row.
        const { data: existing } = await svc.from("conversations")
          .select("id, message_count, unread_count, contact_id")
          .eq("brokerage_id", brokerageId)
          .eq("type", "social_dm")
          .contains("context_data", { page_id: ev.pageId, sender_id: ev.senderId })
          .limit(1)
          .maybeSingle()

        const nowIso = new Date().toISOString()
        let conversationId: string | null = null
        let conversationContactId: string | null = null
        if (existing) {
          conversationId = (existing as any).id
          conversationContactId = ((existing as any).contact_id as string | null) ?? resolvedContactId
          await svc.from("conversations").update({
            last_message_at: nowIso,
            message_count: (Number((existing as any).message_count) || 0) + 1,
            unread_count: (Number((existing as any).unread_count) || 0) + 1,
            // A thread captured before identity resolution existed gets its
            // contact bound on the next inbound DM.
            ...(!(existing as any).contact_id && resolvedContactId
              ? { contact_id: resolvedContactId }
              : {}),
            context_data: {
              page_id: ev.pageId, sender_id: ev.senderId, platform: ev.platform,
              last_message: ev.text,
            },
            updated_at: nowIso,
          }).eq("id", (existing as any).id)
        } else {
          const { data: createdConv } = await svc.from("conversations").insert({
            brokerage_id: brokerageId,
            agent_id: threadAgentId,
            contact_id: resolvedContactId,
            type: "social_dm",
            status: "active",
            last_message_at: nowIso,
            message_count: 1,
            unread_count: 1,
            context_data: {
              page_id: ev.pageId, sender_id: ev.senderId, platform: ev.platform,
              account_name: (account as any)?.account_name ?? null,
              last_message: ev.text,
            },
          }).select("id").single()
          conversationId = ((createdConv as any)?.id as string | null) ?? null
          conversationContactId = resolvedContactId
        }

        // THE TIMELINE ROW (owner rule: the unified inbox carries social DMs) —
        // every DM lands in messages, the ONE timeline table; once the thread
        // is linked to a contact, the DM appears on that contact's inbox.
        if (conversationId) {
          await svc.from("messages").insert({
            conversation_id: conversationId,
            contact_id: conversationContactId,
            brokerage_id: brokerageId,
            agent_id: threadAgentId,
            type: "social_dm",
            direction: "inbound",
            sender_type: "contact",
            body: ev.text ?? "",
            status: "delivered",
            created_at: nowIso,
            updated_at: nowIso,
          }).then(() => {}, () => {})
        }
      } catch { /* per-event best-effort — the ack stands */ }
    }
  }

  return NextResponse.json({ received: true })
}
