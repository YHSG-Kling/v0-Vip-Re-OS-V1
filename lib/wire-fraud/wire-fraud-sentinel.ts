// lib/wire-fraud/wire-fraud-sentinel.ts
//
// WIRE-FRAUD SENTINEL — the single most CATASTROPHIC real-estate scam: at the closing/wire window a
// fraudster spoofs the title company or agent, emails the buyer NEW wire instructions, and the
// buyer wires their entire down payment to the scammer — gone, rarely recovered. The system already
// tracks wire instructions as a closing MILESTONE (closing-orchestration.detectWireInstructionsMissing)
// but NOTHING detects the FRAUD. This does: a pure detector over the red flags the FBI/title industry
// flag, a HARD verdict (block/warn/ok), and the one protective action that actually stops it. No
// competitor markets AI wire-fraud protection — this is the Deal Coordinator standing guard.
//
// PURE — no I/O. Only signals ACTUALLY PRESENT contribute (no fabrication).

export type WireFraudSeverity = "critical" | "high"

export interface WireFraudFlag {
  key: string
  severity: WireFraudSeverity
  evidence: string
}

export interface WireFraudInput {
  /** Who sent the wire instructions. */
  senderEmail?: string | null
  /** The legitimate title/escrow/agent domains on file for this deal. */
  expectedDomains?: string[] | null
  /** Bank details previously on file (if any). */
  priorInstructions?: { account?: string | null; routing?: string | null } | null
  /** Bank details in this message. */
  newInstructions?: { account?: string | null; routing?: string | null } | null
  /** The email/text body, for pressure-language detection. */
  messageText?: string | null
  daysToClose?: number | null
}

export interface WireFraudVerdict {
  /** block = do not wire; warn = verify first; ok = no red flags present. */
  riskLevel: "block" | "warn" | "ok"
  flags: WireFraudFlag[]
  /** The non-negotiable protective step (always returned — the call-to-verify rule). */
  protectiveAction: string
}

const FREEMAIL = new Set(["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "aol.com", "icloud.com", "proton.me", "gmx.com"])
const URGENCY = /\b(wire (today|now|immediately|asap)|new (wire )?instructions|updated (wire )?instructions|disregard (the )?previous|changed our bank|do not call|urgent|time.?sensitive|before (the )?bank closes)\b/i

const domainOf = (email: string): string => (email.split("@")[1] ?? "").trim().toLowerCase()
/** Alphanumeric core of a domain (strip dots/dashes + TLD) — for look-alike detection. */
const core = (domain: string): string => domain.replace(/\.[a-z]+$/i, "").replace(/[^a-z0-9]/gi, "").toLowerCase()

export function detectWireFraudRisk(input: WireFraudInput): WireFraudVerdict {
  const flags: WireFraudFlag[] = []
  const expected = (input.expectedDomains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean)

  if (input.senderEmail) {
    const sd = domainOf(input.senderEmail)
    if (sd) {
      if (FREEMAIL.has(sd)) {
        flags.push({ key: "freemail_sender", severity: "critical", evidence: `Wire instructions sent from a free email (${sd}) — title/escrow never use personal email for wires` })
      } else if (expected.length && !expected.includes(sd)) {
        // Look-alike (same core, different punctuation/TLD) is worse than a plain mismatch.
        const lookalike = expected.some((e) => core(e) === core(sd) && e !== sd)
        flags.push(lookalike
          ? { key: "lookalike_domain", severity: "critical", evidence: `Sender domain ${sd} is a LOOK-ALIKE of the real ${expected.join("/")} — classic spoof` }
          : { key: "domain_mismatch", severity: "critical", evidence: `Sender domain ${sd} is not the title/escrow on file (${expected.join(", ")})` })
      }
    }
  }

  // Last-minute change to the bank details = the #1 fraud signature.
  const prior = input.priorInstructions, next = input.newInstructions
  if (prior && next && (prior.account || prior.routing)) {
    const changed = (next.account && next.account !== prior.account) || (next.routing && next.routing !== prior.routing)
    if (changed) {
      flags.push({ key: "account_changed", severity: "critical", evidence: "Bank account/routing CHANGED from what was previously on file — never trust a changed wire instruction without voice verification" })
    }
  }

  if (input.messageText && URGENCY.test(input.messageText)) {
    flags.push({ key: "urgency_pressure", severity: "high", evidence: "Pressure / urgency language ('wire now', 'new instructions', 'disregard previous') — a hallmark of wire fraud" })
  }

  const hasCritical = flags.some((f) => f.severity === "critical")
  const riskLevel: WireFraudVerdict["riskLevel"] = hasCritical ? "block" : flags.length ? "warn" : "ok"

  return {
    riskLevel,
    flags: flags.sort((a, b) => (a.severity === "critical" ? -1 : 1) - (b.severity === "critical" ? -1 : 1)),
    protectiveAction:
      "DO NOT WIRE until verified. Call the title/escrow company at the number on your SIGNED settlement statement — never a number or link from this message — and verbally confirm the account + routing before sending anything.",
  }
}
