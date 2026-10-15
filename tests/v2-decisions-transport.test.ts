import { describe, expect, test } from "bun:test"
import {
  createDecisionsTransport,
  DecisionsTransportError,
  type DecisionsTransportRequest,
} from "../src/system-one/decisions-transport.ts"

const STATE = {
  trustedPolicy: { reviewer: "trusted policy", tenant: "tenant" },
  untrustedEvidence: "inspect the requested command",
}

function request(
  model: string,
  signal = new AbortController().signal,
  timeoutMs = 1000,
  onRequestSent = () => {},
): DecisionsTransportRequest {
  return { model, state: STATE, signal, timeoutMs, onRequestSent }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

describe("native V2 Decisions transport", () => {
  test("uses the anonymous fixed Zen route and strips only the provider prefix", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    let credentials = 0
    const transport = createDecisionsTransport({
      resolveOpenRouterKey: async () => {
        credentials++
        return "unused-key"
      },
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return Response.json({ model: "jev-1.13-free", answers: {} })
      },
    })

    await transport(request("opencode/jev-1.13-free"))

    expect(credentials).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://opencode.ai/zen/v1/systemone")
    expect(calls[0]?.init.redirect).toBe("error")
    expect(new Headers(calls[0]?.init.headers).has("authorization")).toBe(false)
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: "jev-1.13-free",
      state: STATE,
      questions: expect.any(Object),
    })
  })

  test("resolves OpenRouter credentials lazily for its fixed native Decisions route", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    let credentialCalls = 0
    const transport = createDecisionsTransport({
      resolveOpenRouterKey: async () => {
        credentialCalls++
        return "synthetic-openrouter-key"
      },
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} })
        return Response.json({ model: "vendor/model", answers: {} })
      },
    })

    await transport(request("openrouter/vendor/model"))

    expect(credentialCalls).toBe(1)
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/alpha/decisions")
    expect(calls[0]?.init.redirect).toBe("error")
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe(
      "Bearer synthetic-openrouter-key",
    )
    expect(JSON.parse(String(calls[0]?.init.body)).model).toBe("vendor/model")
    expect(String(calls[0]?.init.body)).not.toContain("synthetic-openrouter-key")
  })

  test("times out while resolving credentials and ignores a late credential result", async () => {
    const credential = deferred<string | undefined>()
    let fetchCalls = 0
    const transport = createDecisionsTransport({
      resolveOpenRouterKey: () => credential.promise,
      fetchImpl: async () => {
        fetchCalls++
        return Response.json({})
      },
    })

    await expect(
      transport(request("openrouter/vendor/model", undefined, 10)),
    ).rejects.toMatchObject({ kind: "timeout", requestSent: false })
    credential.resolve("late-key")
    await Promise.resolve()
    expect(fetchCalls).toBe(0)
  })

  test("cancellation during credential resolution prevents late fetch", async () => {
    const credential = deferred<string | undefined>()
    const controller = new AbortController()
    let fetchCalls = 0
    const transport = createDecisionsTransport({
      resolveOpenRouterKey: () => credential.promise,
      fetchImpl: async () => {
        fetchCalls++
        return Response.json({})
      },
    })
    const pending = transport(request("openrouter/vendor/model", controller.signal, 1000))
    controller.abort(new Error("review cancelled"))

    await expect(pending).rejects.toMatchObject({ kind: "cancelled", requestSent: false })
    credential.resolve("late-key")
    await Promise.resolve()
    expect(fetchCalls).toBe(0)
  })

  test("credential resolver observes caller cancellation and releases the attempt", async () => {
    const credential = deferred<string | undefined>()
    const controller = new AbortController()
    let fetchCalls = 0
    let resolverSignal: AbortSignal | undefined
    const transport = createDecisionsTransport({
      resolveOpenRouterKey: (signal) => {
        resolverSignal = signal
        return credential.promise
      },
      fetchImpl: async () => {
        fetchCalls++
        return Response.json({})
      },
    })
    const pending = transport(request("openrouter/vendor/model", controller.signal, 1000))
    controller.abort(new Error("review cancelled"))

    await expect(pending).rejects.toMatchObject({ kind: "cancelled", requestSent: false })
    expect(resolverSignal?.aborted).toBe(true)
    credential.resolve("late-key")
    await Promise.resolve()
    expect(fetchCalls).toBe(0)
  })

  test("credential resolver observes the per-attempt timeout and releases the attempt", async () => {
    const credential = deferred<string | undefined>()
    let fetchCalls = 0
    let resolverSignal: AbortSignal | undefined
    const transport = createDecisionsTransport({
      resolveOpenRouterKey: (signal) => {
        resolverSignal = signal
        return credential.promise
      },
      fetchImpl: async () => {
        fetchCalls++
        return Response.json({})
      },
    })

    await expect(
      transport(request("openrouter/vendor/model", undefined, 10)),
    ).rejects.toMatchObject({ kind: "timeout", requestSent: false })
    expect(resolverSignal?.aborted).toBe(true)
    credential.resolve("late-key")
    await Promise.resolve()
    expect(fetchCalls).toBe(0)
  })

  test("times out while fetch is pending and aborts the native fetch signal", async () => {
    let fetchSignal: AbortSignal | null | undefined
    const transport = createDecisionsTransport({
      fetchImpl: async (_url, init) => {
        fetchSignal = init?.signal
        return new Promise<Response>(() => {})
      },
    })

    await expect(transport(request("opencode/jev-1.13-free", undefined, 10))).rejects.toMatchObject(
      { kind: "timeout", requestSent: true },
    )
    expect(fetchSignal?.aborted).toBe(true)
  })

  test("caller cancellation while fetch is pending aborts the native fetch signal", async () => {
    let fetchSignal: AbortSignal | null | undefined
    const transport = createDecisionsTransport({
      fetchImpl: async (_url, init) => {
        fetchSignal = init?.signal
        return new Promise<Response>(() => {})
      },
    })
    const controller = new AbortController()
    const pending = transport(request("opencode/jev-1.13-free", controller.signal, 1000))
    while (!fetchSignal) await Promise.resolve()
    controller.abort(new Error("review cancelled"))

    await expect(pending).rejects.toMatchObject({ kind: "cancelled", requestSent: true })
    expect(fetchSignal?.aborted).toBe(true)
  })

  test("times out and cancels a response reader while the body is stalled", async () => {
    let streamCancelled = 0
    const transport = createDecisionsTransport({
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              streamCancelled++
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    })

    await expect(transport(request("opencode/jev-1.13-free", undefined, 10))).rejects.toMatchObject(
      { kind: "timeout", requestSent: true },
    )
    expect(streamCancelled).toBe(1)
  })

  test("per-attempt timeout after error headers preserves the authoritative status", async () => {
    for (const status of [400, 401, 503]) {
      let streamCancelled = 0
      const transport = createDecisionsTransport({
        resolveOpenRouterKey: async () => "synthetic-key",
        fetchImpl: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                streamCancelled++
              },
            }),
            { status },
          ),
      })

      await expect(
        transport(request("openrouter/vendor/model", undefined, 10)),
      ).rejects.toMatchObject({ kind: "http", status, requestSent: true })
      expect(streamCancelled).toBe(1)
    }
  })

  test("cancellation while consuming a body cancels its reader", async () => {
    let streamCancelled = 0
    let beginPull!: () => void
    const pulling = new Promise<void>((resolve) => {
      beginPull = resolve
    })
    const transport = createDecisionsTransport({
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              beginPull()
            },
            cancel() {
              streamCancelled++
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    })
    const controller = new AbortController()
    const pending = transport(request("opencode/jev-1.13-free", controller.signal, 1000))
    await pulling
    controller.abort(new Error("cancel review"))

    await expect(pending).rejects.toMatchObject({ kind: "cancelled", requestSent: true })
    expect(streamCancelled).toBe(1)
  })

  test("caller cancellation while consuming a non-2xx body remains terminal", async () => {
    let beginPull!: () => void
    const pulling = new Promise<void>((resolve) => {
      beginPull = resolve
    })
    const transport = createDecisionsTransport({
      resolveOpenRouterKey: async () => "synthetic-key",
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull() {
              beginPull()
            },
          }),
          { status: 400 },
        ),
    })
    const controller = new AbortController()
    const pending = transport(request("openrouter/vendor/model", controller.signal, 1000))
    await pulling
    controller.abort(new Error("review cancelled"))

    await expect(pending).rejects.toMatchObject({ kind: "cancelled", requestSent: true })
  })

  test("enforces the success byte cap even when Content-Length understates the stream", async () => {
    const payload = `{"model":"jev-1.13-free","padding":"${"x".repeat(64 * 1024)}"}`
    const transport = createDecisionsTransport({
      fetchImpl: async () => new Response(payload, { headers: { "Content-Length": "1" } }),
    })

    await expect(transport(request("opencode/jev-1.13-free"))).rejects.toMatchObject({
      kind: "response-too-large",
      requestSent: true,
    })
  })

  test("cancels a stream after detecting actual successful-response overflow", async () => {
    let streamCancelled = 0
    const transport = createDecisionsTransport({
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("x".repeat(64 * 1024 + 1)))
            },
            cancel() {
              streamCancelled++
            },
          }),
          { headers: { "Content-Length": "1" } },
        ),
    })

    await expect(transport(request("opencode/jev-1.13-free"))).rejects.toMatchObject({
      kind: "response-too-large",
      requestSent: true,
    })
    expect(streamCancelled).toBe(1)
  })

  test("uses Content-Length as an early success-body rejection and cancels the stream", async () => {
    let streamCancelled = 0
    const transport = createDecisionsTransport({
      fetchImpl: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              streamCancelled++
            },
          }),
          { headers: { "Content-Length": String(64 * 1024 + 1) } },
        ),
    })

    await expect(transport(request("opencode/jev-1.13-free"))).rejects.toMatchObject({
      kind: "response-too-large",
      requestSent: true,
    })
    expect(streamCancelled).toBe(1)
  })

  test("bounds HTTP error bodies and does not expose oversized text", async () => {
    const transport = createDecisionsTransport({
      resolveOpenRouterKey: async () => "synthetic-key",
      fetchImpl: async () =>
        new Response(`{"error":{"message":"${"x".repeat(9 * 1024)}"}}`, {
          status: 400,
          headers: { "Content-Length": "1" },
        }),
    })

    let caught: unknown
    try {
      await transport(request("openrouter/vendor/model"))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DecisionsTransportError)
    expect(caught).toMatchObject({ kind: "http", status: 400 })
    expect(String(caught)).not.toContain("x".repeat(100))
  })

  test("extracts only the bounded missing-model signal from parsed HTTP errors", async () => {
    const transport = createDecisionsTransport({
      resolveOpenRouterKey: async () => "synthetic-key",
      fetchImpl: async () =>
        Response.json({ error: { message: "Model vendor/model does not exist" } }, { status: 400 }),
    })
    let caught: unknown
    try {
      await transport(request("openrouter/vendor/model"))
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(DecisionsTransportError)
    expect((caught as DecisionsTransportError).explicitlyNamesMissingModel("vendor/model")).toBe(
      true,
    )
    expect((caught as DecisionsTransportError).explicitlyNamesMissingModel("vendor/other")).toBe(
      false,
    )
    expect(JSON.stringify(caught)).not.toContain("Model vendor/model does not exist")
  })

  test("never classifies a truncated provider message prefix as the missing-model form", () => {
    const exact = "Model vendor/first does not exist"
    const paddedToBound = `${exact}${" ".repeat(1024 - exact.length)}`
    const paddedPastBound = `${exact}${" ".repeat(1024 - exact.length)}x`
    const paddedTail = `${exact}${" ".repeat(1100)}; invalid global request`
    const cases: Array<{ message: string; requestedModel: string; expected: boolean }> = [
      { message: exact, requestedModel: "vendor/first", expected: true },
      { message: `  ${exact}  `, requestedModel: "vendor/first", expected: true },
      { message: paddedToBound, requestedModel: "vendor/first", expected: true },
      { message: paddedPastBound, requestedModel: "vendor/first", expected: false },
      { message: paddedTail, requestedModel: "vendor/first", expected: false },
      { message: paddedTail, requestedModel: "vendor/second", expected: false },
    ]

    expect(paddedToBound).toHaveLength(1024)
    expect(paddedPastBound).toHaveLength(1025)
    expect(paddedTail).toHaveLength(1157)

    for (const item of cases) {
      const error = new DecisionsTransportError("http", {
        requestSent: true,
        status: 400,
        providerMessage: item.message,
      })
      expect(error.explicitlyNamesMissingModel(item.requestedModel)).toBe(item.expected)
      expect(Object.keys(error)).not.toContain("providerMessage")
      expect(JSON.stringify(error)).not.toContain("does not exist")
      expect(String(error)).not.toContain("does not exist")
    }
  })

  test("marks an overlong extracted error message unavailable instead of truncating", async () => {
    const paddedTail = `Model vendor/first does not exist${" ".repeat(1100)}; invalid global request`
    const transport = createDecisionsTransport({
      resolveOpenRouterKey: async () => "synthetic-key",
      fetchImpl: async () => Response.json({ error: { message: paddedTail } }, { status: 400 }),
    })

    let caught: unknown
    try {
      await transport(request("openrouter/vendor/first"))
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(DecisionsTransportError)
    expect(caught).toMatchObject({ kind: "http", status: 400, requestSent: true })
    expect((caught as DecisionsTransportError).explicitlyNamesMissingModel("vendor/first")).toBe(
      false,
    )
  })

  test("treats only the whole explicit missing-model form as model-specific", async () => {
    const cases: Array<{ message: string; requestedModel: string; expected: boolean }> = [
      {
        message: "Model vendor/model does not exist",
        requestedModel: "vendor/model",
        expected: true,
      },
      {
        message: "  Model vendor/model does not exist  ",
        requestedModel: "vendor/model",
        expected: true,
      },
      {
        message:
          "Invalid state contains literal Model vendor/model does not exist; fix the global request.",
        requestedModel: "vendor/model",
        expected: false,
      },
      {
        message: "Model vendor/model does not exist; try another model",
        requestedModel: "vendor/model",
        expected: false,
      },
      {
        message: "Model vendor/other does not exist",
        requestedModel: "vendor/model",
        expected: false,
      },
      {
        message: "Model vendor/model does not exist",
        requestedModel: "vendor/other",
        expected: false,
      },
    ]

    for (const item of cases) {
      const transport = createDecisionsTransport({
        resolveOpenRouterKey: async () => "synthetic-key",
        fetchImpl: async () => Response.json({ error: { message: item.message } }, { status: 400 }),
      })
      let caught: unknown
      try {
        await transport(request("openrouter/vendor/model"))
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(DecisionsTransportError)
      expect(
        (caught as DecisionsTransportError).explicitlyNamesMissingModel(item.requestedModel),
      ).toBe(item.expected)
    }
  })

  test("reports missing credentials without sending a request", async () => {
    let sent = 0
    let fetchCalls = 0
    const transport = createDecisionsTransport({
      resolveOpenRouterKey: async () => undefined,
      fetchImpl: async () => {
        fetchCalls++
        return Response.json({})
      },
    })

    await expect(
      transport(request("openrouter/vendor/model", undefined, 1000, () => sent++)),
    ).rejects.toMatchObject({ kind: "missing-credentials", requestSent: false })
    expect(fetchCalls).toBe(0)
    expect(sent).toBe(0)
  })

  test("rejects unsupported providers before resolving credentials or fetching", async () => {
    let credentialCalls = 0
    let fetchCalls = 0
    const transport = createDecisionsTransport({
      resolveOpenRouterKey: async () => {
        credentialCalls++
        return "synthetic-key"
      },
      fetchImpl: async () => {
        fetchCalls++
        return Response.json({})
      },
    })

    await expect(transport(request("attacker.invalid/model"))).rejects.toMatchObject({
      kind: "invalid-model",
      requestSent: false,
    })
    expect(credentialCalls).toBe(0)
    expect(fetchCalls).toBe(0)
  })
})
