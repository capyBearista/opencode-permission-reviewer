import { OpenCode, type OpenCodeEvent } from "@opencode/client"
import { V2AskDecisions } from "../../src/opencode/v2/event-codec.ts"
import { createV2ContextReader } from "../../src/opencode/v2/context-reader.ts"
import { hostCompatibleFetch } from "../../src/opencode/v2/connection.ts"
import { withTimeout } from "../../src/opencode/transport.ts"
import type { MessageWithParts } from "../../src/types.ts"
import contracts from "./host-contracts.json"

const [url, directory, hostVersion] = process.argv.slice(2)
if (!url || !directory || !hostVersion || !process.env.OPENCODE_PASSWORD)
  throw new Error("Missing synthetic host settings")
if (!Object.hasOwn(contracts.v2.integrities, hostVersion))
  throw new Error(`Unsupported fixture host ${hostVersion}`)
const authorization = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`
const client = OpenCode.make({
  baseUrl: url,
  headers: { authorization },
  fetch: hostCompatibleFetch(),
})
const controller = new AbortController()
const events: OpenCodeEvent[] = []
const registry = new V2AskDecisions()
let connected!: () => void
const ready = new Promise<void>((resolve) => {
  connected = resolve
})
const stream = (async () => {
  for await (const event of client.event.subscribe({ signal: controller.signal })) {
    if (event.type === "server.connected") connected()
    registry.observe(event, directory)
    if (
      event.type === "form.created" ||
      event.type === "form.replied" ||
      event.type === "session.forked"
    )
      events.push(event)
  }
})()
void stream.catch(() => {})
let phase = "event connection"
try {
  await withTimeout(ready, 5000)
  phase = "session creation"
  const session = await client.session.create({
    title: "Read-only contract fixture",
    location: { directory },
    model: { providerID: "fixture", id: "reviewer" },
  })
  phase = "session prompt"
  const admission = await client.session.prompt({
    sessionID: session.id,
    text: "Read-only contract fixture.",
  })
  phase = "session wait"
  await client.session.wait({ sessionID: session.id })
  phase = "session context"
  const context = await client.session.context({ sessionID: session.id })
  if (!context.some((message) => message.id === admission.id && message.type === "user"))
    throw new Error("Inbox correlation changed")
  phase = "session fork"
  const fork = await client.session.fork({ sessionID: session.id })
  const reader = createV2ContextReader(client, controller.signal)
  phase = "fork context"
  const normalizedFork = (await reader.messages(fork.id, directory, 10)) as MessageWithParts[]
  const formInput = {
    title: "Scope fixture",
    fields: [
      {
        type: "string" as const,
        key: "scope",
        title: "Allowed scope",
        options: [{ value: "read", label: "Read only" }],
      },
    ] as const,
  }
  phase = "form creation"
  const form = await client.session.form.create({ sessionID: session.id, ...formInput })
  phase = "form reply"
  await client.session.form.reply({
    sessionID: session.id,
    formID: form.id,
    answer: { scope: "read" },
  })
  const deadline = Date.now() + 3000
  phase = "form event"
  while (!registry.recentFor([session.id]).length && Date.now() < deadline) await Bun.sleep(10)
  if (registry.recentFor([session.id])[0]?.answer !== "Read only")
    throw new Error("Native form answer was not normalized")
  const formCreated = events.find((event) => event.type === "form.created")
  const formReplied = events.find((event) => event.type === "form.replied")
  console.log(
    JSON.stringify({
      session: { location: "/workspace/fixture", parent: session.parentID ?? null },
      context: context.map((message) => ({
        type: message.type,
        ...(message.type === "user"
          ? { text: message.text, matchesAdmission: message.id === admission.id }
          : {}),
      })),
      fork: {
        sourceMatches: fork.fork?.sessionID === session.id,
        normalized: normalizedFork.map((message) => ({
          role: message.info.role,
          synthetic: message.info.synthetic === true,
          originMatches: message.info.originSessionID === session.id,
          parts: message.parts.map((part) => ({
            type: part.type,
            synthetic: part.synthetic === true,
          })),
        })),
      },
      formCreated:
        formCreated?.type === "form.created"
          ? { type: formCreated.type, fields: formCreated.data.form.fields }
          : null,
      formReplied:
        formReplied?.type === "form.replied"
          ? { type: formReplied.type, answer: formReplied.data.answer }
          : null,
    }),
  )
} catch (error) {
  throw new Error(`Contract capture failed during ${phase}`, { cause: error })
} finally {
  controller.abort()
  await stream.catch(() => {})
}
