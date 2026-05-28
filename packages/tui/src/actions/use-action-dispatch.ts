// @openslack/tui — Action dispatch hook

import { useState, useCallback } from 'react'
import type {
  TuiAction,
  TuiActionState,
  TuiActionResult,
} from './types.js'
import { TuiActionStatus, REQUIRES_CONFIRMATION } from './types.js'

const IDLE_STATE: TuiActionState = { status: TuiActionStatus.Idle }

export interface UseActionDispatchReturn {
  /** Current action state (idle, confirming, executing, success, error). */
  readonly state: TuiActionState

  /** The action currently being confirmed or executed, if any. */
  readonly activeAction: TuiAction | null

  /**
   * Dispatch an action. If the action requires confirmation
   * (or belongs to REQUIRES_CONFIRMATION), transitions to 'confirming'.
   * Otherwise, executes immediately.
   */
  dispatch: (action: TuiAction) => void

  /** Confirm and execute the active action. No-op unless status is 'confirming'. */
  confirm: () => void

  /** Cancel the active confirmation. No-op unless status is 'confirming'. */
  cancel: () => void

  /** Reset state back to idle, clearing any result/error. */
  reset: () => void
}

export function useActionDispatch(): UseActionDispatchReturn {
  const [state, setState] = useState<TuiActionState>(IDLE_STATE)
  const [activeAction, setActiveAction] = useState<TuiAction | null>(null)

  const reset = useCallback(() => {
    setState(IDLE_STATE)
    setActiveAction(null)
  }, [])

  const executeAction = useCallback(async (action: TuiAction) => {
    setState({ status: TuiActionStatus.Executing })
    try {
      const result: TuiActionResult = await action.handler()
      setState({
        status: result.success ? TuiActionStatus.Success : TuiActionStatus.Error,
        result,
      })
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err)
      setState({
        status: TuiActionStatus.Error,
        error: message,
      })
    }
  }, [])

  const dispatch = useCallback(
    (action: TuiAction) => {
      // Reset any previous state
      setActiveAction(action)

      const needsConfirm =
        action.requiresConfirmation || REQUIRES_CONFIRMATION.has(action.category)

      if (needsConfirm) {
        setState({ status: TuiActionStatus.Confirming })
      } else {
        executeAction(action)
      }
    },
    [executeAction],
  )

  const confirm = useCallback(() => {
    if (state.status !== TuiActionStatus.Confirming || !activeAction) return
    executeAction(activeAction)
  }, [state.status, activeAction, executeAction])

  const cancel = useCallback(() => {
    if (state.status !== TuiActionStatus.Confirming) return
    reset()
  }, [state.status, reset])

  return { state, activeAction, dispatch, confirm, cancel, reset }
}

export default useActionDispatch
