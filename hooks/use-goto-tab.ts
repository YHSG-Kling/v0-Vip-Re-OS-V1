"use client"

import { useCallback } from "react"
import { useRouter, usePathname } from "next/navigation"

/**
 * useGotoTab — same-body census, round 4 (2026-09-09, lane FC). Two settings
 * pages each pasted an identical `gotoTab(tab, team?)` closure that pushed
 * `?tab=<tab>&team=<team>` onto the current pathname. Survivor for the
 * byte-identical private `gotoTab` in app/settings/blog-cadence/client.tsx:72
 * and app/settings/lifecycle-promos/tabs.tsx:52.
 *
 * Generic over the tab-key union `T` so each caller keeps its own `TabKey`
 * type instead of widening to `string`.
 */
export function useGotoTab<T extends string>() {
  const router = useRouter()
  const pathname = usePathname()
  return useCallback(
    (tab: T, team?: string) => {
      const url = new URL(pathname, "http://x")
      url.searchParams.set("tab", tab)
      if (team) url.searchParams.set("team", team)
      router.push(url.pathname + url.search)
    },
    [router, pathname],
  )
}
