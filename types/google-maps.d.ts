/**
 * Type declarations for Google Maps JavaScript API
 * Used by app/dashboard/team-heatmap/heatmap-map.tsx
 */

declare namespace google {
  namespace maps {
    class Map {
      constructor(element: HTMLElement, options?: MapOptions)
      setCenter(latLng: LatLng | LatLngLiteral): void
      setZoom(zoom: number): void
      panTo(latLng: LatLng | LatLngLiteral): void
      fitBounds(bounds: LatLngBounds): void
    }

    class LatLng {
      constructor(lat: number, lng: number)
      lat(): number
      lng(): number
    }

    class LatLngBounds {
      constructor()
      extend(point: LatLng | LatLngLiteral): void
      getCenter(): LatLng
    }

    class Marker {
      constructor(options?: MarkerOptions)
      setMap(map: Map | null): void
      setPosition(latLng: LatLng | LatLngLiteral): void
      getPosition(): LatLng | null
    }

    namespace visualization {
      class HeatmapLayer {
        constructor(options?: HeatmapLayerOptions)
        setMap(map: Map | null): void
        setData(data: any[]): void
        setOptions(options: HeatmapLayerOptions): void
      }
    }

    interface MapOptions {
      center?: LatLngLiteral
      zoom?: number
      mapTypeId?: string
      disableDefaultUI?: boolean
      zoomControl?: boolean
      mapTypeControl?: boolean
      scaleControl?: boolean
      streetViewControl?: boolean
      rotateControl?: boolean
      fullscreenControl?: boolean
    }

    interface MarkerOptions {
      position?: LatLngLiteral
      map?: Map
      title?: string
      label?: string | MarkerLabel
      icon?: string | Icon | Symbol
      draggable?: boolean
    }

    interface MarkerLabel {
      text: string
      color?: string
      fontSize?: string
      fontWeight?: string
    }

    interface Icon {
      url: string
      scaledSize?: Size
      anchor?: Point
    }

    interface Symbol {
      path: string | SymbolPath
      fillColor?: string
      fillOpacity?: number
      strokeColor?: string
      strokeOpacity?: number
      strokeWeight?: number
      scale?: number
    }

    interface Size {
      width: number
      height: number
    }

    interface Point {
      x: number
      y: number
    }

    interface HeatmapLayerOptions {
      data?: any[]
      map?: Map
      radius?: number
      opacity?: number
      gradient?: string[]
      maxIntensity?: number
      dissipating?: boolean
    }

    interface LatLngLiteral {
      lat: number
      lng: number
    }

    enum SymbolPath {
      CIRCLE = 0,
      FORWARD_CLOSED_ARROW = 1,
      FORWARD_OPEN_ARROW = 2,
      BACKWARD_CLOSED_ARROW = 3,
      BACKWARD_OPEN_ARROW = 4
    }
  }
}
