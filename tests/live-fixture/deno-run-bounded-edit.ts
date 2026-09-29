export {}

import { mkdir, open } from "node:fs/promises"

await mkdir("docs", { recursive: true })
// "wx" refuses to truncate an existing file: the edit is bounded creation.
const handle = await open("docs/deno-run-guide.md", "wx")
await handle.write("# Deno run target\n\nBounded local edit executed through deno run.\n")
await handle.close()
