// lib/communications/vendor-follow-up-cadence.ts
//
// READER for vendor_communications.sent_at (readerless-write-census) — the
// asset_manager follow-up cadence for booked-but-not-yet-completed marketing
// services. sendVendorServiceReminder (lib/communications/vendor-
// communications.tsx) has always been reachable ONLY from an agent's manual
// "Remind vendor" click; nothing ever nudged the agent, let alone the vendor,
// on its own. This closes that loop: any listing_marketing_services row that
// is booked, scheduled within RE_REMIND_WITHIN_DAYS (or already overdue), and
// not completed gets ONE reminder per RE_REMIND_COOLDOWN_DAYS — the cooldown
// read straight off vendor_communications.sent_at, so a service that was just
// reminded is not reminded again on the next run.
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { sendVendorServiceReminder } from "./vendor-communications"

const RE_REMIND_WITHIN_DAYS = 3
const RE_REMIND_COOLDOWN_DAYS = 2

export async function runVendorFollowUpCadence(
  now: Date = new Date()
): Promise<{ scanned: number; reminded: number; skippedCooldown: number; errors: number }> {
  const supabase = createServiceClient()
  const horizon = new Date(now.getTime() + RE_REMIND_WITHIN_DAYS * 86_400_000).toISOString()

  // Booked, scheduled within the horizon (or already overdue — no lower bound),
  // not yet completed. Explicit columns only.
  const { data: services, error } = await supabase
    .from("listing_marketing_services")
    .select("id, vendor_id, scheduled_date, brokerage_id")
    .not("vendor_id", "is", null)
    .not("scheduled_date", "is", null)
    .is("completed_at", null)
    .lte("scheduled_date", horizon)

  if (error) {
    console.error("[vendor-follow-up-cadence] service scan refused:", error.message)
    return { scanned: 0, reminded: 0, skippedCooldown: 0, errors: 1 }
  }
  if (!services || services.length === 0) return { scanned: 0, reminded: 0, skippedCooldown: 0, errors: 0 }

  const serviceIds = services.map((s) => s.id)
  const vendorIds = [...new Set(services.map((s) => s.vendor_id as string))]

  // The reader: last reminder sent per SERVICE and per VENDOR, from vendor_communications.
  // vendor_id is read here on purpose (it had only a DB trigger reading it): a vendor
  // booked on three listings must not get three nudges in one morning — the cooldown is
  // theirs, not the service's. Read the error (§3): a refused read is not "no history".
  const { data: comms, error: commsError } = await supabase
    .from("vendor_communications")
    .select("service_id, vendor_id, communication_type, sent_at")
    .in("vendor_id", vendorIds)
    .eq("communication_type", "service_reminder")
    .order("sent_at", { ascending: false })
  if (commsError) {
    console.error("[vendor-follow-up-cadence] vendor_communications read refused:", commsError.message)
    return { scanned: services.length, reminded: 0, skippedCooldown: 0, errors: 1 }
  }

  const lastReminderAt = new Map<string, string>()
  const lastVendorReminderAt = new Map<string, string>()
  for (const c of comms ?? []) {
    if (!c.sent_at) continue
    if (c.service_id && serviceIds.includes(c.service_id) && !lastReminderAt.has(c.service_id)) lastReminderAt.set(c.service_id, c.sent_at)
    if (c.vendor_id && !lastVendorReminderAt.has(c.vendor_id)) lastVendorReminderAt.set(c.vendor_id, c.sent_at)
  }

  let reminded = 0
  let skippedCooldown = 0
  let errors = 0

  for (const svc of services) {
    const last = lastReminderAt.get(svc.id) ?? lastVendorReminderAt.get(svc.vendor_id as string)
    if (last) {
      const daysSinceLast = (now.getTime() - new Date(last).getTime()) / 86_400_000
      if (daysSinceLast < RE_REMIND_COOLDOWN_DAYS) {
        skippedCooldown++
        continue
      }
    }

    const daysUntilDue = Math.max(
      0,
      Math.ceil((new Date(svc.scheduled_date as string).getTime() - now.getTime()) / 86_400_000)
    )

    const result = await sendVendorServiceReminder(
      {
        vendorId: svc.vendor_id as string,
        serviceId: svc.id,
        daysUntilDue,
      },
      supabase
    )
    if (result.success) reminded++
    else errors++
  }

  return { scanned: services.length, reminded, skippedCooldown, errors }
}
