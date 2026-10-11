"use client"

import { useEffect, useRef, useState } from "react"
import type { HeatmapSnapshot, OpportunityZone } from "@/app/actions/team-heatmap"

/** The provider the SERVER chose (lib/property/street-view.ts resolveMapProvider — the ONE map_render
 *  route, wave 140 lane 140I) and the PUBLIC credential it is called with. This component reads no env:
 *  it renders exactly the provider it was handed, and nothing when it was handed none. */
interface HeatmapMapProvider {
  provider: "mapbox" | "google_maps"
  /** Public by design — a Mapbox `pk.` token or the NEXT_PUBLIC Google key. */
  key: string
  browser: { script: string; css: string | null }
}

interface HeatmapMapProps {
  snapshots: HeatmapSnapshot[]
  revenueWeighted: boolean
  opportunityZones: OpportunityZone[]
  showGaps: boolean
  map?: HeatmapMapProvider | null
}

// Activity type to color mapping
const ACTIVITY_COLORS: Record<string, string> = {
  listing: "#3B82F6", // blue
  buyer: "#22C55E", // green
  closed: "#F59E0B", // amber
  lead: "#F97316", // orange
}

interface ActivityPoint { lat: number; lng: number; color: string; radius: number; html: string }

/** PURE — one point per location (the clustering both renderers share), sized by revenue or count. */
function activityPoints(snapshots: HeatmapSnapshot[], revenueWeighted: boolean): ActivityPoint[] {
  const grouped = new Map<string, { lat: number; lng: number; activities: HeatmapSnapshot[]; totalCount: number; totalRevenue: number }>()
  for (const s of snapshots) {
    const key = `${s.lat.toFixed(3)},${s.lng.toFixed(3)}`
    const existing = grouped.get(key)
    if (existing) {
      existing.activities.push(s)
      existing.totalCount += s.activity_count
      existing.totalRevenue += s.revenue_amount || 0
    } else {
      grouped.set(key, { lat: s.lat, lng: s.lng, activities: [s], totalCount: s.activity_count, totalRevenue: s.revenue_amount || 0 })
    }
  }
  const groups = [...grouped.values()]
  const maxRevenue = Math.max(0, ...groups.map((g) => g.totalRevenue))
  const maxCount = Math.max(0, ...groups.map((g) => g.totalCount))
  const baseRadius = 8, maxRadius = 24
  return groups.map((group) => {
    const typeCounts: Record<string, number> = {}
    for (const a of group.activities) typeCounts[a.activity_type] = (typeCounts[a.activity_type] || 0) + a.activity_count
    const primaryType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "listing"
    const color = ACTIVITY_COLORS[primaryType] || "#6B7280"
    const radius = revenueWeighted && group.totalRevenue > 0 && maxRevenue > 0
      ? baseRadius + (group.totalRevenue / maxRevenue) * (maxRadius - baseRadius)
      : maxCount > 0 ? baseRadius + (group.totalCount / maxCount) * (maxRadius - baseRadius) : baseRadius
    const agents = [...new Set(group.activities.map((a) => a.agent_name))].slice(0, 3)
    const html = `
        <div style="padding: 8px; min-width: 150px;">
          <div style="font-weight: 600; margin-bottom: 4px;">
            ${group.activities[0]?.zip_code || "Unknown"} - ${group.activities[0]?.city || ""}
          </div>
          <div style="font-size: 12px; color: #666; margin-bottom: 8px;">
            ${agents.join(", ")}${group.activities.length > 3 ? " +" + (group.activities.length - 3) + " more" : ""}
          </div>
          <div style="display: flex; gap: 12px; font-size: 12px;">
            <div>
              <div style="color: #666;">Activities</div>
              <div style="font-weight: 600;">${group.totalCount}</div>
            </div>
            ${group.totalRevenue > 0 ? `
              <div>
                <div style="color: #666;">Revenue</div>
                <div style="font-weight: 600;">$${(group.totalRevenue / 1000).toFixed(0)}K</div>
              </div>
            ` : ""}
          </div>
        </div>
      `
    return { lat: group.lat, lng: group.lng, color, radius, html }
  })
}

const ZONE_HTML = (zone: OpportunityZone) => `
              <div style="padding: 8px;">
                <div style="font-weight: 600; color: #B45309;">Opportunity Zone</div>
                <div style="font-size: 12px; margin-top: 4px;">${zone.reason}</div>
              </div>
            `

/** Load a browser script / stylesheet once (idempotent by src) and resolve when it is ready. */
function loadBrowserAsset(kind: "script" | "css", src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(kind === "script" ? `script[src="${src}"]` : `link[href="${src}"]`) as HTMLScriptElement | HTMLLinkElement | null
    if (existing) {
      if (existing.dataset.loaded === "1") return resolve()
      existing.addEventListener("load", () => resolve(), { once: true })
      existing.addEventListener("error", () => reject(new Error(`failed to load ${src}`)), { once: true })
      return
    }
    const el = kind === "script" ? Object.assign(document.createElement("script"), { src, async: true }) : Object.assign(document.createElement("link"), { href: src, rel: "stylesheet" })
    el.addEventListener("load", () => { el.dataset.loaded = "1"; resolve() }, { once: true })
    el.addEventListener("error", () => reject(new Error(`failed to load ${src}`)), { once: true })
    document.head.appendChild(el)
  })
}

export function HeatmapMap({
  snapshots,
  revenueWeighted,
  opportunityZones,
  showGaps,
  map: provider,
}: HeatmapMapProps) {
  const mapRef = useRef<HTMLDivElement>(null)
  const [map, setMap] = useState<google.maps.Map | null>(null)
  const [markers, setMarkers] = useState<google.maps.Marker[]>([])
  const [infoWindow, setInfoWindow] = useState<any | null>(null)
  const [mbMap, setMbMap] = useState<any | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const isGoogle = provider?.provider === "google_maps" && !!provider.key
  const isMapbox = provider?.provider === "mapbox" && !!provider.key

  // ── Mapbox GL JS (wave 140, lane 140I): the CDN build pinned by the server's choice, the PUBLIC token ──
  useEffect(() => {
    if (!isMapbox || !mapRef.current || !provider) return
    let cancelled = false
    let instance: any = null
    ;(async () => {
      try {
        if (provider.browser.css) await loadBrowserAsset("css", provider.browser.css)
        await loadBrowserAsset("script", provider.browser.script)
        const mb = (window as any).mapboxgl
        if (!mb || cancelled || !mapRef.current) return
        mb.accessToken = provider.key
        instance = new mb.Map({ container: mapRef.current, style: "mapbox://styles/mapbox/streets-v12", center: [-98.5795, 39.8283], zoom: 3, attributionControl: true })
        instance.addControl(new mb.NavigationControl({ showCompass: false }), "top-right")
        instance.on("load", () => { if (!cancelled) setMbMap(instance) })
      } catch (err) {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : "map failed to load")
      }
    })()
    return () => { cancelled = true; try { instance?.remove() } catch { /* already gone */ } }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMapbox])

  useEffect(() => {
    if (!mbMap) return
    const mb = (window as any).mapboxgl
    const points = activityPoints(snapshots, revenueWeighted)
    const features = points.map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: [p.lng, p.lat] }, properties: { color: p.color, radius: p.radius, html: p.html } }))
    if (showGaps) for (const zone of opportunityZones) if (zone.lat && zone.lng) features.push({ type: "Feature", geometry: { type: "Point", coordinates: [zone.lng, zone.lat] }, properties: { color: "#F59E0B", radius: 20, html: ZONE_HTML(zone) } })
    const data = { type: "FeatureCollection", features }
    const src = mbMap.getSource("activity")
    if (src) src.setData(data)
    else {
      mbMap.addSource("activity", { type: "geojson", data })
      mbMap.addLayer({ id: "activity-circles", type: "circle", source: "activity", paint: { "circle-color": ["get", "color"], "circle-radius": ["get", "radius"], "circle-opacity": 0.7, "circle-stroke-color": ["get", "color"], "circle-stroke-width": 2 } })
      mbMap.on("click", "activity-circles", (e: any) => {
        const f = e.features?.[0]
        if (!f) return
        new mb.Popup({ closeButton: true }).setLngLat(f.geometry.coordinates).setHTML(String(f.properties?.html ?? "")).addTo(mbMap)
      })
      mbMap.on("mouseenter", "activity-circles", () => { mbMap.getCanvas().style.cursor = "pointer" })
      mbMap.on("mouseleave", "activity-circles", () => { mbMap.getCanvas().style.cursor = "" })
    }
    if (features.length > 0) {
      const bounds = new mb.LngLatBounds()
      for (const f of features) bounds.extend(f.geometry.coordinates as [number, number])
      mbMap.fitBounds(bounds, { padding: 48, maxZoom: 12, duration: 0 })
    }
  }, [mbMap, snapshots, revenueWeighted, opportunityZones, showGaps])

  // ── Google Maps JS (the pre-140 renderer, unchanged; reached only when the server chose it) ──
  useEffect(() => {
    if (!isGoogle || !mapRef.current || typeof google === "undefined") return

    // Initialize map
    const newMap = new google.maps.Map(mapRef.current, {
      center: { lat: 39.8283, lng: -98.5795 }, // Center of US
      zoom: 4,
      mapTypeControlOptions: { mapTypeIds: [] },
    } as google.maps.MapOptions)

    setMap(newMap)
    setInfoWindow(new (google.maps as any).InfoWindow())

    return () => {
      markers.forEach((m) => m.setMap(null))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isGoogle])

  useEffect(() => {
    if (!map || !infoWindow) return

    // Clear existing markers
    markers.forEach((m) => m.setMap(null))

    const newMarkers: google.maps.Marker[] = []
    const bounds = new google.maps.LatLngBounds()

    for (const p of activityPoints(snapshots, revenueWeighted)) {
      const marker = new google.maps.Marker({
        position: { lat: p.lat, lng: p.lng },
        map,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          fillColor: p.color,
          fillOpacity: 0.7,
          strokeColor: p.color,
          strokeWeight: 2,
          scale: p.radius,
        },
      })
      ;(marker as any).addListener("click", () => {
        infoWindow.setContent(p.html)
        infoWindow.open(map, marker)
      })
      newMarkers.push(marker)
      bounds.extend({ lat: p.lat, lng: p.lng })
    }

    // Add opportunity zone markers
    if (showGaps) {
      for (const zone of opportunityZones) {
        if (zone.lat && zone.lng) {
          const marker = new google.maps.Marker({
            position: { lat: zone.lat, lng: zone.lng },
            map,
            icon: {
              path: google.maps.SymbolPath.CIRCLE,
              fillColor: "#F59E0B",
              fillOpacity: 0.3,
              strokeColor: "#F59E0B",
              strokeWeight: 2,
              scale: 20,
            },
          })

          ;(marker as any).addListener("click", () => {
            infoWindow.setContent(ZONE_HTML(zone))
            infoWindow.open(map, marker)
          })

          newMarkers.push(marker)
        }
      }
    }

    setMarkers(newMarkers)

    // Fit bounds if we have markers
    if (newMarkers.length > 0) {
      map.fitBounds(bounds)
      const zoom = (map as any).getZoom?.() as number | undefined
      if (zoom && zoom > 12) {
        map.setZoom(12)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, snapshots, revenueWeighted, opportunityZones, showGaps, infoWindow])

  return (
    <>
      {/* Google Maps JS loads ONLY when the server chose google_maps WITH a key (wave 140, lane 140I:
          this tag used to render with `key=` empty whenever the Google key was absent). The Mapbox
          build is loaded programmatically above from the Mapbox CDN with the public token. */}
      {isGoogle && provider && (
        <script src={provider.browser.script} async defer />
      )}
      <div className="relative h-full w-full">
        <div ref={mapRef} className="h-full w-full" />
        {/* Lane 90D (test:rendered-empty-states): with no snapshots the map
            was a blank tile. The overlay says so; it never blocks the map. */}
        {snapshots.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <p className="rounded-md bg-background/90 px-3 py-2 text-sm text-muted-foreground shadow-sm">
              No activity recorded yet — the heatmap fills in as listings, buyers and closings land.
            </p>
          </div>
        )}
        {loadError && (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
            <p className="rounded-md bg-background/90 px-3 py-1 text-xs text-destructive shadow-sm">Map library did not load ({loadError}).</p>
          </div>
        )}
      </div>
    </>
  )
}
