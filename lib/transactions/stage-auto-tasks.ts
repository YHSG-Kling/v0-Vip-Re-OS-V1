import { createServiceClient } from '@/lib/supabase/service'
import { TransactionStage } from '@/lib/transactions/transaction-stages'

const STAGE_AUTO_TASKS: Record<string, Array<{
  title: string
  description: string
  priority: 'critical' | 'high' | 'medium' | 'low'
  category: string
  assigned_to: string
  due_days: number
}>> = {
  UNDER_CONTRACT: [
    { title: 'Schedule home inspection', description: 'Book general home inspection and confirm date.', priority: 'high', category: 'inspection', assigned_to: 'tc', due_days: 3 },
    { title: 'Collect lender pre-approval letter', description: 'Confirm financing package is attached and current.', priority: 'high', category: 'lender', assigned_to: 'tc', due_days: 2 },
    { title: 'Confirm earnest money delivery', description: 'Verify earnest money handling and due timeline.', priority: 'critical', category: 'escrow', assigned_to: 'tc', due_days: 1 },
  ],
  INSPECTION: [
    { title: 'Request inspection report', description: 'Obtain report from inspector and upload to transaction.', priority: 'high', category: 'inspection', assigned_to: 'tc', due_days: 2 },
    { title: 'Review inspection issues', description: 'Review report with agent and assess repair strategy.', priority: 'high', category: 'inspection', assigned_to: 'agent', due_days: 3 },
    { title: 'Request insurance quotes', description: 'Collect insurance quote options for buyer review.', priority: 'medium', category: 'insurance', assigned_to: 'tc', due_days: 5 },
  ],
  APPRAISAL: [
    { title: 'Confirm appraisal ordered', description: 'Confirm lender has ordered the appraisal.', priority: 'high', category: 'appraisal', assigned_to: 'tc', due_days: 1 },
    { title: 'Track appraisal completion', description: 'Monitor appraisal scheduling and completion.', priority: 'medium', category: 'appraisal', assigned_to: 'tc', due_days: 10 },
  ],
  FINANCING_PENDING: [
    { title: 'Follow up on lender document requests', description: 'Ensure all lender conditions are addressed.', priority: 'high', category: 'lender', assigned_to: 'tc', due_days: 2 },
    { title: 'Track underwriting status', description: 'Monitor underwriting progress.', priority: 'high', category: 'lender', assigned_to: 'tc', due_days: 3 },
    { title: 'Confirm clear to close', description: 'Get lender confirmation when file is CTC.', priority: 'critical', category: 'lender', assigned_to: 'tc', due_days: 7 },
  ],
  CLOSING_PREP: [
    { title: 'Generate CDA for review', description: 'Prepare CDA and route for broker approval.', priority: 'critical', category: 'cda', assigned_to: 'tc', due_days: 1 },
    { title: 'Schedule final walkthrough', description: 'Coordinate walkthrough with buyer and agent.', priority: 'high', category: 'closing', assigned_to: 'agent', due_days: 2 },
    { title: 'Confirm closing time and location', description: 'Finalize logistics with title/escrow.', priority: 'high', category: 'closing', assigned_to: 'tc', due_days: 3 },
    { title: 'Order closing gift', description: 'Prepare post-close client experience gift.', priority: 'low', category: 'client_experience', assigned_to: 'agent', due_days: 5 },
  ],
  CLOSED: [
    { title: 'Generate post-closing follow-up plan', description: 'Create referral and nurture touchpoints.', priority: 'medium', category: 'post_close', assigned_to: 'agent', due_days: 1 },
    { title: 'Request client review', description: 'Ask for testimonial or online review.', priority: 'medium', category: 'post_close', assigned_to: 'agent', due_days: 7 },
    { title: 'Schedule 30-day check-in', description: 'Create first post-closing touchpoint.', priority: 'low', category: 'post_close', assigned_to: 'agent', due_days: 1 },
  ],
  LOST: [],
}

export async function seedStageAutoTasks(params: {
  transactionId: string
  brokerageId: string
  stage: TransactionStage
  userId: string
}) {
  const supabase = createServiceClient()
  const tasks = STAGE_AUTO_TASKS[params.stage] ?? []

  if (!tasks.length) return { success: true, inserted: 0 }

  const { data: existing } = await supabase
    .from('transaction_tasks')
    .select('title')
    .eq('transaction_id', params.transactionId)
    .in('title', tasks.map(t => t.title))

  const existingTitles = new Set((existing ?? []).map((r: { title: string }) => r.title))
  const today = new Date()

  const rows = tasks
    .filter(t => !existingTitles.has(t.title))
    .map(task => {
      const due = new Date(today)
      due.setDate(due.getDate() + task.due_days)
      return {
        transaction_id:  params.transactionId,
        brokerage_id:    params.brokerageId,
        title:           task.title,
        description:     task.description,
        priority:        task.priority,
        category:        task.category,
        assigned_to:     task.assigned_to,
        ai_generated:    false,
        automatable:     false,
        status:          'pending',
        due_date:        due.toISOString().slice(0, 10),
      }
    })

  if (!rows.length) return { success: true, inserted: 0 }

  const { error } = await supabase.from('transaction_tasks').insert(rows)
  if (error) throw error

  return { success: true, inserted: rows.length }
}
