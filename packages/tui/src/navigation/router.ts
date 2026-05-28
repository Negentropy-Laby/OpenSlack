/**
 * Stack-based navigation router for the TUI shell.
 *
 * Route type is flat and serializable — no class instances, no callbacks.
 * State transitions happen through push/pop/replace/reset actions only.
 */

export interface Route {
  view: string
  params?: Record<string, unknown>
}

export interface RouterState {
  stack: Route[]
  current: Route
}

export interface RouterActions {
  push: (route: Route) => void
  pop: () => void
  replace: (route: Route) => void
  reset: () => void
}

export const HOME_ROUTE: Route = Object.freeze({ view: 'home' })

export function createInitialRouterState(): RouterState {
  return {
    stack: [HOME_ROUTE],
    current: HOME_ROUTE,
  }
}

export function routerPush(state: RouterState, route: Route): RouterState {
  return {
    stack: [...state.stack, route],
    current: route,
  }
}

export function routerPop(state: RouterState): RouterState {
  if (state.stack.length <= 1) return state
  const newStack = state.stack.slice(0, -1)
  return {
    stack: newStack,
    current: newStack[newStack.length - 1],
  }
}

export function routerReplace(state: RouterState, route: Route): RouterState {
  const newStack = state.stack.slice(0, -1).concat(route)
  return {
    stack: newStack,
    current: route,
  }
}

export function routerReset(state: RouterState): RouterState {
  return createInitialRouterState()
}
