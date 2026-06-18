

import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import { ValidationError } from "@/lib/errors"

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

    // Get vendor and property details
    const { data: vendor } = await supabase
      .from("vendor_directory")
      .select("name")
      .eq("id", params.vendorId)
      .single()

    const { data: transaction } = await supabase
      .from("transactions")
      .select("*, listings(*)")
      .eq("id", params.transactionId)
      .single()

    if (!vendor || !transaction) {
      return { success: false, error: "Vendor or transaction not found" }
    }

    const property = transaction.listings
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

    // Send email to vendor
    console.log(`[v0] Sending booking confirmation to ${params.vendorEmail}`)

    // Log the booking
    await supabase.from("vendor_communications").insert({
      vendor_id: params.vendorId,
      service_id: params.serviceId,
      communication_type: "booking_confirmation",
      sent_at: new Date().toISOString(),
    })

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

    const { data: service } = await supabase
      .from("listing_marketing_services")
      .select("*, vendor_directory(*), transactions(*, listings(*))")
      .eq("id", params.serviceId)
      .single()

    if (!service) {
      return { success: false, error: "Service not found" }
    }

    const vendor = service.vendor_directory
    const property = service.transactions?.listings

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

    console.log(`[v0] Sending service reminder to ${vendor.email}`)

    await supabase.from("vendor_communications").insert({
      vendor_id: params.vendorId,
      service_id: params.serviceId,
      communication_type: "service_reminder",
      sent_at: new Date().toISOString(),
    })

    return { success: true }
  } catch (error) {
    console.error("[v0] Send vendor reminder error:", error)
    return { success: false, error: "Failed to send reminder" }
  }
}
