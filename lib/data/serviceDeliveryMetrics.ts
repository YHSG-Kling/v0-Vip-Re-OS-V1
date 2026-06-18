import { createClient } from "@/lib/supabase/server"

export interface ServiceDeliveryMetrics {
  onTimeMilestones: number
  overdueMilestones: number
  avgContractToCloseDays: number
  errorRevisionRate: number
  exceptionCount: number
}

export interface TransactionRisk {
  transactionId: string
  address: string
  clientName: string
  pipeline: string
  overdueMilestones: number
  healthScore: number
  daysInContract: number
  riskLevel: "low" | "medium" | "high" | "critical"
}

export async function getServiceDeliveryMetrics(
  brokerageId: string,
  timeRange = "30d",
): Promise<ServiceDeliveryMetrics> {
  const supabase = await createClient()

  // Calculate date range
  const now = new Date()
  const startDate = new Date()
  if (timeRange === "7d") startDate.setDate(now.getDate() - 7)
  else if (timeRange === "30d") startDate.setDate(now.getDate() - 30)
  else if (timeRange === "90d") startDate.setDate(now.getDate() - 90)

  // Query milestones
  // transaction_milestones has no listing_id and no FK to listings; it carries its
  // own brokerage_id. due_date is target_date (aliased to keep m.due_date below).
  const { data: milestones } = await supabase
    .from("transaction_milestones")
    .select(`
      id,
      due_date:target_date,
      completed_at,
      status
    `)
    .eq("brokerage_id", brokerageId)
    .gte("created_at", startDate.toISOString())

  const onTime =
    milestones?.filter((m: any) => m.completed_at && new Date(m.completed_at) <= new Date(m.due_date)).length || 0

  const overdue = milestones?.filter((m: any) => !m.completed_at && new Date(m.due_date) < now).length || 0

  // Query closed transactions for avg days
  const { data: closedTransactions } = await supabase
    .from("listings")
    .select("created_at, updated_at, status")
    .eq("brokerage_id", brokerageId)
    .eq("status", "sold")
    .gte("updated_at", startDate.toISOString())

  const avgDays = closedTransactions?.length
    ? closedTransactions.reduce((sum: number, t: any) => {
        const days = Math.floor(
          (new Date(t.updated_at).getTime() - new Date(t.created_at).getTime()) / (1000 * 60 * 60 * 24),
        )
        return sum + days
      }, 0) / closedTransactions.length
    : 0

  // Mock error/revision rate and exception count
  const errorRevisionRate = 2.3 // percentage
  const exceptionCount = 5

  return {
    onTimeMilestones: onTime,
    overdueMilestones: overdue,
    avgContractToCloseDays: Math.round(avgDays),
    errorRevisionRate,
    exceptionCount,
  }
}

export async function getTransactionRisks(brokerageId: string): Promise<TransactionRisk[]> {
  const supabase = await createClient()

  // Get active transactions with overdue milestones
  const { data: transactions } = await supabase
    .from("transactions")
    .select(`
      id,
      property_address,
      stage,
      created_at,
      contact_id
    `)
    .eq("brokerage_id", brokerageId)
    .in("stage", ["under_contract", "contingent", "pending"])

  if (!transactions || transactions.length === 0) return []

  // Fetch contacts separately
  const contactIds = transactions.map((t: any) => t.contact_id).filter(Boolean)
  let contactMap = new Map<string, any>()
  if (contactIds.length > 0) {
    const { data: contacts } = await supabase
      .from("contacts")
      .select("id, first_name, last_name")
      .in("id", contactIds)
    contactMap = new Map(contacts?.map((c: any) => [c.id, c]) || [])
  }

  // Fetch milestones for all transactions
  const transactionIds = transactions.map((t: any) => t.id)
  const { data: milestones } = await supabase
    .from("transaction_milestones")
    .select("id, transaction_id, status, due_date:target_date, completed_at")
    .in("transaction_id", transactionIds)

  const milestonesMap = new Map<string, any[]>()
  ;(milestones || []).forEach((m: any) => {
    if (!milestonesMap.has(m.transaction_id)) {
      milestonesMap.set(m.transaction_id, [])
    }
    milestonesMap.get(m.transaction_id)!.push(m)
  })

  const now = new Date()
  const risks: TransactionRisk[] = []

  for (const transaction of transactions) {
    const transactionMilestones = milestonesMap.get(transaction.id) || []
    const overdueMilestones = transactionMilestones.filter(
      (m: any) => !m.completed_at && new Date(m.due_date) < now
    ).length || 0

    const daysInContract = Math.floor(
      (now.getTime() - new Date(transaction.created_at).getTime()) / (1000 * 60 * 60 * 24),
    )

    // Calculate health score (100 - penalties for overdue milestones and time)
    const healthScore = Math.max(0, 100 - overdueMilestones * 15 - Math.max(0, daysInContract - 45))

    let riskLevel: "low" | "medium" | "high" | "critical" = "low"
    if (healthScore < 30) riskLevel = "critical"
    else if (healthScore < 50) riskLevel = "high"
    else if (healthScore < 70) riskLevel = "medium"

    const contact = contactMap.get(transaction.contact_id)
    const clientName = contact ? `${contact.first_name} ${contact.last_name}` : "Unknown"

    risks.push({
      transactionId: transaction.id,
      address: transaction.property_address || "N/A",
      clientName,
      pipeline: transaction.stage,
      overdueMilestones,
      healthScore,
      daysInContract,
      riskLevel,
    })
  }

  return risks.sort((a, b) => a.healthScore - b.healthScore)
}
