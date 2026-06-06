"use server"

/**
 * app/actions/kb-search.ts — Server Action wrapper for kb-search.
 *
 * Client components must use this instead of importing
 * "@/lib/intelligence/kb-search" directly. The lib module imports
 * OpenAI + service Supabase + (transitively via lib/agents/contact-memory)
 * the kernel event surface, so Turbopack walks the graph into
 * server-only territory and refuses to client-bundle.
 */
import {
  searchKB as _searchKB,
  type KBResult,
} from "@/lib/intelligence/kb-search"

export async function searchKB(
  query: string,
  brokerageId: string,
  limit?: number,
): Promise<KBResult[]> {
  return _searchKB(query, brokerageId, limit)
}
