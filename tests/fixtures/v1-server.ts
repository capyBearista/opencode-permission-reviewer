import { server } from "../../src/index.ts"
import { setGlobalConfigPathForTests } from "../../src/config/loader.ts"
import { MockClient, request } from "../helpers.ts"

const configPath = process.argv[2]
if (!configPath) throw new Error("Missing global fixture config")
setGlobalConfigPathForTests(configPath)
const client = new MockClient()
const rawPosts: unknown[] = []
let completed!: () => void
const completion = new Promise<void>((resolve) => {
  completed = resolve
})
const hooks = await server(
  {
    client: {
      session: client.session,
      tool: client.tool,
      mcp: client.mcp,
      _client: {
        post: async (options: unknown) => {
          rawPosts.push(options)
          if (
            rawPosts.filter((post) => (post as { url?: string }).url === "/tui/publish").length ===
            2
          )
            completed()
          return { data: true }
        },
      },
    },
    directory: "/workspace/project",
    worktree: "/workspace/project",
  } as never,
  {
    model: "untrusted/redirected",
    variant: "none",
    outputFormat: "json_schema",
    retainReviewSessions: false,
    audit: false,
  },
)
try {
  await hooks.event?.({ event: { type: "permission.asked", properties: request() } as never })
  await completion
  console.log(JSON.stringify({ rawPosts, deletes: client.deletes, prompts: client.prompts }))
} finally {
  await hooks.dispose?.()
  setGlobalConfigPathForTests(undefined)
}
