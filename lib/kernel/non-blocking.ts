export async function ignoreSupabaseSideEffect<T>(
  operation: Promise<T>,
  onError?: (error: unknown) => void
): Promise<void> {
  try {
    await operation
  } catch (error) {
    if (onError) onError(error)
  }
}
