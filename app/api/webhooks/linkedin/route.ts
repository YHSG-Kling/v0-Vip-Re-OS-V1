import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { ingestMessageService } from "@/lib/communication-spine/ingest-message-service"
import crypto from "crypto"

/**
 * LinkedIn webhook — VERIFIED ON BOTH HALVES.
 *
 * Scheme (LinkedIn "Webhooks" → webhook validation, Microsoft Learn,
 * learn.microsoft.com/linkedin/shared/api-guide/webhook-validation, read
 * 2026-09-03 via search excerpt — the host is egress-blocked from this
 * sandbox, so the two rules below are quoted from the indexed page text, and
 * the header handling is deliberately tolerant where the excerpt could be read
 * two ways):
 *
 *   GET  "LinkedIn will use the challengeCode as a query parameter to make an
 *        HTTP GET to your webhook endpoint. Your application must compute the
 *        challengeResponse (hex-encoded HMACSHA256 signature for the
 *        challengeCode) using its clientSecret as the secret key. Return both
 *        the challengeCode and challengeResponse in a JSON payload with a
 *        200 OK status within 3 seconds."
 *   POST "LinkedIn includes an X-LI-Signature header with each POST request.
 *        Combine the literal string hmacsha256= with the raw JSON POST body
 *        to build the string-to-sign. Compute the HMACSHA256 of that string
 *        using your app's clientSecret as the key. Encode the result as a
 *        lowercase hex string." — i.e.
 *        X-LI-Signature = hex(HMACSHA256("hmacsha256=" + rawBody, clientSecret))
 *        compared constant-time; "discard the event if the values do not match".
 *
 * TOLERANCE, stated: the same page is also summarised as "the value is the
 * HMAC-SHA256 hash of the request body, prefixed with hmacsha256=". So the
 * header value may arrive as bare hex OR as "hmacsha256=<hex>"; a leading
 * "hmacsha256=" on the HEADER is stripped before comparison, and the digest is
 * accepted if it matches EITHER the documented string-to-sign (prefix + body)
 * or the body alone. Both candidates require the client secret, so accepting
 * two digests weakens nothing — it only stops a doc ambiguity from refusing
 * LinkedIn itself.
 *
 * FAIL CLOSED (CLAUDE.md §4): LINKEDIN_CLIENT_SECRET unset → 503 on BOTH
 * halves (the old GET answered the challenge with the challengeCode echoed
 * back — a fabricated response LinkedIn rejects anyway, dressed as a 200);
 * header missing/malformed/mismatched → 401. Until 2026-09-03 POST parsed
 * `req.json()` from anyone and filed the result into a tenant's CRM.
 *
 * The signature is over the EXACT bytes LinkedIn sent, so the body is read
 * ONCE with `req.text()` and that string is what gets parsed.
 *
 * LINKEDIN_WEBHOOK_VERIFY_TOKEN — READ, NOT USED, AND WHY IT STAYS (2026-09-03,
 * lane H4). LinkedIn's scheme carries no verify token; the client secret is the
 * only key on both halves, and nothing below consults this value. It is kept
 * because the console contract row for this route
 * (lib/providers/webhook-contract.ts, provider "linkedin", `secretEnv`) still
 * names it, and scripts/webhook-contract-guard.ts:340-341 asserts that every
 * env name on a row is consulted as `process.env.<NAME>` in the route's files —
 * removing the read here alone would turn test:webhook-contract red. The RIGHT
 * fix is to drop the name from the contract row and this read together; the
 * contract module belongs to the integrator, so this stays until that lands.
 */
const VERIFY_TOKEN = process.env.LINKEDIN_WEBHOOK_VERIFY_TOKEN ?? ""
const CLIENT_SECRET = process.env.LINKEDIN_CLIENT_SECRET ?? ""
void VERIFY_TOKEN // contract-row parity only — see the note above

type LinkedInSignatureVerdict =
  | { ok: true }
  | { ok: false; status: 401 | 503; reason: string }

/** Constant-time hex compare; false (never a throw) on any malformed input. */
function safeHexEqual(expectedHex: string, actualHex: string): boolean {
  if (!/^[0-9a-fA-F]+$/.test(expectedHex) || !/^[0-9a-fA-F]+$/.test(actualHex)) return false
  if (expectedHex.length % 2 !== 0 || actualHex.length % 2 !== 0) return false
  try {
    const a = Buffer.from(expectedHex, "hex")
    const b = Buffer.from(actualHex, "hex")
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function verifyLinkedInSignature(rawBody: string, signatureHeader: string | null): LinkedInSignatureVerdict {
  if (!CLIENT_SECRET) {
    return { ok: false, status: 503, reason: "LinkedIn webhook not configured: LINKEDIN_CLIENT_SECRET is unset" }
  }
  const header = (signatureHeader ?? "").trim()
  if (!header) return { ok: false, status: 401, reason: "missing X-LI-Signature" }
  const actual = header.startsWith("hmacsha256=") ? header.slice("hmacsha256=".length) : header
  const candidates = [
    crypto.createHmac("sha256", CLIENT_SECRET).update("hmacsha256=" + rawBody, "utf-8").digest("hex"),
    crypto.createHmac("sha256", CLIENT_SECRET).update(rawBody, "utf-8").digest("hex"),
  ]
  return candidates.some((expected) => safeHexEqual(expected, actual))
    ? { ok: true }
    : { ok: false, status: 401, reason: "invalid X-LI-Signature" }
}

// --- GET: LinkedIn webhook challenge verification ---
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const challengeCode = searchParams.get("challengeCode")

  if (!challengeCode) {
    return NextResponse.json({ error: "Missing challengeCode" }, { status: 400 })
  }
  if (!CLIENT_SECRET) {
    // Honest refusal — an echoed challengeCode is not a challengeResponse.
    return NextResponse.json({ error: "LinkedIn webhook not configured: LINKEDIN_CLIENT_SECRET is unset" }, { status: 503 })
  }

  // hex(HMACSHA256(challengeCode, clientSecret)); LinkedIn wants BOTH fields back.
  const challengeResponse = crypto.createHmac("sha256", CLIENT_SECRET).update(challengeCode).digest("hex")
  return NextResponse.json({ challengeCode, challengeResponse }, { status: 200 })
}

// --- POST: Inbound LinkedIn DM events ---
export async function POST(req: NextRequest) {
  // Raw body FIRST — the signature is over the exact bytes LinkedIn sent.
  const rawBody = await req.text()
  const verdict = verifyLinkedInSignature(rawBody, req.headers.get("x-li-signature"))
  if (!verdict.ok) return NextResponse.json({ error: verdict.reason }, { status: verdict.status })

  let payload: any
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 })
  }

  const events: any[] = payload?.value ?? []

  for (const event of events) {
    // LinkedIn messaging events have conversationId + message.from + message.body
    const senderId: string | undefined =
      event?.message?.from?.replace(/^urn:li:person:/, "") ??
      event?.sender?.replace(/^urn:li:person:/, "")
    const messageText: string | undefined =
      event?.message?.body?.text ?? event?.messageBody?.text ?? event?.message?.body
    const timestamp: number | undefined = event?.createdAt
    // Receiving side of the DM — the connected page/org this event was delivered to.
    // Used to resolve which brokerage owns the conversation.
    const recipientId: string | undefined = (
      event?.message?.to ?? event?.recipient ?? event?.owner ?? undefined
    )?.replace?.(/^urn:li:(person|organization|organizationBrand):/, "")

    if (!senderId || !messageText) continue

    await handleLinkedInDm({
      senderId,
      recipientId,
      messageText,
      timestamp: timestamp ? new Date(timestamp) : new Date(),
    })
  }

  return NextResponse.json({ status: "ok" }, { status: 200 })
}

// ---------------------------------------------------------------------------

async function handleLinkedInDm(params: {
  senderId: string
  recipientId?: string
  messageText: string
  timestamp: Date
}) {
  const { senderId, recipientId, messageText, timestamp } = params
  const svc = createServiceClient()

  // tenant anchor (scope burn-down): resolve which brokerage owns the receiving
  // LinkedIn account so the identity match + new-contact insert are tenant-stamped.
  let brokerageId: string | null = null
  if (recipientId) {
    const { data: acct } = await svc
      .from("social_media_accounts")
      .select("brokerage_id")
      .eq("platform", "linkedin")
      .eq("account_id", recipientId)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle()
    brokerageId = (acct as { brokerage_id: string | null } | null)?.brokerage_id ?? null
  }

  // Look up existing contact by LinkedIn person URN stored in metadata —
  // scoped to the resolved brokerage when the webhook carried one; otherwise the
  // person URN is a unique-ish identity and the match stays capped at one row.
  let contactQuery = svc
    .from("contacts")
    .select("id, brokerage_id")
    .contains("metadata", { linkedin_person_id: senderId })
  // AMBIGUITY IS NOT A MATCH (tenant fail-closed, CLAUDE.md §4). The tenant
  // predicate here is CONDITIONAL — applied only when the receiving account could
  // be mapped to a brokerage — so on the unresolved path the query ran with no
  // tenant boundary at all, on the SERVICE client, and `.limit(1)` then handed back
  // whichever brokerage's row happened to sort first. The same person can be a
  // contact at two brokerages (see app/api/webhooks/inbound-mail/route.ts, which
  // documents exactly that), and this identity feeds a message INSERT — so the
  // wrong first row files a client's inbound DM into another tenant's CRM.
  // limit(2) + "one distinct tenant or nothing" is the rule already in force in
  // app/api/webhooks/sendgrid-events/route.ts; unresolved falls through to the
  // staging insert with a null tenant, which is this handler's documented
  // behaviour for an unmappable account.
    .limit(2)
  if (brokerageId) contactQuery = contactQuery.eq("brokerage_id", brokerageId)
  const { data: contactRows } = await contactQuery
  const candidates = (contactRows ?? []) as Array<{ id: string; brokerage_id: string | null }>
  const contacts = new Set(candidates.map((c) => c.brokerage_id)).size === 1 ? candidates : []

  let contactId: string

  if (contacts.length > 0) {
    contactId = contacts[0].id
  } else {
    // tenant anchor (scope burn-down): stamp the resolved brokerage; when the
    // receiving account can't be mapped the row stays in staging (null tenant)
    // for an admin to assign, same as the Meta webhook.
    const { data: newContact, error } = await svc
      .from("contacts")
      .insert({
        brokerage_id: brokerageId,
        first_name: "LinkedIn",
        last_name: "Lead",
        contact_type: "lead",
        source: "linkedin_dm",
        metadata: { linkedin_person_id: senderId },
      })
      .select("id")
      .single()

    if (error || !newContact) return
    contactId = newContact.id
  }

  await ingestMessageService({
    contactId,
    rawMessage: {
      channel: "social_dm_linkedin",
      from: senderId,
      to: "page",
      body: messageText,
      timestamp,
      metadata: { linkedin_person_id: senderId },
    },
  })
}
