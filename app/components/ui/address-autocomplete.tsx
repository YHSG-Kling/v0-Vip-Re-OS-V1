"use client"

import { useEffect, useRef } from "react"
import { Input } from "@/components/ui/input"

interface AddressComponents {
  street: string
  city: string
  state: string
  zip: string
  full: string
}

interface AddressAutocompleteProps {
  value: string
  onChange: (value: string) => void
  onSelect?: (address: AddressComponents) => void
  placeholder?: string
  id?: string
  className?: string
  disabled?: boolean
}

let mapsLoadPromise: Promise<void> | null = null

function loadGoogleMaps(apiKey: string): Promise<void> {
  if (mapsLoadPromise) return mapsLoadPromise
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((window as any).google?.maps?.places) {
    mapsLoadPromise = Promise.resolve()
    return mapsLoadPromise
  }
  mapsLoadPromise = new Promise<void>((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).__googleMapsCallback = () => resolve()
    const script = document.createElement("script")
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places&callback=__googleMapsCallback`
    script.async = true
    script.defer = true
    script.onerror = () => {
      mapsLoadPromise = null
      reject(new Error("Failed to load Google Maps"))
    }
    document.head.appendChild(script)
  })
  return mapsLoadPromise
}

function parseAddressComponents(place: any): AddressComponents {
  const get = (type: string) =>
    (place.address_components ?? []).find((c: any) => c.types.includes(type))?.long_name ?? ""
  const getShort = (type: string) =>
    (place.address_components ?? []).find((c: any) => c.types.includes(type))?.short_name ?? ""
  const streetNumber = get("street_number")
  const route = get("route")
  return {
    street: [streetNumber, route].filter(Boolean).join(" "),
    city: get("locality") || get("sublocality") || get("neighborhood"),
    state: getShort("administrative_area_level_1"),
    zip: get("postal_code"),
    full: place.formatted_address ?? "",
  }
}

export function AddressAutocomplete({
  value,
  onChange,
  onSelect,
  placeholder = "Enter address...",
  id,
  className,
  disabled,
}: AddressAutocompleteProps) {
  const inputRef = useRef<HTMLInputElement>(null)

  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY

  useEffect(() => {
    if (!apiKey || !inputRef.current) return

    loadGoogleMaps(apiKey)
      .then(() => {
        if (!inputRef.current) return
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const g = (window as any).google
        const ac = new g.maps.places.Autocomplete(inputRef.current, {
          types: ["address"],
          componentRestrictions: { country: "us" },
          fields: ["formatted_address", "address_components"],
        })
        ac.addListener("place_changed", () => {
          const place = ac.getPlace()
          if (!place.formatted_address) return
          onChange(place.formatted_address)
          if (onSelect) onSelect(parseAddressComponents(place))
        })
      })
      .catch(() => {
        // Silently degrade to plain input
      })
  // Run once on mount — apiKey is env-level constant
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey])

  return (
    <Input
      ref={inputRef}
      id={id}
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      className={className}
      disabled={disabled}
      autoComplete="off"
    />
  )
}
