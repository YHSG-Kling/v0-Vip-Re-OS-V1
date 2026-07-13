/**
 * lib/kernel/local-lifestyle.ts
 *
 * LOCAL LIFESTYLE COMPOSER (client concierge #30) — turns REAL nearby
 * places (Geoapify/OpenStreetMap, provider-gated) into the concierge
 * block the portal assistant may share when a client is exploring an
 * area: parks, schools, dining, groceries, fitness — grouped, closest
 * first, capped per group. PURE: places in → block out; ZERO places =
 * honest null (never an invented amenity). The client fetches; this
 * composes. NOT server-only (simulator-driven).
 */

import type { NearbyPlace } from "@/lib/external/geoapify-client"

const GROUPS: Array<{ label: string; match: RegExp }> = [
  { label: "Parks", match: /^leisure\.park/ },
  { label: "Schools", match: /^education\.school/ },
  { label: "Dining & coffee", match: /^catering\./ },
  { label: "Groceries", match: /^commercial\.supermarket/ },
  { label: "Fitness", match: /^sport\./ },
]

const walkNote = (m: number | null): string =>
  m == null ? "" : m <= 1200 ? " (walkable)" : ` (~${(m / 1609).toFixed(1)} mi)`

/** PURE: the grouped nearby-life block, or honest null when nothing real. */
export function composeLocalLifestyle(places: NearbyPlace[], perGroup = 3): string | null {
  const lines: string[] = []
  for (const g of GROUPS) {
    const hits = places
      .filter((p) => g.match.test(p.category))
      .sort((a, b) => (a.distanceMeters ?? 1e9) - (b.distanceMeters ?? 1e9))
      .slice(0, perGroup)
    if (hits.length === 0) continue
    lines.push(`${g.label}: ${hits.map((h) => `${h.name}${walkNote(h.distanceMeters)}`).join(", ")}`)
  }
  return lines.length > 0 ? lines.join("\n") : null
}
