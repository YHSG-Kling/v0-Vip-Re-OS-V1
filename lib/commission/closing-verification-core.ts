// lib/commission/closing-verification-core.ts — THE FIVE-LAYER EVALUATION, PURE (wave 145, lane 145C; owner ruling 7).
//
// The layer vocabulary and the one pure evaluation the closing verification is built on, split from its loader
// (lib/commission/closing-verification.ts — the reads and the ONE write, the attestation) the way
// lib/transactions/closing-compliance-core.ts is split from lib/transactions/closing-compliance.ts: no database, no session,
// no model — facts in, layers + the digest the attestation is given on out. Proved directly by
// scripts/agreement-governance-guard.ts §G (consistent / finding / unreadable, order, digest).

import { createHash } from "node:crypto"

export const VERIFICATION_LAYERS = ["signed_agreements", "effective_terms", "contract_instruments", "settlement", "waterfall"] as const
export type VerificationLayerKey = (typeof VERIFICATION_LAYERS)[number]
export type LayerStatus = "consistent" | "finding" | "missing" | "unreadable"

export const VERIFICATION_LAYER_LABEL: Record<VerificationLayerKey, string> = {
  signed_agreements: "Signed agreements",
  effective_terms: "Current effective terms",
  contract_instruments: "Offer, counters and addenda",
  settlement: "Settlement documents",
  waterfall: "Commission waterfall",
}

export interface VerificationLayer { key: VerificationLayerKey; label: string; status: LayerStatus; facts: string[]; findings: string[] }

export interface ClosingVerificationFacts {
  agentAgreement: { readable: boolean; signedAgreementId: string | null; effectiveDate: string | null; governance: string | null; versionId: string | null; effectiveFrom: string | null; mismatches: number; findings: string[] } | null
  clientAgreements: { readable: boolean; listing: Array<{ id: string; executed: boolean }>; buyer: Array<{ id: string; executed: boolean }>; dealType: string | null }
  referral: { readable: boolean; applies: boolean; agreementOnRecord: boolean; detail: string | null }
  clientFees: { readable: boolean; available: boolean; findings: string[]; settling: number }
  contract: { readable: boolean; governingVersion: string | null; superseded: number; latestExecutedAt: string | null; addenda: number; reason: string | null }
  settlement: { readable: boolean; openFail: number; openReview: number; checked: number }
  waterfall: { readable: boolean; calculatedAt: string | null; versionId: string | null; asOf: string | null; governance: string | null }
}

/** PURE — the five layers, each consistent / finding / missing / unreadable, plus the digest the attestation is given on. */
export function evaluateClosingVerification(f: ClosingVerificationFacts): { layers: VerificationLayer[]; digest: string; findingsCount: number } {
  const layer = (key: VerificationLayerKey, status: LayerStatus, facts: string[], findings: string[]): VerificationLayer => ({ key, label: VERIFICATION_LAYER_LABEL[key], status, facts, findings })
  const layers: VerificationLayer[] = []

  // 1 · signed agreements
  {
    const facts: string[] = [], findings: string[] = []
    let unreadable = false
    if (!f.agentAgreement || !f.agentAgreement.readable) unreadable = true
    else if (f.agentAgreement.signedAgreementId) facts.push(`agent agreement ${f.agentAgreement.signedAgreementId} in force${f.agentAgreement.effectiveDate ? ` from ${f.agentAgreement.effectiveDate}` : " (effective date not recorded)"}`)
    else findings.push("no executed agent commission agreement is on record for the deal's date")
    if (f.agentAgreement?.readable && f.agentAgreement.signedAgreementId && !f.agentAgreement.effectiveDate) findings.push("the agent agreement's effective date is not recorded")
    if (!f.clientAgreements.readable) unreadable = true
    else {
      const sideListing = f.clientAgreements.dealType !== "buyer"
      const sideBuyer = f.clientAgreements.dealType === "buyer" || f.clientAgreements.dealType === "dual"
      if (sideListing && f.clientAgreements.listing.length > 0) {
        if (f.clientAgreements.listing.some((a) => a.executed)) facts.push("executed listing agreement on file")
        else findings.push("the listing agreement on file is not executed")
      }
      if (sideBuyer) {
        if (f.clientAgreements.buyer.some((a) => a.executed)) facts.push("executed buyer-broker agreement on file")
        else if (f.clientAgreements.buyer.length > 0) findings.push("the buyer-broker agreement on file is not executed")
      }
    }
    if (!f.referral.readable) unreadable = true
    else if (f.referral.applies) (f.referral.agreementOnRecord ? facts : findings).push(f.referral.detail ?? (f.referral.agreementOnRecord ? "executed referral agreement on record" : "a referral applies but no executed referral agreement is on record"))
    layers.push(layer("signed_agreements", unreadable ? "unreadable" : findings.length ? "finding" : "consistent", facts, findings))
  }

  // 2 · current effective terms
  {
    const facts: string[] = [], findings: string[] = []
    let unreadable = !f.agentAgreement?.readable || !f.clientFees.readable
    if (f.agentAgreement?.readable) {
      if (f.agentAgreement.versionId || f.agentAgreement.effectiveFrom) facts.push(`terms version ${f.agentAgreement.versionId ?? "(live profile)"} in force from ${f.agentAgreement.effectiveFrom ?? "—"}`)
      if (f.agentAgreement.governance === "verified") facts.push("terms verified against the executed agreement in force")
      if (f.agentAgreement.governance === "unverified") findings.push("the terms in force were not verified against the executed agreement in force")
      if (f.agentAgreement.mismatches > 0) findings.push(`${f.agentAgreement.mismatches} term(s) the executed agreement states differ from the terms in force`)
    }
    if (f.clientFees.readable) {
      if (!f.clientFees.available) facts.push("client-agreement fees are not recorded on this system yet")
      if (f.clientFees.settling > 0) facts.push(`${f.clientFees.settling} verified client-agreement fee line(s) settle at closing`)
      findings.push(...f.clientFees.findings)
    }
    if (!f.agentAgreement) unreadable = true
    layers.push(layer("effective_terms", unreadable ? "unreadable" : findings.length ? "finding" : "consistent", facts, findings))
  }

  // 3 · contract instruments
  {
    const facts: string[] = [], findings: string[] = []
    if (!f.contract.readable) layers.push(layer("contract_instruments", "unreadable", facts, [f.contract.reason ?? "the governing terms could not be read"]))
    else {
      if (f.contract.governingVersion) facts.push(`governing contract version ${f.contract.governingVersion}${f.contract.addenda ? ` (${f.contract.addenda} executed addend${f.contract.addenda === 1 ? "um" : "a"})` : ""}`)
      if (f.contract.superseded > 0) facts.push(`${f.contract.superseded} earlier executed term(s) superseded by a later executed instrument`)
      layers.push(layer("contract_instruments", !f.contract.governingVersion ? "missing" : findings.length ? "finding" : "consistent", facts, findings))
    }
  }

  // 4 · settlement documents
  {
    if (!f.settlement.readable) layers.push(layer("settlement", "unreadable", [], ["the closing comparison could not be read"]))
    else if (f.settlement.checked === 0) layers.push(layer("settlement", "missing", [], ["the settlement statement has not been compared with the governing terms yet"]))
    else {
      const findings: string[] = []
      if (f.settlement.openFail > 0) findings.push(`${f.settlement.openFail} settlement line(s) disagree with the governing terms`)
      if (f.settlement.openReview > 0) findings.push(`${f.settlement.openReview} settlement line(s) need review`)
      layers.push(layer("settlement", findings.length ? "finding" : "consistent", [`${f.settlement.checked} closing comparison row(s) on file`], findings))
    }
  }

  // 5 · waterfall
  {
    if (!f.waterfall.readable) layers.push(layer("waterfall", "unreadable", [], ["the commission calculation could not be read"]))
    else if (!f.waterfall.calculatedAt) layers.push(layer("waterfall", "missing", [], ["no commission calculation is on record for this deal yet"]))
    else {
      const facts = [`calculated ${f.waterfall.calculatedAt.slice(0, 10)} on terms version ${f.waterfall.versionId ?? "—"} (as of ${f.waterfall.asOf ?? "—"})`]
      const findings: string[] = []
      if (f.contract.latestExecutedAt && f.contract.latestExecutedAt > f.waterfall.calculatedAt) findings.push(`an executed contract change (${f.contract.latestExecutedAt.slice(0, 10)}) is newer than the calculation — recalculate`)
      if (f.agentAgreement?.versionId && f.waterfall.versionId && f.agentAgreement.versionId !== f.waterfall.versionId) findings.push("the calculation priced a different agreement version than the one in force now — recalculate")
      layers.push(layer("waterfall", findings.length ? "finding" : "consistent", facts, findings))
    }
  }

  const digest = createHash("sha256").update(JSON.stringify(layers.map((l) => [l.key, l.status, l.facts, l.findings]))).digest("hex").slice(0, 16)
  return { layers, digest, findingsCount: layers.reduce((n, l) => n + l.findings.length, 0) }
}
