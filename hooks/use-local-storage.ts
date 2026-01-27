"use client"

import { useState, useEffect, useCallback } from "react"

/**
 * useLocalStorage - Persist state in localStorage
 * NOTE: This hook should only be used for user preferences and non-critical data.
 * For data persistence, use a proper database integration (Supabase, etc.)
 * 
 * @param key - The localStorage key
 * @param initialValue - The initial value if no value exists in storage
 * @returns [value, setValue, removeValue]
 * 
 * @example
 * const [theme, setTheme] = useLocalStorage('theme', 'light')
 * const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorage('sidebar-collapsed', false)
 */
export function useLocalStorage<T>(
  key: string,
  initialValue: T
): [T, (value: T | ((prev: T) => T)) => void, () => void] {
  // State to store our value
  const [storedValue, setStoredValue] = useState<T>(initialValue)

  // On mount, read from localStorage
  useEffect(() => {
    try {
      const item = window.localStorage.getItem(key)
      if (item) {
        setStoredValue(JSON.parse(item))
      }
    } catch (error) {
      console.warn(`[useLocalStorage] Error reading key "${key}":`, error)
    }
  }, [key])

  // Update localStorage when value changes
  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      try {
        // Allow value to be a function for the same API as useState
        const valueToStore = value instanceof Function ? value(storedValue) : value
        setStoredValue(valueToStore)
        window.localStorage.setItem(key, JSON.stringify(valueToStore))
      } catch (error) {
        console.warn(`[useLocalStorage] Error writing key "${key}":`, error)
      }
    },
    [key, storedValue]
  )

  // Remove the value from storage
  const removeValue = useCallback(() => {
    try {
      window.localStorage.removeItem(key)
      setStoredValue(initialValue)
    } catch (error) {
      console.warn(`[useLocalStorage] Error removing key "${key}":`, error)
    }
  }, [key, initialValue])

  return [storedValue, setValue, removeValue]
}
