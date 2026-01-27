"use client"

import { useState, useEffect } from "react"

/**
 * useMediaQuery - Detect media query matches
 * Useful for responsive behavior beyond CSS breakpoints
 * 
 * @param query - The media query string (e.g., "(min-width: 768px)")
 * @returns Whether the media query matches
 * 
 * @example
 * const isDesktop = useMediaQuery("(min-width: 1024px)")
 * const prefersDark = useMediaQuery("(prefers-color-scheme: dark)")
 * const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)")
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(false)

  useEffect(() => {
    const mediaQueryList = window.matchMedia(query)
    
    // Set initial value
    setMatches(mediaQueryList.matches)

    // Handler function
    const handleChange = (event: MediaQueryListEvent) => {
      setMatches(event.matches)
    }

    // Add listener
    mediaQueryList.addEventListener("change", handleChange)

    // Cleanup
    return () => {
      mediaQueryList.removeEventListener("change", handleChange)
    }
  }, [query])

  return matches
}

// Convenience hooks for common breakpoints (matching Tailwind defaults)
export function useIsSmall(): boolean {
  return useMediaQuery("(min-width: 640px)")
}

export function useIsMedium(): boolean {
  return useMediaQuery("(min-width: 768px)")
}

export function useIsLarge(): boolean {
  return useMediaQuery("(min-width: 1024px)")
}

export function useIsXLarge(): boolean {
  return useMediaQuery("(min-width: 1280px)")
}

export function useIs2XLarge(): boolean {
  return useMediaQuery("(min-width: 1536px)")
}

// Preference-based hooks
export function usePrefersDarkMode(): boolean {
  return useMediaQuery("(prefers-color-scheme: dark)")
}

export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)")
}
