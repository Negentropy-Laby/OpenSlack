import React, { createContext, useContext, useCallback, useState } from 'react'
import {
  type Route,
  type RouterState,
  type RouterActions,
  HOME_ROUTE,
  createInitialRouterState,
  routerPush,
  routerPop,
  routerReplace,
  routerReset,
} from './router.js'

const NavigationContext = createContext<RouterState & RouterActions | null>(null)

export function useNavigation(): RouterState & RouterActions {
  const ctx = useContext(NavigationContext)
  if (!ctx) {
    throw new Error('useNavigation must be used within a NavigationProvider')
  }
  return ctx
}

export function NavigationProvider({
  children,
}: {
  children?: React.ReactNode
}): React.JSX.Element {
  const [state, setState] = useState<RouterState>(createInitialRouterState)

  const push = useCallback((route: Route) => {
    setState(prev => routerPush(prev, route))
  }, [])

  const pop = useCallback(() => {
    setState(prev => routerPop(prev))
  }, [])

  const replace = useCallback((route: Route) => {
    setState(prev => routerReplace(prev, route))
  }, [])

  const reset = useCallback(() => {
    setState(routerReset)
  }, [])

  const value: RouterState & RouterActions = {
    ...state,
    push,
    pop,
    replace,
    reset,
  }

  return React.createElement(
    NavigationContext.Provider,
    { value },
    children,
  )
}

export { HOME_ROUTE }
export type { Route, RouterState, RouterActions }
