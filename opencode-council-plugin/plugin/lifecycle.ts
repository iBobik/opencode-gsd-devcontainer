/** Stop waiting locally even when an in-process adapter ignores request options. */
export async function bounded<T>(work: Promise<T>, signal: AbortSignal, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: () => void = () => {}
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason ?? new Error("Council interrupted"))
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
        timer = setTimeout(() => reject(new Error("Council title generation timed out")), milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", abort)
  }
}

export function sessionMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const value = error as { _tag?: string; name?: string; data?: { _tag?: string } }
  return [value._tag, value.name, value.data?._tag].some((tag) => tag === "SessionNotFoundError" || tag === "Session.NotFoundError")
}
