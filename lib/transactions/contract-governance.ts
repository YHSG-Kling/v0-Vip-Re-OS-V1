import { createClient } from "@supabase/supabase-js"

export async function setContractDate(params: {
  transactionId: string
  brokerageId: string
  contractDate: string
  userId: string
  role: string
  override?: boolean
}) {

  const { transactionId, brokerageId, contractDate, userId, role, override } = params

  const allowedRoles = ["admin", "broker", "compliance_officer", "TC"]

  if (!allowedRoles.includes(role)) {
    throw new Error("Unauthorized to set contract date")
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  const { data: transaction } = await supabase
    .from("transactions")
    .select("compliance_passed_at, contract_date")
    .eq("id", transactionId)
    .eq("brokerage_id", brokerageId)
    .single()

  if (!transaction) {
    throw new Error("Transaction not found")
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
      contract_date: contractDate
    }
  })
}
