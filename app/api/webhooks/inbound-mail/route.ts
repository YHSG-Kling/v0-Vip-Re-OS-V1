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
      // Persist the new history_id so the next push starts from here
      const supabase = createServiceClient()
      await supabase
        .from("platform_credentials")
        .update({ config: { ...resolvedCredential.config, history_id: instruction.historyId } })
        .eq("id", resolvedCredential.credential_id)
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
    // emailing an offer is NOT a known contact). If this is an offer for an in-house listing
    // (matched by address, not sender), the offer flow owns it: auto-ingest when the buyer is a
    // known sender contact, else surface a one-tap confirm to the listing agent. Best-effort.
    if (brokerageId && email.attachments.some((a) => a.mime === "application/pdf")) {
      try {
        const { tryIngestInboundOffer } = await import("@/lib/inbound-mail/offer-intake")
        const intake = await tryIngestInboundOffer({
          brokerageId,
          subject:         email.subject ?? null,
          bodyText:        email.bodyText ?? null,
          fromEmail:       email.fromEmail ?? null,
          senderContactId: contactId,
          attachments:     email.attachments.map((a) => ({ fileName: a.fileName, mime: a.mime, contentB64: a.contentB64 ?? null })),
        }, supabase)
        if (intake.handled) {
          results.push({ email_from: email.fromEmail, uploads: 0 })
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
          await ingestPortalLead(supabase, brokerageId, portalLead, resolvedCredential?.agent_user_id ?? null)
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
      let storageUrl: string | null = null
      if (!upErr && up) {
        const { data: pub } = supabase.storage.from("documents").getPublicUrl(up.path)
        storageUrl = pub.publicUrl ?? null
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
