"use server"

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

/**
 * Required row lookup.
 * Use when the row MUST exist for the workflow to continue.
 */
export async function expectSingle<T>(
  query: Promise<{ data: T | null; error: { message: string } | null }>,
  notFoundMessage = "Required record not found"
): Promise<RowResult<T>> {
  try {
    const { data, error } = await query
    if (error) {
      return { success: false, error: error.message }
    }
    if (!data) {
      return { success: false, error: notFoundMessage }
    }
    return { success: true, data }
  } catch (error) {
    return { success: false, error: getErrorMessage(error) }
  }
}

/**
 * Optional row lookup.
 * Use when null is a valid outcome.
 */
export async function maybeSingleRow<T>(
  query: Promise<{ data: T | null; error: { message: string } | null }>
): Promise<OptionalRowResult<T>> {
  try {
    const { data, error } = await query
    if (error) {
      return { success: false, error: error.message }
    }
    return { success: true, data: data ?? null }
  } catch (error) {
    return { success: false, error: getErrorMessage(error) }
  }
}
