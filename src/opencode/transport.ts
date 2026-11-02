export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Reviewer timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}
