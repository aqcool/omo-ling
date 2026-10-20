import { afterEach, describe, expect, test } from "bun:test"
import type { ModelRef, OpenCodeEvent, SessionInfo, SessionMessageInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GraphController } from "./graph-controller"
import { GraphStore } from "./graph-store"
import type { Extraction, GraphTicket, GraphTurn } from "./graph-types"

const directories: string[] = [], controllers: GraphController[] = []
const releases: Array<() => void> = []
const settlers: Array<() => Promise<void>> = []
const model: ModelRef = { id: "fixture", providerID: "local" }
const extraction: Extraction = { summary: "The user requested the violet theme; the assistant enabled violet.", outcome: "completed", triples: [
  { subject: "theme", predicate: "is", object: "violet" },
] }
const reply = { text: JSON.stringify(extraction) }
async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Waited 5 seconds for graph completion; no observable signal arrived")), 5_000)
    })])
  } finally { if (timer) clearTimeout(timer) }
}
afterEach(async () => {
  for (const release of releases.splice(0)) release()
  await Promise.all(settlers.splice(0).map(settle => settle()))
  for (const controller of controllers.splice(0)) controller.dispose()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function user(id: string, text = "Use violet theme"): SessionMessageInfo {
  return { type: "user", id, text, time: { created: 10_000 } }
}
function assistant(id: string, text = "Enabled violet theme"): SessionMessageInfo {
  return { type: "assistant", id, agent: "fixture", model, content: [
    { type: "reasoning", text: "PRIVATE REASONING" },
    { type: "tool", id: "private-tool", tool: "read", state: { status: "completed", input: {}, content: [{ type: "text", text: "PRIVATE TOOL OUTPUT" }] } },
    { type: "text", text },
  ], time: { created: 10_001, completed: 10_002 }, finish: "stop" } as SessionMessageInfo
}
function synthetic(id: string): SessionMessageInfo {
  return { type: "synthetic", id, text: "goal continuation", time: { created: 10_003 } } as SessionMessageInfo
}
async function fixture(options: { timeoutMs?: number; maxPending?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "omo-graph-controller-"))
  directories.push(directory)
  const messages = new Map<string, SessionMessageInfo[]>()
  const infos = new Map<string, SessionInfo>()
  const calls: Array<{ prompt: string; model?: ModelRef | null }> = []
  let generate = async (_input: { prompt: string; model?: ModelRef | null }) => reply
  let readContext = async (sessionID: string) => messages.get(sessionID) ?? []
  const observers = new Set<() => void>()
  const changed = () => { for (const observer of observers) observer() }
  const pending = new Set<Promise<void>>()
  const track = (promise: Promise<void>) => {
    pending.add(promise)
    const completed = () => { pending.delete(promise); changed() }
    void promise.then(completed, completed)
    return promise
  }
  const settle = async () => { while (pending.size) await deadline(Promise.all([...pending])) }
  settlers.push(settle)
  // All state writes and host calls notify this fixture. Durable conditions are
  // checked when subscribing as well, so an already-completed operation is safe.
  const until = async (predicate: () => boolean) => {
    let observe!: () => void
    try {
      await deadline(new Promise<void>((resolve, reject) => {
        observe = () => {
          try { if (predicate()) resolve() } catch (error) { reject(error) }
        }
        observers.add(observe); observe()
      }))
    } finally { observers.delete(observe) }
  }
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const host = {
    location,
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        const info = infos.get(sessionID)
        if (!info) throw new Error("Native session not found")
        return info
      },
      context: async ({ sessionID }: { sessionID: string }) => { const result = readContext(sessionID); changed(); return result },
    },
    generate: { text: async (input: { prompt: string; model?: ModelRef | null }) => { calls.push(input); changed(); return generate(input) } },
  } as unknown as Pick<Plugin.Context, "session" | "generate" | "location">
  const addSession = (sessionID: string, additions: Partial<SessionInfo> = {}) => {
    infos.set(sessionID, { id: sessionID, projectID: "project", location: { directory }, ...additions } as SessionInfo)
  }
  addSession("one"); addSession("two")
  class ObservedStore extends GraphStore {
    override schedule(sessionID: string, turn: GraphTurn) { const result = super.schedule(sessionID, turn); changed(); return result }
    override complete(ticket: GraphTicket, result: Extraction) { const completed = super.complete(ticket, result); changed(); return completed }
    override fail(ticket: GraphTicket, reason: unknown) { super.fail(ticket, reason); changed() }
  }
  const store = new ObservedStore(join(directory, "graph.sqlite"))
  const controller = new GraphController(host, store, { ...options, now: () => 10_000 })
  const originalGenerate = controller.generate.bind(controller)
  controller.generate = job => track(originalGenerate(job))
  controllers.push(controller)
  let seq = 0
  const event = (type: string, sessionID = "one", data: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) => {
    const value = { id: `event_${++seq}`, type: `session.${type}`, created: 10_000 + seq,
      durable: { seq, aggregateID: sessionID, version: 1 }, location: { directory },
      data: { sessionID, ...data }, ...overrides } as unknown as OpenCodeEvent
    const receipt = controller.event(value)
    if (receipt) track(receipt)
    return value
  }
  const complete = (suffix = "1", sessionID = "one") => {
    const u = user(`user_${suffix}`), a = assistant(`assistant_${suffix}`)
    messages.set(sessionID, [...messages.get(sessionID) ?? [], u, a])
    event("inbox.enqueued", sessionID, { inboxID: u.id, item: { type: "user", payload: { text: "Use violet theme" }, delivery: "queue" } })
    event("execution.started", sessionID)
    event("inbox.delivered", sessionID, { inboxID: u.id })
    event("step.started", sessionID, { assistantMessageID: a.id, model })
    event("step.ended", sessionID, { assistantMessageID: a.id, finish: "stop" })
    return event("execution.succeeded", sessionID)
  }
  return { directory, host, store, controller, messages, infos, calls, event, complete, addSession, settle, until,
    setGenerate: (fn: typeof generate) => { generate = fn },
    setContext: (fn: typeof readContext) => { readContext = fn },
  }
}
function seed(store: GraphStore, sessionID: string, suffix: string, summary: string) {
  const turn: GraphTurn = { createdAt: 10_000, sources: [
    { id: `user_${suffix}`, role: "user", text: "Use violet theme" },
    { id: `assistant_${suffix}`, role: "assistant", text: "Enabled violet theme" },
  ] }
  const ticket = store.schedule(sessionID, turn)
  if (!ticket) throw new Error("Expected graph ticket")
  store.complete(ticket, { ...extraction, summary })
}

describe("native session graph controller", () => {
  test("extracts one real visible turn once, selects its model, and retains restart deduplication", async () => {
    // given fresh native user and assistant IDs
    const f = await fixture()
    const terminal = f.complete()
    await f.until(() => f.store.status("one").ready === 1)
    // when the host repeats terminal notifications
    f.controller.event(terminal)
    f.event("execution.succeeded")
    await f.settle()
    // then extraction only sees visible Q/A and survives a new controller
    expect(f.calls).toHaveLength(1)
    expect(f.calls[0].model).toEqual(model)
    expect(f.calls[0].prompt).toContain("Use violet theme")
    expect(f.calls[0].prompt).toContain("Enabled violet theme")
    expect(f.calls[0].prompt).not.toContain("PRIVATE REASONING")
    expect(f.calls[0].prompt).not.toContain("PRIVATE TOOL OUTPUT")
    expect((await f.controller.search("one", "violet"))[0].sources.map(item => item.id)).toEqual(["user_1", "assistant_1"])
    expect(await f.controller.search("two", "violet")).toEqual([])
    f.controller.dispose()
    const reopened = new GraphStore(join(f.directory, "graph.sqlite"))
    const controller = new GraphController(f.host, reopened, { now: () => 10_000 })
    controllers.push(controller)
    controller.event(terminal)
    expect((await controller.search("one", "violet"))[0].summary).toBe(extraction.summary)
    await f.settle()
    expect(f.calls).toHaveLength(1)
  })

  test("ignores synthetic-only, failed, interrupted, old and incomplete native executions", async () => {
    const f = await fixture()
    f.messages.set("one", [user("old-user"), assistant("old-assistant"), synthetic("goal"), assistant("goal-output")])
    f.event("execution.started")
    f.event("step.started", "one", { assistantMessageID: "goal-output", model })
    f.event("step.ended", "one", { assistantMessageID: "goal-output", finish: "stop" })
    f.event("execution.succeeded")
    for (const terminal of ["failed", "interrupted"]) {
      f.event("inbox.enqueued", "one", { inboxID: "old-user", item: { type: "user", payload: { text: "Use violet theme" }, delivery: "queue" } })
      f.event("execution.started")
      f.event("inbox.delivered", "one", { inboxID: "old-user" })
      f.event("step.started", "one", { assistantMessageID: "old-assistant", model })
      f.event("step.ended", "one", { assistantMessageID: "old-assistant", finish: "stop" })
      f.event(`execution.${terminal}`)
    }
    f.event("inbox.enqueued", "one", { inboxID: "old-user", item: { type: "user", payload: { text: "Use violet theme" }, delivery: "queue" } }, { created: 9_999 })
    f.event("execution.started")
    f.event("inbox.delivered", "one", { inboxID: "old-user" })
    f.event("step.started", "one", { assistantMessageID: "old-assistant", model })
    f.event("step.ended", "one", { assistantMessageID: "old-assistant", finish: "stop" })
    f.event("execution.succeeded")
    f.messages.set("one", [user("incomplete-user"), { ...assistant("incomplete-answer"), time: { created: 10_001 } }])
    f.event("inbox.enqueued", "one", { inboxID: "incomplete-user", item: { type: "user", payload: { text: "Use violet theme" }, delivery: "queue" } })
    f.event("execution.started")
    f.event("inbox.delivered", "one", { inboxID: "incomplete-user" })
    f.event("step.started", "one", { assistantMessageID: "incomplete-answer", model })
    f.event("step.ended", "one", { assistantMessageID: "incomplete-answer", finish: "stop" })
    f.event("execution.succeeded")
    await f.settle()
    expect(f.calls).toHaveLength(0)
    expect(f.store.status("one")).toMatchObject({ ready: 0, pending: 0, failed: 0 })
  })

  test("handles inbox delivery before start and multiple real turns without synthetic output", async () => {
    const f = await fixture()
    f.messages.set("one", [user("u1"), assistant("a1"), user("u2"), assistant("a2"), synthetic("goal"), assistant("goal-a")])
    for (const id of ["u1", "u2"]) {
      f.event("inbox.enqueued", "one", { inboxID: id, item: { type: "user", payload: { text: "Use violet theme" }, delivery: "queue" } })
      f.event("inbox.delivered", "one", { inboxID: id })
    }
    f.event("execution.started")
    for (const id of ["a1", "a2", "goal-a"]) {
      f.event("step.started", "one", { assistantMessageID: id, model })
      f.event("step.ended", "one", { assistantMessageID: id, finish: "stop" })
    }
    f.event("execution.succeeded")
    await f.until(() => f.store.status("one").ready === 2)
    expect(f.calls).toHaveLength(2)
    expect(f.calls.every(call => !call.prompt.includes("goal-a"))).toBe(true)
  })

  test("accepts native execution events without locations only after a bound prompt or inbox observation", async () => {
    const f = await fixture()
    f.messages.set("one", [user("u"), assistant("a")])
    f.event("execution.started", "unobserved", {}, { location: undefined })
    f.event("execution.succeeded", "unobserved", {}, { location: undefined })
    f.event("inbox.enqueued", "one", { inboxID: "u", item: { type: "user", payload: { text: "Use violet theme" }, delivery: "queue" } })
    f.event("execution.started", "one", {}, { location: undefined })
    f.event("inbox.delivered", "one", { inboxID: "u" })
    f.event("step.started", "one", { assistantMessageID: "a", model })
    f.event("step.ended", "one", { assistantMessageID: "a", finish: "stop" })
    f.event("execution.succeeded", "one", {}, { location: undefined })
    await f.until(() => f.store.status("one").ready === 1)
    expect(f.calls).toHaveLength(1)
    expect(f.store.status("unobserved").initialized).toBe(false)
  })

  test("preserves consecutive delivered real user messages answered by one native assistant", async () => {
    const f = await fixture()
    f.messages.set("one", [user("queued-first"), user("queued-second", "Keep original spacing"), assistant("answer")])
    for (const id of ["queued-first", "queued-second"]) {
      f.event("inbox.enqueued", "one", { inboxID: id, item: { type: "user", payload: { text: id }, delivery: "steer" } })
    }
    f.event("execution.started", "one", {}, { location: undefined })
    for (const id of ["queued-first", "queued-second"]) f.event("inbox.delivered", "one", { inboxID: id })
    f.event("step.started", "one", { assistantMessageID: "answer", model })
    f.event("step.ended", "one", { assistantMessageID: "answer", finish: "stop" })
    f.event("execution.succeeded", "one", {}, { location: undefined })
    await f.until(() => f.store.status("one").ready === 1)
    expect(f.calls).toHaveLength(1)
    const result = await f.controller.search("one", "spacing")
    expect(result[0].sources.map(item => [item.id, item.role])).toEqual([
      ["queued-first", "user"], ["queued-second", "user"], ["answer", "assistant"],
    ])
  })

  test("retains old graph records through native compaction without extracting hidden sources", async () => {
    const f = await fixture()
    f.complete()
    await f.until(() => f.store.status("one").ready === 1)
    f.messages.set("one", [{ type: "compaction", id: "compact", status: "completed", summary: "compressed", time: { created: 11_000 } } as SessionMessageInfo])
    f.event("execution.started")
    f.event("execution.succeeded")
    expect((await f.controller.search("one", "violet"))).toHaveLength(1)
    expect(await f.controller.recall("one")).toEqual([])
    expect(f.calls).toHaveLength(1)
  })

  test("clear, delete, revert and disposal fence late generation without releasing its slot", async () => {
    for (const action of ["clear", "delete", "revert", "dispose"] as const) {
      const f = await fixture()
      const held = deferred<{ text: string }>()
      releases.push(() => held.resolve(reply))
      f.setGenerate(() => held.promise)
      f.complete(action)
      await f.until(() => f.calls.length === 1)
      if (action === "clear") f.controller.clear("one")
      if (action === "delete") f.event("deleted")
      if (action === "revert") f.event("revert.committed", "one", { to: `user_${action}` })
      if (action === "dispose") f.controller.dispose()
      const reopened = new GraphStore(join(f.directory, "graph.sqlite"))
      expect(reopened.status("one").ready).toBe(0)
      held.resolve(reply)
      await f.settle()
      expect(reopened.status("one").ready).toBe(0)
      expect(reopened.status("one").pending).toBe(0)
      reopened.dispose()
    }
  })

  test("times out truthfully, keeps one native request in flight, then explicitly retries", async () => {
    const f = await fixture({ timeoutMs: 15 })
    const held = deferred<{ text: string }>()
    releases.push(() => held.resolve(reply))
    f.setGenerate(() => held.promise)
    f.complete("slow")
    await f.until(() => f.calls.length === 1)
    f.complete("queued", "two")
    await f.until(() => f.store.status("one").failed === 1)
    expect(f.calls).toHaveLength(1)
    expect(await f.controller.status("one")).toMatchObject({ failed: 1, generating: false, waitingForNativeCall: true })
    expect(await f.controller.status("two")).toMatchObject({ pending: 1, queued: 1 })
    f.setGenerate(async () => reply)
    held.resolve(reply)
    await f.until(() => f.store.status("two").ready === 1)
    expect(f.store.status("one").ready).toBe(0)
    await f.controller.retry("one")
    await f.until(() => f.store.status("one").ready === 1)
    expect(f.calls).toHaveLength(3)
  })

  test("bounded queue rejects excess work with inspectable failure and validates malformed results", async () => {
    const f = await fixture({ maxPending: 1 })
    const held = deferred<{ text: string }>()
    releases.push(() => held.resolve({ text: "not JSON" }))
    f.setGenerate(() => held.promise)
    f.complete("active")
    await f.until(() => f.calls.length === 1)
    f.complete("excess", "two")
    await f.until(() => f.store.status("two").failed === 1)
    expect(f.store.status("two").lastError).toContain("queue")
    held.resolve({ text: "not JSON" })
    await f.until(() => f.store.status("one").failed === 1)
    expect(f.store.status("one").ready).toBe(0)
    expect(f.store.status("one").lastError).toContain("structured")
    expect(f.calls).toHaveLength(1)
  })

  test("a second controller does not reset another instance's pending jobs on open or disposal", async () => {
    const f = await fixture()
    const held = deferred<{ text: string }>()
    releases.push(() => held.resolve(reply))
    f.setGenerate(() => held.promise)
    f.complete()
    await f.until(() => f.calls.length === 1)
    const second = new GraphController(f.host, new GraphStore(join(f.directory, "graph.sqlite")))
    controllers.push(second)
    expect(await second.status("one")).toMatchObject({ pending: 1, failed: 0 })
    second.dispose()
    expect(f.store.status("one")).toMatchObject({ pending: 1, failed: 0 })
    held.resolve(reply)
    await f.until(() => f.store.status("one").ready === 1)
  })

  test("overlapping capture reads retain distinct turns while another instance's clear rejects stale capture", async () => {
    const f = await fixture()
    const snapshots = deferred<SessionMessageInfo[]>()
    releases.push(() => snapshots.resolve([]))
    let reads = 0
    f.setContext(async () => { reads++; return snapshots.promise })
    f.complete("first"); f.complete("second")
    await f.until(() => reads === 2)
    snapshots.resolve(f.messages.get("one")!)
    await f.until(() => f.store.status("one").ready === 2)
    expect(f.calls).toHaveLength(2)
    const stale = deferred<SessionMessageInfo[]>()
    releases.push(() => stale.resolve([]))
    f.setContext(async () => { reads++; return stale.promise })
    f.complete("stale")
    await f.until(() => reads === 3)
    const other = new GraphStore(join(f.directory, "graph.sqlite"))
    other.clear("one")
    stale.resolve(f.messages.get("one")!)
    await f.settle()
    expect(other.status("one")).toMatchObject({ ready: 0, pending: 0, generation: 1 })
    expect(f.calls).toHaveLength(2)
    other.dispose()
  })

  test("another instance's clear during native execution prevents its old turn from being recaptured", async () => {
    const f = await fixture()
    f.messages.set("one", [user("u"), assistant("a")])
    f.event("inbox.enqueued", "one", { inboxID: "u", item: { type: "user", payload: { text: "Use violet theme" }, delivery: "queue" } })
    f.event("execution.started")
    f.event("inbox.delivered", "one", { inboxID: "u" })
    f.event("step.started", "one", { assistantMessageID: "a", model })
    const other = new GraphStore(join(f.directory, "graph.sqlite"))
    other.clear("one")
    f.event("step.ended", "one", { assistantMessageID: "a", finish: "stop" })
    f.event("execution.succeeded")
    await f.settle()
    expect(f.calls).toHaveLength(0)
    expect(other.status("one")).toMatchObject({ generation: 1, ready: 0, pending: 0 })
    other.dispose()
  })

  test("retry requires every original source ID, role, visible text and order, including intermediate answers", async () => {
    const f = await fixture()
    const turn: GraphTurn = { createdAt: 10_000, sources: [
      { id: "u", role: "user", text: "Use violet theme" },
      { id: "a1", role: "assistant", text: "First visible answer" },
      { id: "a2", role: "assistant", text: "Enabled violet theme" },
    ] }
    const ticket = f.store.schedule("one", turn)!
    f.store.fail(ticket, "Graph extraction returned invalid JSON")
    const variants = [
      [assistant("a1", "First visible answer"), assistant("a2")],
      [user("u", "EDITED"), assistant("a1", "First visible answer"), assistant("a2")],
      [user("u"), assistant("a2")],
      [user("u"), assistant("a1", "CHANGED"), assistant("a2")],
      [user("u"), assistant("a2"), assistant("a1", "First visible answer")],
      [user("u"), synthetic("continuation"), assistant("a1", "First visible answer"), assistant("a2")],
    ]
    for (const messages of variants) {
      f.messages.set("one", messages)
      await f.controller.retry("one")
      expect(f.store.status("one")).toMatchObject({ ready: 0, pending: 0, failed: 1 })
    }
    expect(f.calls).toHaveLength(0)
    f.messages.set("one", [user("u"), assistant("a1", "First visible answer"), assistant("a2")])
    await f.controller.retry("one")
    await f.until(() => f.store.status("one").ready === 1)
    expect(f.calls).toHaveLength(1)
  })

  test("native scope validation blocks foreign sessions before reading sources or changing records", async () => {
    const f = await fixture()
    f.addSession("foreign", { projectID: "another-project" })
    f.addSession("remote", { location: { directory: "/different-host-directory" } })
    for (const id of ["foreign", "remote"]) {
      await expect(f.controller.status(id)).rejects.toThrow("outside")
      await expect(f.controller.search(id, "violet")).rejects.toThrow("outside")
      await expect(f.controller.retry(id)).rejects.toThrow("outside")
      f.complete(id, id)
    }
    await f.settle()
    expect(f.calls).toHaveLength(0)
    expect(f.store.status("foreign").initialized).toBe(false)
    expect(f.store.status("remote").initialized).toBe(false)
    f.event("revert.committed", "foreign", { to: "user_foreign" }, { location: undefined })
    f.event("deleted", "foreign", {}, { location: undefined })
    expect(f.store.status("foreign").initialized).toBe(false)
    f.event("deleted", "unknown", {}, { location: { directory: "/foreign" } })
    expect(f.store.status("unknown").initialized).toBe(false)
  })

  test("fork inheritance verifies native boundary and sources; unrelated subtask parents inherit nothing", async () => {
    const f = await fixture()
    seed(f.store, "one", "first", "first violet")
    seed(f.store, "one", "second", "second violet")
    f.messages.set("one", [user("user_first"), assistant("assistant_first"), user("user_second"), assistant("assistant_second")])
    f.addSession("child", { fork: { sessionID: "one", boundary: { type: "before", messageID: "user_second" } } })
    f.messages.set("child", [user("child_user_first"), assistant("child_assistant_first")])
    const inherited = await f.controller.search("child", "violet")
    expect(inherited.map(result => result.summary)).toEqual(["first violet"])
    expect(inherited[0].sources.map(item => item.id)).toEqual(["child_user_first", "child_assistant_first"])
    f.addSession("subtask", { parentID: "one" })
    f.messages.set("subtask", f.messages.get("one")!)
    expect(await f.controller.search("subtask", "violet")).toEqual([])
    f.addSession("hidden", { fork: { sessionID: "one", boundary: { type: "before", messageID: "missing-after-compaction" } } })
    f.messages.set("hidden", f.messages.get("one")!)
    expect(await f.controller.search("hidden", "violet")).toEqual([])
  })

  test("fork remapping rejects changed sequence, timestamp, content and native assistant metadata", async () => {
    const f = await fixture()
    seed(f.store, "one", "first", "first violet")
    const original = [user("user_first"), assistant("assistant_first")]
    f.messages.set("one", original)
    const variants: SessionMessageInfo[][] = [
      [original[1], original[0]],
      [{ ...original[0], time: { created: 10_001 } }, original[1]],
      [user("different-user", "CHANGED"), original[1]],
      [original[0], { ...original[1], model: { id: "different-model", providerID: "local" } } as SessionMessageInfo],
      [original[0]],
    ]
    for (let index = 0; index < variants.length; index++) {
      const id = `mismatch-${index}`
      f.addSession(id, { fork: { sessionID: "one", boundary: { type: "through", messageID: "assistant_first" } } })
      f.messages.set(id, variants[index])
      expect(await f.controller.search(id, "violet")).toEqual([])
    }
    // given identical text in two native turns with distinct creation times
    const secondUser = { ...user("user_second"), time: { created: 20_000 } }
    const secondAssistant = { ...assistant("assistant_second"), time: { created: 20_001, completed: 20_002 } }
    f.messages.set("one", [...original, secondUser, secondAssistant])
    f.addSession("wrong-identical-prefix", { fork: { sessionID: "one", boundary: { type: "through", messageID: "assistant_first" } } })
    f.messages.set("wrong-identical-prefix", [secondUser, secondAssistant])
    expect(await f.controller.search("wrong-identical-prefix", "violet")).toEqual([])
  })

  test("clear during fork lookup fences capture and unavailable parent does not block the child's new facts", async () => {
    const f = await fixture()
    const parentRead = deferred<SessionMessageInfo[]>()
    releases.push(() => parentRead.resolve([]))
    f.addSession("child", { fork: { sessionID: "one", boundary: { type: "before", messageID: "boundary" } } })
    let parentReads = 0
    f.setContext(async id => {
      if (id === "one") { parentReads++; return parentRead.promise }
      return f.messages.get(id) ?? []
    })
    f.complete("fork-new", "child")
    await f.until(() => parentReads === 1)
    f.controller.clear("child")
    parentRead.resolve([])
    await f.settle()
    expect(f.calls).toHaveLength(0)
    expect(f.store.status("child")).toMatchObject({ ready: 0, pending: 0 })
    f.addSession("orphan", { fork: { sessionID: "missing-parent", boundary: { type: "through", messageID: "old" } } })
    f.complete("orphan-new", "orphan")
    await f.until(() => f.store.status("orphan").ready === 1)
    expect((await f.controller.search("orphan", "violet"))[0].sources[0].id).toBe("user_orphan-new")
  })
})
