// AI-powered suggestion engine that analyzes user data and generates actionable insights

export interface SmartSuggestionData {
  id: string
  type: "contact_followup" | "content_generation" | "task_priority" | "lead_scoring" | "automation"
  title: string
  description: string
  confidence: number
  urgency: "low" | "medium" | "high"
  category: string
  estimatedTime: string
  automatedSteps: string[]
  manualSteps: string[]
  actionPayload: Record<string, any>
  createdAt: Date
  expiresAt?: Date
}

export async function generateSmartSuggestions(
  userId: string,
  context: {
    contacts?: any[]
    tasks?: any[]
    contentIdeas?: any[]
    recentActivity?: any[]
  },
): Promise<SmartSuggestionData[]> {
  const suggestions: SmartSuggestionData[] = []

  // Analyze contacts for follow-up opportunities
  if (context.contacts) {
    const hotLeads = context.contacts.filter(
      (c) => c.lead_score >= 80 && (!c.last_contact || daysSince(c.last_contact) > 3),
    )

    if (hotLeads.length > 0) {
      suggestions.push({
        id: `followup-${Date.now()}`,
        type: "contact_followup",
        title: `Follow up with ${hotLeads.length} hot leads`,
        description: `${hotLeads.length} high-priority contacts haven't been contacted in 3+ days. AI will draft personalized messages based on their interests.`,
        confidence: 92,
        urgency: "high",
        category: "CRM",
        estimatedTime: "2 min",
        automatedSteps: [
          "Generate personalized email templates using contact history",
          "Schedule optimal send times based on past engagement",
          "Queue SMS reminders for non-openers after 48 hours",
        ],
        manualSteps: ["Review and customize email templates", "Approve final send list"],
        actionPayload: { contactIds: hotLeads.map((l) => l.id) },
        createdAt: new Date(),
      })
    }
  }

  // Analyze content gaps
  if (context.contentIdeas && context.contentIdeas.length < 3) {
    suggestions.push({
      id: `content-${Date.now()}`,
      type: "content_generation",
      title: "Generate this week's social content",
      description:
        "AI detected low content pipeline. Generate 5 high-performing posts based on market trends and your past engagement.",
      confidence: 87,
      urgency: "medium",
      category: "Marketing",
      estimatedTime: "1 min",
      automatedSteps: [
        "Analyze trending topics in your market",
        "Generate 5 post ideas with captions",
        "Create content calendar for next 7 days",
        "Schedule posts at optimal times",
      ],
      manualSteps: ["Review generated content", "Approve posting schedule"],
      actionPayload: { contentType: "social", count: 5 },
      createdAt: new Date(),
    })
  }

  // Analyze task priorities
  if (context.tasks && context.tasks.length > 10) {
    const overdueTasks = context.tasks.filter((t) => t.due_date && new Date(t.due_date) < new Date())

    if (overdueTasks.length > 0) {
      suggestions.push({
        id: `task-reorg-${Date.now()}`,
        type: "task_priority",
        title: `Reorganize ${overdueTasks.length} overdue tasks`,
        description:
          "AI will analyze task dependencies and create an optimized action plan based on impact and urgency.",
        confidence: 85,
        urgency: "high",
        category: "Productivity",
        estimatedTime: "30 sec",
        automatedSteps: [
          "Calculate task impact scores",
          "Identify quick wins (< 15 min tasks)",
          "Suggest task delegation opportunities",
          "Reschedule low-priority items",
        ],
        manualSteps: ["Approve new task priorities", "Confirm delegations"],
        actionPayload: { taskIds: overdueTasks.map((t) => t.id) },
        createdAt: new Date(),
      })
    }
  }

  return suggestions.sort((a, b) => {
    // Sort by urgency and confidence
    const urgencyWeight = { high: 3, medium: 2, low: 1 }
    const scoreA = urgencyWeight[a.urgency] * a.confidence
    const scoreB = urgencyWeight[b.urgency] * b.confidence
    return scoreB - scoreA
  })
}

function daysSince(date: string | Date): number {
  const then = new Date(date).getTime()
  const now = Date.now()
  return Math.floor((now - then) / (1000 * 60 * 60 * 24))
}
