import { SYSTEM_ONE_QUESTIONS, type SystemOneState } from "./review.ts"

export type DecisionsTransportFailureKind =
  | "missing-credentials"
  | "timeout"
  | "cancelled"
  | "network"
  | "invalid-json"
  | "response-too-large"
  | "http"
  | "invalid-model"
  | "internal"

export interface DecisionsTransportErrorOptions {
  requestSent?: boolean
  status?: number
  /** Provider error text used only for the narrow 400 model-not-found check.
   *  Retained only when it fits the log-safe bound whole; an overlong message is
   *  dropped rather than truncated, so a padded message stays generic. */
  providerMessage?: string
}

export class DecisionsTransportError extends Error {
  readonly kind: DecisionsTransportFailureKind
  readonly requestSent: boolean
  readonly status?: number
  readonly #providerMessage?: string

  constructor(kind: DecisionsTransportFailureKind, options: DecisionsTransportErrorOptions = {}) {
    super(`Decisions transport ${kind}`)
    this.name = "DecisionsTransportError"
    this.kind = kind
    this.requestSent = options.requestSent ?? false
    if (options.status !== undefined) this.status = options.status
    if (
      options.providerMessage !== undefined &&
      options.providerMessage.length <= MAX_PROVIDER_MESSAGE_CHARS
    )
      this.#providerMessage = options.providerMessage
  }

  explicitlyNamesMissingModel(nativeModel: string): boolean {
    return (
      this.kind === "http" &&
      this.status === 400 &&
      this.#providerMessage?.trim() === `Model ${nativeModel} does not exist`
    )
  }
}

export interface DecisionsTransportRequest {
  model: string
  state: SystemOneState
  signal: AbortSignal
  timeoutMs: number
  onRequestSent: () => void
}

export type DecisionsTransport = (request: DecisionsTransportRequest) => Promise<unknown>
export type DecisionsFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export interface DecisionsTransportOptions {
  /** Lazy OpenRouter credential lookup, invoked only for OpenRouter models and
   *  given the attempt-scoped bounded signal (caller cancellation and this
   *  attempt's timeout) so a resolver can stop advancing its own stages. */
  resolveOpenRouterKey?: (signal: AbortSignal) => Promise<string | undefined>
  fetchImpl?: DecisionsFetch
}

const MAX_SUCCESS_BYTES = 64 * 1024
const MAX_ERROR_BYTES = 8 * 1024
const ZEN_URL = "https://opencode.ai/zen/v1/systemone"
const OPENROUTER_URL = "https://openrouter.ai/api/alpha/decisions"
/** Log-safe bound for provider error text. Overlong text is unavailable, never
 *  a truncated prefix: classification must see the complete message. */
const MAX_PROVIDER_MESSAGE_CHARS = 1024

function abortFailure(
  didTimeout: () => boolean,
  requestSent: () => boolean,
): DecisionsTransportError {
  return new DecisionsTransportError(didTimeout() ? "timeout" : "cancelled", {
    requestSent: requestSent(),
  })
}

function waitForSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  onAbort: () => DecisionsTransportError,
  onLateValue?: (value: T) => void,
): Promise<T> {
  if (signal.aborted) {
    operation.then(
      (value) => onLateValue?.(value),
      () => {},
    )
    return Promise.reject(onAbort())
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false
    const cleanup = () => signal.removeEventListener("abort", aborted)
    const aborted = () => {
      if (settled) return
      settled = true
      cleanup()
      operation.then(
        (value) => onLateValue?.(value),
        () => {},
      )
      reject(onAbort())
    }
    signal.addEventListener("abort", aborted, { once: true })
    operation.then(
      (value) => {
        if (settled) return
        settled = true
        cleanup()
        if (signal.aborted) {
          onLateValue?.(value)
          reject(onAbort())
        } else resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      },
    )
  })
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (!body) return
  try {
    void body.cancel().catch(() => {})
  } catch {
    // Cancellation is best-effort after the request is already being discarded.
  }
}

async function readBounded(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
  onAbort: () => DecisionsTransportError,
  status: number,
  requestSent: () => boolean,
): Promise<Uint8Array> {
  const hintedLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(hintedLength) && hintedLength > maximumBytes) {
    cancelBody(response.body)
    throw new DecisionsTransportError("response-too-large", { status, requestSent: requestSent() })
  }

  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  let bytesRead = 0
  const chunks: Uint8Array[] = []
  let readerReleased = false
  const cancelReader = () => {
    try {
      void reader.cancel().catch(() => {})
    } catch {
      // The stream may already have completed or released its lock.
    }
  }
  const releaseReader = () => {
    try {
      reader.releaseLock()
      readerReleased = true
    } catch {
      // A pending read is cancelled asynchronously; release after it settles.
    }
  }
  const onSignalAbort = () => cancelReader()
  signal.addEventListener("abort", onSignalAbort, { once: true })

  try {
    while (true) {
      const read = reader.read()
      try {
        const chunk = await waitForSignal(Promise.resolve(read), signal, onAbort)
        if (chunk.done) break
        bytesRead += chunk.value.byteLength
        if (bytesRead > maximumBytes) {
          cancelReader()
          throw new DecisionsTransportError("response-too-large", {
            status,
            requestSent: requestSent(),
          })
        }
        chunks.push(chunk.value)
      } catch (error) {
        if (signal.aborted) {
          cancelReader()
          void Promise.resolve(read).then(releaseReader, releaseReader)
          readerReleased = true
        }
        throw error
      }
    }
  } finally {
    signal.removeEventListener("abort", onSignalAbort)
    if (!readerReleased) releaseReader()
  }

  const result = new Uint8Array(bytesRead)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
}

function providerErrorMessage(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return
    const root = parsed as Record<string, unknown>
    const nested =
      typeof root.error === "object" && root.error !== null
        ? (root.error as Record<string, unknown>).message
        : undefined
    const message = typeof nested === "string" ? nested : root.message
    // A message longer than the log-safe bound is unavailable: keeping its first
    // slice would let a padded tail erase contradictory text during classification.
    return typeof message === "string" && message.length <= MAX_PROVIDER_MESSAGE_CHARS
      ? message
      : undefined
  } catch {
    return
  }
}

function nativeRoute(model: string): { provider: "opencode" | "openrouter"; nativeModel: string } {
  const slash = model.indexOf("/")
  if (slash <= 0 || slash === model.length - 1) throw new DecisionsTransportError("invalid-model")
  const provider = model.slice(0, slash)
  if (provider !== "opencode" && provider !== "openrouter")
    throw new DecisionsTransportError("invalid-model")
  return { provider, nativeModel: model.slice(slash + 1) }
}

export function createDecisionsTransport(
  options: DecisionsTransportOptions = {},
): DecisionsTransport {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch

  return async (request) => {
    let requestSent = false
    let didTimeout = false
    const controller = new AbortController()
    const abortFromCaller = () => controller.abort(request.signal.reason)
    if (request.signal.aborted) abortFromCaller()
    else request.signal.addEventListener("abort", abortFromCaller, { once: true })
    const timer = setTimeout(
      () => {
        didTimeout = true
        controller.abort(new DOMException("Decisions attempt timed out", "TimeoutError"))
      },
      Math.max(0, request.timeoutMs),
    )
    const signal = controller.signal
    const onAbort = () =>
      abortFailure(
        () => didTimeout,
        () => requestSent,
      )

    try {
      if (signal.aborted) throw onAbort()
      const route = nativeRoute(request.model)
      let url = ZEN_URL
      const headers = new Headers({ "Content-Type": "application/json" })
      if (route.provider === "opencode") {
        headers.set("x-opencode-client", "opencode-permission-reviewer")
      } else {
        let key: string | undefined
        if (options.resolveOpenRouterKey) {
          // Invoke the resolver directly (before the race) so a cancelled or
          // timed-out attempt never starts credential work; the outer race and
          // its cleanup stay in force for the resolver's own async stages.
          if (signal.aborted) throw onAbort()
          let pending: Promise<string | undefined>
          try {
            pending = Promise.resolve(options.resolveOpenRouterKey(signal))
          } catch {
            throw new DecisionsTransportError("internal")
          }
          try {
            key = await waitForSignal(pending, signal, onAbort)
          } catch (error) {
            if (error instanceof DecisionsTransportError) throw error
            throw new DecisionsTransportError("internal")
          }
        }
        if (!key?.trim()) throw new DecisionsTransportError("missing-credentials")
        headers.set("Authorization", `Bearer ${key.trim()}`)
        url = OPENROUTER_URL
      }

      if (signal.aborted) throw onAbort()
      const body = JSON.stringify({
        model: route.nativeModel,
        state: request.state,
        questions: SYSTEM_ONE_QUESTIONS,
      })
      const init: RequestInit = {
        method: "POST",
        headers,
        body,
        redirect: "error",
        signal,
      }
      requestSent = true
      request.onRequestSent()
      let pendingResponse: Promise<Response>
      try {
        pendingResponse = Promise.resolve(fetchImpl(url, init))
      } catch (error) {
        pendingResponse = Promise.reject(error)
      }
      const response = await waitForSignal(pendingResponse, signal, onAbort, (lateResponse) =>
        cancelBody(lateResponse.body),
      )
      if (signal.aborted) {
        cancelBody(response.body)
        throw onAbort()
      }

      if (!response.ok) {
        let bytes: Uint8Array
        try {
          bytes = await readBounded(
            response,
            MAX_ERROR_BYTES,
            signal,
            onAbort,
            response.status,
            () => requestSent,
          )
        } catch {
          // Error text is optional; after headers, the HTTP status is authoritative.
          // Caller cancellation/deadline still outranks the received status.
          if (request.signal.aborted)
            throw new DecisionsTransportError("cancelled", { requestSent })
          throw new DecisionsTransportError("http", {
            requestSent,
            status: response.status,
          })
        }
        let message: string | undefined
        try {
          message = providerErrorMessage(decode(bytes))
        } catch {
          message = undefined
        }
        throw new DecisionsTransportError("http", {
          requestSent,
          status: response.status,
          ...(message === undefined ? {} : { providerMessage: message }),
        })
      }

      const bytes = await readBounded(
        response,
        MAX_SUCCESS_BYTES,
        signal,
        onAbort,
        response.status,
        () => requestSent,
      )
      try {
        return JSON.parse(decode(bytes)) as unknown
      } catch {
        throw new DecisionsTransportError("invalid-json", { requestSent })
      }
    } catch (error) {
      if (error instanceof DecisionsTransportError) throw error
      if (signal.aborted) throw onAbort()
      if (error instanceof TypeError) throw new DecisionsTransportError("network", { requestSent })
      throw new DecisionsTransportError("internal", { requestSent })
    } finally {
      clearTimeout(timer)
      request.signal.removeEventListener("abort", abortFromCaller)
    }
  }
}
