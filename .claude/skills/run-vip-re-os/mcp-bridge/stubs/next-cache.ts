export const revalidated: string[] = []
export function revalidatePath(p: string) { revalidated.push(p) }
export function revalidateTag(t: string) { revalidated.push(`tag:${t}`) }
export function unstable_cache<T extends (...a: any[]) => any>(fn: T) { return fn }
export function unstable_noStore() {}
export function updateTag(t: string) { revalidated.push(`tag:${t}`) }
export function refresh() {}
export const unstable_cacheLife = () => {}
export const unstable_cacheTag = () => {}
