import { createServiceClient } from "@/lib/supabase/service"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"

export async function setContractDate(params: {
  transactionId: string
  brokerageId: string
  contractDate: string
  userId: string
  role: string
  override?: boolean
  reason?: string
}) {

  const { transactionId, brokerageId, contractDate, userId, role, override } = params

  const allowedRoles = ["admin", "broker", "compliance_officer", "tc"]

  if (!allowedRoles.includes(role)) {
    throw new Error("Unauthorized to set contract date")
  }

  const supabase = createServiceClient()

  const { data: transaction } = await supabase
    .from("transactions")
    .select("compliance_passed_at, contract_date")
    .eq("id", transactionId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (!transaction) {
    throw new Error(
      `[contract-governance] Transaction ${transactionId} not found in brokerage ${brokerageId}`
    )
  }

  if (!transaction.compliance_passed_at) {
    throw new Error("Compliance has not passed — cannot set contract date")
  }

  await supabase
    .from("transactions")
    .update({ contract_date: contractDate })
    .eq("id", transactionId)
    .eq("brokerage_id", brokerageId)

  await transitionLifecycle({
    brokerageId: brokerageId,
    entityType:  "transaction",
    entityId:    transactionId,
    fromState:   transaction.contract_date ? "contract_date_set" : "compliance_passed",
    toState:     override ? "contract_date_overridden" : "contract_date_set",
    actorUserId: userId,
    actorRole:   role as any,
    eventType:   override ? "contract_date.overridden" : "contract_date.set",
    metadata:    { contract_date: contractDate, previous_date: transaction.contract_date ?? null, reason: params.reason ?? null },
  })
}

export async function assertAdjustmentsUnlocked(params: {
  transactionId: string
  brokerageId: string
  userId: string
  role: string
}): Promise<void> {
  const supabase = createServiceClient()

  const { data: transaction } = await supabase
    .from("transactions")
    .select("contract_date")
    .eq("id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)
    .maybeSingle()

  if (!transaction) {
    throw new Error(
      `[contract-governance] Transaction ${params.transactionId} not found`
    )
  }

  if (transaction.contract_date) {
    const allowedOverrideRoles = ["broker", "admin"]

    if (!allowedOverrideRoles.includes(params.role)) {
      throw new Error(
        "[contract-governance] Commission adjustments locked after contract_date."
      )
    }

    await transitionLifecycle({
      brokerageId: params.brokerageId,
      entityType:  "transaction",
      entityId:    params.transactionId,
      fromState:   "adjustments_locked",
      toState:     "adjustments_unlocked",
      actorUserId: params.userId,
      actorRole:   params.role as any,
      eventType:   "commission.adjustment.lock_overridden",
      metadata:    { role: params.role, contract_date: transaction.contract_date },
    })
  }
}
