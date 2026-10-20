import type { Plugin } from "@opencode/plugin"
import { parse } from "node:path"
import { z } from "zod"
import { NativeMemoryStore, memoryStorageOptions } from "./memory-store"
import { registerGraphMemory } from "./graph-memory"

const text = z.string().max(64 * 1024).optional()
export const memoryWriteSchema = z.object({
  command: z.enum(["create", "str_replace", "insert", "delete", "rename", "update_description", "apply_patch"]),
  reason: z.string().min(1).max(1000),
  file_path: text, old_path: text, new_path: text,
  old_string: text, new_string: text, insert_line: z.number().int().positive().optional(), insert_text: text,
  description: z.string().max(500).optional(), file_text: text, input: text,
})
export const memoryReadSchema = z.object({
  command: z.enum(["status", "list", "read", "search", "graph_status", "graph_search"]).default("status"),
  file_path: z.string().max(1000).optional(), query: z.string().max(500).optional(), offset: z.number().int().nonnegative().optional(),
})

export async function registerMemory(ctx: Plugin.Context): Promise<() => Promise<void>> {
  if (ctx.options.memory === false || ctx.options.memory?.enabled === false) return async () => {}
  const canonical = ctx.location.project.canonical
  const project = ctx.location.project.id === "global" || !canonical || canonical === parse(canonical).root
    ? ctx.location.directory : canonical
  const store = new NativeMemoryStore(memoryStorageOptions(project))
  const registrations: Array<{ dispose(): Promise<void> }> = []
  let graph: Awaited<ReturnType<typeof registerGraphMemory>>
  const read = async (input: z.infer<typeof memoryReadSchema>, sessionID?: string) => {
    if (input.command === "graph_status" || input.command === "graph_search") {
      if (!graph) return JSON.stringify({ enabled: false })
      if (!sessionID) throw new Error("Graph memory requires the native session context")
      return JSON.stringify(input.command === "graph_status"
        ? await graph.controller.status(sessionID) : await graph.controller.search(sessionID, input.query ?? ""))
    }
    return store.read({ ...input, command: input.command })
  }
  try {
    graph = await registerGraphMemory(ctx, project)
    if (graph) registrations.push(graph)
    registrations.push(await ctx.tool.transform(editor => {
      editor.add({
        name: "memory", input: memoryWriteSchema,
        description: "Persist durable project facts and preferences across conversations. Each operation validates paths and commits to the profile/project memory Git repository. Supply reason; create requires file_path (e.g. system/preferences.md), description and file_text. Supports edit, delete, rename and apply_patch. Do not store secrets.",
        execute: async input => ({ content: await store.write(memoryWriteSchema.parse(input)) }),
      })
      editor.add({
        name: "memory_read", input: memoryReadSchema,
        description: "Read committed persistent memory for this profile and project. status reports repository health; list lists blocks; read requires file_path; search requires query. graph_status reports automatic session graph state; graph_search recalls source-linked history in this native session and requires query. Outputs are bounded; offset continues project reads or scans.",
        execute: async (input, context) => ({ content: await read(memoryReadSchema.parse(input), context.sessionID) }),
      })
    }))
    registrations.push(await ctx.command.transform(editor => {
      editor.add({ name: "memory", description: "记忆：status / list / read <路径> / search <关键词> / graph status|search|clear|retry", execute: async input => {
        const raw = input.prompt.text.trim().replace(/^\/memory\s*/, "")
        const [command = "status", ...rest] = raw.split(/\s+/).filter(Boolean)
        const args = rest.join(" ")
        if (command === "graph") {
          if (!graph) {
            await ctx.session.synthetic({ sessionID: input.sessionID, text: JSON.stringify({ enabled: false }), description: "omo-ling 会话图谱", resume: false })
            return
          }
          const [action = "status", ...query] = rest
          await graph.controller.assertSessionScope(input.sessionID)
          let result: unknown
          if (action === "search") result = await graph.controller.search(input.sessionID, query.join(" "))
          else if (action === "retry") result = await graph.controller.retry(input.sessionID)
          else if (action === "clear") { graph.controller.clear(input.sessionID); result = await graph.controller.status(input.sessionID) }
          else if (action === "status") result = await graph.controller.status(input.sessionID)
          else throw new Error("Use /memory graph status, search <query>, clear or retry")
          await ctx.session.synthetic({ sessionID: input.sessionID, text: JSON.stringify(result), description: "omo-ling 会话图谱", resume: false })
          return
        }
        const parsed = memoryReadSchema.parse({ command, ...(command === "read" ? { file_path: args } : { query: args }) })
        await ctx.session.synthetic({ sessionID: input.sessionID, text: await read(parsed, input.sessionID), description: "omo-ling 记忆", resume: false })
      } })
    }))
    for (const hook of ["context", "compaction"] as const) {
      registrations.push(await ctx.session.hook(hook, async input => {
        input.system = input.system.filter(part => !part.text.startsWith("<omo_ling_memory "))
        input.system.push({ type: "text", text: await store.prompt() })
      }))
    }
    registrations.push(await ctx.rpc.register({
      id: "omo.memory", methods: { read: { input: memoryReadSchema, output: z.object({ text: z.string() }) } }, events: {},
    }, { read: async input => ({ text: await read(memoryReadSchema.parse(input)) }) }))
  } catch (error) {
    for (const registration of registrations.reverse()) await registration.dispose().catch(() => {})
    throw error
  }
  return async () => { for (const registration of registrations.reverse()) await registration.dispose() }
}
