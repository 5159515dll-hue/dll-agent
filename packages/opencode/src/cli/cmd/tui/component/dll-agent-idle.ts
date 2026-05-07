/**
 * dll-agent idle-aware refresh scheduler.
 *
 * Provides adaptive interval control: refresh faster when the session is active
 * (pending assistant message, running tools, state changing), and slow down when
 * idle (waiting for API response, waiting for user input, no state changes).
 *
 * This reduces CPU usage during idle/API-wait periods without affecting
 * responsiveness during active tasks.
 */

type Cleanup = () => void

/**
 * Start an adaptive interval that switches between activeMs and idleMs based
 * on the isIdle signal. When idle transitions to active (or vice versa), the
 * interval is immediately rescheduled at the new rate.
 *
 * Returns a cleanup function.
 */
export function idleAwareInterval(
  callback: () => void,
  activeMs: number,
  idleMs: number,
  isIdle: () => boolean,
): Cleanup {
  let timer: ReturnType<typeof setInterval> | undefined
  let currentMs = isIdle() ? idleMs : activeMs

  const schedule = () => {
    timer = setInterval(() => {
      callback()
      const shouldBeIdle = isIdle()
      const targetMs = shouldBeIdle ? idleMs : activeMs
      if (targetMs !== currentMs) {
        currentMs = targetMs
        clearInterval(timer)
        timer = setInterval(callback, currentMs)
      }
    }, currentMs)
  }

  schedule()
  return () => clearInterval(timer)
}

/**
 * Detect idle state based on supervisor state "updated_at" timestamp.
 * Returns true if the supervisor state hasn't been updated in the last
 * `thresholdMs` milliseconds, indicating the session is likely idle.
 */
export function isIdleBySupervisorState(
  updatedAt: string | undefined,
  thresholdMs: number,
): boolean {
  if (!updatedAt) return true
  const age = Date.now() - new Date(updatedAt).getTime()
  return age > thresholdMs
}

/**
 * Detect idle state based on whether there is a pending (incomplete) assistant
 * message. Returns true if there is NO pending assistant message.
 */
export function isIdleByPendingMessage(pendingMessageID: string | undefined): boolean {
  return !pendingMessageID
}
