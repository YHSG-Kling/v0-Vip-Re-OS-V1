// lib/notifications/buyer-preferences.ts
// ─────────────────────────────────────────────────────────────────────────────
// BUYER NOTIFICATION PREFERENCES — the buyer's settings panel is only real if the OS actually
// HONORS it. This is the single typed source of truth: a reader that resolves a contact's saved
// choices (contacts.custom_fields.notification_preferences) and PURE matchers the send paths consult
// before any buyer-facing automated touch. Service updates default opt-IN; marketing defaults opt-OUT.
//
// This is NOT a consent gate (TCPA/CAN-SPAM consent still lives in the egress gate) — it is the
// buyer's own "what do I want to hear about" layer, layered ON TOP of consent. Both must say yes.

export interface BuyerNotificationPreferences {
  email: boolean
  sms: boolean
  push: boolean
  marketing: boolean
  showing_reminders: boolean
  offer_updates: boolean
  document_alerts: boolean
  weekly_digest: boolean
}

/** A buyer who has never touched settings: hear about everything that serves the deal, no marketing. */
export const DEFAULT_BUYER_NOTIFICATION_PREFERENCES: BuyerNotificationPreferences = {
  email: true, sms: true, push: false, marketing: false,
  showing_reminders: true, offer_updates: true, document_alerts: true, weekly_digest: true,
}

/** The content categories a send can belong to (maps 1:1 to the buyer's Alert Types toggles). */
export type NotificationCategory = "showing_reminders" | "offer_updates" | "document_alerts" | "weekly_digest" | "marketing"
/** The delivery channels the buyer can mute wholesale. */
export type NotificationChannel = "email" | "sms" | "push"

function readMetadata(raw: any): Record<string, any> {
  if (!raw) return {}
  if (typeof raw === "string") { try { return JSON.parse(raw) } catch { return {} } }
  return raw
}

/** PURE — merge a raw saved blob (contacts.metadata) over the defaults into a typed, total set. */
export function resolveBuyerNotificationPreferences(raw: any): BuyerNotificationPreferences {
  const saved = (readMetadata(raw)?.notification_preferences ?? {}) as Partial<Record<string, unknown>>
  const out = { ...DEFAULT_BUYER_NOTIFICATION_PREFERENCES }
  for (const k of Object.keys(out) as (keyof BuyerNotificationPreferences)[]) {
    if (typeof saved[k] === "boolean") out[k] = saved[k] as boolean
  }
  return out
}

/** PURE — would the buyer welcome an automated touch of this category on this channel? */
export function buyerWantsNotification(
  prefs: BuyerNotificationPreferences,
  category: NotificationCategory,
  channel?: NotificationChannel,
): boolean {
  if (prefs[category] === false) return false
  if (channel && prefs[channel] === false) return false
  return true
}

/**
 * Resolve a contact's preferences from the database (service or server client). Best-effort:
 * on any failure returns the safe defaults (service updates on, marketing off) so a read error
 * never silently drops a deal-critical update — only an explicit opt-out suppresses.
 */
export async function getBuyerNotificationPreferences(
  contactId: string,
  client: { from: (t: string) => any },
): Promise<BuyerNotificationPreferences> {
  try {
    const { data } = await client.from("contacts").select("metadata").eq("id", contactId).maybeSingle()
    return resolveBuyerNotificationPreferences(data?.metadata)
  } catch {
    return { ...DEFAULT_BUYER_NOTIFICATION_PREFERENCES }
  }
}
