import type { Plugin } from "@opencode/plugin"
import { registerAgents } from "../packages/omo-opencode/src/v2/agents"
import { registerOrchestration } from "../packages/omo-opencode/src/v2/orchestration"
import { registerToolsAndHooks } from "../packages/omo-opencode/src/v2/tools"

// Host-managed MCP servers and skill inventory are left to OpenCode / LING.
const plugin: Parameters<typeof Plugin.define>[0] = {
  id: "omo-ling",
  async setup(ctx) {
    const cleanups: Array<() => Promise<void>> = []
    try {
      cleanups.push(await registerToolsAndHooks(ctx))
      cleanups.push(await registerAgents(ctx))
      cleanups.push(await registerOrchestration(ctx))
    } catch (error) {
      for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {})
      throw error
    }
    return async () => {
      for (const cleanup of cleanups.reverse()) await cleanup()
    }
  },
}

export default plugin
