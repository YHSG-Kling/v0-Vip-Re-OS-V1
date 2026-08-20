"use server"

import { createClient } from "@/lib/supabase/server"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { calculateCost, type AIModel } from "@/lib/ai/cost-tracking"
import { getAgentContext, type AgentContext } from "@/lib/identity/get-agent-context"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import type { MessageType } from "@/lib/kernel/types"

// =====================================================
// WHAT A TOOL IS ALLOWED TO SAY IT SPENT
// =====================================================
//
// Seven tools in this file used to be one-line stubs that returned a canned
// string AND a hardcoded `tokensUsed` — 500, 400, 300, 350, 250, 600, 700 —
// which `executeAITool` then wrote to `ai_tool_usage.tokens_used` as a
// SUCCESSFUL run. That table is the platform's AI cost ledger: it is what
// lib/finance/usage-metering.ts rolls into `meter_readings.ai_tokens` per
// brokerage and what the per-tier overage projection is built on. A function
// that never called a model and reported 500 tokens was not an unfinished
// feature, it was a fabricated meter reading in a billing record.
//
// So a token figure now has to say WHERE IT CAME FROM, and there is no arm of
// this union that lets a tool name a number of its own:
//
//   measured             — this file called the model and read the counts off
//                          the provider's response. This row books them.
//   booked_by_survivor   — the tool routes to a real implementation elsewhere
//                          whose own lane already writes an ai_tool_usage
//                          ledger row (via logAIUsage) for the same call.
//                          Booking it again here would DOUBLE-BILL the tenant,
//                          so this row books 0 and names where the spend landed.
//   lane_reports_no_usage — a model ran through a path that neither returns its
//                          usage nor ledgers it. 0, with a warning naming the
//                          lane. Reported, never guessed at.
//   no_model_call        — nothing was bought.
//   refused              — the tool declined (missing input, no tenant, blocked
//                          by compliance). 0 tokens AND success=false.
type ToolTokens =
  | { measured: true; inputTokens: number; outputTokens: number; model: AIModel }
  | {
      measured: false
      reason: "booked_by_survivor" | "lane_reports_no_usage" | "no_model_call" | "refused"
      detail: string
    }

interface ToolRun {
  /**
   * What the caller sees.
   *
   * A STRING, not `unknown`, because that is what the surface on the other end
   * actually is: app/dashboard/ai-tools/ai-tools-client.tsx keeps results in a
   * `Record<string, string>`, hands them to `checkThemFirstCompliance`, renders
   * them as a React child and copies them to the clipboard. Four tools were
   * returning bare objects into that, which React refuses to render at all.
   * Anything structured is serialised at the dispatch boundary instead.
   */
  output: string
  tokens: ToolTokens
  /** AI_TASK_ROUTING key this run rode, stamped on the ledger row. */
  feature?: string
}

/** Whatever a tool produced, as the text the panel can actually show. */
function toPanelText(result: unknown): string {
  if (typeof result === "string") return result
  if (result == null) return ""
  return JSON.stringify(result, null, 2)
}

/** The tool declined to run. Ledgered as a FAILURE, never as a successful run. */
function refuse(reason: string, detail = reason): ToolRun {
  return { output: reason, tokens: { measured: false, reason: "refused", detail } }
}

/** Trim a form field to a real value, or null. Blank strings are not answers. */
function field(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t.length > 0 ? t : null
}

// =====================================================
// UNIVERSAL AI TOOL EXECUTOR
// =====================================================

export async function executeAITool(
  toolName: string,
  /**
   * IGNORED, and kept only so the AI Toolkit client's existing call site still
   * type-checks. This is a `"use server"` export — a public HTTP endpoint — so
   * a caller-supplied user id is an assertion by the browser about who it is,
   * and it decided both the tenant this run was billed to and (through
   * compareProperties) whose saved properties were read. Identity comes from
   * the session below and from nowhere else.
   */
  _callerSuppliedUserId: string,
  userType: string,
  params: any
) {
  const supabase = await createClient()
  const startTime = Date.now()

  // ── IDENTITY + TENANT, FROM THE SESSION ──────────────────────────────────
  // getAgentContext never throws; an unauthenticated caller gets the safe
  // default and is refused here rather than reaching a model call.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.userId) {
    return { success: false, result: "Sign in to run AI tools.", error: "Sign in to run AI tools." }
  }
  const userId = ctx.userId
  const brokerageId = ctx.brokerageId
  if (!brokerageId) {
    // Not fatal — the row still lands — but it will not appear in the
    // brokerage usage meter, so say so instead of letting it vanish quietly.
    console.error(
      `[ai-tools-hub] user ${userId} carries no brokerage_id — ai_tool_usage row written untenanted and will not appear in the brokerage usage meter`,
    )
  }

  let run: ToolRun
  try {
    run = await dispatchAITool(toolName, ctx, userType, params)
  } catch (error: any) {
    run = refuse(
      error?.message ? `The tool did not run: ${error.message}` : "The tool did not run.",
      error?.message ?? "unknown error",
    )
  }

  const refused = run.tokens.measured === false && run.tokens.reason === "refused"
  const success = !refused

  // ── THE LEDGER ROW ───────────────────────────────────────────────────────
  // tokens_used / model_used / cost_cents are derived from `run.tokens` and
  // from nothing else. There is no branch here that can produce a number the
  // provider did not return. A run this file did not pay for books ZERO —
  // either because nothing was spent, or because the spend is already booked
  // on another ai_tool_usage row and counting it twice would overstate the
  // tenant's AI meter.
  const measured = run.tokens.measured ? run.tokens : null
  const ledgerTokens = measured === null ? 0 : measured.inputTokens + measured.outputTokens
  const ledgerModel = measured === null ? null : measured.model
  const ledgerCostCents =
    measured === null ? 0 : calculateCost(measured.model, measured.inputTokens, measured.outputTokens)

  if (!run.tokens.measured && run.tokens.reason === "lane_reports_no_usage") {
    console.warn(
      `[ai-tools-hub] ${toolName}: a model ran but its lane reports no usage — ledgered as 0 tokens. ${run.tokens.detail}`,
    )
  }

  // ai_tool_usage real columns: context_json (was input_data), output_text
  // (was output_data); no user_type column.
  const { error: usageError } = await supabase.from("ai_tool_usage").insert({
    brokerage_id: brokerageId,
    user_id: userId,
    agent_id: ctx.agentId,
    team_id: ctx.teamId,
    tool_name: toolName,
    feature: run.feature ?? null,
    context_json: JSON.stringify(params ?? {}),
    output_text: run.output,
    execution_time_ms: Date.now() - startTime,
    success,
    tokens_used: ledgerTokens,
    model_used: ledgerModel,
    cost_cents: ledgerCostCents,
  })
  // supabase-js RESOLVES a refused write, so an unread error here would report
  // a ledger row that was never created.
  if (usageError) {
    console.error("[ai-tools-hub] ai_tool_usage insert failed:", usageError.message)
  }

  // `error` is populated on a refusal because the AI Toolkit client reads
  // `result.error` when success is false; without it the panel showed the
  // generic "The tool returned no result." and the real reason was lost.
  return refused
    ? { success: false, result: run.output, error: run.output }
    : { success: true, result: run.output }
}

/**
 * Route a tool id to its implementation.
 *
 * Split out of executeAITool so the ledger above has exactly one shape to
 * write — every arm returns a ToolRun carrying its own token provenance, and
 * there is no path back to the old `result?.tokensUsed` read that let a
 * function assert its own billing figure.
 */
async function dispatchAITool(
  toolName: string,
  ctx: AgentContext,
  userType: string,
  params: any,
): Promise<ToolRun> {
  switch (toolName) {
    // ── CLIENT EDUCATION TOOLS ───────────────────────────────────────────
    case "explain_this":
      return unmeasuredLane(
        await explainTerm(params.term, params.context, userType),
        "explainTerm → generateTextRouted with no brokerageId, which skips logAIUsage",
      )

    case "property_comparison":
      // userId is the SESSION user — this read returns the caller's own saved
      // properties, and it used to take whichever id the browser sent.
      return unmeasuredLane(
        await compareProperties(params, ctx.userId),
        "compareProperties → generateTextRouted with no brokerageId, which skips logAIUsage",
      )

    case "affordability_calculator":
      // The form's own four fields — income, debt, downPayment, rate. The old
      // call passed params.location, which this form does not collect, and
      // dropped debt and rate entirely.
      return unmeasuredLane(
        await runAffordabilityTool(params),
        "runAffordabilityTool → calculators + generateTextRouted with no brokerageId",
      )

    case "neighborhood_research":
      return unmeasuredLane(
        await researchNeighborhood(params.address, ctx.userId),
        "researchNeighborhood → generateTextRouted with no brokerageId, which skips logAIUsage",
      )

    case "document_explainer":
      return explainDocument(params, ctx)

    // ── AGENT TOOLS ──────────────────────────────────────────────────────
    case "property_description":
      return generatePropertyDescription(params, ctx)

    case "email_composer":
      return composeEmail(params, ctx)

    case "social_post":
      return generateSocialPost(params, ctx)

    case "objection_handler":
      return handleObjection(params, ctx)

    case "smart_reply":
      return generateSmartReply(params, ctx)

    // ── BROKER TOOLS ─────────────────────────────────────────────────────
    case "deal_health_monitor":
      return {
        output: toPanelText(await analyzeDealHealth(params.transactionIds, ctx.userId)),
        tokens: { measured: false, reason: "no_model_call", detail: "pure scoring over transactions — no model call" },
      }

    case "team_performance_analyzer":
      return analyzeTeamPerformance(params, ctx)

    case "market_trend_predictor":
      return predictMarketTrends(params, ctx)

    // ── TC TOOLS ─────────────────────────────────────────────────────────
    case "document_checklist":
      return generateDocumentChecklist(params, ctx)

    case "deadline_calculator":
      return calculateDeadlines(params, ctx)

    default:
      throw new Error(`Unknown tool: ${toolName}`)
  }
}

/**
 * Wrap a tool that DID call a model through a lane which neither returns its
 * usage nor writes a ledger row. Books 0 and says why.
 *
 * These four are the pre-existing, genuinely-implemented tools. They are
 * untouched here; this only stops the executor from silently reading a
 * `tokensUsed` field off whatever they happen to return. Closing the gap means
 * giving each one a tenant so `generateTextRouted` ledgers it — recorded as a
 * finding rather than swept into this change.
 */
function unmeasuredLane(output: unknown, detail: string): ToolRun {
  return { output: toPanelText(output), tokens: { measured: false, reason: "lane_reports_no_usage", detail } }
}

/**
 * The one model call this file makes on its own account.
 *
 * `brokerageId` is deliberately NOT passed: generateTextRouted ledgers through
 * logAIUsage only when it has a tenant, and this hub writes its own
 * ai_tool_usage row for every run. Passing it would put the SAME call on two
 * rows of the same table and usage-metering sums the table without filtering,
 * so the brokerage's ai_tokens meter would read double. The counts come back
 * from the provider and the caller books them exactly once.
 */
async function runHubModel(opts: {
  feature: string
  prompt: string
  system?: string
  temperature?: number
  maxTokens?: number
}): Promise<{ text: string; tokens: Extract<ToolTokens, { measured: true }> }> {
  const { text, usage } = await generateText({
    feature: opts.feature,
    prompt: opts.prompt,
    system: opts.system,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
  })
  return {
    text,
    tokens: {
      measured: true,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      model: usage.model,
    },
  }
}

/**
 * THE OUTBOUND COMPLIANCE GATE for copy this hub hands back.
 *
 * Anything a client will read — listing copy, a social post, an email, a
 * message draft, a talk track the agent will say out loud — goes through
 * evaluateOutbound before it leaves this file. That is the same five-gate
 * kernel the rest of the platform's outbound content uses, and it is what
 * enforces Fair Housing and Them-First; a new copy generator that returned
 * ungated text would be a hole straight past it.
 *
 * `contact` is omitted deliberately. These tools collect a recipient NAME at
 * most, never a resolved contacts.id, so there is no recipient whose
 * DNC/consent state could be checked — Gates 2 and 3 are skipped and Gates 1,
 * 4 and 5 still run. Passing a placeholder id instead would make both the
 * contact re-fetch and the compliance_events audit INSERT fail with 22P02.
 *
 * The tenant comes from the SESSION context, never from a parameter.
 */
async function gateOutboundCopy(
  ctx: AgentContext,
  content: string,
  messageType: MessageType,
): Promise<{ allowed: boolean; violations: string[] }> {
  if (!ctx.brokerageId) {
    // Fail CLOSED. applyBrandVoice and the compliance_events audit row are both
    // brokerage-keyed, so with no tenant there is no ruleset to evaluate
    // against — and "nobody checked" must never read as "checked and fine".
    return { allowed: false, violations: ["No brokerage on this session — outbound copy cannot be compliance-checked."] }
  }
  const result = await evaluateOutbound({
    actorContext: {
      userId: ctx.userId,
      role: (ctx.role as any) ?? "agent",
      brokerageId: ctx.brokerageId,
      teamId: ctx.teamId ?? undefined,
    },
    journeyType: "buyer",
    persona: "first_time",
    messageType,
    content,
  })
  return { allowed: result.allowed, violations: result.violations ?? [] }
}

/** A gate refusal, worded for the panel and ledgered as a refusal. */
function blockedByCompliance(violations: string[]): ToolRun {
  const first = violations[0] ?? "compliance violation"
  return refuse(
    `This draft was blocked by the compliance gate and has not been returned.\n\n${violations.map((v) => `• ${v}`).join("\n")}`,
    `compliance: ${first}`,
  )
}

// =====================================================
// RAG-BASED "EXPLAIN THIS" FOR CLIENTS
// =====================================================

async function explainTerm(term: string, context: string, userType: string) {
  const supabase = await createClient()
  
  // Search knowledge base using text search (simplified without embeddings)
  const { data: relevantDocs, error } = await supabase
    .from("knowledge_articles")
    .select("content, title")
    .textSearch("content", term)
    .limit(3)
  
  if (error) {
    console.error("[AI Tools] RAG search error:", error)
    throw new Error("Failed to search knowledge base")
  }
  
  // AI generates explanation using retrieved context
  const prompt = `
Explain "${term}" in simple, plain English for a ${userType === "buyer" ? "homebuyer" : userType === "seller" ? "home seller" : "real estate professional"}.

Context from knowledge base:
${relevantDocs?.map((d: any) => d.content).join("\\n\\n")}

Additional context: ${context}

Requirements:
- No jargon
- Use analogies and examples
- 2-3 sentences max
- Reassuring tone
- "Them First" approach

Explain:
`
  
  const { text } = await generateText({
    model: "openai/gpt-4o-mini",
    prompt,
    temperature: 0.7,
  })
  
  return {
    term,
    explanation: text,
    learn_more_docs: relevantDocs?.map((d: any) => d.title) || [],
  }
}

// =====================================================
// PROPERTY COMPARISON (CLIENT TOOL)
// =====================================================

interface ComparePropertiesParams {
  property1?: string
  property2?: string
  property3?: string
  buyerCriteria?: string
}

async function compareProperties(params: ComparePropertiesParams, userId: string) {
  const supabase = await createClient()

  // Buyer-side properties live in `saved_properties` (IDX/external/manual,
  // keyed by `property_address`) — NOT the seller-owned `listings` table and
  // not a non-existent `properties` table. The UI collects address strings,
  // so we match on address and enrich with whatever saved-property data exists.
  const addresses = [params.property1, params.property2, params.property3]
    .map((a) => a?.trim())
    .filter((a): a is string => Boolean(a))

  if (addresses.length < 2) {
    throw new Error("Need at least 2 property addresses to compare")
  }

  const { data: saved } = await supabase
    .from("saved_properties")
    .select(
      "property_address, list_price, bedrooms, bathrooms, sqft, city, state, property_type, source"
    )
    .eq("user_id", userId)
    .in("property_address", addresses)

  const byAddress = new Map(
    (saved ?? []).map((p) => [p.property_address?.trim().toLowerCase(), p])
  )

  const properties = addresses.map((address) => {
    const match = byAddress.get(address.toLowerCase())
    return {
      property_address: address,
      list_price: match?.list_price ?? null,
      bedrooms: match?.bedrooms ?? null,
      bathrooms: match?.bathrooms ?? null,
      sqft: match?.sqft ?? null,
      city: match?.city ?? null,
      state: match?.state ?? null,
      property_type: match?.property_type ?? null,
      source: match?.source ?? null,
    }
  })

  const prompt = `
You are a real estate AI assistant. Compare these properties for a homebuyer and provide insights.
${params.buyerCriteria ? `\nBuyer criteria: ${params.buyerCriteria}\n` : ""}
${properties
  .map(
    (p, i) => `
Property ${i + 1}:
- Address: ${p.property_address}
- Price: ${p.list_price != null ? `$${Number(p.list_price).toLocaleString()}` : "unknown"}
- Beds: ${p.bedrooms ?? "?"} | Baths: ${p.bathrooms ?? "?"} | SqFt: ${p.sqft ?? "?"}
- Location: ${[p.city, p.state].filter(Boolean).join(", ") || "unknown"}
- Property Type: ${p.property_type ?? "unknown"}`
  )
  .join("\n")}

Where a field is unknown, reason from the address and buyer criteria rather than inventing numbers.
Provide:
1. Price per square foot comparison (only where data is available)
2. Key differentiators
3. Pros/cons of each
4. Which property offers better value for this buyer and why

Be concise, objective, and helpful.
`

  const { text } = await generateText({
    model: "openai/gpt-4o-mini",
    prompt,
    temperature: 0.7,
  })

  return {
    properties,
    comparison: text,
  }
}

// =====================================================
// AFFORDABILITY CALCULATOR
// =====================================================
//
// This case used to run a SECOND, weaker affordability model defined right here.
// app/actions/calculators.ts calculateAffordability is the survivor — it is
// strictly more capable and it matches the fields this tool's own form already
// collects. The local copy is deleted. What it got wrong:
//
//   · It took (income, downPayment, location) while the form collects income,
//     debt, downPayment and RATE. The buyer's monthly debt and the real interest
//     rate were typed in and thrown away; it assumed zero debt and hardcoded 7%.
//   · `location` is not a field on this form at all, so it was always undefined —
//     the prompt asked the model what to expect "in the undefined market".
//   · The form's inputs are text ("$120,000", "$500", "6.5%" — its own
//     placeholders). `"$120,000" / 12` is NaN, so every figure it produced was
//     NaN and the narrative quoted $NaN.
//   · It returned an OBJECT while this screen renders results as text, so the
//     panel showed "[object Object]".
//   · Its single 43% DTI ignored property tax, insurance, PMI and HOA when
//     solving for max price, so the number it did aim at was too high anyway.
//
// The survivor applies front-end 28% AND back-end 36% DTI against real debts,
// and solves for max price carrying tax + insurance + PMI + HOA. The AI narrative
// stays — it is this tool's value-add — but it now explains REAL figures instead
// of generating them.

/** "6.5%" / "6.5" → 6.5. Returns null rather than guessing. */
function parseRatePercent(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null
  if (typeof v !== "string") return null
  const cleaned = v.replace(/[%\s]/g, "")
  if (cleaned === "" || !/^\d+(\.\d+)?$/.test(cleaned)) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

async function runAffordabilityTool(params: {
  income?: unknown
  debt?: unknown
  downPayment?: unknown
  rate?: unknown
}): Promise<string> {
  const { parseMoney } = await import("@/lib/offers/closing-cost-accuracy")

  const annualIncome = parseMoney(params.income)
  const downPayment = parseMoney(params.downPayment)
  const interestRate = parseRatePercent(params.rate)
  // Debt is the one genuinely optional field — blank means no monthly debts,
  // which is a real answer. An UNREADABLE value is not the same thing and is
  // refused below rather than silently treated as zero.
  const debtRaw = typeof params.debt === "string" ? params.debt.trim() : params.debt
  const monthlyDebts = debtRaw === "" || debtRaw == null ? 0 : parseMoney(debtRaw)

  const missing: string[] = []
  if (annualIncome == null) missing.push("annual income")
  if (downPayment == null) missing.push("down payment")
  if (interestRate == null) missing.push("interest rate")
  if (monthlyDebts == null) missing.push("monthly debt")

  if (missing.length > 0) {
    // No figure at all beats a figure built on NaN.
    return `I could not read ${missing.join(", ")}. Enter ${missing.length === 1 ? "it" : "them"} as a plain amount — for example 120000 or $120,000 for income, and 6.5 or 6.5% for the rate — and run it again.`
  }

  const { calculateAffordability } = await import("@/app/actions/calculators")
  const affordability = await calculateAffordability({
    annualIncome: annualIncome!,
    monthlyDebts: monthlyDebts!,
    downPayment: downPayment!,
    interestRate: interestRate!,
  })

  const b = affordability.monthlyBreakdown
  const h = affordability.hiddenCosts
  const money = (n: number) => `$${Math.round(n).toLocaleString()}`

  const figures = `Maximum home price: ${money(affordability.maxHomePrice)}
Down payment: ${money(affordability.downPayment)}
Loan amount: ${money(affordability.loanAmount)}

Estimated monthly payment: ${money(b.total)}
  Principal & interest: ${money(b.principal_interest)}
  Property tax: ${money(b.property_tax)}
  Insurance: ${money(b.insurance)}
  PMI: ${money(b.pmi)}
  HOA: ${money(b.hoa)}

Costs beyond the payment:
  Estimated closing costs: ${money(h.closing_costs)}
  Monthly maintenance budget: ${money(h.maintenance_budget)}
  Estimated utilities: ${money(h.utilities_estimate)}`

  // The narrative EXPLAINS the numbers above; it does not produce them.
  const prompt = `You are advising a homebuyer. These figures were already
calculated from their real inputs — annual income ${money(annualIncome!)}, monthly
debts ${money(monthlyDebts!)}, down payment ${money(downPayment!)}, interest rate
${interestRate}%:

${figures}

Write 2-3 short paragraphs that:
1. Explain what price range they should realistically shop in and why.
2. Point out which part of the monthly payment will surprise them most.
3. Give concrete ways to increase their buying power.

Use ONLY the figures above. Do not recalculate them, do not introduce different
numbers, and do not comment on any specific city or market — no location was
provided.`

  const { text } = await generateText({
    model: "openai/gpt-4o-mini",
    prompt,
    temperature: 0.7,
  })

  const notes = affordability.recommendations?.length
    ? `\n\nWhat to watch:\n${affordability.recommendations.map((r) => `• ${r}`).join("\n")}`
    : ""

  return `${figures}\n\n${text}${notes}`
}

// =====================================================
// NEIGHBORHOOD RESEARCH
// =====================================================

async function researchNeighborhood(address: string, userId: string) {
  const prompt = `
Provide a comprehensive neighborhood analysis for: ${address}

Cover:
1. Schools (quality, ratings)
2. Safety & Crime Statistics
3. Walkability & Transportation
4. Local Amenities (restaurants, shopping, parks)
5. Market Trends (appreciation, inventory)
6. Demographics & Community Vibe

Be factual, balanced, and helpful for a homebuyer making a decision.
`
  
  const { text } = await generateText({
    model: "openai/gpt-4o-mini",
    prompt,
    temperature: 0.7,
  })
  
  return {
    address,
    analysis: text,
  }
}

// =====================================================
// BROKER: DEAL HEALTH MONITOR
// =====================================================

async function analyzeDealHealth(transactionIds: string[], userId: string) {
  const supabase = await createClient()
  
  const { data: transactions } = await supabase
    .from("transactions")
    .select("*, document_requests(*)")
    .in("id", transactionIds)
  
  const healthReports = []
  
  for (const txn of transactions || []) {
    let healthScore = 100
    const issues = []
    
    // Check time in stage
    const daysInStage = Math.floor(
      (Date.now() - new Date(txn.stage_entered_at || txn.created_at).getTime()) / (1000 * 60 * 60 * 24)
    )
    
    if (daysInStage > 30) {
      healthScore -= 20
      issues.push(`Stalled: ${daysInStage} days in ${txn.status}`)
    }
    
    // Check missing documents
    const overdueDocs = txn.document_requests?.filter(
      (d: any) => d.status === "pending" && new Date(d.due_date) < new Date()
    )
    
    if (overdueDocs && overdueDocs.length > 0) {
      healthScore -= overdueDocs.length * 15
      issues.push(`${overdueDocs.length} documents overdue`)
    }
    
    // Check communication frequency
    if (txn.days_since_last_comm > 7) {
      healthScore -= 10
      issues.push(`No communication in ${txn.days_since_last_comm} days`)
    }
    
    healthReports.push({
      transaction_id: txn.id,
      property_address: txn.property_address,
      health_score: Math.max(healthScore, 0),
      status: healthScore >= 70 ? "healthy" : healthScore >= 50 ? "warning" : "critical",
      issues,
      recommendation: generateHealthRecommendation(healthScore, issues),
    })
  }
  
  return { health_reports: healthReports }
}

function generateHealthRecommendation(score: number, issues: string[]): string {
  if (score >= 70) return "Deal is on track. Continue normal monitoring."
  if (score >= 50) return `Action needed: ${issues[0]}. Schedule check-in call.`
  return `URGENT: Multiple issues detected. ${issues.join(". ")}. Escalate immediately.`
}

// =====================================================
// FAVORITES MANAGEMENT
// =====================================================

export async function toggleToolFavorite(userId: string, toolName: string) {
  const supabase = await createClient()
  
  const { data: existing } = await supabase
    .from("ai_tool_favorites")
    .select()
    .eq("user_id", userId)
    .eq("tool_name", toolName)
    .maybeSingle()
  
  if (existing) {
    await supabase.from("ai_tool_favorites").delete().eq("id", existing.id)
    return { favorited: false }
  } else {
    await supabase.from("ai_tool_favorites").insert({ user_id: userId, tool_name: toolName })
    return { favorited: true }
  }
}

export async function getUserFavorites(userId: string) {
  const supabase = await createClient()
  
  const { data } = await supabase
    .from("ai_tool_favorites")
    .select("tool_name")
    .eq("user_id", userId)
  
  return data?.map((f) => f.tool_name) || []
}

// =====================================================
// USAGE ANALYTICS
// =====================================================

export async function getAIToolUsageStats(userId: string, dateRange?: { start: string; end: string }) {
  const supabase = await createClient()
  
  let query = supabase
    .from("ai_tool_usage")
    .select("*")
    .eq("user_id", userId)
  
  if (dateRange) {
    query = query.gte("created_at", dateRange.start).lte("created_at", dateRange.end)
  }
  
  const { data } = await query
  
  const totalTasks = data?.length || 0
  const totalTokens = data?.reduce((sum, d) => sum + (d.tokens_used || 0), 0) || 0
  const avgExecutionTime = data?.reduce((sum, d) => sum + (d.execution_time_ms || 0), 0) / totalTasks || 0
  
  // Calculate time saved (assume 5 minutes per AI task)
  const timeSavedHours = (totalTasks * 5) / 60
  
  return {
    total_tasks: totalTasks,
    total_tokens: totalTokens,
    time_saved_hours: Math.round(timeSavedHours * 10) / 10,
    avg_execution_time_ms: Math.round(avgExecutionTime),
    // Per-tool counts, most-used first. The AI Toolkit's "Recently Used" row needs an
    // ARRAY of {toolName, count} and previously tried to .sort() this whole object,
    // which crashed the page. Keyed on tool_name — the real column on ai_tool_usage.
    by_tool: groupByTool(data || []),
  }
}

/**
 * Count usage per tool from the REAL column (ai_tool_usage.tool_name).
 *
 * This replaces a groupByCategory helper that read `item.tool_category` — a column that
 * does not exist on ai_tool_usage — so every row fell to "other" and the returned
 * tools_by_category was always a single meaningless bucket. Nothing consumed it. Tool
 * categories live in the client's TOOLS constant, not in the table, so grouping by
 * category cannot be done here honestly; per-tool counts are what the caller wants.
 */
function groupByTool(usage: any[]): Array<{ toolName: string; count: number }> {
  const counts = new Map<string, number>()
  for (const item of usage) {
    const name = item?.tool_name
    if (!name) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([toolName, count]) => ({ toolName, count }))
    .sort((a, b) => b.count - a.count)
}

// =====================================================
// THE TEN TOOLS THAT USED TO BE ONE-LINE STUBS
// =====================================================
//
// Every one of them ignored its arguments, returned a fixed sentence dressed
// as AI output, and asserted a token count. Two separate defects, and the
// second was the worse one — see the ToolTokens header at the top of this file.
//
// A SECOND DEFECT SURFACED WHILE WIRING THEM: not one of these took the fields
// its own form collects. app/dashboard/ai-tools/ai-tools-client.tsx passes the
// form's inputs object through verbatim, so `params.propertyData`,
// `params.topic`, `params.messageHistory`, `params.dateRange`,
// `params.metrics`, `params.marketArea`, `params.timeframe` and
// `params.documentText` were all `undefined` on every call. Even a real
// implementation behind those names would have been writing about nothing. The
// wiring below reads the field names the form actually renders.
//
// WHERE A REAL IMPLEMENTATION ALREADY EXISTED, THE STUB IS THE DUPLICATE and
// the hub routes to the survivor rather than growing a second one. Each such
// tool names its survivor at file:line in its own header.

// ─────────────────────────────────────────────────────────────────────────────
// property_description — DUPLICATE
//
// SURVIVOR: generateListingDescription, app/actions/ai-content-generation.tsx:924
//
// The survivor is a full listing-copy lane: plan feature gate
// (ai_listing_generation), brand-voice profile, persona guidance, a length
// contract (short/medium/long), the ai_generated_content artifact row, the
// content_generation_logs telemetry row, and — the reason this matters here —
// it generates through generateAIResponse, so its spend is already booked to
// the tenant on its own ai_tool_usage row by logAIUsage. This hub books 0 for
// it; booking it twice is what would overstate the brokerage's AI meter.
//
// MERGED FROM THE HUB'S SIGNATURE: the form's three fields had nowhere to go
// under the old `propertyData` name. `features` becomes `emphasize` (the
// survivor's own "what to lead with" input) and `tone` becomes
// `targetPersona`, which is exactly what the form's options are — luxury,
// family, modern, traditional, investment are buyer personas, not voices.
//
// THE GATE IS ADDED HERE, NOT ASSUMED: the survivor asks the model for fair
// housing compliance in its prompt and stamps compliance_status from the
// model's own self-report, but it never runs evaluateOutbound. MLS-facing
// copy leaving this hub goes through the real gate.
// ─────────────────────────────────────────────────────────────────────────────
async function generatePropertyDescription(
  params: { address?: unknown; features?: unknown; tone?: unknown },
  ctx: AgentContext,
): Promise<ToolRun> {
  const address = field(params.address)
  const features = field(params.features)
  if (!address || !features) {
    return refuse(
      "Enter the property address and its key features, then run it again — a description written without them would be about nothing.",
    )
  }
  if (!ctx.agentId) {
    return refuse(
      "This tool writes listing copy under your agent profile, and this account has no agent profile yet. Finish account setup and run it again.",
    )
  }

  const { generateListingDescription } = await import("@/app/actions/ai-content-generation")
  const res = (await generateListingDescription({
    agentId: ctx.agentId,
    length: "medium",
    targetPersona: field(params.tone) ?? undefined,
    emphasize: features.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean),
    propertyDetails: { address, key_features: features, requested_style: field(params.tone) },
  })) as { success: boolean; data?: any; error?: string }

  if (!res.success) return refuse(res.error ?? "The listing-copy generator did not return a description.")

  const copy = renderListingCopy(res.data)
  if (!copy) return refuse("The listing-copy generator returned nothing usable.")

  const gate = await gateOutboundCopy(ctx, copy, "social")
  if (!gate.allowed) return blockedByCompliance(gate.violations)

  return {
    output: copy,
    feature: "listing_description",
    tokens: {
      measured: false,
      reason: "booked_by_survivor",
      detail:
        "generateListingDescription → generateAIResponse → logAIUsage already wrote this call's ai_tool_usage row (tool_name='ai_model') against the same tenant",
    },
  }
}

/** Flatten the survivor's structured listing copy into the text the panel shows. */
function renderListingCopy(data: any): string {
  if (!data) return ""
  if (typeof data === "string") return data.trim()
  const parts = [
    data.headline ? String(data.headline) : "",
    String(data.medium_description ?? data.long_description ?? data.short_description ?? ""),
    Array.isArray(data.key_features_bullets) && data.key_features_bullets.length
      ? `Key features:\n${data.key_features_bullets.map((b: unknown) => `• ${b}`).join("\n")}`
      : "",
    data.neighborhood_paragraph ? String(data.neighborhood_paragraph) : "",
  ]
  const rendered = parts.filter((p) => p && p.trim()).join("\n\n").trim()
  // Never silently return "" for a shape this renderer does not know — show the
  // real payload rather than an empty panel that reads like a failure.
  return rendered || JSON.stringify(data, null, 2)
}

// ─────────────────────────────────────────────────────────────────────────────
// email_composer — DUPLICATE
//
// SURVIVOR: generateContextualDraft, app/actions/social/generate-social-post.ts:450
//
// It resolves the brokerage → team → agent brand-voice hierarchy and runs
// evaluateOutbound with messageType "email" on the draft before returning it.
//
// WHY NOT generateEmail (app/actions/ai-content-generation.tsx:1227), which is
// the more obvious name: it is built for CONTACT-BOUND campaign email. Its
// prompt builder (lib/services/content-generation.service.ts::buildEmailPrompt)
// reads the recipient out of a contacts row via contactId and never reads
// context.additionalContext at all, and its emailType union
// (welcome/follow_up/property_alert/market_update/check_in/reengagement/
// newsletter) does not contain four of the six types this form offers. Routing
// here would have dropped the Context box entirely and mislabelled the rest.
//
// MERGED FROM THE HUB'S SIGNATURE: `brief` and `variant` were added to the
// survivor. It could write from nothing or improve existing copy, but had no
// slot for "what this message has to accomplish" — which is the only thing the
// Toolkit's Context box contains.
// ─────────────────────────────────────────────────────────────────────────────
async function composeEmail(
  params: { emailType?: unknown; recipient?: unknown; context?: unknown },
  ctx: AgentContext,
): Promise<ToolRun> {
  const context = field(params.context)
  if (!context) {
    return refuse("Describe what this email needs to accomplish in the Context box, then run it again.")
  }
  if (!ctx.brokerageId) {
    return refuse("No brokerage on this session — an email cannot be brand-voiced or compliance-checked without one.")
  }

  const { generateContextualDraft } = await import("@/app/actions/social/generate-social-post")
  const res = await generateContextualDraft({
    // The survivor resolves brand voice tolerantly from either id class, and
    // uses this as actorContext.userId for the compliance gate — so the SESSION
    // user id is the correct thing to hand it.
    agentId: ctx.userId,
    brokerageId: ctx.brokerageId,
    teamId: ctx.teamId ?? undefined,
    contentType: "email",
    variant: field(params.emailType) ?? undefined,
    contactName: field(params.recipient) ?? undefined,
    brief: context,
  })

  // The survivor runs evaluateOutbound itself for contentType "email", so a
  // blocked draft comes back as success:false with the violations — this hub
  // does not re-gate it and does not return the blocked text.
  if (!res.success || !res.draft) {
    const why = res.error ?? "The email generator did not return a draft."
    return {
      output: res.complianceViolations?.length
        ? `This draft was blocked by the compliance gate and has not been returned.\n\n${res.complianceViolations.map((v) => `• ${v}`).join("\n")}`
        : why,
      feature: "email_generation",
      tokens: {
        measured: false,
        reason: "refused",
        // A refusal that FOLLOWED a model call is not free. The survivor now
        // carries its counts out, so the ledger row records what the refused
        // attempt cost instead of reading like nothing happened.
        detail: res.usage ? `refused after spending ${res.usage.totalTokens} tokens; ${why}` : why,
      },
    }
  }

  return {
    output: res.draft,
    feature: "email_generation",
    tokens: usageToTokens(res.usage, "generateContextualDraft"),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// social_post — DUPLICATE
//
// SURVIVOR: generateSocialPostContent, app/actions/social/generate-social-post.ts:146
//
// Brand-voice hierarchy, per-platform character limits, a structured post
// (body + hashtags + hook + CTA) and evaluateOutbound on the generated body.
// The hub's three form fields map onto it one-for-one with nothing left over,
// which is the clearest possible sign the stub was the duplicate.
//
// TENANT: brokerageId and agentId come from the session. The survivor takes
// them as parameters because its other callers are inside authenticated UI,
// but a `"use server"` entry point must never let the browser name them.
// ─────────────────────────────────────────────────────────────────────────────
async function generateSocialPost(
  params: { platform?: unknown; contentType?: unknown; context?: unknown },
  ctx: AgentContext,
): Promise<ToolRun> {
  const brief = field(params.context)
  const platform = field(params.platform)
  if (!brief) return refuse("Describe what the post is about in the Context box, then run it again.")
  if (!platform) return refuse("Pick a platform — the post is written to that platform's length and tone.")
  if (!ctx.brokerageId) {
    return refuse("No brokerage on this session — a post cannot be brand-voiced or compliance-checked without one.")
  }

  const { generateSocialPostContent } = await import("@/app/actions/social/generate-social-post")
  const res = await generateSocialPostContent({
    brief,
    platform,
    contentType: field(params.contentType) ?? undefined,
    brokerageId: ctx.brokerageId,
    agentId: ctx.userId,
    teamId: ctx.teamId ?? undefined,
  })

  if (!res.success || !res.data) {
    const detail = res.complianceBlocked
      ? `compliance: ${res.complianceViolations?.[0] ?? "blocked"}`
      : res.error ?? "no post returned"
    return {
      ...refuse(
        res.complianceBlocked
          ? `This post was blocked by the compliance gate and has not been returned.\n\n${(res.complianceViolations ?? []).map((v) => `• ${v}`).join("\n")}`
          : res.error ?? "The social post generator did not return a post.",
        detail,
      ),
      feature: "social_post_generation",
    }
  }

  const post = res.data
  const rendered = [
    post.content,
    post.hashtags?.length ? post.hashtags.map((h) => `#${h}`).join(" ") : "",
  ]
    .filter(Boolean)
    .join("\n\n")

  return {
    output: rendered,
    feature: "social_post_generation",
    tokens: usageToTokens(res.usage, "generateSocialPostContent"),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// objection_handler — BUILD
//
// NO SURVIVOR. Searched the whole tree for the capability, not the name:
//   · app/actions/objection-training.ts is a ROLEPLAY lane — it starts a
//     practice session, plays the prospect, grades the agent's turns and
//     stores objection_training_sessions/_turns. It never answers an
//     objection; it asks one.
//   · ai-sphere-management.ts:304, ai-referral-management.ts:318 and
//     lib/listing-presentation/generate-ai-presentation.ts:150 each carry an
//     objectionHandling ARRAY nested inside a larger artifact (a sphere plan,
//     a referral script, a listing presentation). None takes a free-text
//     objection, and pulling one out would mean generating an entire
//     presentation to read one field.
//   · app/actions/workflows.ts:469 generateScriptContent writes a script BY
//     TYPE and saves it to the scripts library — a different job with a
//     different side effect.
// So this is built here, on the routing table's playbook_response key
// ("Agent coaching playbook responses — nuanced guidance").
//
// GATED even though it is agent-facing: the output is a talk track the agent
// will say to a client, so Fair Housing and Them-First apply to it exactly as
// they apply to a written message.
// ─────────────────────────────────────────────────────────────────────────────
async function handleObjection(
  params: { objection?: unknown; context?: unknown },
  ctx: AgentContext,
): Promise<ToolRun> {
  const objection = field(params.objection)
  if (!objection) return refuse("Paste the objection you heard, then run it again.")
  const situation = field(params.context)

  const { text, tokens } = await runHubModel({
    feature: "playbook_response",
    temperature: 0.6,
    system: [
      "You are a real estate coach helping an agent respond to a live client objection.",
      'Answer with the "Them First" framework: acknowledge the concern as legitimate before addressing it, and keep the focus on what the client gains.',
      "Never use false urgency, never guarantee appreciation or investment returns, never disparage another agent or brokerage.",
      "Never reference or imply any protected class.",
    ].join("\n"),
    prompt: [
      `The client said: "${objection}"`,
      situation ? `Situation: ${situation}` : "",
      "",
      "Give the agent:",
      "1. What this objection usually means underneath the words.",
      "2. One acknowledgement line they can say verbatim.",
      "3. A short response, in the agent's voice, that answers the real concern.",
      "4. The one question to ask next to move the conversation forward.",
      "",
      situation
        ? "Use the situation above. Do not invent numbers, timelines or market facts that were not given."
        : "No situation was given, so keep the response general and do not invent numbers, timelines or market facts.",
    ]
      .filter(Boolean)
      .join("\n"),
  })

  const gate = await gateOutboundCopy(ctx, text, "in_app")
  if (!gate.allowed) {
    // The model already ran, so this refusal is NOT free. It is ledgered as a
    // refusal (success=false) carrying the reason; the tokens it cost are named
    // in the detail rather than dropped.
    return {
      ...blockedByCompliance(gate.violations),
      feature: "playbook_response",
      tokens: {
        measured: false,
        reason: "refused",
        detail: `compliance-blocked after spending ${tokens.inputTokens + tokens.outputTokens} tokens on ${tokens.model}`,
      },
    }
  }

  return { output: text, feature: "playbook_response", tokens }
}

// ─────────────────────────────────────────────────────────────────────────────
// smart_reply — DUPLICATE
//
// SURVIVOR: generateSmartReplies, lib/inbox/smart-replies.ts:79
//
// It produces exactly what this tool's card promises — three drafted replies to
// a received message, one affirming, one clarifying, one soft hold — already
// tuned for Them First, already rail-guarded against price commitments and
// speaking for the other side, and with a canned fallback when the gateway key
// is absent.
//
// NOT generateSmartResponse (app/actions/ai-communication-hub.ts:470): that one
// needs a contacts.id to load the thread and the contact's persona. This form
// collects a pasted message and a relationship type, and nothing else.
//
// The survivor now reports whether it actually called a model — the canned
// fallback path books ZERO, because nothing was bought.
// ─────────────────────────────────────────────────────────────────────────────
async function generateSmartReply(
  params: { lastMessage?: unknown; relationshipType?: unknown },
  ctx: AgentContext,
): Promise<ToolRun> {
  const lastMessage = field(params.lastMessage)
  if (!lastMessage) return refuse("Paste the message you received, then run it again.")

  const { generateSmartReplies } = await import("@/lib/inbox/smart-replies")
  const { replies, usage } = await generateSmartReplies({
    inboundBody: lastMessage,
    // The Toolkit does not ask which channel the reply goes out on — the agent
    // picks that when they send it — so this is drafted as an in-app message
    // rather than guessing SMS and getting SMS-length copy.
    channel: "in_app",
    contactType: field(params.relationshipType),
  })

  const rendered = replies
    .map((r) => `${r.intent === "affirm" ? "Affirm" : r.intent === "clarify" ? "Clarify" : "Soft hold"}: ${r.body}`)
    .join("\n\n")

  const gate = await gateOutboundCopy(ctx, rendered, "in_app")
  if (!gate.allowed) {
    return {
      ...blockedByCompliance(gate.violations),
      feature: "smart_reply_generation",
      tokens: {
        measured: false,
        reason: "refused",
        detail: usage.modelCalled
          ? `compliance-blocked after spending ${usage.totalTokens} tokens`
          : "compliance-blocked; no model was called (canned fallback)",
      },
    }
  }

  return {
    output: rendered,
    feature: "smart_reply_generation",
    tokens: usage.modelCalled
      ? {
          measured: true,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          // generateObjectRouted routes smart_reply_generation to claude-sonnet;
          // it does not report back WHICH of primary/fallback served the call,
          // so the ledger names the routed primary. Recorded as a finding.
          model: "claude-sonnet",
        }
      : {
          measured: false,
          reason: "no_model_call",
          detail: "AI_GATEWAY_API_KEY absent or the call threw — canned fallback replies, nothing spent",
        },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// team_performance_analyzer — BUILD (analysis layer only)
//
// NO SURVIVOR for the ANALYSIS. The DATA already exists and is not duplicated
// here: lib/kernel/reporting.ts:732 generateTeamPerformanceReport is the
// canonical team roll-up, and it carries the scope rule this tool must respect
// — a team lead sees only their own team, a broker/admin sees every team
// (resolveReportScope). This tool calls it and does nothing but read it.
//
// What did NOT exist is the narrative: analyzeAgentPerformance
// (app/actions/ai-training-coaching.ts:18) is PER-AGENT and coaches one
// person, and generateTeamPerformanceReport returns numbers with no reading of
// them. So the model call here is new capability, not a second copy of one.
//
// HONEST ABOUT SCOPE: the kernel roll-up is a CURRENT-STATE snapshot of
// team_performance rows; it has no period filter. The form's "time period" is
// therefore carried into the prompt as the lens the broker asked for, and the
// prompt says plainly that the figures are not filtered to it. Inventing a
// per-period query here would be a second, disagreeing set of team numbers.
// ─────────────────────────────────────────────────────────────────────────────
async function analyzeTeamPerformance(
  params: { timePeriod?: unknown; focusArea?: unknown },
  ctx: AgentContext,
): Promise<ToolRun> {
  if (!ctx.brokerageId || !ctx.agentId) {
    return refuse("This tool reads your brokerage's team roll-up, and this session has no brokerage or agent profile.")
  }

  const { generateTeamPerformanceReport } = await import("@/lib/kernel/reporting")
  const report = await generateTeamPerformanceReport({
    ctx: {
      userId: ctx.userId,
      agentId: ctx.agentId,
      brokerageId: ctx.brokerageId,
      userType: ctx.userType,
      teamId: ctx.teamId,
    },
  })

  if (!report.success) return refuse(`Could not read the team roll-up: ${report.error ?? "unknown error"}`)

  const teams = report.data?.teams ?? []
  if (teams.length === 0) {
    // No model call, and nothing to say. An empty roll-up is a real answer and
    // is reported as one — it is NOT sent to a model to have prose written
    // about nothing, and it books zero because nothing was spent.
    return {
      output:
        "No team performance rows are recorded for your brokerage yet, so there is nothing to analyse. Team roll-ups are written by the nightly team P&L job once a team has closed commissions.",
      tokens: { measured: false, reason: "no_model_call", detail: "empty team roll-up — nothing sent to a model" },
    }
  }

  const focus = field(params.focusArea)
  const period = field(params.timePeriod)
  const table = teams
    .map(
      (t) =>
        `- ${t.team_name}: revenue $${Math.round(t.total_revenue).toLocaleString()}, goal $${Math.round(t.goal_amount).toLocaleString()}, attainment ${t.attainment_pct}%`,
    )
    .join("\n")

  const { text, tokens } = await runHubModel({
    feature: "coaching_insight",
    temperature: 0.5,
    system:
      "You are a brokerage operations analyst. Read the team figures you are given and say what they mean. Never invent a metric that was not supplied.",
    prompt: [
      "Team roll-up for this brokerage (current recorded state):",
      table,
      "",
      period
        ? `The broker asked about: ${period.replace(/-/g, " ")}. IMPORTANT: the figures above are the CURRENT recorded roll-up and were NOT filtered to that window. Do not restate them as that period's numbers; where the question genuinely needs a period-scoped figure, say which figure is missing.`
        : "",
      focus && focus !== "all" ? `Focus area: ${focus.replace(/-/g, " ")}.` : "",
      "",
      "Give the broker:",
      "1. What stands out across these teams, with the figure that shows it.",
      "2. The single team most in need of attention, and why.",
      "3. Two concrete coaching actions.",
      "4. Anything you would need that is not in the figures above in order to answer better.",
      "",
      "Attainment is 0% wherever no goal is recorded — read that as 'no goal set', never as failure.",
      "agent_count is not carried on these rows; do not comment on headcount.",
    ]
      .filter(Boolean)
      .join("\n"),
  })

  return { output: `${table}\n\n${text}`, feature: "coaching_insight", tokens }
}

// ─────────────────────────────────────────────────────────────────────────────
// market_trend_predictor — DUPLICATE
//
// SURVIVOR: predictMarketShift, app/actions/ai-predictions.ts:2363
//
// Same capability, same inputs (city + state), and materially better than
// anything a fresh implementation would have been: it resolves the caller's
// own IDX Broker feed through idxForCallerBrokerage, refuses to report a
// fabricated average DOM when no listing carries one, tells the model in the
// prompt that the inventory count is the brokerage's own listings and not the
// market's, files a trend_alerts row, and raises ai_insights for the
// brokerage's affected contacts. Its spend rides generateAIJSON →
// runPipelineSimple → generateAIResponse → logAIUsage, so it is already booked
// to the tenant and this hub books 0.
//
// NOT generateMarketInsight (lib/intelligence/market-insight-generator.ts:291):
// that one is keyed to a market_area the brokerage has REGISTERED in
// market_data_sources and reads market_data / market_trends rows for it. This
// form takes a free-text city, which that lane cannot serve.
//
// MERGED FROM THE HUB'S SIGNATURE: `propertyType`, which this form has always
// collected and which the survivor had no parameter for.
// ─────────────────────────────────────────────────────────────────────────────
async function predictMarketTrends(
  params: { city?: unknown; state?: unknown; propertyType?: unknown },
  ctx: AgentContext,
): Promise<ToolRun> {
  const city = field(params.city)
  const state = field(params.state)
  if (!city || !state) return refuse("Enter both a city and a state, then run it again.")
  if (!ctx.brokerageId) {
    return refuse("No brokerage on this session — the prediction reads your brokerage's own IDX feed.")
  }

  const { predictMarketShift } = await import("@/app/actions/ai-predictions")
  const res = await predictMarketShift({
    city,
    state,
    propertyType: field(params.propertyType) ?? undefined,
  })

  return {
    // The AI Toolkit panel renders a string; the survivor returns the structured
    // prediction it also files to trend_alerts. Serialised rather than reshaped,
    // so nothing the survivor produced is dropped on the way to the screen.
    output: toPanelText(res.prediction),
    feature: "market_insight_generation",
    tokens: {
      measured: false,
      reason: "booked_by_survivor",
      detail:
        "predictMarketShift → generateAIJSON → runPipelineSimple → generateAIResponse → logAIUsage already wrote this call's ai_tool_usage row against the same tenant",
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// document_checklist / deadline_calculator / explainDocument
//
// THESE THREE WERE STUBS TOO — the brief named seven, and there are ten. They
// carried the same two defects (a canned string, and a fabricated 200 / 150 /
// 500 token ledger entry) and the fabricated meter readings are fixed here for
// the same reason as the other seven.
//
// THEY ARE NOT BUILT, and that is a deliberate refusal rather than an
// omission. What each would need is written out below so the next person does
// not have to re-derive it. A refusal that says what is missing is worth more
// than a placeholder that reads like an answer, and far more than a billing
// row for work nobody did.
// ─────────────────────────────────────────────────────────────────────────────

const NOT_BUILT_TOKENS = {
  measured: false as const,
  reason: "refused" as const,
  detail: "tool not implemented — no model call, nothing spent",
}

/**
 * deadline_calculator — REFUSED, and it must not be built with a model call.
 *
 * The platform already owns a DETERMINISTIC deadline vocabulary:
 * lib/transactions/milestone-catalog.ts pins the date-bearing milestones
 * (earnest money, inspection, appraisal, financing, closing) and
 * lib/transactions/contingency-deadlines.ts:24 carries the day-offset defaults
 * for the non-standard contingencies. Both read a real transaction's contract
 * terms. Asking a language model to produce contract deadlines from a date and
 * a state would create a SECOND source of truth for legally operative dates
 * that could disagree with the one the deadline-watcher cron escalates on.
 *
 * To finish it: either bind this tool to a transaction id and read the existing
 * transaction_deadlines rows, or lift the catalog's offsets into a pure
 * calculator both lanes call. Neither is a model call.
 */
async function calculateDeadlines(
  _params: { contractDate?: unknown; state?: unknown; contingencyDays?: unknown },
  _ctx: AgentContext,
): Promise<ToolRun> {
  return {
    output:
      "This tool is not wired up yet, so it has nothing to give you. Contract deadlines on this platform are computed from a real transaction's contract terms (lib/transactions), not estimated — a standalone calculator would be a second set of legally operative dates. Open the transaction and use its deadline schedule.",
    tokens: NOT_BUILT_TOKENS,
  }
}

/**
 * document_checklist — REFUSED.
 *
 * The nearest real implementation, prepareForClosing
 * (app/actions/ai-transaction-coordinator.ts:905), produces a document
 * checklist from an actual transaction's documents, participants and state —
 * it cannot serve a form that collects only a transaction TYPE. Finishing this
 * means either binding the tool to a transaction or agreeing that a
 * state-generic checklist is a distinct capability worth generating.
 */
async function generateDocumentChecklist(
  _params: { transactionType?: unknown; state?: unknown; propertyType?: unknown },
  _ctx: AgentContext,
): Promise<ToolRun> {
  return {
    output:
      "This tool is not wired up yet, so it has nothing to give you. Document checklists on this platform are built from a real transaction's documents and participants — open the transaction and use its closing checklist.",
    tokens: NOT_BUILT_TOKENS,
  }
}

/**
 * document_explainer — REFUSED.
 *
 * Its form collects a document TYPE and a question but no document, while the
 * old stub's signature asked for `documentText` — so nothing on this screen
 * has ever reached it. The document-intelligence lane
 * (app/actions/ai-document-intelligence.ts) explains real uploaded documents.
 * Finishing this means either accepting a pasted clause or pointing the tool at
 * a stored document.
 */
async function explainDocument(
  _params: { documentType?: unknown; question?: unknown },
  _ctx: AgentContext,
): Promise<ToolRun> {
  return {
    output:
      "This tool is not wired up yet, so it has nothing to give you. To have a document explained, upload it in Documents — the document intelligence tools read the real text rather than guessing from a document type.",
    tokens: NOT_BUILT_TOKENS,
  }
}

/**
 * Convert a survivor-reported usage block into the hub's token provenance.
 *
 * The `estimated` flag survives into the detail line rather than being
 * flattened away: an estimate measured off the real prompt and the real
 * completion is a legitimate ledger figure, but a reader of this table is
 * entitled to know it was not the provider's own count.
 */
function usageToTokens(
  usage: { inputTokens: number; outputTokens: number; totalTokens: number; estimated: boolean } | undefined,
  lane: string,
): ToolTokens {
  if (!usage) {
    return {
      measured: false,
      reason: "lane_reports_no_usage",
      detail: `${lane} returned no usage block for this call`,
    }
  }
  return {
    measured: true,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    // These lanes pin anthropic/claude-sonnet-4 (social) and openai/gpt-4o-mini
    // (contextual draft) at their own call sites through resolveModel, and the
    // generateObject shim does not report the served model back. The ledger
    // names the model the lane pins. Recorded as a finding.
    model: lane === "generateSocialPostContent" ? "claude-sonnet" : "gpt-4o-mini",
  }
}
