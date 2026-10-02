export {}

import { mkdir, open } from "node:fs/promises"

await mkdir("docs", { recursive: true })
// "wx" refuses to truncate an existing file: the edit is bounded creation.
const handle = await open("docs/bun-run-guide.md", "wx")
await handle.write("# Bun run target\n\nBounded local edit executed through bun run.\n")
await handle.close()
