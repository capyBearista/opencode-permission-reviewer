import { expect, test } from "bun:test"
import { ReviewAttempt } from "../src/core/review-attempt.ts"

test("attempt identity, deadline, and terminal state cannot be resurrected", async () => {
  let now = 100
  const attempt = new ReviewAttempt(
    "generation",
    1000,
    () => now,
    () => "review",
  )
  expect(attempt.id).toBe("review")
  expect(attempt.active("other-generation")).toBe(false)
  now = 1100
  expect(attempt.active()).toBe(false)
  expect(attempt.state).toBe("expired")
  expect(attempt.remainingMs()).toBe(0)
  expect(attempt.close("finished")).toBe(false)
  await expect(attempt.wait(Promise.reject(new Error("late transport failure")))).rejects.toThrow(
    "Review expired",
  )
})

test("cancellation rejects an outstanding wait and ignores a late result", async () => {
  const attempt = new ReviewAttempt("generation", 1000)
  let complete!: (value: string) => void
  const operation = new Promise<string>((resolve) => {
    complete = resolve
  })
  const waiting = attempt.wait(operation)
  attempt.close("cancelled")
  await expect(waiting).rejects.toThrow("Review cancelled")
  complete("allow")
  await operation
  expect(attempt.state).toBe("cancelled")
})

test.each(["cancelled", "expired", "finished"] as const)(
  "terminal state %s retains its rejection reason after garbage collection",
  async (state) => {
    const attempt = new ReviewAttempt("generation", 1000)
    attempt.close(state)
    await Bun.sleep(0)
    Bun.gc(true)
    await expect(attempt.wait(Promise.resolve("late allow"))).rejects.toThrow(`Review ${state}`)
    await expect(attempt.wait(Promise.reject(new Error("late transport failure")))).rejects.toThrow(
      `Review ${state}`,
    )
    expect(attempt.state).toBe(state)
    expect(attempt.active()).toBe(false)
  },
)
