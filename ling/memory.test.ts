import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { NativeMemoryStore, MEMORY_OUTPUT_LIMIT, memoryIdentity } from "./memory-store"
import { memoryWriteSchema, registerMemory } from "./memory"
import { renderMemoryFile } from "../packages/memory-core/src/memfs"

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "omo-ling-memory-test-"))
  directories.push(root)
  const options = { root: join(root, "memory"), project: join(root, "project"), profile: join(root, "profile") }
  await mkdir(options.project)
  await mkdir(options.profile)
  return { root, options, store: new NativeMemoryStore(options) }
}
const create = (file_path = "system/preferences.md", file_text = "用户喜欢中文回答") => ({ command: "create" as const, file_path, file_text, reason: "Save user preference", description: "User preferences" })

describe("native durable memory", () => {
  test("commits, recalls and injects after reopening; edits, renames and deletes", async () => {
    const { store, options } = await fixture()
    expect(await store.write(create())).toContain("committed locally")
    const reopened = new NativeMemoryStore(options)
    expect(await reopened.read({ command: "search", query: "中文" })).toContain("用户喜欢中文回答")
    expect(await reopened.prompt()).toContain("用户喜欢中文回答")
    expect(await reopened.prompt()).not.toContain("there is no recall tool")
    await reopened.write({ command: "str_replace", file_path: "system/preferences.md", old_string: "中文", new_string: "简体中文", reason: "Clarify language" })
    await reopened.write({ command: "rename", old_path: "system/preferences.md", new_path: "system/language.md", reason: "Rename" })
    expect(await store.read({ command: "list" })).toContain("system/language.md")
    expect(await store.read({ command: "read", file_path: "system/language.md" })).toContain("简体中文")
    await store.write({ command: "delete", file_path: "system/language.md", reason: "User requested forgetting" })
    expect(await reopened.prompt()).not.toContain("简体中文")
  })

  test("inserts, updates descriptions and applies validated multi-file patches", async () => {
    const { store } = await fixture()
    await store.write(create("reference/design.md", "first"))
    await store.write({ command: "insert", file_path: "reference/design.md", insert_line: 2, insert_text: "second", reason: "Append detail" })
    await store.write({ command: "update_description", file_path: "reference/design.md", description: "Design: 中文 # notes", reason: "Clarify index" })
    expect(await store.read({ command: "list" })).toContain("Design: 中文 # notes")
    await store.write({ command: "apply_patch", reason: "Refine design", input: "*** Begin Patch\n*** Update File: reference/design.md\n@@\n-second\n+updated second\n*** End Patch" })
    expect(await store.read({ command: "read", file_path: "reference/design.md" })).toContain("updated second")
    expect(await store.repo.status()).toBe("")
  })

  test("isolates profiles and canonical projects while resolving project aliases", async () => {
    const { root, store, options } = await fixture()
    await store.write(create())
    const otherProject = new NativeMemoryStore({ ...options, project: join(root, "different-project") })
    const otherProfile = new NativeMemoryStore({ ...options, profile: join(root, "different-profile") })
    expect(await otherProject.prompt()).not.toContain("用户喜欢中文回答")
    expect(await otherProfile.prompt()).not.toContain("用户喜欢中文回答")
    const alias = join(root, "project-link")
    await symlink(options.project, alias)
    expect(memoryIdentity(alias, options.profile)).toBe(store.id)
  })

  test("reads only committed data and refuses dirty writes", async () => {
    const { store } = await fixture()
    await store.write(create())
    await writeFile(join(store.repo.dir, "system/preferences.md"), renderMemoryFile({ description: "dirty" }, "UNCOMMITTED-SECRET"))
    expect(await store.prompt()).toContain("用户喜欢中文回答")
    expect(await store.prompt()).not.toContain("UNCOMMITTED-SECRET")
    expect(await store.read({ command: "read", file_path: "system/preferences.md" })).not.toContain("UNCOMMITTED-SECRET")
    await expect(store.write(create("system/second.md"))).rejects.toThrow()
    expect(JSON.parse(await store.read({ command: "status" })).dirty).toBe(true)
  })

  test("rejects traversal, symlink escape, read-only changes and invalid patches", async () => {
    const { root, store } = await fixture()
    await store.read({ command: "status" })
    await expect(store.write(create("../escape.md"))).rejects.toThrow()
    await symlink(root, join(store.repo.dir, "escape"))
    await expect(store.write(create("escape/outside.md"))).rejects.toThrow()
    await rm(join(store.repo.dir, "escape"))
    await mkdir(join(store.repo.dir, "system"), { recursive: true })
    await writeFile(join(store.repo.dir, "system/locked.md"), renderMemoryFile({ description: "Locked", read_only: "true" }, "Keep me"))
    // Seed read-only content as the human owner, outside the agent write path.
    execFileSync("git", ["add", "system/locked.md"], { cwd: store.repo.dir })
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Human", "-c", "user.email=human@example.invalid", "commit", "-m", "Human seed"], { cwd: store.repo.dir })
    await expect(store.write({ command: "delete", file_path: "system/locked.md", reason: "Rejected" })).rejects.toThrow("read_only")
    await expect(store.write({ command: "apply_patch", input: "*** Begin Patch\n*** Add File: ../evil.md\n+bad\n*** End Patch", reason: "Rejected" })).rejects.toThrow()
    expect(await readFile(join(store.repo.dir, "system/locked.md"), "utf8")).toContain("Keep me")
  })

  test("bounds output, paginates reads and never injects an oversized projection", async () => {
    const { store } = await fixture()
    const body = "B".repeat(MEMORY_OUTPUT_LIMIT + 500)
    await store.write(create("system/large.md", body))
    const first = await store.read({ command: "read", file_path: "system/large.md" })
    expect(first.length).toBeLessThan(MEMORY_OUTPUT_LIMIT + 200)
    expect(first).toContain("More content")
    expect(await store.read({ command: "read", file_path: "system/large.md", offset: MEMORY_OUTPUT_LIMIT })).toContain("B")
    expect((await store.prompt()).length).toBeLessThan(MEMORY_OUTPUT_LIMIT)
    expect(await store.prompt()).toContain("exceeds the prompt budget")
    await expect(store.write(create("system/huge.md", "x".repeat(70_000)))).rejects.toThrow("64 KiB")
  })

  test("serializes simultaneous writers sharing one identity", async () => {
    const { store, options } = await fixture()
    const another = new NativeMemoryStore(options)
    await Promise.all([store.write(create("system/one.md", "one")), another.write(create("system/two.md", "two"))])
    const list = await store.read({ command: "list" })
    expect(list).toContain("system/one.md")
    expect(list).toContain("system/two.md")
    expect(await store.repo.status()).toBe("")
  })
})

function mockHost(project: string) {
  const tools = new Map<string, any>()
  const commands = new Map<string, any>()
  const hooks = new Map<string, any>()
  const messages: any[] = []
  const rpc = new Map<string, any>()
  let disposed = 0
  const registration = () => ({ dispose: async () => { disposed++ } })
  const ctx = {
    options: { memory: { graph: false } }, location: { directory: project, project: { canonical: project } },
    tool: { transform: async (callback: any) => { callback({ add: (tool: any) => tools.set(tool.name, tool) }); return registration() } },
    command: { transform: async (callback: any) => { callback({ add: (command: any) => commands.set(command.name, command) }); return registration() } },
    session: { hook: async (name: string, callback: any) => { hooks.set(name, callback); return registration() }, synthetic: async (input: any) => { messages.push(input) } },
    rpc: { register: async (definition: any, handlers: any) => { rpc.set(definition.id, handlers); return registration() } },
  } as unknown as Plugin.Context
  return { ctx, tools, commands, hooks, messages, rpc, disposed: () => disposed }
}

test("native registration writes, injects both hooks, answers slash command without starting model, and disposes", async () => {
  const { options } = await fixture()
  const previousRoot = process.env.OMO_LING_MEMORY_HOME
  const previousProfile = process.env.OPENCODE_CONFIG_DIR
  process.env.OMO_LING_MEMORY_HOME = options.root
  process.env.OPENCODE_CONFIG_DIR = options.profile
  try {
    const host = mockHost(options.project)
    const cleanup = await registerMemory(host.ctx)
    expect([...host.tools.keys()]).toEqual(["memory", "memory_read"])
    await host.tools.get("memory").execute(memoryWriteSchema.parse(create()))
    for (const name of ["context", "compaction"]) {
      const input = { system: [{ type: "text", text: "Existing system instruction" }] }
      await host.hooks.get(name)(input)
      await host.hooks.get(name)(input)
      expect(input.system.length).toBe(2)
      expect(input.system[1].text).toContain("用户喜欢中文回答")
    }
    await host.commands.get("memory").execute({ sessionID: "session-a", prompt: { text: "search 中文" } })
    expect(host.messages[0]).toMatchObject({ sessionID: "session-a", resume: false })
    expect(host.messages[0].text).toContain("用户喜欢中文回答")
    expect((await host.rpc.get("omo.memory").read({ command: "status" })).text).toContain("profile + canonical project")
    await cleanup()
    expect(host.disposed()).toBe(5)
  } finally {
    if (previousRoot === undefined) delete process.env.OMO_LING_MEMORY_HOME; else process.env.OMO_LING_MEMORY_HOME = previousRoot
    if (previousProfile === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = previousProfile
  }
})


test("disabled memory installs nothing; partial setup failure cleans existing registrations", async () => {
  const { options } = await fixture()
  const disabled = mockHost(options.project)
  await registerMemory({ ...disabled.ctx, options: { memory: false } })
  expect(disabled.tools.size).toBe(0)
  expect(disabled.hooks.size).toBe(0)
  const failing = mockHost(options.project)
  const ctx = { ...failing.ctx, command: { ...failing.ctx.command, transform: async () => { throw new Error("host unavailable") } } }
  await expect(registerMemory(ctx)).rejects.toThrow("host unavailable")
  expect(failing.disposed()).toBe(1)
})
