import { useState, useEffect } from 'react'

/**
 * A hook that tracks a selected index and automatically clamps it
 * when the underlying list length changes. Prevents out-of-bounds
 * access when data refreshes and the list shrinks.
 */
export function useClampedIndex(
  length: number,
): [number, (updater: number | ((prev: number) => number)) => void] {
  const [selectedIndex, setSelectedIndex] = useState(0)

  useEffect(() => {
    if (length === 0) {
      setSelectedIndex(0)
    } else if (selectedIndex >= length) {
      setSelectedIndex(length - 1)
    }
  }, [length, selectedIndex])

  const safeSet = (updater: number | ((prev: number) => number)) => {
    setSelectedIndex(prev => {
      const next = typeof updater === 'function'
        ? (updater as (prev: number) => number)(prev)
        : updater
      if (length === 0) return 0
      if (next < 0) return length - 1
      if (next >= length) return 0
      return next
    })
  }

  return [selectedIndex, safeSet]
}
