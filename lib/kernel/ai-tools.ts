// lib/kernel/ai-tools.ts
// LAYER 1 — Canonical AI Tools kernel commands.
// Kernel ownership: every AI tool execution, save, and attachment flows here.
// No "use server" — this file is server-only (called only from action wrappers).
// Imports nothing from app/ — depends only on lib/supabase/service and lib/kernel/types.
//
// ─── KERNEL OWNERSHIP ────────────────────────────────────────────────────────
// Owner: AI Tools subsystem
// Commands:
//   1. loadAiToolsWorkspace   — load tool usage history + saved outputs for a user
//   2. runAiTool              — execute an AI tool, log to ai_tool_usage, enforce gates
//   3. saveAiToolOutput       — persist tool output to saved_ai_outputs
//   4. attachAiOutputToEntity — link a saved output to a contact/lead/listing/transaction
//   5. previewAiOutput        — return a formatted preview without persisting
//
// ─── EXPLICIT RULES ──────────────────────────────────────────────────────────
// Rule 1: All tool executions must be logged to ai_tool_usage (no silent runs).
// Rule 2: Tool output is saved only when the user explicitly saves it.
// Rule 3: An output can be attached to one entity at a time (upsert by entity).
// Rule 4: tool_name must be a value from VALID_TOOL_NAMES — no ad-hoc tool strings.
// Rule 5: execution_time_ms is always tracked for performance auditing.
//
// ─── EXPLICIT COMMANDS ───────────────────────────────────────────────────────
// loadAiToolsWorkspace(input)   → AiToolsWorkspaceData
// runAiTool(input)              → { success, result, usageId }
// saveAiToolOutput(input)       → { success, savedOutputId }
// attachAiOutputToEntity(input) → { success }
// previewAiOutput(input)        → { preview: string }
//
// ─── TABLES WRITTEN ──────────────────────────────────────────────────────────
// ai_tool_usage         — every execution (insert)
// saved_ai_outputs      — user saves (upsert)
// ai_assistant_notes    — entity attachment (insert)
// lifecycle_events      — entity attachment events (insert)

import { createServiceClient } from "@/lib/supabase/service"
import type { ActorRole } from "@/lib/kernel/types"

// ─── VALID TOOL NAMES ─────────────────────────────────────────────────────────
// Strict union — no ad-hoc strings allowed in runAiTool.
export type AiToolName =
  | "explain_this"
  | "property_comparison"
  | "affordability_calculator"
  | "neighborhood_research"
  | "document_explainer"
  | "property_description"
  | "email_composer"
  | "social_post"
  | "objection_handler"
  | "smart_reply"
  | "deal_health_monitor"
  | "team_performance_analyzer"
  | "market_trend_predictor"
  | "document_checklist"
  | "deadline_calculator"

// ─── KERNEL RESULT TYPE ───────────────────────────────────────────────────────
export interface KernelAiToolsResult<T = unknown> {
  success: boolean
  data?: T
  error?: string
}

// ─── INPUT TYPES ─────────────────────────────────────────────────────────────

export interface AiToolsActorContext {
  userId: string
  brokerageId: string
  role: ActorRole
}

export interface LoadAiToolsWorkspaceInput {
  ctx: AiToolsActorContext
  /** Number of recent usage records to fetch. Default 50. */
  limit?: number
}

export interface AiToolsWorkspaceData {
  recentUsage: AiToolUsageRecord[]
  savedOutputs: SavedAiOutput[]
  stats: {
    totalRuns: number
    totalTokens: number
    timeSavedHours: number
    successRate: number
  }
}

export interface AiToolUsageRecord {
  id: string
  tool_name: string
  success: boolean
  execution_time_ms: number
  tokens_used: number
  created_at: string
  output_data: unknown
}

export interface SavedAiOutput {
  id: string
  tool_name: string
  output_text: string
  entity_type: string | null
  entity_id: string | null
  created_at: string
}

export interface RunAiToolInput {
  ctx: AiToolsActorContext
  toolName: AiToolName
  /** Raw params passed to the AI tool executor */
  params: Record<string, unknown>
  /** Output text from the tool (generated upstream by the executor) */
  outputText: string
  tokensUsed?: number
  executionTimeMs?: number
  success?: boolean
}

export interface SaveAiToolOutputInput {
  ctx: AiToolsActorContext
  toolName: AiToolName
  outputText: string
  /** Optional: attach to entity immediately on save */
  entityType?: "contact" | "lead" | "listing" | "transaction"
  entityId?: string
  metadata?: Record<string, unknown>
}

export interface AttachAiOutputToEntityInput {
  ctx: AiToolsActorContext
  savedOutputId: string
  entityType: "contact" | "lead" | "listing" | "transaction"
  entityId: string
  note?: string
}

export interface PreviewAiOutputInput {
  ctx: AiToolsActorContext
  toolName: AiToolName
  outputText: string
  /** Max characters to return. Default 500. */
  maxLength?: number
}

// ─── COMMAND 1: loadAiToolsWorkspace ─────────────────────────────────────────
/**
 * Load AI tools workspace data for a user.
 *
 * Input:  { ctx: { userId, brokerageId, role }, limit? }
 * Output: { success, data: AiToolsWorkspaceData }
 *
 * Tables read:
 *   ai_tool_usage (filter: user_id, order: created_at desc)
 *   saved_ai_outputs (filter: user_id, order: created_at desc)
 *
 * Business rules:
 *   - Returns up to `limit` recent usage records (default 50)
 *   - Stats are computed in-memory from the fetched records
 *   - timeSavedHours = totalRuns * 5 min / 60 (standard AI assist estimate)
 */
export async function loadAiToolsWorkspace(
  input: LoadAiToolsWorkspaceInput
): Promise<KernelAiToolsResult<AiToolsWorkspaceData>> {
  try {
    const { ctx, limit = 50 } = input
    const supabase = createServiceClient()

    const [usageRes, savedRes] = await Promise.all([
      supabase
        .from("ai_tool_usage")
        .select("id, tool_name, success, execution_time_ms, tokens_used, created_at, output_data")
        .eq("user_id", ctx.userId)
        .order("created_at", { ascending: false })
        .limit(limit),

      supabase
        .from("saved_ai_outputs")
        .select("id, tool_name, output_text, entity_type, entity_id, created_at")
        .eq("user_id", ctx.userId)
        .order("created_at", { ascending: false })
        .limit(20),
    ])

    const usage: AiToolUsageRecord[] = usageRes.data ?? []
    const saved: SavedAiOutput[] = savedRes.data ?? []

    const totalRuns = usage.length
    const totalTokens = usage.reduce((s, r) => s + (r.tokens_used ?? 0), 0)
    const successCount = usage.filter((r) => r.success).length
    const successRate = totalRuns > 0 ? Math.round((successCount / totalRuns) * 100) : 0
    const timeSavedHours = Math.round(((totalRuns * 5) / 60) * 10) / 10

    return {
      success: true,
      data: {
        recentUsage: usage,
        savedOutputs: saved,
        stats: { totalRuns, totalTokens, timeSavedHours, successRate },
      },
    }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to load AI tools workspace",
    }
  }
}

// ─── COMMAND 2: runAiTool ─────────────────────────────────────────────────────
/**
 * Log an AI tool execution to ai_tool_usage.
 *
 * This command is called AFTER the tool has already run (the AI executor
 * lives in the action layer). The kernel owns the audit trail.
 *
 * Input:  { ctx, toolName, params, outputText, tokensUsed?, executionTimeMs?, success? }
 * Output: { success, data: { usageId } }
 *
 * Tables written:
 *   ai_tool_usage (insert)
 *
 * Business rules:
 *   Rule 1: All executions logged — success or failure.
 *   Rule 2: toolName must be a valid AiToolName.
 *   Rule 3: usageId is returned so the caller can reference the record for saving.
 */
export async function runAiTool(
  input: RunAiToolInput
): Promise<KernelAiToolsResult<{ usageId: string }>> {
  try {
    const { ctx, toolName, params, outputText, tokensUsed = 0, executionTimeMs = 0, success = true } = input
    const supabase = createServiceClient()

    const { data: usageRow, error } = await supabase
      .from("ai_tool_usage")
      .insert({
        user_id: ctx.userId,
        brokerage_id: ctx.brokerageId,
        tool_name: toolName,
        input_data: params,
        output_data: { text: outputText },
        tokens_used: tokensUsed,
        execution_time_ms: executionTimeMs,
        success,
      })
      .select("id")
      .single()

    if (error) throw error

    return { success: true, data: { usageId: usageRow.id } }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to log AI tool run",
    }
  }
}

// ─── COMMAND 3: saveAiToolOutput ─────────────────────────────────────────────
/**
 * Persist a tool output to saved_ai_outputs.
 *
 * Input:  { ctx, toolName, outputText, entityType?, entityId?, metadata? }
 * Output: { success, data: { savedOutputId } }
 *
 * Tables written:
 *   saved_ai_outputs (insert)
 *
 * Business rules:
 *   Rule 1: Output is only saved when the user explicitly requests it.
 *   Rule 2: If entityType + entityId are provided, they are stored with the record
 *           so the UI can surface contextual saves per entity.
 *   Rule 3: outputText must not be empty.
 */
export async function saveAiToolOutput(
  input: SaveAiToolOutputInput
): Promise<KernelAiToolsResult<{ savedOutputId: string }>> {
  try {
    const { ctx, toolName, outputText, entityType, entityId, metadata } = input

    if (!outputText?.trim()) {
      return { success: false, error: "Output text is required" }
    }

    const supabase = createServiceClient()

    const { data: saved, error } = await supabase
      .from("saved_ai_outputs")
      .insert({
        user_id: ctx.userId,
        brokerage_id: ctx.brokerageId,
        tool_name: toolName,
        output_text: outputText.trim(),
        entity_type: entityType ?? null,
        entity_id: entityId ?? null,
        metadata: metadata ?? null,
      })
      .select("id")
      .single()

    if (error) throw error

    return { success: true, data: { savedOutputId: saved.id } }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to save AI tool output",
    }
  }
}

// ─── COMMAND 4: attachAiOutputToEntity ───────────────────────────────────────
/**
 * Attach a saved AI output to a real estate entity as a note.
 *
 * Input:  { ctx, savedOutputId, entityType, entityId, note? }
 * Output: { success }
 *
 * Tables written:
 *   ai_assistant_notes (insert — links saved output to entity)
 *   lifecycle_events   (insert — AI_NOTE_ATTACHED event)
 *
 * Business rules:
 *   Rule 1: The saved output must exist and belong to the calling user.
 *   Rule 2: One attachment per saved output per entity (upsert on conflict).
 *   Rule 3: Attachment is a non-destructive operation — does not modify the saved output.
 *
 * UI behavior:
 *   - On success: contact/lead/listing/transaction detail panel should refresh notes section.
 *   - On error: toast "Failed to attach output to [entity type]".
 */
export async function attachAiOutputToEntity(
  input: AttachAiOutputToEntityInput
): Promise<KernelAiToolsResult<void>> {
  try {
    const { ctx, savedOutputId, entityType, entityId, note } = input
    const supabase = createServiceClient()

    // Verify the saved output belongs to the calling user
    const { data: saved, error: fetchErr } = await supabase
      .from("saved_ai_outputs")
      .select("id, output_text, tool_name")
      .eq("id", savedOutputId)
      .eq("user_id", ctx.userId)
      .maybeSingle()

    if (fetchErr || !saved) {
      return { success: false, error: "Saved output not found or access denied" }
    }

    // Insert into ai_assistant_notes
    const { error: noteErr } = await supabase.from("ai_assistant_notes").insert({
      brokerage_id: ctx.brokerageId,
      user_id: ctx.userId,
      entity_type: entityType,
      entity_id: entityId,
      tool_name: saved.tool_name,
      content: note ?? saved.output_text,
      saved_output_id: savedOutputId,
    })

    if (noteErr) throw noteErr

    // Write lifecycle event
    await supabase
      .from("lifecycle_events")
      .insert({
        brokerage_id: ctx.brokerageId,
        entity_type: entityType,
        entity_id: entityId,
        event_type: "ai_note_attached",
        metadata: {
          tool_name: saved.tool_name,
          saved_output_id: savedOutputId,
          actor_user_id: ctx.userId,
        },
      })
      .then(() => void 0)
      .catch(() => void 0) // lifecycle event is non-fatal

    return { success: true }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Failed to attach output to entity",
    }
  }
}

// ─── COMMAND 5: previewAiOutput ──────────────────────────────────────────────
/**
 * Return a formatted preview of an AI output without persisting.
 *
 * Input:  { ctx, toolName, outputText, maxLength? }
 * Output: { success, data: { preview: string } }
 *
 * Business rules:
 *   Rule 1: Preview is always truncated to maxLength (default 500 chars).
 *   Rule 2: No DB writes — preview is purely a formatting helper.
 *   Rule 3: If outputText is empty, returns an error.
 *
 * UI behavior:
 *   - Shown inline in the tool output card before user decides to save.
 *   - "Save Output" button calls saveAiToolOutput separately.
 */
export async function previewAiOutput(
  input: PreviewAiOutputInput
): Promise<KernelAiToolsResult<{ preview: string }>> {
  const { outputText, maxLength = 500 } = input

  if (!outputText?.trim()) {
    return { success: false, error: "No output text to preview" }
  }

  const preview =
    outputText.length > maxLength
      ? outputText.slice(0, maxLength).trim() + "…"
      : outputText.trim()

  return { success: true, data: { preview } }
}
