/**
 * THE transaction_tasks VOCABULARY — one copy, derived from the database.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * `transaction_tasks_priority_check` is:
 *
 *     CHECK (priority = ANY (ARRAY['critical','high','medium','low']))
 *
 * Every place that asks a model for a task priority used to hand-type its own
 * list, and the lists disagreed with the column. `app/actions/ai-transaction-
 * documents.ts` offered the model "urgent"|"high"|"medium"|"low" and then wrote
 * `r.priority ?? "medium"` straight through — so the moment the model picked the
 * first option it was offered, the CHECK refused the row and the ENTIRE batch
 * insert failed. The `??` fallback is no defence at all: it only fires for
 * null/undefined, never for a present-but-invalid value.
 *
 * A prompt must not be able to offer a value the column will refuse, so the
 * prompt text and the runtime coercion are both generated FROM this constant.
 *
 * NOTE ON PLACEMENT: this is a plain module, not `"use server"`. A "use server"
 * module may only export async functions, which is why the AI action files
 * cannot own this constant themselves — they import it.
 */

/** The live `transaction_tasks_priority_check` vocabulary, in severity order. */
export const TRANSACTION_TASK_PRIORITIES = ["critical", "high", "medium", "low"] as const

export type TransactionTaskPriority = (typeof TRANSACTION_TASK_PRIORITIES)[number]

/** The default used when a model returns nothing usable. Must be in the vocabulary. */
export const DEFAULT_TRANSACTION_TASK_PRIORITY: TransactionTaskPriority = "medium"

/**
 * The `"critical"|"high"|"medium"|"low"` fragment to interpolate into a prompt,
 * so the offered vocabulary is literally the accepted vocabulary.
 */
export const TRANSACTION_TASK_PRIORITY_PROMPT_UNION = TRANSACTION_TASK_PRIORITIES.map((p) => `"${p}"`).join("|")

/**
 * Narrow an arbitrary model-supplied value to a priority the column accepts.
 * Unlike `?? "medium"` this also catches a PRESENT but invalid value — which is
 * the only failure mode that ever actually occurred.
 */
export function coerceTaskPriority(value: unknown): TransactionTaskPriority {
  return (TRANSACTION_TASK_PRIORITIES as readonly string[]).includes(value as string)
    ? (value as TransactionTaskPriority)
    : DEFAULT_TRANSACTION_TASK_PRIORITY
}
