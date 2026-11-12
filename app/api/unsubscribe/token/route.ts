/**
 * app/api/unsubscribe/token/route.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PUBLIC MAIL OPT-OUT ENDPOINT. Credential: the token printed on the mail
 * piece, and nothing else.
 *
 *   GET  /api/unsubscribe/token?token=K7M2N-P4RQ8-TVWX   → is this code real?
 *   POST /api/unsubscribe/token  { token, request }      → suppress
 *
 * UNAUTHENTICATED BY DESIGN. The caller is a member of the public holding a
 * postcard; there is no session to check and demanding one would defeat the
 * purpose. That makes TOKEN ENTROPY the security boundary (70 bits, minted by
 * pgcrypto — see the m493 migration) and this rate limiter defence in depth.
 *
 * WHAT THE ENDPOINT NEVER ACCEPTS FROM THE CALLER: a brokerage id, a lead id, a
 * contact id, a recipient id, an email or a phone. Every one of those is read
 * OFF the row the token resolves to. There is therefore no parameter an attacker
 * can vary to reach a second person — which is precisely the property the legacy
 * `?contactId=` shape does not have.
 *
 * WHAT AN ATTACKER WITH ONE VALID TOKEN CAN REACH: exactly one recipient of one
 * campaign, and exactly one action against them — suppression, i.e. the thing
 * that recipient is entitled to ask for. No read of their address, email or
 * phone (the resolver does not select those columns, and the responses below
 * carry only a first name, which is printed on the piece the caller is holding).
 * No write to any other row. No way to walk to a sibling recipient.
 *
 * GET IS READ-ONLY AND POST IS THE ONLY WRITE. Deliberate: link scanners in
 * corporate mail gateways and chat clients fetch URLs, and an opt-out that fires
 * on GET would suppress people who never asked. The page below therefore
 * confirms before it posts.
 */

import { NextRequest, NextResponse } from "next/server"
import { checkPublicRateLimit, publicCallerIp } from "@/lib/security/public-rate-limit"
import {
  resolveMailUnsubscribeToken,
  applyMailUnsubscribe,
  type MailUnsubRequest,
} from "@/lib/direct-mail/mail-unsubscribe"

/** Generous — this is a read, and someone retyping a code off paper will fumble it. */
const PREVIEW_LIMIT = { limit: 40, windowMs: 60_000 }
/** Tight — this one writes. A real person needs it once. */
const APPLY_LIMIT = { limit: 10, windowMs: 60_000 }

export async function GET(req: NextRequest) {
  const ip = await publicCallerIp()
  const verdict = checkPublicRateLimit("mail-unsub-preview", ip, PREVIEW_LIMIT)
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please wait a moment and try again." },
      { status: 429, headers: { "Retry-After": String(verdict.retryAfterSeconds) } },
    )
  }

  const token = req.nextUrl.searchParams.get("token")
  const resolved = await resolveMailUnsubscribeToken(token)

  if (!resolved.ok) {
    // "unreadable" is the database refusing, NOT a bad code. It must be a 5xx the
    // person can retry — telling a real recipient their printed code is invalid
    // because our read failed is how an opt-out request gets abandoned.
    if (resolved.reason === "unreadable") {
      return NextResponse.json({ error: "We could not check that code right now. Please try again." }, { status: 503 })
    }
    return NextResponse.json({ valid: false }, { status: 404 })
  }

  // Only what is already printed on the piece in the caller's hand.
  return NextResponse.json({
    valid: true,
    firstName: resolved.recipient.firstName,
    alreadyUnsubscribed: resolved.recipient.alreadyUnsubscribedAt !== null,
  })
}

export async function POST(req: NextRequest) {
  const ip = await publicCallerIp()
  const verdict = checkPublicRateLimit("mail-unsub-apply", ip, APPLY_LIMIT)
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Please wait a moment and try again." },
      { status: 429, headers: { "Retry-After": String(verdict.retryAfterSeconds) } },
    )
  }

  let body: { token?: unknown; request?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 })
  }

  const token = typeof body.token === "string" ? body.token : null
  // Anything that is not the explicit global request is the narrow one. An
  // unrecognised value must never widen a suppression the person did not ask for.
  const request: MailUnsubRequest = body.request === "all" ? "all" : "mail"

  const result = await applyMailUnsubscribe({ rawToken: token, request })

  if (!result.ok) {
    if (result.reason === "malformed" || result.reason === "not_found") {
      return NextResponse.json({ error: "That code was not recognised." }, { status: 404 })
    }
    // "unreadable" and "write_refused" are OUR failure. A 5xx, and the detail is
    // logged rather than returned — the person cannot act on it and it describes
    // our schema.
    console.error("[/api/unsubscribe/token] refusing to report success:", result.reason, result.error)
    return NextResponse.json(
      { error: "We could not record that right now. Please try again, or reply to the mail piece." },
      { status: 503 },
    )
  }

  return NextResponse.json({
    success: true,
    firstName: result.firstName ?? null,
    channels: result.channelsSuppressed,
    alreadyUnsubscribed: result.alreadyApplied,
    // Surfaced, not swallowed: the person is told plainly when the request was
    // recorded but nothing can enforce it automatically.
    warning: result.bindingGap ?? null,
  })
}
