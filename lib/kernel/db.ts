"use server"

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
