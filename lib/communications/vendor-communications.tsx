

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import { ValidationError } from "@/lib/errors"

/**
 * A PostgREST embed arrives as an OBJECT for a many-to-one relation and an
 * ARRAY for a one-to-many, and supabase-js types the ambiguous ones as arrays.
 * Both reads below embed through a plain FK, so at runtime they are objects —
 * but writing `x.address` against an array-typed value is a compile error, and
 * silencing it with a cast would be asserting a shape rather than handling one.
 * This narrows honestly and works whichever shape actually arrives.
 *
 * It exists because the selects here were changed from `select("*")` to named
 * columns. The star returned `any`, so this mismatch was invisible: the drift
 * guard could not see the columns AND the type checker could not see the shape.
 */
function firstEmbedded<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

/**
 * Send booking confirmation to vendor for marketing service
 */
export async function sendVendorBookingConfirmation(params: {
  vendorId: string
  vendorEmail: string
  serviceType: string
  transactionId: string
  serviceId: string
  scheduledDate?: string
}): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isValidUUID(params.vendorId)) {
      throw new ValidationError("Invalid vendor ID")
    }

    const supabase = await createClient()

    // Get vendor and property details — vendors replaced vendor_directory — vendor_directory
    // was a writer-less legacy twin (burn-down round 4 repoint); bookings' vendor_id FKs vendors.id
    const { data: vendor } = await supabase
      .from("vendors")
      .select("name")
      .eq("id", params.vendorId)
      .single()

    // The tenant of the ledger row below is derived from this read, so its error
    // is destructured: supabase-js RESOLVES a refused query, and an un-checked
    // `{ data }` would turn "permission denied" into an indistinguishable
    // "not found" — on the one read that decides which brokerage owns the record.
    const { data: transaction, error: txError } = await supabase
      .from("transactions")
      // NAMED, not starred. `select("*")` inside an embed is invisible to the
      // schema-drift guard, which is how brokerages.address survived as a
      // phantom for its whole life — the guard can only check a column it can
      // see. Every column below was verified against the live schema before it
      // was written here, and the set is exactly what this function reads:
      // brokerage_id for the tenant stamp, listings.address/city for the email.
      // The relation resolves through the single FK transactions.listing_id →
      // listings.id (checked: one FK, so no PGRST201 ambiguity).
      .select("id, brokerage_id, listing_id, listings(id, address, city)")
      .eq("id", params.transactionId)
      .single()

    if (txError && txError.code !== "PGRST116") {
      console.error("[v0] Vendor booking: transaction read refused:", txError.message)
      return { success: false, error: "Could not load the transaction for this booking" }
    }

    if (!vendor || !transaction) {
      return { success: false, error: "Vendor or transaction not found" }
    }

    // ── TENANT OF THIS DELIVERY LEDGER ROW ────────────────────────────────────
    // VERDICT: STAMP. A vendor communication is TENANT data, not platform data.
    // The distinction the repo already draws is on the vendor, not on the
    // booking: `vendors` (which replaced the writer-less `vendor_directory`) is
    // itself brokerage-scoped but keeps a shared lane — `vendors_tenant_select`
    // is `brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()`, so
    // a NULL-brokerage vendor is a SHARED directory entry several brokerages may
    // book. What is never shared is the BOOKING: this row records that THIS
    // brokerage engaged that vendor for that listing on that date.
    //
    // Therefore the tenant is the TRANSACTION's, not the vendor's. That matters,
    // because the live BEFORE INSERT trigger `vendor_communications_set_brokerage()`
    // back-fills from `vendors.brokerage_id` — precisely the wrong source for a
    // shared vendor, where it yields NULL. The trigger only fires
    // `IF NEW.brokerage_id IS NULL`, so an explicit stamp pre-empts it.
    //
    // Leaving it NULL does not hide the row. `vc_select` is
    // `is_platform_admin() OR brokerage_id IS NULL OR has_brokerage_access(...)`,
    // granted to `authenticated` — so an unstamped row is PUBLISHED to every
    // signed-in user of every other brokerage.
    const brokerageId: string | null = (transaction as any).brokerage_id ?? null
    if (!brokerageId) {
      // Refused rather than sent-and-filed-untenanted: dispatchEmail needs a real
      // brokerage for its autonomy/budget gates anyway, so this fails closed on
      // both halves instead of publishing the ledger row to the whole platform.
      return {
        success: false,
        error: "This transaction has no brokerage, so the booking cannot be sent or recorded",
      }
    }

    const property = firstEmbedded(transaction.listings)
    const scheduledDate = params.scheduledDate
      ? new Date(params.scheduledDate).toLocaleDateString()
      : "TBD"

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #16a34a;">New Service Booking Confirmation</h2>
        <p>Hi ${vendor.name},</p>
        <p>You've received a new booking request:</p>
        
        <div style="background: #f0fdf4; border-left: 4px solid #16a34a; padding: 16px; margin: 20px 0;">
          <p><strong>Service:</strong> ${params.serviceType}</p>
          <p><strong>Property:</strong> ${property?.address || "N/A"}</p>
          <p><strong>City:</strong> ${property?.city || "N/A"}</p>
          <p><strong>Scheduled Date:</strong> ${scheduledDate}</p>
          <p><strong>Booking ID:</strong> ${params.serviceId}</p>
        </div>

        <p><strong>Next Steps:</strong></p>
        <ul>
          <li>Review the booking details</li>
          <li>Confirm your availability</li>
          <li>Coordinate with the listing agent</li>
        </ul>

        <p>Thank you for your service!</p>
      </div>
    `

    // REAL SEND through the canonical email gate (this function used to
    // console.log "Sending" and log a false 'sent' row — open-loop sweep).
    // Vendors are B2B service partners, not contacts/leads, so no contactId.
    const { dispatchEmail } = await import("@/lib/providers/dispatch")
    const send = await dispatchEmail({
      brokerageId,
      from: "",
      to: params.vendorEmail,
      subject: `New booking — ${params.serviceType}${property?.address ? ` at ${property.address}` : ""}`,
      html: emailHtml,
      channelPurpose: "transactional",
      systemSource: "vendor_booking_confirmation",
    })
    if (!send.success) {
      return { success: false, error: send.error ?? "Email dispatch failed" }
    }

    // Delivery ledger — written ONLY after a real successful dispatch.
    //
    // The error is destructured for that exact reason: the mail HAS gone out by
    // this line, so a silently-refused insert means a real message with no record
    // of it. supabase-js resolves a refused insert, and the enclosing try/catch
    // would never have seen it. The send is not un-done (it cannot be), but the
    // gap is reported instead of vanishing.
    const { error: ledgerError } = await supabase.from("vendor_communications").insert({
      brokerage_id: brokerageId,
      vendor_id: params.vendorId,
      service_id: params.serviceId,
      communication_type: "booking_confirmation",
      sent_at: new Date().toISOString(),
    })
    if (ledgerError) {
      console.error(
        `[v0] Vendor booking confirmation SENT to ${params.vendorEmail} but the delivery-ledger write was refused (service ${params.serviceId}):`,
        ledgerError.message,
      )
    }

    return { success: true }
  } catch (error) {
    console.error("[v0] Send vendor booking confirmation error:", error)
    return { success: false, error: "Failed to send booking confirmation" }
  }
}

/**
 * Send service completion reminder to vendor
 */
export async function sendVendorServiceReminder(params: {
  vendorId: string
  serviceId: string
  daysUntilDue: number
}): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isValidUUID(params.vendorId)) {
      throw new ValidationError("Invalid vendor ID")
    }

    const supabase = await createClient()

    // Live FK: listing_marketing_services.vendor_id → vendors(id) — the old
    // vendor_directory embed had no FK to resolve, so PostgREST errored this
    // whole select and the reminder could never send (round-4 repoint).
    // Error destructured — this read is the tenant source for the ledger row
    // below, and a refused query resolves rather than throwing (see the note in
    // sendVendorBookingConfirmation above).
    const { data: service, error: serviceError } = await supabase
      .from("listing_marketing_services")
      // NAMED for the same reason as the booking read above: a starred embed is
      // a blind spot in the drift guard, not a convenience. All three relations
      // were checked live and each resolves through exactly ONE foreign key —
      // listing_marketing_services.vendor_id → vendors.id,
      // listing_marketing_services.transaction_id → transactions.id,
      // transactions.listing_id → listings.id — so none of them can raise
      // PGRST200 (no relation) or PGRST201 (ambiguous, needs a !hint).
      // ONE STRING LITERAL, not a concatenation: supabase-js parses the select
      // at the type level, and a concatenated expression is opaque to it — the
      // whole row degrades to GenericStringError and every field read goes red.
      .select("id, service_type, status, brokerage_id, vendor_id, transaction_id, vendors(id, name, email), transactions(id, brokerage_id, listing_id, listings(id, address))")
      .eq("id", params.serviceId)
      .single()

    if (serviceError && serviceError.code !== "PGRST116") {
      console.error("[v0] Vendor reminder: service read refused:", serviceError.message)
      return { success: false, error: "Could not load the service for this reminder" }
    }

    if (!service) {
      return { success: false, error: "Service not found" }
    }

    const vendor = firstEmbedded(service.vendors)
    const transaction = firstEmbedded(service.transactions)
    const property = firstEmbedded(transaction?.listings)

    // ── TENANT OF THIS DELIVERY LEDGER ROW ────────────────────────────────────
    // VERDICT: STAMP, on the same reasoning recorded in
    // sendVendorBookingConfirmation above — the vendor may be a shared directory
    // entry, but the engagement this row records belongs to one brokerage.
    //
    // `listing_marketing_services` carries its own `brokerage_id` (back-filled by
    // the live `listing_marketing_services_set_brokerage_trg`), so the service row
    // is the nearest tenant of record; the parent transaction is the fallback.
    // Neither is caller-supplied: both are read from the row named by serviceId.
    // Reads the NORMALIZED transaction, not `service.transactions` directly: the
    // embed can arrive as an array, and `arr?.brokerage_id` is `undefined` — so
    // the fallback would have silently stopped working while still looking correct.
    const brokerageId: string | null =
      (service.brokerage_id ?? transaction?.brokerage_id) || null
    if (!brokerageId) {
      return {
        success: false,
        error: "This service has no brokerage, so the reminder cannot be sent or recorded",
      }
    }

    // The vendor is checked BEFORE the message is composed, not after. This
    // reminder is addressed to them by name and sent to their address; if the
    // vendor row could not be resolved there is no one to send it to, and
    // building the body first only defers the same refusal past the point where
    // it reads as an error about the message rather than about the recipient.
    if (!vendor?.email) {
      return { success: false, error: "Vendor has no email on file" }
    }

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #ea580c;">Service Reminder</h2>
        <p>Hi ${vendor.name},</p>
        <p>This is a reminder about an upcoming service deadline:</p>
        
        <div style="background: #fff7ed; border-left: 4px solid #ea580c; padding: 16px; margin: 20px 0;">
          <p><strong>Service:</strong> ${service.service_type}</p>
          <p><strong>Property:</strong> ${property?.address || "N/A"}</p>
          <p><strong>Days Until Due:</strong> ${params.daysUntilDue}</p>
          <p><strong>Status:</strong> ${service.status}</p>
        </div>

        <p>Please ensure the service is completed on time.</p>
      </div>
    `

    // REAL SEND through the canonical email gate (used to console.log only).
    // The vendor/email check that used to sit here has moved ABOVE the body —
    // same refusal, raised before the work rather than after it.
    const { dispatchEmail } = await import("@/lib/providers/dispatch")
    const send = await dispatchEmail({
      brokerageId,
      from: "",
      to: vendor.email,
      subject: `Service reminder — ${service.service_type} due in ${params.daysUntilDue} day${params.daysUntilDue === 1 ? "" : "s"}`,
      html: emailHtml,
      channelPurpose: "transactional",
      systemSource: "vendor_service_reminder",
    })
    if (!send.success) {
      return { success: false, error: send.error ?? "Email dispatch failed" }
    }

    // Delivery ledger — written ONLY after a real successful dispatch. Error
    // checked for the same reason as the booking ledger above: the reminder has
    // already left, so a silently-refused row is a sent message with no record.
    const { error: ledgerError } = await supabase.from("vendor_communications").insert({
      brokerage_id: brokerageId,
      vendor_id: params.vendorId,
      service_id: params.serviceId,
      communication_type: "service_reminder",
      sent_at: new Date().toISOString(),
    })
    if (ledgerError) {
      console.error(
        `[v0] Vendor service reminder SENT to ${vendor.email} but the delivery-ledger write was refused (service ${params.serviceId}):`,
        ledgerError.message,
      )
    }

    return { success: true }
  } catch (error) {
    console.error("[v0] Send vendor reminder error:", error)
    return { success: false, error: "Failed to send reminder" }
  }
}
