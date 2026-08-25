/**
 * lib/lead-pipeline/contact-signal-rescrape.ts
 *
 * Lifecycle re-scrape hooks — when a contact's actionable signal changes (TCPA consent flips on,
 * deal stage advances to under_contract, an inspection completes, etc.) we fire a targeted
 * re-enrichment / re-valuation rather than waiting for the daily cron sweep. Cheaper than blind
 * sweeps + faster signal-to-action.
 *
 * The map below names every signal that triggers a refresh; the dispatch is a single function
 * `triggerSignalRescrape` callers invoke after the underlying state change is persisted. Each
 * task is best-effort and uses the bounded gateway path (never throws, healer observes).
 */
import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export type ContactSignal =
  | "tcpa_consent_granted"           // contact opted in to phone/SMS → re-check PDL phone validity
  | "deal_under_contract"            // transaction stage flipped → refresh RentCast AVM for the property
  | "inspection_completed"           // refresh property valuation + comps (post-inspection price gap)
  | "appraisal_completed"            // same — value may have shifted
  | "address_changed"                // re-verify mailing address (Lob) + re-pull PDL with new address
  | "email_changed"                  // tier-3 PDL email/validate on the new address
  | "phone_changed"                  // re-pull PDL to confirm new phone is reachable

export interface SignalRescrapeResult {
  contactId:   string
  signal:      ContactSignal
  tasks:       Array<{ name: string; ok: boolean; via?: string; error?: string; cost?: number }>
  totalCost:   number
}

export async function triggerSignalRescrape(params: {
  contactId: string
  signal:    ContactSignal
}): Promise<SignalRescrapeResult> {
  const out: SignalRescrapeResult = { contactId: params.contactId, signal: params.signal, tasks: [], totalCost: 0 }
  const svc = createServiceClient()
  const { data: contact } = await svc
    .from("contacts")
    .select("id, first_name, last_name, email, phone, mailing_address, mailing_city, mailing_state, mailing_zip, brokerage_id")
    .eq("id", params.contactId)
    .maybeSingle()
  if (!contact) {
    out.tasks.push({ name: "load_contact", ok: false, error: "contact not found" })
    return out
  }
  const addr  = [contact.mailing_address, contact.mailing_city, contact.mailing_state, contact.mailing_zip].filter(Boolean).join(", ")
  const fullName = [contact.first_name, contact.last_name].filter(Boolean).join(" ")

  // Per-signal task plan — additive (more than one task may fire for a single signal).
  const wantPdl     = ["tcpa_consent_granted", "address_changed", "email_changed", "phone_changed"].includes(params.signal)
  const wantAddrChk = ["address_changed"].includes(params.signal)
  const wantEmailValidate = ["email_changed"].includes(params.signal)
  const wantAvm     = ["deal_under_contract", "inspection_completed", "appraisal_completed"].includes(params.signal)

  if (wantPdl && (fullName || contact.email || contact.phone)) {
    try {
      const { skipTraceWithPeopleData } = await import("@/lib/external/peopledata-client")
      const r = await skipTraceWithPeopleData({
        name: fullName || undefined, email: contact.email ?? undefined, phone: contact.phone ?? undefined, address: addr || undefined,
      })
      out.tasks.push({ name: "pdl_skip_trace", ok: !!r.data, cost: r.cost })
      out.totalCost += r.cost
    } catch (e) { out.tasks.push({ name: "pdl_skip_trace", ok: false, error: (e as Error).message }) }
  }

  if (wantEmailValidate && contact.email) {
    try {
      const { verifyEmailDeep } = await import("@/lib/external/email-verifier")
      const v = await verifyEmailDeep(contact.email)
      // Write the verified flag back so the canonical gate sees it.
      await svc.from("contacts").update({ email_verified: v.verified }).eq("id", contact.id)
      out.tasks.push({ name: "email_verify_deep", ok: true, via: `tier-${v.tier}`, cost: v.cost })
      out.totalCost += v.cost
    } catch (e) { out.tasks.push({ name: "email_verify_deep", ok: false, error: (e as Error).message }) }
  }

  if (wantAddrChk && contact.mailing_address) {
    try {
      const { verifyAddressViaLob } = await import("@/lib/external/lob-address-verify")
      const r = await verifyAddressViaLob({
        primary_line: contact.mailing_address as string,
        city:         contact.mailing_city  ?? undefined,
        state:        contact.mailing_state ?? undefined,
        zip_code:     contact.mailing_zip   ?? undefined,
      })
      if (r.data) {
        // Flip mailing_address_verified per Lob's deliverability verdict.
        // The error is READ. The task below reports ok:true and the Lob call was
        // PAID FOR — a refused flag means the money was spent and the verdict that
        // gates direct-mail spend never landed on the row.
        const { error: addrFlagError } = await svc.from("contacts").update({ mailing_address_verified: r.data.verified }).eq("id", contact.id)
        if (addrFlagError) {
          out.tasks.push({ name: "lob_address_verify", ok: false, error: `verified but NOT persisted: ${addrFlagError.message}`, cost: r.cost })
        } else {
          out.tasks.push({ name: "lob_address_verify", ok: true, cost: r.cost })
        }
      } else {
        out.tasks.push({ name: "lob_address_verify", ok: false, error: "Lob not configured" })
      }
      out.totalCost += r.cost
    } catch (e) { out.tasks.push({ name: "lob_address_verify", ok: false, error: (e as Error).message }) }
  }

  if (wantAvm && addr) {
    try {
      const apiKey = process.env.RENTCAST_API_KEY
      if (apiKey) {
        const { callRentcastGet } = await import("@/lib/external/rentcast-typed")
        const avm = await callRentcastGet("/avm/value", { address: addr } as any, apiKey)
        out.tasks.push({ name: "rentcast_avm_refresh", ok: avm.ok, cost: 0.01 })
        out.totalCost += 0.01
      } else {
        out.tasks.push({ name: "rentcast_avm_refresh", ok: false, error: "RENTCAST_API_KEY not configured" })
      }
    } catch (e) { out.tasks.push({ name: "rentcast_avm_refresh", ok: false, error: (e as Error).message }) }
  }

  return out
}
