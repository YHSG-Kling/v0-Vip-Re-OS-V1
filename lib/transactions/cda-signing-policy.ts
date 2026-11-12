// ─── CDA SIGNING STATE MACHINE (pure) ────────────────────────────────────────
// The CDA disbursement sign-off sequence, as a pure, unit-testable policy so the
// server actions (cda-portal) and the simulator share ONE source of truth:
//
//   agent fills + E-SIGNS  →  submit  →  compliance APPROVES (or sends back)
//      →  BROKER signs (2nd signature)  →  sent to title (disbursement)
//
// Separation of duties: the agent can't approve or broker-sign their own CDA;
// compliance approves but does NOT apply the broker's signature; the signed CDA
// can't reach title until the broker has signed. Roles below mirror the action gates.

// SCOPE LADDER (separation-of-duties rosters, kept inline — the two sets are
// deliberately different and must not collapse into one shared predicate).
// 'superadmin' removed from both: tested against users.user_type (cda-portal
// passes auth.userType) and 0 live rows store it — the platform superadmin is
// user_type='admin' + platform_role='superadmin', admitted via 'admin' already.
// 'broker_owner' added to both: storable, owns the brokerage, and m472 groups it
// with broker for CDA (finance) authority; without it the owner of the brokerage
// could neither approve nor broker-sign their own CDA.
export const CDA_APPROVE_ROLES = new Set(["compliance_officer", "admin", "broker", "broker_owner", "broker_admin"])
export const CDA_BROKER_SIGN_ROLES = new Set(["broker", "broker_owner", "broker_admin", "admin"])

export interface PolicyVerdict {
  ok: boolean
  error?: string
}

/** Compliance approval gate: submitted + agent e-signed + a compliance role. */
export function canApproveCda(input: {
  status: string | null | undefined
  agentSignedOff: boolean
  role: string | null | undefined
}): PolicyVerdict {
  if (!CDA_APPROVE_ROLES.has((input.role ?? "").toLowerCase().trim())) return { ok: false, error: "forbidden" }
  if (input.status !== "submitted") return { ok: false, error: `cannot_approve_from_status:${input.status}` }
  if (!input.agentSignedOff) return { ok: false, error: "agent_signoff_required" }
  return { ok: true }
}

/** Broker-signature gate: an APPROVED CDA, not yet broker-signed, by a broker role. */
export function canBrokerSignCda(input: {
  status: string | null | undefined
  brokerSigned: boolean
  role: string | null | undefined
}): PolicyVerdict {
  if (!CDA_BROKER_SIGN_ROLES.has((input.role ?? "").toLowerCase().trim())) return { ok: false, error: "forbidden_broker_only" }
  if (input.status !== "approved") return { ok: false, error: `cannot_sign_from_status:${input.status}` }
  if (input.brokerSigned) return { ok: false, error: "already_signed" }
  return { ok: true }
}

/** Send-to-title gate: an APPROVED CDA that the broker has SIGNED. */
export function canSendCdaToTitle(input: {
  status: string | null | undefined
  brokerSigned: boolean
}): PolicyVerdict {
  if (input.status !== "approved") return { ok: false, error: `cannot_send_from_status:${input.status}` }
  if (!input.brokerSigned) return { ok: false, error: "broker_signature_required" }
  return { ok: true }
}
