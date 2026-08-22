/**
 * Inbound email webhook — provider-aware AND per-user-aware.
 *
 * Two classes of provider handled in one endpoint:
 *
 *   TRANSACTIONAL (HMAC-signed payload):
 *     postmark / sendgrid / mailgun / resend
 *   PER-USER OAUTH (push notification → API fetch):
 *     gmail / outlook
 *
 * Per-user resolution: the provider settings come from the USER, not the
 * brokerage. Independent-contractor agents + team leads use Gmail / Outlook
 * (their own); brokerage staff use the transactional provider on the
 * brokerage's domain. lib/inbound-mail/resolve-user-provider.ts walks the
 * cascade (user → team → brokerage) to find the right credential row.
 */

import { type NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  detectInboundProvider, parseInbound, parseFetchInstruction, verifyInbound,
  type ParsedInboundEmail,
} from "@/lib/inbound-mail/providers"
import { issueBucketObjectUrl } from "@/lib/storage/document-buckets"
import { removeOrRecordOrphan } from "@/lib/storage/put-and-sign"
import { resolveUserByInboundIdentifier } from "@/lib/inbound-mail/resolve-user-provider"
import { fetchGmailMessagesSinceHistory, fetchOutlookMessage } from "@/lib/inbound-mail/oauth-fetchers"

export async function POST(request: NextRequest) {
  const rawBody = await request.text()

  // Outlook subscription-validation handshake: Microsoft Graph sends a single
  // POST with ?validationToken=<random> when creating a subscription. We
  // must echo it back as text/plain to complete the handshake.
  const url = new URL(request.url)
  const validationToken = url.searchParams.get("validationToken")
  if (validationToken) {
    return new Response(validationToken, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    })
  }

  // 1) Detect provider — works for both classes
  const provider = detectInboundProvider(request.headers, rawBody)
  if (!provider) {
    return NextResponse.json({ error: "No recognized inbound-email provider in this request" }, { status: 401 })
  }

  // 2) Verify the request (HMAC for transactional, JWT-or-clientState for OAuth)
  if (!verifyInbound(provider, rawBody, request.headers)) {
    return NextResponse.json({ error: `Invalid ${provider} signature` }, { status: 401 })
  }

  // 3) Get parsed emails. Two paths:
  //    TRANSACTIONAL: parseInbound returns the full email payload directly.
  //    OAUTH (gmail/outlook): parseFetchInstruction returns the IDs we need
  //      to fetch the actual messages via the user's stored OAuth tokens.
  let emails: ParsedInboundEmail[] = []
  let resolvedCredential = null as Awaited<ReturnType<typeof resolveUserByInboundIdentifier>>

  if (provider === "gmail" || provider === "outlook") {
    const instruction = parseFetchInstruction(provider, rawBody)
    if (!instruction) {
      return NextResponse.json({ error: `Could not parse ${provider} notification` }, { status: 400 })
    }
    // Identify the user — Gmail by inboxEmail, Outlook by clientState
    resolvedCredential = await resolveUserByInboundIdentifier({
      platform:           provider,
      inboxEmail:         instruction.inboxEmail,
      outlookClientState: instruction.outlookClientState,
    })
    if (!resolvedCredential) {
      return NextResponse.json({ error: `No user inbox registered for this ${provider} notification` }, { status: 404 })
    }
    if (provider === "gmail" && instruction.historyId) {
      emails = await fetchGmailMessagesSinceHistory({
        credential:   resolvedCredential,
        newHistoryId: instruction.historyId,
      })
      // Persist the new history_id so the next push starts from here.
      //
      // NOT optional, and the result is now read. This is Gmail's incremental
      // sync cursor: if the write is lost the next push notification replays
      // from the OLD history_id, so the same inbound emails are fetched and
      // processed again. The failure mode is duplicate inbound handling, which
      // is exactly the sort of thing that looks like a mystery rather than a
      // bug — and supabase-js resolves a rejected update, so nothing surfaced.
      const supabase = createServiceClient()
      const { error: cursorError } = await supabase
        .from("platform_credentials")
        .update({ config: { ...resolvedCredential.config, history_id: instruction.historyId } })
        .eq("id", resolvedCredential.credential_id)
      if (cursorError) {
        console.error(
          `[inbound-mail] Gmail history cursor NOT advanced for credential ${resolvedCredential.credential_id} — the next push will replay:`,
          cursorError.message,
        )
      }
    } else if (provider === "outlook" && instruction.outlookResource) {
      const one = await fetchOutlookMessage({
        credential:  resolvedCredential,
        resourceUrl: instruction.outlookResource,
      })
      if (one) emails = [one]
    }
  } else {
    // TRANSACTIONAL provider — body is the email itself
    const parsed = parseInbound(provider, rawBody)
    if (!parsed) {
      return NextResponse.json({ error: `Could not parse ${provider} body` }, { status: 400 })
    }
    emails = [parsed]
    // For transactional, resolve user/brokerage by recipient address
    resolvedCredential = await resolveUserByInboundIdentifier({
      platform:  provider,
      toAddress: parsed.toEmail,
    })
  }

  if (emails.length === 0) {
    return NextResponse.json({ ok: true, provider, action: "no_new_messages" })
  }

  // 4) For each email: identify the contact (by FROM or TO) within the
  //    resolved brokerage, then upload each attachment through the universal
  //    helper (scanner fires automatically).
  const supabase = createServiceClient()
  const { uploadDocument } = await import("@/lib/documents/upload-document")
  const results: Array<{ email_from: string; uploads: number }> = []

  for (const email of emails) {
    if (email.attachments.length === 0) {
      results.push({ email_from: email.fromEmail, uploads: 0 })
      continue
    }

    // Determine brokerage scope. For OAuth: from resolvedCredential.brokerage_id.
    // For transactional: from the matched credential OR via contact lookup.
    let brokerageId = resolvedCredential?.brokerage_id ?? null
    let contactId: string | null = null

    if (email.fromEmail) {
      if (brokerageId) {
        // Tenant already established by the credential — resolve the sender WITHIN it.
        const { data: c } = await supabase
          .from("contacts")
          .select("id")
          .eq("brokerage_id", brokerageId)
          .eq("email", email.fromEmail)
          .maybeSingle()
        if (c) contactId = c.id as string
      } else {
        // No credential-derived tenant, so the sender's email is all we have to go on.
        // An email address is not unique across tenants: the same person can be a
        // contact at two brokerages, and .maybeSingle() would have handed us whichever
        // row came back first — which then became `brokerageId` for the entire flow
        // below (offer intake, document upload, transaction routing). One shared
        // address filed another tenant's documents.
        //
        // Take the match only when it is UNAMBIGUOUS. Two or more tenants claiming the
        // sender means we cannot know whose mail this is, and guessing is the bug.
        const { data: matches } = await supabase
          .from("contacts")
          .select("id, brokerage_id")
          .eq("email", email.fromEmail)
          .limit(2)
        const rows = (matches ?? []) as Array<{ id: string; brokerage_id: string }>
        const tenants = new Set(rows.map((r) => r.brokerage_id))
        if (rows.length === 1 || (rows.length > 1 && tenants.size === 1)) {
          contactId = rows[0].id
          brokerageId = rows[0].brokerage_id
        } else if (tenants.size > 1) {
          console.warn(
            `[inbound-mail] sender ${email.fromEmail} is a contact at ${tenants.size} brokerages — ` +
            "refusing to guess a tenant; skipping this message",
          )
        }
      }
    }
    if (!contactId && email.toEmail && brokerageId) {
      const { data: c } = await supabase
        .from("contacts")
        .select("id")
        .eq("brokerage_id", brokerageId)
        .eq("email", email.toEmail)
        .maybeSingle()
      if (c) contactId = c.id as string
    }

    // EMAIL → OFFER lookout (runs BEFORE the known-contact requirement, since an outside agent
    // emailing an offer is NOT a known contact).
    //
    // WHOSE MAILBOX THIS IS, PASSED THROUGH (wave 12, R1). This route already
    // resolves the credential that owns the inbox and used to hand the offer
    // lane only the SENDER — the one identity an outside buyer's agent does not
    // have with us. The mailbox owner is the authority the owner's ruling names:
    // watch the LISTING AGENT's inbox for the listing's address. `agent_user_id`
    // is a `users.id` and `listings.agent_id` is an `agents.id`; the intake
    // RESOLVES between them and never coalesces one into the other.
    //
    // The transactional lane frequently resolves no agent at all. That is passed
    // through as null, and the intake keeps its brokerage-wide fallback and
    // records that the match was unkeyed — the working path is not deleted.
    const mailbox = {
      userId:  resolvedCredential?.agent_user_id ?? null,
      address: resolvedCredential?.account_id ?? email.toEmail ?? null,
    }
    if (brokerageId && email.attachments.some((a) => a.mime === "application/pdf")) {
      try {
        const { tryIngestInboundOffer, tryRouteOutboundOfferReply } = await import("@/lib/inbound-mail/offer-intake")
        const intake = await tryIngestInboundOffer({
          brokerageId,
          subject:         email.subject ?? null,
          bodyText:        email.bodyText ?? null,
          fromEmail:       email.fromEmail ?? null,
          senderContactId: contactId,
          mailbox,
          attachments:     email.attachments.map((a) => ({ fileName: a.fileName, mime: a.mime, contentB64: a.contentB64 ?? null })),
        }, supabase)
        if (intake.handled) {
          results.push({ email_from: email.fromEmail, uploads: 0 })
          continue
        }
        // THE OUTBOUND RECIPROCAL (wave 12, R2). We sent our buyer's offer OUT to
        // an outside listing agent; this is their reply coming back. It cannot
        // reach the branch above: an outside listing has no `listings` row, so
        // `offers.listing_id` is null and there is nothing for the address match
        // to compare against. The counterparty address recorded at send time is
        // the only key this mail will ever have.
        const replied = await tryRouteOutboundOfferReply({
          brokerageId,
          subject:     email.subject ?? null,
          fromEmail:   email.fromEmail ?? null,
          mailbox,
          attachments: email.attachments.map((a) => ({ fileName: a.fileName, mime: a.mime, contentB64: a.contentB64 ?? null })),
        }, supabase)
        if (replied.handled) {
          results.push({ email_from: email.fromEmail, uploads: replied.documentIds?.length ?? 0 })
          continue
        }
        // Not an offer — but maybe another deal doc (signed contract / inspection / appraisal /
        // lender CTC / disclosure) for an in-house listing. Classify + route to the owning manager's
        // agent (confirm-first; we don't auto-file a transaction doc from an email).
        const { routeInboundDealDoc } = await import("@/lib/inbound-mail/deal-doc-intake")
        const routed = await routeInboundDealDoc({
          brokerageId,
          subject:     email.subject ?? null,
          bodyText:    email.bodyText ?? null,
          fromEmail:   email.fromEmail ?? null,
          attachments: email.attachments.map((a) => ({ fileName: a.fileName, mime: a.mime, contentB64: a.contentB64 ?? null })),
        }, supabase)
        if (routed.handled) {
          results.push({ email_from: email.fromEmail, uploads: 0 })
          continue
        }
      } catch (e) {
        console.error("[inbound-mail] offer/deal-doc intake failed (non-fatal):", e)
      }
    }

    // PORTAL LEAD intake (Zillow / realtor.com / Opcity notification emails the
    // tenant auto-forwards here) — runs BEFORE the known-contact requirement,
    // since the sender is the portal, never a contact. Conservative detection;
    // a hit lands in the GATED lead pipeline (raw → dedupe → suppression →
    // promotion → speed-to-lead). Best-effort.
    if (brokerageId) {
      try {
        const { parsePortalLeadEmail, ingestPortalLead } = await import("@/lib/lead-pipeline/portal-lead-intake")
        const portalLead = parsePortalLeadEmail({
          fromEmail: email.fromEmail ?? null,
          subject: email.subject ?? null,
          bodyText: email.bodyText ?? null,
        })
        if (portalLead) {
          // The mailbox OWNER is the agent the portal routed this lead to — the
          // contact is created assigned to them (owner's rule: portal leads are
          // agent-assigned contacts, never cold raw leads).
          await ingestPortalLead(supabase, brokerageId, portalLead, mailbox.userId)
          results.push({ email_from: email.fromEmail, uploads: 0 })
          continue
        }
      } catch (e) {
        console.error("[inbound-mail] portal-lead intake failed (non-fatal):", e)
      }
    }

    if (!contactId || !brokerageId) {
      results.push({ email_from: email.fromEmail, uploads: 0 })
      continue
    }

    // Pre-link to the contact's most-recent open offer when no ref:offer in subject
    let offerId: string | null = null
    const subjMatch = email.subject.match(/ref:offer:([0-9a-f-]{36})/i)
    if (subjMatch) {
      offerId = subjMatch[1]
    } else {
      const { data: openOffer } = await supabase
        .from("offers")
        .select("id")
        .eq("brokerage_id", brokerageId)
        .eq("contact_id", contactId)
        .in("status", ["submitted","accepted","countered"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      offerId = (openOffer?.id as string | null) ?? null
    }

    let uploaded = 0
    for (const att of email.attachments) {
      if (!att.contentB64) continue
      const buf  = Buffer.from(att.contentB64, "base64")
      const safe = att.fileName.replace(/[^a-zA-Z0-9._-]/g, "_")
      const path = `${brokerageId}/${contactId}/${Date.now()}_${safe}`
      const { data: up, error: upErr } = await supabase.storage
        .from("documents")
        .upload(path, buf, { contentType: att.mime, upsert: false })
      // An emailed-in attachment is whatever the counterparty sent — a signed
      // contract, an addendum, a client's bank letter. getPublicUrl put every
      // one at a permanent, unauthenticated URL that the row then persisted.
      // One issuer, fail closed: no signed URL → the bytes are removed and the
      // attachment is skipped, never filed behind a public link.
      let storageUrl: string | null = null
      if (!upErr && up) {
        const issued = await issueBucketObjectUrl(supabase as never, { bucket: "documents", objectPath: up.path })
        if (issued.ok) {
          storageUrl = issued.url
        } else {
          console.error(`[inbound-mail] ${issued.reason}`)
          await removeOrRecordOrphan(supabase as never, {
            bucket: "documents", objectPath: up.path,
            reason: "inbound_mail_sign_failed", detail: issued.reason,
            brokerageId,
          })
        }
      }
      if (!storageUrl) continue

      const r = await uploadDocument({
        brokerageId,
        storageUrl,
        fileName:     att.fileName,
        documentType: "uploaded_document",
        contactId,
        offerId,
        metadata: {
          source:      "inbound_email",
          provider,
          from_email:  email.fromEmail,
          to_email:    email.toEmail,
          subject:     email.subject,
          mime:        att.mime,
          credential_scope: resolvedCredential?.scope ?? null,
          user_id:     resolvedCredential?.agent_user_id ?? null,
        },
      })
      if (r.success) uploaded++
    }
    results.push({ email_from: email.fromEmail, uploads: uploaded })
  }

  return NextResponse.json({
    ok:                true,
    provider,
    user_scoped:       provider === "gmail" || provider === "outlook",
    credential_scope:  resolvedCredential?.scope ?? null,
    emails_processed:  emails.length,
    results,
  })
}
