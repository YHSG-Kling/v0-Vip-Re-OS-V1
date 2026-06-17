// lib/forms/esign-anchor-adapters.ts
//
// Per-provider translation of the canonical e-sign anchors (lib/forms/esign-anchors) into each
// provider's native tag/tab shape. The canonical layer is the single source of truth; these adapters
// are thin, pure mappers so adding a 5th provider is one function, not a rewrite. We support the four
// the app connects today (Dotloop, DocuSign, SkySlope, Authentisign) and a generic fallback. Pure.

import type { EsignAnchor, SignerRole, AnchorType } from "./esign-anchors"

export type EsignProvider = "dotloop" | "docusign" | "skyslope" | "authentisign" | "generic"

/** A provider-native tag for one anchor — the shape each provider's API/SDK expects. */
export interface ProviderTag {
  provider: EsignProvider
  anchorKey: string
  role: SignerRole
  type: AnchorType
  /** the provider-native recipient/role label. */
  recipientRole: string
  /** the provider-native tab/field descriptor (what we send to place the mark). */
  tab: Record<string, unknown>
}

// ── Recipient-role naming per provider ───────────────────────────────────────
// Every provider names the parties slightly differently; map the canonical role to theirs.
const RECIPIENT_ROLE: Record<EsignProvider, Record<SignerRole, string>> = {
  docusign: { buyer: "Buyer", co_buyer: "Co-Buyer", seller: "Seller", co_seller: "Co-Seller", agent: "Agent", listing_agent: "Listing Agent" },
  dotloop:  { buyer: "BUYER", co_buyer: "BUYER", seller: "SELLER", co_seller: "SELLER", agent: "BUYING_AGENT", listing_agent: "LISTING_AGENT" },
  skyslope: { buyer: "buyer", co_buyer: "co_buyer", seller: "seller", co_seller: "co_seller", agent: "agent", listing_agent: "listing_agent" },
  authentisign: { buyer: "Buyer", co_buyer: "Co-Buyer", seller: "Seller", co_seller: "Co-Seller", agent: "Agent", listing_agent: "Listing Agent" },
  generic:  { buyer: "buyer", co_buyer: "co_buyer", seller: "seller", co_seller: "co_seller", agent: "agent", listing_agent: "listing_agent" },
}

// DocuSign tab type names.
const DOCUSIGN_TAB_TYPE: Record<AnchorType, string> = { signature: "signHere", initial: "initialHere", date: "dateSigned" }
// SkySlope / generic tab kinds.
const TAB_KIND: Record<AnchorType, string> = { signature: "signature", initial: "initials", date: "date" }

/** Translate the canonical anchors into one provider's native tags. Pure. */
export function anchorsForProvider(provider: EsignProvider, anchors: EsignAnchor[]): ProviderTag[] {
  const roleMap = RECIPIENT_ROLE[provider] ?? RECIPIENT_ROLE.generic
  return (anchors ?? []).map((a) => {
    const recipientRole = roleMap[a.role]
    let tab: Record<string, unknown>
    switch (provider) {
      case "docusign":
        // DocuSign anchors on the field name string ("anchor tabs").
        tab = { tabType: DOCUSIGN_TAB_TYPE[a.type], anchorString: a.fieldName, anchorUnits: "pixels", recipientRole }
        break
      case "dotloop":
        // Dotloop places fields by participant role + field name on the loop document.
        tab = { fieldName: a.fieldName, participantRole: recipientRole, kind: TAB_KIND[a.type] }
        break
      case "skyslope":
      case "authentisign":
      case "generic":
      default:
        tab = { kind: TAB_KIND[a.type], field: a.fieldName, role: recipientRole }
        break
    }
    return { provider, anchorKey: a.key, role: a.role, type: a.type, recipientRole, tab }
  })
}

/** The distinct provider recipient roles an anchor set needs (to build the recipient list). Pure. */
export function recipientRolesForProvider(provider: EsignProvider, anchors: EsignAnchor[]): string[] {
  const roleMap = RECIPIENT_ROLE[provider] ?? RECIPIENT_ROLE.generic
  return Array.from(new Set((anchors ?? []).map((a) => roleMap[a.role])))
}

const DOCUSIGN_TAB_GROUP: Record<string, string> = { signHere: "signHereTabs", initialHere: "initialHereTabs", dateSigned: "dateSignedTabs" }

/**
 * Group DocuSign-shaped tags into per-recipient-role tab buckets, the exact shape DocuSign's recipient
 * payload wants: { "<recipientRole>": { signHereTabs:[], initialHereTabs:[], dateSignedTabs:[] } }. Pure.
 */
export function docusignTabsByRecipient(tags: ProviderTag[]): Record<string, Record<string, unknown[]>> {
  const out: Record<string, Record<string, unknown[]>> = {}
  for (const t of tags ?? []) {
    const tab = t.tab as Record<string, unknown>
    const group = DOCUSIGN_TAB_GROUP[String(tab.tabType ?? "")] ?? "signHereTabs"
    const role = String(tab.recipientRole ?? t.recipientRole)
    const bucket = out[role] ?? (out[role] = {})
    ;(bucket[group] = (bucket[group] as unknown[]) ?? []).push(tab)
  }
  return out
}
