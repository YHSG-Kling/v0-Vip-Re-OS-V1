import { createServiceClient } from "@/lib/supabase/service"

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

  const allowedRoles = ["admin", "broker", "compliance_officer", "TC"]

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

  await supabase.from("lifecycle_events").insert({
    entity_type: "transaction",
    entity_id: transactionId,
    event_type: override
      ? "transaction.contract_date.overridden"
      : "transaction.contract_date.set",
    brokerage_id: brokerageId,
    actor_user_id: userId,
    metadata: {
      contract_date: contractDate,
      previous_date: transaction.contract_date ?? null,
      reason: params.reason ?? null,
    }
  })
}
