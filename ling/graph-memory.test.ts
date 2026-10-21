import { afterEach, describe, expect, test } from "bun:test"
import type { OpenCodeEvent, SessionInfo, SessionMessageInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerMemory } from "./memory"
import { registerGraphMemory } from "./graph-memory"
import { GraphStore } from "./graph-store"
import { memoryIdentity } from "./memory-store"

type HookInput = { sessionID: string; messageID?: string; system: Array<{ type: "text"; text: string }>;
  messages: Array<{ id?: string; role: string; content: Array<{ type: "text"; text: string }> }> }
type ToolDefinition = { name: string; execute(input: unknown, context: { sessionID: string }): Promise<{ content: string }> }
type CommandDefinition = { name: string; execute(input: { sessionID: string; prompt: { text: string } }): Promise<void> }
type RpcMethod = (input: Record<string, unknown>) => Promise<unknown>
const cleanups: Array<() => Promise<void>> = []
const directories: string[] = []
let previousEnvironment: { root?: string; profile?: string } | undefined
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
  if (previousEnvironment) {
    if (previousEnvironment.root === undefined) delete process.env.OMO_LING_MEMORY_HOME
    else process.env.OMO_LING_MEMORY_HOME = previousEnvironment.root
    if (previousEnvironment.profile === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previousEnvironment.profile
    previousEnvironment = undefined
  }
})
async function fixture(options: Record<string, unknown> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "omo-graph-hooks-"))
  directories.push(directory)
  const root = join(directory, "memory"), profile = join(directory, "profile"), project = join(directory, "project")
  previousEnvironment ??= { root: process.env.OMO_LING_MEMORY_HOME, profile: process.env.OPENCODE_CONFIG_DIR }
  process.env.OMO_LING_MEMORY_HOME = root
  process.env.OPENCODE_CONFIG_DIR = profile
  const tools = new Map<string, ToolDefinition>(), commands = new Map<string, CommandDefinition>()
  const hooks = new Map<string, Array<(input: HookInput) => Promise<void>>>()
  const rpc = new Map<string, Record<string, RpcMethod>>()
  const sent: unknown[] = [], generated: unknown[] = [], queue: OpenCodeEvent[] = []
  const messages = new Map<string, SessionMessageInfo[]>()
  let contextFailure = false, ended = false, failed = false, notify = () => {}, disposed = 0
  const registration = () => ({ dispose: async () => { disposed++ } })
  const ctx = {
    options, location: { directory: project, project: { id: "project", canonical: project, directory: project } },
    tool: { transform: async (callback: (editor: { add: (tool: ToolDefinition) => void }) => void) => {
      callback({ add: tool => { tools.set(tool.name, tool) } }); return registration()
    } },
    command: { transform: async (callback: (editor: { add: (command: CommandDefinition) => void }) => void) => {
      callback({ add: command => { commands.set(command.name, command) } }); return registration()
    } },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID, projectID: sessionID === "foreign-project" ? "foreign" : "project",
        location: { directory: sessionID === "foreign-host" ? "/foreign" : project },
      } as SessionInfo),
      context: async ({ sessionID }: { sessionID: string }) => {
        if (contextFailure) throw new Error("Native source unavailable")
        return messages.get(sessionID) ?? []
      },
      hook: async (name: string, callback: (input: HookInput) => Promise<void>) => {
        const callbacks = hooks.get(name) ?? []; callbacks.push(callback); hooks.set(name, callbacks)
        return registration()
      },
      synthetic: async (input: unknown) => { sent.push(input) },
    },
    rpc: { register: async (definition: { id: string }, handlers: Record<string, RpcMethod>) => {
      rpc.set(definition.id, handlers); return registration()
    } },
    generate: { text: async (input: unknown) => {
      generated.push(input)
      return { text: JSON.stringify({ summary: "violet is enabled", outcome: "completed", triples: [] }) }
    } },
    event: { subscribe: ({ signal }: { signal: AbortSignal }) => (async function* () {
      while (!signal.aborted) {
        if (failed) throw new Error("private native stream failure")
        if (ended) return
        const event = queue.shift()
        if (event) { yield event; continue }
        await new Promise<void>(resolve => {
          notify = resolve
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
      }
    })() },
  } as unknown as Plugin.Context
  const store = new GraphStore(join(root, "graphs", `${memoryIdentity(project, profile)}.sqlite`))
  cleanups.push(async () => { store.dispose() })
  const seed = (sessionID = "one", content = "Use violet theme") => {
    const ticket = store.schedule(sessionID, { createdAt: 10_000, sources: [
      { id: "original-user", role: "user", text: content }, { id: "original-assistant", role: "assistant", text: "Violet enabled" },
    ] })
    if (!ticket) throw new Error("Expected graph ticket")
    store.complete(ticket, { summary: "violet is enabled", outcome: "completed", triples: [] })
  }
  return { ctx, tools, commands, hooks, rpc, sent, generated, messages, store, seed,
    disposed: () => disposed,
    failContext: () => { contextFailure = true },
    finishStream: () => { ended = true; notify() },
    failStream: () => { failed = true; notify() },
    async hook(name: string, input: HookInput) { for (const callback of hooks.get(name) ?? []) await callback(input) },
    event(event: OpenCodeEvent) { queue.push(event); notify() },
  }
}
const input = (): HookInput => ({ sessionID: "one", system: [{ type: "text", text: "existing" }],
  messages: [{ id: "question", role: "user", content: [{ type: "text", text: "Current violet question" }] }] })

describe("native graph memory bindings", () => {
  test("default registration reuses memory command and tool, honors tool session binding, and disposes", async () => {
    const f = await fixture()
    const cleanup = await registerMemory(f.ctx)
    cleanups.push(cleanup)
    expect([...f.tools.keys()]).toEqual(["memory", "memory_read"])
    expect([...f.commands.keys()]).toEqual(["memory"])
    expect(f.rpc.has("omo.memory.graph")).toBe(true)
    expect(f.generated).toHaveLength(0)
    f.seed()
    const read = f.tools.get("memory_read")!
    const output = await read.execute({ command: "graph_search", query: "violet", sessionID: "two" }, { sessionID: "one" })
    expect(JSON.parse(output.content)[0].sessionID).toBe("one")
    expect(JSON.parse((await read.execute({ command: "graph_search", query: "violet" }, { sessionID: "two" })).content)).toEqual([])
    await f.commands.get("memory")!.execute({ sessionID: "one", prompt: { text: "/memory graph status" } })
    expect(f.sent[0]).toMatchObject({ sessionID: "one", resume: false })
    expect(f.generated).toHaveLength(0)
    await f.commands.get("memory")!.execute({ sessionID: "one", prompt: { text: "/memory graph clear" } })
    expect(f.store.status("one").ready).toBe(0)
  })

  test("memory and graph opt-outs do not register extraction hooks or call the model", async () => {
    for (const options of [
      { memory: false }, { memory: { enabled: false } }, { memory: { graph: false } }, { memory: { graph: { enabled: false } } },
    ]) {
      const f = await fixture(options)
      const cleanup = await registerMemory(f.ctx)
      await cleanup()
      expect(f.rpc.has("omo.memory.graph")).toBe(false)
      expect(f.hooks.has("prompt")).toBe(false)
      expect(f.generated).toHaveLength(0)
    }
  })

  test("context and compaction recall are bounded untrusted history before the current request", async () => {
    const f = await fixture()
    cleanups.push(await registerMemory(f.ctx))
    f.seed("one", "violet " + "历史来源".repeat(2_000))
    f.messages.set("one", [
      { type: "user", id: "question", text: "violet", time: { created: 20_000 } },
      { type: "synthetic", id: "goal", text: "unrelated current goal", time: { created: 20_001 } } as SessionMessageInfo,
    ])
    for (const name of ["context", "compaction"]) {
      const hookInput = input()
      await f.hook(name, hookInput)
      await f.hook(name, hookInput)
      expect(hookInput.messages).toHaveLength(2)
      expect(hookInput.messages[0].role).toBe("user")
      expect(hookInput.messages[0].id).toBe("omo-ling-session-graph-memory")
      expect(hookInput.messages.at(-1)?.id).toBe("question")
      const text = hookInput.messages[0].content[0].text
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(8 * 1024)
      expect(JSON.parse(text.slice(text.indexOf("\n") + 1))[0].sources[0].id).toBe("original-user")
      expect(hookInput.system.every(part => !part.text.includes("original-user"))).toBe(true)
    }
  })

  test("RPCs require the native session's location and project before reads or mutations", async () => {
    const f = await fixture()
    cleanups.push(await registerMemory(f.ctx))
    f.seed()
    const rpc = f.rpc.get("omo.memory.graph")!
    for (const sessionID of ["foreign-project", "foreign-host"]) {
      for (const method of ["status", "search", "snapshot", "detail", "clear", "retry"]) {
        await expect(rpc[method]({ sessionID, query: "violet", key: "a".repeat(64) })).rejects.toThrow("outside")
      }
    }
    await expect(rpc.status({})).rejects.toThrow("native session ID")
    expect(f.store.status("one").ready).toBe(1)
    expect(f.store.status("foreign-project").initialized).toBe(false)
    expect(f.generated).toHaveLength(0)
  })

  test("browser RPC returns exact source groups without requesting model work", async () => {
    // given
    const f = await fixture()
    cleanups.push(await registerMemory(f.ctx))
    f.seed("one", "violet " + "原始来源".repeat(2_000))
    const rpc = f.rpc.get("omo.memory.graph")!
    // when
    const snapshot = await rpc.snapshot({ sessionID: "one" }) as { revision: string; records: Array<{ key: string }> }
    const detail = await rpc.detail({ sessionID: "one", key: snapshot.records[0].key, revision: snapshot.revision })
    // then
    expect(snapshot).toMatchObject({ sessionID: "one", records: [{ sources: [
      { id: "original-user", role: "user" }, { id: "original-assistant", role: "assistant" },
    ] }], hasMore: false, truncated: false, resetRequired: false, status: { enabled: true, available: true, ready: 1 } })
    expect(detail).toMatchObject({ record: { sources: [
      { id: "original-user", role: "user", text: "violet " + "原始来源".repeat(2_000) },
      { id: "original-assistant", role: "assistant", text: "Violet enabled" },
    ] }, resetRequired: false })
    expect(f.generated).toHaveLength(0)
    expect(f.sent).toHaveLength(0)
  })

  test("unavailable native history fails open for both hooks and exposes a redacted status error", async () => {
    const f = await fixture()
    cleanups.push(await registerMemory(f.ctx))
    f.failContext()
    for (const name of ["context", "compaction"]) {
      const hookInput = input()
      await f.hook(name, hookInput)
      expect(hookInput.messages.map(message => message.id)).toEqual(["question"])
    }
    expect(await f.rpc.get("omo.memory.graph")!.status({ sessionID: "one" })).toMatchObject({ status: { lastError: expect.any(String) } })
  })

  test("ended or failed native subscriptions report unavailable while existing graph data remains readable", async () => {
    for (const outcome of ["end", "failure"]) {
      const f = await fixture()
      const graph = await registerGraphMemory(f.ctx, f.ctx.location.directory)
      if (!graph) throw new Error("Expected enabled graph")
      cleanups.push(graph.dispose)
      f.seed()
      let stop!: () => void
      const stopped = new Promise<void>(resolve => { stop = resolve })
      const subscriptionFailed = graph.controller.subscriptionFailed.bind(graph.controller)
      graph.controller.subscriptionFailed = () => { subscriptionFailed(); stop() }
      let timer: ReturnType<typeof setTimeout> | undefined
      const failure = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Waited 5 seconds for native subscription termination")), 5_000)
      })
      try {
        if (outcome === "end") f.finishStream(); else f.failStream()
        await Promise.race([stopped, failure])
      } finally { if (timer) clearTimeout(timer) }
      const status = await graph.controller.status("one")
      expect(status.available).toBe(false)
      expect(status.lastError).toBeTruthy()
      expect(status.lastError).not.toContain("private native stream")
      expect(await graph.controller.search("one", "violet")).toHaveLength(1)
      expect(await graph.controller.snapshot("one")).toMatchObject({ status: { available: false }, records: [{ summary: "violet is enabled" }] })
    }
  })
})
