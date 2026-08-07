/**
 * lib/kernel/db.ts — single-row query helpers.
 *
 * These encode the discipline the rest of this codebase keeps re-learning:
 * **supabase-js RESOLVES a failed query**, so `const { data } = await q` turns a
 * refused read into an empty one, and a gate written that way fails OPEN.
 * `expectSingle` / `maybeSingleRow` destructure `error` for you and return a
 * discriminated result, so a caller cannot accidentally read "refused" as
 * "no rows".
 *
 * The `"use server"` directive was REMOVED here (orphan burn-down w2s3).
 * It made both exports publicly reachable HTTP endpoints — and nonsensical
 * ones: each takes a `Promise<QueryResult<T>>` as its argument, which is not
 * serializable across the Server Action boundary, so no browser caller could
 * ever have invoked them correctly. They are pure in-process utilities that
 * happen to be async, imported by ordinary `import`. Dropping the directive
 * removes two public endpoints and changes nothing else: the module had no
 * importers anywhere in the tree (verified), so there is no call site to
 * migrate.
 */

type QueryResult<T> = {
  data: T | null
  error: { message?: string } | null
}

type RowResult<T> =
  | { success: true; data: T }
  | { success: false; error: string }

type OptionalRowResult<T> =
  | { success: true; data: T | null }
  | { success: false; error: string }

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return "Unknown database error"
}

export async function expectSingle<T>(
  query: Promise<QueryResult<T>>,
  notFoundMessage = "Required record not found"
): Promise<RowResult<T>> {
  try {
    const { data, error } = await query
    if (error) {
      return { success: false, error: error.message || notFoundMessage }
    }
    if (!data) {
      return { success: false, error: notFoundMessage }
    }
    return { success: true, data }
  } catch (error) {
    return { success: false, error: getErrorMessage(error) }
  }
}

export async function maybeSingleRow<T>(
  query: Promise<QueryResult<T>>
): Promise<OptionalRowResult<T>> {
  try {
    const { data, error } = await query
    if (error) {
      return { success: false, error: error.message || "Optional query failed" }
    }
    return { success: true, data: data ?? null }
  } catch (error) {
    return { success: false, error: getErrorMessage(error) }
  }
}
