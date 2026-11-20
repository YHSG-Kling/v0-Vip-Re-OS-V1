// lib/format/collections.ts
// ─────────────────────────────────────────────────────────────────────────────
// SAME-BODY CENSUS, ROUND 4 (2026-09-09, lane FC). PURE LEAF — no imports.

export interface PriorityBuckets<T> {
  high: T[]
  medium: T[]
  standard: T[]
}

/** Bucket items into `{ high, medium, standard }` by their `priority` field.
 *  Generic over the item shape — app/approvals/page.tsx and
 *  app/dashboard/admin/approvals/page.tsx each define their own local
 *  `ApprovalItem` interface (different optional fields), but both satisfy
 *  `{ priority: "high" | "medium" | "standard" }`, so one generic function
 *  serves both without forcing the two interfaces together. Survivor for the
 *  byte-identical private `groupByPriority` in app/approvals/page.tsx:217 and
 *  app/dashboard/admin/approvals/page.tsx:129. */
export function groupByPriority<T extends { priority: "high" | "medium" | "standard" }>(
  items: T[],
): PriorityBuckets<T> {
  return items.reduce(
    (acc, item) => {
      acc[item.priority].push(item)
      return acc
    },
    { high: [], medium: [], standard: [] } as PriorityBuckets<T>,
  )
}
