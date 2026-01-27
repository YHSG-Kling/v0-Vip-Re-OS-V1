import { getSupabaseServerClient } from "../supabaseServer"

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
  const supabase = getSupabaseServerClient()

  // Calculate date range
  const now = new Date()
  const startDate = new Date()
  if (timeRange === "7d") startDate.setDate(now.getDate() - 7)
  else if (timeRange === "30d") startDate.setDate(now.getDate() - 30)
  else if (timeRange === "90d") startDate.setDate(now.getDate() - 90)

  // Query milestones
  const { data: milestones } = await supabase
    .from("transaction_milestones")
    .select(`
      id,
      due_date,
      completed_at,
      status,
      listing_id,
      listings!inner(brokerage_id)
    `)
    .eq("listings.brokerage_id", brokerageId)
    .gte("created_at", startDate.toISOString())

  const onTime =
    milestones?.filter((m) => m.completed_at && new Date(m.completed_at) <= new Date(m.due_date)).length || 0

  const overdue = milestones?.filter((m) => !m.completed_at && new Date(m.due_date) < now).length || 0

  // Query closed transactions for avg days
  const { data: closedTransactions } = await supabase
    .from("listings")
    .select("created_at, updated_at, status")
    .eq("brokerage_id", brokerageId)
    .eq("status", "sold")
    .gte("updated_at", startDate.toISOString())

  const avgDays = closedTransactions?.length
    ? closedTransactions.reduce((sum, t) => {
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
  const supabase = getSupabaseServerClient()

  // Get active transactions with overdue milestones
  const { data: transactions } = await supabase
    .from("listings")
    .select(`
      id,
      address,
      status,
      created_at,
      contacts!inner(first_name, last_name),
      transaction_milestones(id, status, due_date, completed_at)
    `)
    .eq("brokerage_id", brokerageId)
    .in("status", ["under_contract", "contingent", "pending"])

  if (!transactions) return []

  const now = new Date()
  const risks: TransactionRisk[] = []

  for (const transaction of transactions) {
    const overdueMilestones =
      (transaction as any).transaction_milestones?.filter((m: any) => !m.completed_at && new Date(m.due_date) < now)
        .length || 0

    const daysInContract = Math.floor(
      (now.getTime() - new Date(transaction.created_at).getTime()) / (1000 * 60 * 60 * 24),
    )

    // Calculate health score (100 - penalties for overdue milestones and time)
    const healthScore = Math.max(0, 100 - overdueMilestones * 15 - Math.max(0, daysInContract - 45))

    let riskLevel: "low" | "medium" | "high" | "critical" = "low"
    if (healthScore < 30) riskLevel = "critical"
    else if (healthScore < 50) riskLevel = "high"
    else if (healthScore < 70) riskLevel = "medium"

    const contact = (transaction as any).contacts
    const clientName = contact ? `${contact.first_name} ${contact.last_name}` : "Unknown"

    risks.push({
      transactionId: transaction.id,
      address: transaction.address || "N/A",
      clientName,
      pipeline: transaction.status,
      overdueMilestones,
      healthScore,
      daysInContract,
      riskLevel,
    })
  }

  return risks.sort((a, b) => a.healthScore - b.healthScore)
}
