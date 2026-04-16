"use client"

import { useEffect, useRef, useState } from "react"
import type { HeatmapSnapshot, OpportunityZone } from "@/app/actions/team-heatmap"

interface HeatmapMapProps {
  snapshots: HeatmapSnapshot[]
  revenueWeighted: boolean
  opportunityZones: OpportunityZone[]
  showGaps: boolean
}

// Activity type to color mapping
const ACTIVITY_COLORS: Record<string, string> = {
  listing: "#3B82F6", // blue
  buyer: "#22C55E", // green
  closed: "#F59E0B", // amber
  lead: "#F97316", // orange
}

export function HeatmapMap({
  snapshots,
  revenueWeighted,
  opportunityZones,
  showGaps,
}: HeatmapMapProps) {
  const mapRef = useRef<HTMLDivElement>(null)
  const [map, setMap] = useState<google.maps.Map | null>(null)
  const [markers, setMarkers] = useState<google.maps.Marker[]>([])
  const [infoWindow, setInfoWindow] = useState<any | null>(null)

  useEffect(() => {
    if (!mapRef.current || typeof google === "undefined") return

    // Initialize map
    const newMap = new google.maps.Map(mapRef.current, {
      center: { lat: 39.8283, lng: -98.5795 }, // Center of US
      zoom: 4,
      styles: [
        {
          featureType: "poi",
          elementType: "labels",
          stylers: [{ visibility: "off" }],
        },
      ],
    })

    setMap(newMap)
    setInfoWindow(new google.maps.InfoWindow())

    return () => {
      markers.forEach((m) => m.setMap(null))
    }
  }, [])

  useEffect(() => {
    if (!map || !infoWindow) return

    // Clear existing markers
    markers.forEach((m) => m.setMap(null))

    // Group snapshots by location for clustering
    const grouped = new Map<
      string,
      {
        lat: number
        lng: number
        activities: HeatmapSnapshot[]
        totalCount: number
        totalRevenue: number
      }
    >()

    for (const s of snapshots) {
      const key = `${s.lat.toFixed(3)},${s.lng.toFixed(3)}`
      const existing = grouped.get(key)
      if (existing) {
        existing.activities.push(s)
        existing.totalCount += s.activity_count
        existing.totalRevenue += s.revenue_amount || 0
      } else {
        grouped.set(key, {
          lat: s.lat,
          lng: s.lng,
          activities: [s],
          totalCount: s.activity_count,
          totalRevenue: s.revenue_amount || 0,
        })
      }
    }

    // Create markers
    const newMarkers: google.maps.Marker[] = []
    const bounds = new google.maps.LatLngBounds()

    for (const [, group] of grouped) {
      // Determine primary activity type
      const typeCounts: Record<string, number> = {}
      for (const a of group.activities) {
        typeCounts[a.activity_type] = (typeCounts[a.activity_type] || 0) + a.activity_count
      }
      const primaryType = Object.entries(typeCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "listing"
      const color = ACTIVITY_COLORS[primaryType] || "#6B7280"

      // Calculate radius based on revenue or count
      const baseRadius = 8
      const maxRadius = 24
      let radius = baseRadius

      if (revenueWeighted && group.totalRevenue > 0) {
        const maxRevenue = Math.max(...Array.from(grouped.values()).map((g) => g.totalRevenue))
        radius = baseRadius + ((group.totalRevenue / maxRevenue) * (maxRadius - baseRadius))
      } else {
        const maxCount = Math.max(...Array.from(grouped.values()).map((g) => g.totalCount))
        radius = baseRadius + ((group.totalCount / maxCount) * (maxRadius - baseRadius))
      }

      const marker = new google.maps.Marker({
        position: { lat: group.lat, lng: group.lng },
        map,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          fillColor: color,
          fillOpacity: 0.7,
          strokeColor: color,
          strokeWeight: 2,
          scale: radius,
        },
      })

      // Build info window content
      const agents = [...new Set(group.activities.map((a) => a.agent_name))].slice(0, 3)
      const content = `
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

      marker.addListener("click", () => {
        infoWindow.setContent(content)
        infoWindow.open(map, marker)
      })

      newMarkers.push(marker)
      bounds.extend({ lat: group.lat, lng: group.lng })
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

          marker.addListener("click", () => {
            infoWindow.setContent(`
              <div style="padding: 8px;">
                <div style="font-weight: 600; color: #B45309;">Opportunity Zone</div>
                <div style="font-size: 12px; margin-top: 4px;">${zone.reason}</div>
              </div>
            `)
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
      const zoom = map.getZoom()
      if (zoom && zoom > 12) {
        map.setZoom(12)
      }
    }
  }, [map, snapshots, revenueWeighted, opportunityZones, showGaps, infoWindow])

  return (
    <>
      {/* Load Google Maps Script */}
      <script
        src={`https://maps.googleapis.com/maps/api/js?key=${process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY}&libraries=places`}
        async
        defer
      />
      <div ref={mapRef} className="h-full w-full" />
    </>
  )
}
