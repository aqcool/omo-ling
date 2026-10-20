import type { ModelRef, OpenCodeEvent, SessionInfo, SessionMessageInfo } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { buildGraphExtractionPrompt, parseGraphExtraction } from "./graph-extract"
import { GraphStore } from "./graph-store"
import { GRAPH_LIMITS, graphFailureReason, validateSessionID, type GraphStatus, type GraphTicket, type GraphTurn, type Source } from "./graph-types"

type Host = Pick<Plugin.Context, "session" | "generate" | "location">
type Run = { users: Set<string>; assistants: Set<string>; ended: Set<string>; generation: number }
type Tracking = { observed: Set<string>; delivered: Set<string>; run?: Run; seq: number; version: number }
type Job = { owner: GraphController; ticket: GraphTicket; turn: GraphTurn; model: ModelRef; valid: boolean }
export type GraphRuntimeStatus = GraphStatus & {
  enabled: true
  available: boolean
  queued: number
  generating: boolean
  waitingForNativeCall: boolean
}

// The SDK does not propagate AbortSignal to generate.text. Even after a timeout or
// disposal, keep this slot occupied until the actual native request settles.
const queue: Job[] = []
let active: Job | undefined
let captures = 0
function pump() {
  if (active) return
  const job = queue.shift()
  if (!job) return
  active = job
  void job.owner.generate(job).finally(() => { active = undefined; pump() })
}
function canonical(directory: string) {
  try { return realpathSync(directory) } catch { return resolve(directory) }
}
function source(message: SessionMessageInfo): Source | undefined {
  const text = message.type === "user" ? message.text : message.type === "assistant"
    ? message.content.filter(part => part.type === "text").map(part => part.text).join("\n") : ""
  if (!text.trim() || (message.type !== "user" && message.type !== "assistant")) return
  return { id: message.id, role: message.type, text }
}
function sameTicket(left: GraphTicket, right: GraphTicket) {
  return left.key === right.key && left.digest === right.digest && left.epoch === right.epoch
}

export class GraphController {
  private readonly tracking = new Map<string, Tracking>()
  private readonly errors = new Map<string, string>()
  private disposed = false
  private subscriptionError?: string
  private readonly born: number
  readonly timeoutMs: number
  readonly maxPending: number

  constructor(readonly host: Host, readonly store: GraphStore, options: { timeoutMs?: number; maxPending?: number; now?: () => number } = {}) {
    this.born = (options.now ?? Date.now)()
    this.timeoutMs = Math.max(1, Math.min(120_000, options.timeoutMs ?? 30_000))
    this.maxPending = Math.max(1, Math.min(GRAPH_LIMITS.pending, options.maxPending ?? GRAPH_LIMITS.pending))
  }

  private state(sessionID: string) {
    let state = this.tracking.get(sessionID)
    if (!state) {
      if (this.tracking.size >= 1_024) throw new Error("Graph tracking capacity exceeded")
      state = { observed: new Set(), delivered: new Set(), seq: 0, version: 0 }
      this.tracking.set(sessionID, state)
    }
    return state
  }
  noteError(sessionID: string, error: unknown) {
    if (this.errors.size >= 1_024 && !this.errors.has(sessionID)) this.errors.delete(this.errors.keys().next().value!)
    this.errors.set(sessionID, graphFailureReason(error))
  }
  subscriptionFailed() {
    this.subscriptionError = "Native session event subscription stopped; automatic graph extraction is unavailable"
  }
  async assertSessionScope(sessionID: string): Promise<SessionInfo> {
    validateSessionID(sessionID)
    const info = await this.host.session.get({ sessionID })
    if (info.id !== sessionID || info.projectID !== this.host.location.project.id
      || canonical(info.location.directory) !== canonical(this.host.location.directory)) {
      throw new Error("Graph memory session is outside the current host location and project")
    }
    return info
  }
  private matchesLocation(event: OpenCodeEvent, sessionID: string) {
    if (event.location) return canonical(event.location.directory) === canonical(this.host.location.directory)
      && ("workspaceID" in event.location ? event.location.workspaceID : undefined) === this.host.location.workspaceID
    // Native 2.0.32 execution events omit location. Only a prompt hook or an
    // earlier location-bound event may establish tracking; capture still checks
    // session.get's current project/location before reading any source text.
    if (this.tracking.has(sessionID)) return true
    return (event.type === "session.deleted" || event.type === "session.revert.staged" || event.type === "session.revert.committed")
      && this.store.status(sessionID).initialized
  }
  observePrompt(sessionID: string, messageID: string) {
    if (this.disposed) return
    try {
      const state = this.state(sessionID)
      if (state.observed.size >= 64) throw new Error("Graph prompt tracking capacity exceeded")
      state.observed.add(messageID)
    } catch (error) { this.noteError(sessionID, error) }
  }

  /** Only native events observed since this controller loaded can create work. */
  event(event: OpenCodeEvent) {
    if (this.disposed || !("created" in event) || event.created < this.born
      || !("sessionID" in event.data) || typeof event.data.sessionID !== "string") return
    const sessionID = event.data.sessionID
    try {
      if (!this.matchesLocation(event, sessionID)) return
      if (event.type === "session.deleted") {
        // A deleted native session cannot be fetched. Do not create tombstones for
        // unrelated IDs from the host-wide event stream.
        if (this.store.status(sessionID).initialized) this.delete(sessionID)
        else this.invalidate(sessionID, "Graph extraction cancelled by session deletion")
        return
      }
      const state = this.state(sessionID)
      if ("durable" in event) {
        if (event.durable.seq <= state.seq) return
        state.seq = event.durable.seq
      }
      if (event.type === "session.inbox.enqueued" && event.data.item.type === "user") {
        this.observePrompt(sessionID, event.data.inboxID)
      } else if (event.type === "session.inbox.cancelled") {
        state.observed.delete(event.data.inboxID); state.delivered.delete(event.data.inboxID)
      } else if (event.type === "session.inbox.delivered" && state.observed.delete(event.data.inboxID)) {
        const delivered = state.run?.users ?? state.delivered
        if (delivered.size >= 64) throw new Error("Graph prompt tracking capacity exceeded")
        delivered.add(event.data.inboxID)
      } else if (event.type === "session.execution.started") {
        state.run = { users: state.delivered, assistants: new Set(), ended: new Set(), generation: this.store.status(sessionID).generation }
        state.delivered = new Set()
      } else if (event.type === "session.step.started") {
        if (state.run && state.run.assistants.size < 128) state.run.assistants.add(event.data.assistantMessageID)
      } else if (event.type === "session.step.ended") {
        if (state.run?.assistants.has(event.data.assistantMessageID)) state.run.ended.add(event.data.assistantMessageID)
      } else if (event.type === "session.revert.staged" || event.type === "session.revert.committed") {
        // Reverting changes source visibility. Clearing is conservative and also
        // fences requests whose sources were visible before the native edit.
        if (this.store.status(sessionID).initialized) this.clear(sessionID)
        else this.invalidate(sessionID, "Graph extraction cancelled by native revert")
      } else if (event.type === "session.execution.succeeded" || event.type === "session.execution.failed"
        || event.type === "session.execution.interrupted") {
        const run = state.run
        state.run = undefined
        if (event.type === "session.execution.succeeded" && run?.users.size && run.ended.size) {
          const version = state.version
          if (captures >= GRAPH_LIMITS.pending) { this.noteError(sessionID, "Graph queue capacity exceeded"); return }
          captures++
          return this.capture(sessionID, run, version).catch(error => this.noteError(sessionID, error)).finally(() => { captures-- })
        }
      }
    } catch (error) { this.noteError(sessionID, error) }
  }

  private async initializeFork(sessionID: string, info: SessionInfo, messages: SessionMessageInfo[]) {
    const status = this.store.status(sessionID)
    if (!info.fork || status.initialized) return status.generation
    let parentMessages: SessionMessageInfo[] = []
    try {
      const parent = await this.assertSessionScope(info.fork.sessionID)
      parentMessages = await this.host.session.context({ sessionID: parent.id })
    } catch (error) { this.noteError(sessionID, "Graph fork source unavailable") }
    if (this.disposed || this.store.status(sessionID).generation !== status.generation) return undefined
    const boundary = parentMessages.findIndex(message => message.id === info.fork!.boundary.messageID)
    const visible: Source[] = []
    const sourceIDs = new Map<string, string>()
    if (boundary >= 0) {
      const prefix = parentMessages.slice(0, boundary + (info.fork.boundary.type === "through" ? 1 : 0))
      // OpenCode rewrites every message ID when it forks. The native fork edge
      // and boundary identify the exact parent prefix; compare every position,
      // including control messages and empty assistant messages, before remapping.
      const matches = messages.length >= prefix.length && prefix.every((message, index) => {
        const { id: _parentID, ...parentPayload } = message
        const { id: _childID, ...childPayload } = messages[index]
        return isDeepStrictEqual(parentPayload, childPayload)
      })
      if (matches) {
        prefix.forEach((message, index) => {
          const item = source(message)
          if (item && Buffer.byteLength(item.text, "utf8") <= GRAPH_LIMITS.sourceBytes) {
            visible.push(item); sourceIDs.set(message.id, messages[index].id)
          }
        })
      } else {
        this.noteError(sessionID, "Graph fork source unavailable")
      }
    }
    // Active context can omit old raw messages after compaction. Missing source
    // IDs never justify copying facts from the parent's later history.
    this.store.inherit(sessionID, info.fork.sessionID, visible, sourceIDs)
    return this.store.status(sessionID).generation
  }

  private async capture(sessionID: string, run: Run, version: number) {
    const generation = run.generation
    if (this.store.status(sessionID).generation !== generation) return
    const info = await this.assertSessionScope(sessionID)
    const messages = await this.host.session.context({ sessionID })
    if (this.disposed || this.state(sessionID).version !== version || this.store.status(sessionID).generation !== generation) return
    const initializedGeneration = await this.initializeFork(sessionID, info, messages)
    if (this.disposed || this.state(sessionID).version !== version || initializedGeneration === undefined
      || this.store.status(sessionID).generation !== initializedGeneration) return
    let turn: GraphTurn | undefined, model: ModelRef | undefined
    const submit = () => {
      if (turn && model && turn.sources.length > 1) this.schedule(sessionID, turn, model)
    }
    for (const message of messages) {
      if (message.type === "user") {
        const user = source(message)
        if (run.users.has(message.id) && user && turn && !model) turn.sources.push(user)
        else {
          submit(); turn = undefined; model = undefined
          if (run.users.has(message.id) && user) turn = { sources: [user], createdAt: message.time.created }
        }
      } else if (message.type === "synthetic" || message.type === "compaction") {
        submit(); turn = undefined; model = undefined
      } else if (message.type === "assistant" && turn && run.ended.has(message.id)
        && message.time.completed !== undefined && !message.error) {
        const assistant = source(message)
        if (assistant) { turn.sources.push(assistant); model = message.model }
      }
    }
    submit()
  }

  private schedule(sessionID: string, turn: GraphTurn, model: ModelRef) {
    try {
      const ticket = this.store.schedule(sessionID, turn)
      if (ticket) this.enqueue({ owner: this, ticket, turn, model, valid: true })
    } catch (error) { this.noteError(sessionID, error) }
  }
  private enqueue(job: Job) {
    if (queue.length + (active ? 1 : 0) >= this.maxPending) {
      this.store.fail(job.ticket, "Graph queue capacity exceeded")
      return
    }
    queue.push(job); pump()
  }
  private fail(job: Job, reason: unknown) {
    job.valid = false
    try { this.store.fail(job.ticket, reason) } catch (error) { this.noteError(job.ticket.sessionID, error) }
  }
  async generate(job: Job) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (this.disposed || !job.valid || !this.store.pending(job.ticket.sessionID).some(work => sameTicket(work.ticket, job.ticket))) return
      timer = setTimeout(() => this.fail(job, "Graph extraction timed out; native request is still settling"), this.timeoutMs)
      const result = await this.host.generate.text({ prompt: buildGraphExtractionPrompt(job.turn), model: job.model })
      if (!this.disposed && job.valid) {
        this.store.complete(job.ticket, parseGraphExtraction(result.text))
        this.errors.delete(job.ticket.sessionID)
      }
    } catch (error) {
      if (!this.disposed && job.valid) this.fail(job, error)
    } finally { if (timer) clearTimeout(timer) }
  }
  async status(sessionID: string): Promise<GraphRuntimeStatus> {
    await this.assertSessionScope(sessionID)
    let status: GraphStatus, available = true
    try { status = this.store.status(sessionID) } catch (error) {
      available = false; this.noteError(sessionID, "Graph storage unavailable")
      status = { initialized: false, deleted: false, epoch: 0, generation: 0, ready: 0, pending: 0, failed: 0 }
    }
    return { ...status, ...(this.errors.has(sessionID) ? { lastError: this.errors.get(sessionID) } : {}),
      ...(this.subscriptionError ? { lastError: this.subscriptionError } : {}),
      enabled: true, available: available && !this.subscriptionError, queued: queue.filter(job => job.owner === this && job.ticket.sessionID === sessionID).length,
      generating: active?.owner === this && active.ticket.sessionID === sessionID && active.valid,
      waitingForNativeCall: active?.owner === this && active.ticket.sessionID === sessionID && !active.valid }
  }
  async search(sessionID: string, query: string, maxChars = GRAPH_LIMITS.outputBytes) {
    const info = await this.assertSessionScope(sessionID)
    if (!this.store.status(sessionID).initialized && info.fork) {
      await this.initializeFork(sessionID, info, await this.host.session.context({ sessionID }))
    }
    return this.store.search(sessionID, query, { limit: GRAPH_LIMITS.results, maxChars })
  }
  async recall(sessionID: string) {
    await this.assertSessionScope(sessionID)
    const messages = await this.host.session.context({ sessionID })
    const query = messages.findLast(message => message.type === "user")?.text
    if (!query?.trim()) return []
    return this.search(sessionID, query.slice(0, GRAPH_LIMITS.queryChars), GRAPH_LIMITS.outputBytes - 700)
  }
  private invalidate(sessionID: string, reason: string) {
    const state = this.tracking.get(sessionID)
    if (state) { state.version++; state.run = undefined; state.delivered.clear(); state.observed.clear() }
    for (let index = queue.length - 1; index >= 0; index--) {
      const job = queue[index]
      if (job.owner === this && job.ticket.sessionID === sessionID) { this.fail(job, reason); queue.splice(index, 1) }
    }
    if (active?.owner === this && active.ticket.sessionID === sessionID) this.fail(active, reason)
  }
  clear(sessionID: string) {
    this.invalidate(sessionID, "Graph extraction cancelled by clear")
    this.store.clear(sessionID); this.errors.delete(sessionID)
  }
  private delete(sessionID: string) {
    this.invalidate(sessionID, "Graph extraction cancelled by session deletion")
    this.store.delete(sessionID); this.errors.delete(sessionID); this.tracking.delete(sessionID)
  }
  async retry(sessionID: string) {
    await this.assertSessionScope(sessionID)
    const messages = await this.host.session.context({ sessionID })
    for (const work of this.store.retry(sessionID)) {
      let previous = -1
      const visible = work.turn.sources.every(expected => {
        const index = messages.findIndex(message => message.id === expected.id)
        const actual = index < 0 ? undefined : source(messages[index])
        if (!actual || actual.role !== expected.role || actual.text !== expected.text || index <= previous) return false
        if (previous >= 0 && messages.slice(previous + 1, index).some(message =>
          message.type === "user" || message.type === "synthetic" || message.type === "compaction")) return false
        previous = index
        return true
      })
      const assistant = messages[previous]
      if (!visible || assistant?.type !== "assistant" || assistant.time.completed === undefined || assistant.error) {
        this.store.fail(work.ticket, "Graph native source unavailable"); continue
      }
      this.enqueue({ owner: this, ...work, model: assistant.model, valid: true })
    }
    return this.status(sessionID)
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const sessionID of this.tracking.keys()) this.invalidate(sessionID, "Graph runtime stopped")
    for (let index = queue.length - 1; index >= 0; index--) {
      const job = queue[index]
      if (job.owner === this) { this.fail(job, "Graph runtime stopped"); queue.splice(index, 1) }
    }
    if (active?.owner === this) this.fail(active, "Graph runtime stopped")
    this.store.dispose()
  }
}
