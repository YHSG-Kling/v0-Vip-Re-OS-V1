"use client"

import { useEffect, type RefObject } from "react"

/**
 * useClickOutside - Detect clicks outside a specified element
 * Useful for closing dropdowns, modals, and popovers
 * 
 * @param ref - React ref to the element to detect outside clicks for
 * @param handler - Callback function when click outside is detected
 * @param enabled - Optional boolean to enable/disable the listener
 * 
 * @example
 * const dropdownRef = useRef<HTMLDivElement>(null)
 * const [isOpen, setIsOpen] = useState(false)
 * 
 * useClickOutside(dropdownRef, () => setIsOpen(false), isOpen)
 */
export function useClickOutside<T extends HTMLElement = HTMLElement>(
  ref: RefObject<T | null>,
  handler: (event: MouseEvent | TouchEvent) => void,
  enabled: boolean = true
): void {
  useEffect(() => {
    if (!enabled) return

    const listener = (event: MouseEvent | TouchEvent) => {
      const el = ref?.current

      // Do nothing if clicking ref's element or descendent elements
      if (!el || el.contains(event.target as Node)) {
        return
      }

      handler(event)
    }

    document.addEventListener("mousedown", listener)
    document.addEventListener("touchstart", listener)

    return () => {
      document.removeEventListener("mousedown", listener)
      document.removeEventListener("touchstart", listener)
    }
  }, [ref, handler, enabled])
}
