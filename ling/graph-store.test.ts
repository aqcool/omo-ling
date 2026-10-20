import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GraphStore, GraphStorageError } from "./graph-store"
import { GRAPH_LIMITS, GraphValidationError, type Extraction, type GraphTurn, type Source } from "./graph-types"

const directories: string[] = []
const stores: GraphStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "omo-ling-graph-test-"))
  directories.push(directory)
  let now = 1_000
  const open = (path = join(directory, "profile-a", "project-a", "graph.sqlite")) => {
    const store = new GraphStore(path, { now: () => now })
    stores.push(store)
    return store
  }
  return { directory, store: open(), open, setNow: (value: number) => { now = value } }
}
function turn(id = "one", user = "Configure Orchard", assistant = "Orchard now connects to Alpine"): GraphTurn {
  return { createdAt: 100, sources: [{ id: `${id}-u`, role: "user", text: user }, { id: `${id}-a`, role: "assistant", text: assistant }] }
}
function extracted(summary = "Orchard connects to Alpine", subject = "Orchard", object = "Alpine"): Extraction {
  return { summary, outcome: "completed", triples: [{ subject, predicate: "connects to", object }] }
}
function ready(store: GraphStore, session = "ses_a", input = turn(), output = extracted()) {
  const ticket = store.schedule(session, input)
  expect(ticket).toBeDefined()
  expect(store.complete(ticket!, output)).toBe(true)
  return ticket!
}

describe("session-scoped graph SQLite store", () => {
  test("opens lazily with private permissions and isolates native sessions, profiles and projects", () => {
    // given
    const { directory, store, open } = fixture()
    expect(existsSync(store.path)).toBe(false)
    expect(store.status("ses_a").initialized).toBe(false)
    // when
    ready(store)
    const project = open(join(directory, "profile-a", "project-b", "graph.sqlite"))
    const profile = open(join(directory, "profile-b", "project-a", "graph.sqlite"))
    // then
    expect(store.search("ses_a", "Orchard")[0].sources.map(source => source.id)).toEqual(["one-u", "one-a"])
    expect(store.search("ses_b", "Orchard")).toEqual([])
    expect(project.search("ses_a", "Orchard")).toEqual([])
    expect(profile.search("ses_a", "Orchard")).toEqual([])
    expect(statSync(store.path).mode & 0o777).toBe(0o600)
    expect(statSync(join(directory, "profile-a", "project-a")).mode & 0o777).toBe(0o700)
    expect(statSync(store.path + "-wal").mode & 0o777).toBe(0o600)
  })

  test("deduplicates replay across connections and persists ready records across reopen", () => {
    // given
    const { store, open } = fixture()
    const ticket = store.schedule("ses_a", turn())!
    const second = open()
    // when
    expect(second.schedule("ses_a", { ...turn(), createdAt: 999 })).toBeUndefined()
    expect(second.status("ses_a").pending).toBe(1)
    expect(second.retry("ses_a")).toEqual([])
    expect(store.complete(ticket, extracted())).toBe(true)
    expect(store.complete(ticket, extracted())).toBe(false)
    store.dispose()
    // then
    const reopened = open()
    expect(reopened.status("ses_a")).toMatchObject({ ready: 1, pending: 0, failed: 0 })
    expect(reopened.schedule("ses_a", turn())).toBeUndefined()
    const hit = reopened.search("ses_a", "Orchard")[0]
    expect(hit.sources).toEqual(turn().sources)
    expect(hit.summary).toBe(extracted().summary)
  })

  test("replaces changed text at the same source IDs and fences the old attempt", () => {
    // given
    const { store } = fixture()
    const old = store.schedule("ses_a", turn())!
    const changed = turn("one", "Configure Willow", "Willow uses Birch")
    // when
    const next = store.schedule("ses_a", changed)!
    expect(next.key).toBe(old.key)
    expect(next.digest).not.toBe(old.digest)
    expect(next.epoch).toBeGreaterThan(old.epoch)
    expect(store.complete(old, extracted())).toBe(false)
    expect(store.complete(next, extracted("Willow uses Birch", "Willow", "Birch"))).toBe(true)
    // then
    expect(store.search("ses_a", "Orchard")).toEqual([])
    expect(store.search("ses_a", "Willow")[0].sources).toEqual(changed.sources)
    const replacedReady = store.schedule("ses_a", turn())!
    expect(store.search("ses_a", "Willow")).toEqual([])
    expect(store.complete(replacedReady, extracted())).toBe(true)
    expect(store.status("ses_a").ready).toBe(1)
  })

  test("validates every storage boundary and does not accept cross-session completion", () => {
    // given
    const { store } = fixture()
    const ticket = store.schedule("ses_a", turn())!
    // when / then
    expect(() => store.schedule("ses_a", { ...turn(), sources: [...turn().sources, turn().sources[1]] })).toThrow(GraphValidationError)
    expect(() => store.schedule("ses_a", turn("large", "中".repeat(11_000)))).toThrow(GraphValidationError)
    expect(() => store.complete(ticket, { ...extracted(), extra: true } as Extraction)).toThrow(GraphValidationError)
    expect(() => store.complete(ticket, { ...extracted(), triples: Array(17).fill(extracted().triples[0]) })).toThrow(GraphValidationError)
    expect(() => store.status("")).toThrow(GraphValidationError)
    expect(() => store.clear(" ")).toThrow(GraphValidationError)
    expect(store.complete({ ...ticket, sessionID: "ses_b" }, extracted())).toBe(false)
    store.fail({ ...ticket, sessionID: "ses_b" }, "timeout")
    expect(store.status("ses_a")).toMatchObject({ pending: 1, ready: 0, failed: 0 })
    const work = store.pending("ses_a")
    work[0].turn.sources[0].text = "mutated caller object"
    expect(store.pending("ses_a")[0].turn.sources).toEqual(turn().sources)
  })

  test("persists sanitized failures and retries only explicitly with a new attempt fence", () => {
    // given
    const { store, open } = fixture()
    const old = store.schedule("ses_a", turn())!
    store.fail(old, new Error("provider timeout with api_key=PRIVATE_SECRET"))
    store.dispose()
    // when
    const reopened = open()
    expect(reopened.status("ses_a")).toMatchObject({ ready: 0, pending: 0, failed: 1 })
    expect(reopened.status("ses_a").lastError).not.toContain("PRIVATE_SECRET")
    expect(reopened.pending("ses_a")).toEqual([])
    expect(reopened.schedule("ses_a", turn())).toBeUndefined()
    const retried = reopened.retry("ses_a")
    // then
    expect(retried).toHaveLength(1)
    expect(retried[0].turn).toEqual(turn())
    expect(retried[0].ticket.epoch).toBeGreaterThan(old.epoch)
    expect(reopened.complete(old, extracted())).toBe(false)
    reopened.fail(old, "unavailable")
    expect(reopened.status("ses_a").pending).toBe(1)
    expect(reopened.complete(retried[0].ticket, extracted())).toBe(true)
  })

  test("does not steal another connection's live lease and reports an expired lease truthfully", () => {
    // given
    const { store, open, setNow } = fixture()
    const first = store.schedule("ses_a", turn())!
    const second = open()
    // when
    setNow(1_000 + GRAPH_LIMITS.leaseMs - 1)
    expect(second.status("ses_a")).toMatchObject({ pending: 1, failed: 0 })
    expect(second.retry("ses_a")).toEqual([])
    setNow(1_000 + GRAPH_LIMITS.leaseMs)
    // then
    expect(second.status("ses_a")).toMatchObject({ pending: 0, failed: 1 })
    expect(second.status("ses_a").lastError).toBeDefined()
    expect(store.complete(first, extracted())).toBe(false)
    expect(store.pending("ses_a")).toEqual([])
    const retry = second.retry("ses_a")[0]
    expect(store.complete(first, extracted())).toBe(false)
    expect(second.complete(retry.ticket, extracted())).toBe(true)
  })

  test("clear, delete and dispose reject late work and cannot repopulate through inheritance", () => {
    // given
    const { store, open } = fixture()
    ready(store, "parent")
    expect(store.inherit("child", "parent", turn().sources)).toBe(1)
    const pending = store.schedule("child", turn("new"))!
    // when
    store.clear("child")
    expect(store.complete(pending, extracted())).toBe(false)
    expect(store.inherit("child", "parent", turn().sources)).toBe(0)
    expect(store.status("child")).toMatchObject({ initialized: true, ready: 0 })
    const next = store.schedule("child", turn("new"))!
    expect(next.epoch).toBeGreaterThan(pending.epoch)
    expect(store.complete(pending, extracted())).toBe(false)
    expect(store.complete(next, extracted())).toBe(true)
    store.delete("child")
    // then
    expect(store.status("child")).toMatchObject({ deleted: true, ready: 0 })
    expect(store.schedule("child", turn())).toBeUndefined()
    expect(store.retry("child")).toEqual([])
    expect(store.inherit("child", "parent", turn().sources)).toBe(0)
    expect(open().status("child").deleted).toBe(true)
    const inFlight = store.schedule("parent", turn("disposed"))!
    store.dispose()
    expect(store.complete(inFlight, extracted())).toBe(false)
    expect(() => store.status("parent")).toThrow(GraphStorageError)
    expect(open().status("parent").pending).toBe(1)
  })

  test("keeps the session generation stable for independent jobs and advances it only for clear/delete", () => {
    // given
    const { store, open } = fixture()
    expect(store.status("ses_a")).toMatchObject({ epoch: 0, generation: 0 })
    const first = ready(store, "ses_a", turn("first"))
    const second = store.schedule("ses_a", turn("second"))!
    // when
    expect(second.epoch).toBeGreaterThan(first.epoch)
    expect(store.status("ses_a").generation).toBe(0)
    store.fail(second, "timeout")
    const retried = store.retry("ses_a")[0]
    expect(retried.ticket.epoch).toBeGreaterThan(second.epoch)
    expect(store.status("ses_a").generation).toBe(0)
    expect(store.inherit("child", "ses_a", turn("first").sources)).toBe(1)
    expect(store.status("child").generation).toBe(0)
    store.clear("ses_a")
    // then
    expect(store.status("ses_a").generation).toBe(1)
    expect(store.status("child").generation).toBe(0)
    expect(store.schedule("ses_a", turn("third"))).toBeDefined()
    expect(store.status("ses_a").generation).toBe(1)
    store.delete("ses_a")
    expect(open().status("ses_a").generation).toBe(2)
  })

  test("inherits only ready records whose complete ordered source evidence is visible", () => {
    // given
    const { store } = fixture()
    const first = turn("first")
    const later = turn("later", "The later-only secret", "Later secret answered")
    ready(store, "parent", first)
    ready(store, "parent", later, extracted("The later-only secret", "Later", "Secret"))
    store.schedule("parent", turn("pending"))
    // when
    expect(store.search("child", "Orchard")).toEqual([])
    expect(store.inherit("child", "parent", first.sources)).toBe(1)
    // then
    expect(store.search("child", "Orchard")[0].sources).toEqual(first.sources)
    expect(store.search("child", "later-only")).toEqual([])
    expect(store.pending("child")).toEqual([])
    expect(store.inherit("child", "parent", [...first.sources, ...later.sources])).toBe(0)
    expect(store.inherit("no-evidence", "parent", [])).toBe(0)
    expect(store.inherit("no-evidence", "parent", first.sources)).toBe(0)
    expect(store.inherit("missing-answer", "parent", first.sources.slice(0, 1))).toBe(0)
    expect(store.inherit("changed-text", "parent", [first.sources[0], { ...first.sources[1], text: "Edited answer" }])).toBe(0)
    expect(store.inherit("changed-role", "parent", [first.sources[0], { ...first.sources[1], role: "user" }])).toBe(0)
    expect(store.inherit("reordered", "parent", [...first.sources].reverse())).toBe(0)
    expect(() => store.inherit("duplicates", "parent", [...first.sources, first.sources[0]])).toThrow(GraphValidationError)
    expect(() => store.inherit("parent", "parent", first.sources)).toThrow(GraphValidationError)
  })

  test("retrieves lexical matches plus one graph hop with original source provenance", () => {
    // given
    const { store } = fixture()
    ready(store, "ses_a", turn("a"), extracted())
    ready(store, "ses_a", turn("b", "Record the second connection", "Connection recorded"), extracted("Alpine connects to Birch", "Alpine", "Birch"))
    ready(store, "ses_a", turn("c", "Record the third connection", "Third recorded"), extracted("Birch connects to Cedar", "Birch", "Cedar"))
    ready(store, "ses_b", turn("foreign", "Private foreign context", "Foreign answer"), extracted("Alpine connects to Secret", "Alpine", "Secret"))
    // when
    const results = store.search("ses_a", "Orchard", { limit: 8 })
    // then
    expect(results.map(result => result.sources[0].id)).toEqual(["a-u", "b-u"])
    expect(results.map(result => result.match)).toEqual(["lexical", "graph"])
    expect(results[1].triples).toEqual(extracted("Alpine connects to Birch", "Alpine", "Birch").triples)
    expect(results.every(result => result.sessionID === "ses_a")).toBe(true)
    expect(store.search("ses_a", "unrelated-nebula")).toEqual([])
    expect(store.search("ses_a", "%")).toEqual([])
    expect(store.status("ses_b").ready).toBe(1)
  })

  test("inherits verified native ID remaps into child and grandchild provenance", () => {
    // given
    const { store } = fixture()
    const parentTurn = turn("parent")
    ready(store, "parent", parentTurn)
    const childSources = parentTurn.sources.map(source => ({ ...source, id: "child-" + source.id }))
    const remap = new Map(parentTurn.sources.map((source, index) => [source.id, childSources[index].id]))
    // when
    expect(store.inherit("child", "parent", parentTurn.sources, remap)).toBe(1)
    const child = store.search("child", "Orchard")[0]
    // then
    expect(child.sources).toEqual(childSources)
    expect(child.key).not.toBe(store.search("parent", "Orchard")[0].key)
    expect(child.digest).not.toBe(store.search("parent", "Orchard")[0].digest)
    expect(store.schedule("child", { ...parentTurn, sources: childSources })).toBeUndefined()
    const grandchildSources = childSources.map(source => ({ ...source, id: "grandchild-" + source.id }))
    const nextMap = new Map(childSources.map((source, index) => [source.id, grandchildSources[index].id]))
    expect(store.inherit("grandchild", "child", childSources, nextMap)).toBe(1)
    expect(store.search("grandchild", "Orchard")[0].sources).toEqual(grandchildSources)
    expect(store.inherit("missing-map", "parent", parentTurn.sources, new Map([[parentTurn.sources[0].id, "child-u"]]))).toBe(0)
    for (const invalid of [
      new Map(parentTurn.sources.map(source => [source.id, "same-child-id"])),
      new Map([[parentTurn.sources[0].id, " "]]),
      new Map([[parentTurn.sources[0].id, "x".repeat(GRAPH_LIMITS.idChars + 1)]]),
      new Map([["", "valid-child-id"]]),
    ]) {
      expect(() => store.inherit("invalid-map", "parent", parentTurn.sources, invalid)).toThrow(GraphValidationError)
      expect(store.status("invalid-map").initialized).toBe(false)
    }
  })

  test("retains every queued-user source and requires the entire combined turn for fork inheritance", () => {
    // given
    const { store } = fixture()
    const combined: GraphTurn = { ...turn(), sources: [
      turn().sources[0], { id: "queued-u", role: "user", text: "Also preserve the Hazel setting" }, turn().sources[1],
    ] }
    // when
    ready(store, "parent", combined)
    // then
    expect(store.search("parent", "Hazel")[0].sources).toEqual(combined.sources)
    expect(store.inherit("partial", "parent", combined.sources.slice(1))).toBe(0)
    const mapping = new Map(combined.sources.map(source => [source.id, "child-" + source.id]))
    expect(store.inherit("child", "parent", combined.sources, mapping)).toBe(1)
    expect(store.search("child", "Hazel")[0].sources).toEqual(combined.sources.map(source => ({ ...source, id: "child-" + source.id })))
  })

  test("matches Chinese substrings and normalized identifiers without an embedding service", () => {
    // given
    const { store } = fixture()
    const input = turn("cn", "项目 Quartz 的缓存在哪里？", "缓存位于项目目录。")
    ready(store, "ses_a", input, extracted("Quartz 缓存位于项目目录。", "Quartz 缓存", "项目目录"))
    // when / then
    expect(store.search("ses_a", "缓存")[0].sources).toEqual(input.sources)
    expect(store.search("ses_a", "ＱＵＡＲＴＺ")[0].summary).toContain("Quartz")
    expect(store.search("ses_b", "缓存")).toEqual([])
    expect(store.search("ses_a", "\"'; DROP TABLE graph_turns;--")).toEqual([])
    expect(store.status("ses_a").ready).toBe(1)
  })

  test("bounds complete serialized output in UTF-8 and marks exact-source excerpts", () => {
    // given
    const { store } = fixture()
    const input = turn("large", "缓存" + "😀中文".repeat(1_000), "缓存" + "😀回答".repeat(1_000))
    ready(store, "ses_a", input, {
      summary: "缓存状态".repeat(240), outcome: "informational",
      triples: Array.from({ length: 16 }, (_, index) => ({ subject: "缓存" + index + "甲".repeat(150), predicate: "关联", object: "乙".repeat(150) })),
    })
    // when / then
    for (const budget of [GRAPH_LIMITS.outputBytes, 1_500]) {
      const hits = store.search("ses_a", "缓存", { maxChars: budget })
      expect(hits).toHaveLength(1)
      const json = JSON.stringify(hits)
      expect(json.length).toBeLessThanOrEqual(budget)
      expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(budget)
      expect(JSON.parse(json)).toEqual(hits)
      expect(hits[0].truncated).toBe(true)
      expect(hits[0].sources.map(source => source.id)).toEqual(input.sources.map(source => source.id))
      expect(hits[0].sources.every(source => source.truncated)).toBe(true)
      for (const source of hits[0].sources) expect(input.sources.find(original => original.id === source.id)!.text.startsWith(source.text)).toBe(true)
    }
    expect(store.search("ses_a", "缓存", { maxChars: 2 })).toEqual([])
    expect(() => store.search("ses_a", "缓存", { limit: 9 })).toThrow(GraphValidationError)
  })

  test("enforces atomic pending admission across connections", () => {
    // given
    const { store, open } = fixture()
    const second = open()
    // when
    for (let index = 0; index < GRAPH_LIMITS.pending; index++) (index % 2 ? store : second).schedule("ses_a", turn(String(index)))
    // then
    expect(() => second.schedule("ses_a", turn("overflow"))).toThrow(GraphStorageError)
    expect(store.pending("ses_a")).toHaveLength(GRAPH_LIMITS.pending)
    expect(store.status("ses_a")).toMatchObject({ pending: GRAPH_LIMITS.pending, ready: 0, failed: 0 })
    expect(second.schedule("ses_b", turn("independent"))).toBeDefined()
  })

  test("retains at most 2000 records without evicting an active pending turn", () => {
    // given
    const { store } = fixture()
    const pending = store.schedule("ses_a", { ...turn("pending"), createdAt: 0 })!
    // when
    for (let index = 1; index < GRAPH_LIMITS.records; index++) {
      ready(store, "ses_a", { ...turn(`ready-${index}`, `item${index}`, `answer${index}`), createdAt: index },
        extracted(index === 1 ? "oldest-retention-evidence" : `fact${index}`, `entity${index}`, `value${index}`))
    }
    ready(store, "ses_a", { ...turn("newest"), createdAt: GRAPH_LIMITS.records + 1 })
    // then
    expect(store.status("ses_a")).toMatchObject({ pending: 1, ready: GRAPH_LIMITS.records - 1, failed: 0 })
    expect(store.search("ses_a", "oldest-retention-evidence")).toEqual([])
    expect(store.pending("ses_a")[0].ticket).toEqual(pending)
    expect(store.complete(pending, extracted())).toBe(true)
    expect(store.status("ses_a").ready).toBe(GRAPH_LIMITS.records)
  }, 20_000)

  test("rolls back the ready row and graph together when a SQLite statement fails", () => {
    // given
    const { store } = fixture()
    const ticket = store.schedule("ses_a", turn())!
    const db = new Database(store.path)
    try {
      db.exec("CREATE TRIGGER reject_graph_triple BEFORE INSERT ON graph_triples BEGIN SELECT RAISE(ABORT, 'PRIVATE_ERROR'); END")
      // when / then
      expect(() => store.complete(ticket, extracted())).toThrow(GraphStorageError)
      expect(store.status("ses_a")).toMatchObject({ pending: 1, ready: 0 })
      expect(store.search("ses_a", "Orchard")).toEqual([])
      expect(db.query("SELECT count(*) AS count FROM graph_triples WHERE session_id = ?").get("ses_a")).toEqual({ count: 0 })
      db.exec("DROP TRIGGER reject_graph_triple")
      expect(store.complete(ticket, extracted())).toBe(true)
    } finally { db.close() }
  })

  test("reports locked, corrupted and unsupported storage without replacing or leaking it", () => {
    // given
    const { store, directory, open } = fixture()
    const ticket = store.schedule("ses_a", turn())!
    const db = new Database(store.path)
    try {
      db.exec("BEGIN IMMEDIATE")
      // when / then
      expect(() => store.complete(ticket, extracted())).toThrow(GraphStorageError)
      db.exec("ROLLBACK")
      expect(store.status("ses_a").pending).toBe(1)
    } finally { db.close() }
    const corruptPath = join(directory, "corrupt.sqlite")
    writeFileSync(corruptPath, "PRIVATE_NON_DATABASE_CONTENT")
    const corrupt = open(corruptPath)
    expect(() => corrupt.status("ses_a")).toThrow(GraphStorageError)
    expect(readFileSync(corruptPath, "utf8")).toBe("PRIVATE_NON_DATABASE_CONTENT")
    const futurePath = join(directory, "future.sqlite")
    const future = new Database(futurePath)
    future.exec("PRAGMA user_version = 42")
    future.close()
    expect(() => open(futurePath).status("ses_a")).toThrow(GraphStorageError)
    const unavailableParent = join(directory, "regular-file")
    writeFileSync(unavailableParent, "keep")
    expect(() => open(join(unavailableParent, "graph.sqlite")).status("ses_a")).toThrow(GraphStorageError)
    expect(readFileSync(unavailableParent, "utf8")).toBe("keep")
    const unrelatedPath = join(directory, "unrelated.sqlite")
    const unrelated = new Database(unrelatedPath)
    try {
      unrelated.exec("CREATE TABLE valuable (value TEXT); INSERT INTO valuable VALUES ('preserve')")
      expect(() => open(unrelatedPath).status("ses_a")).toThrow(GraphStorageError)
      expect(unrelated.query("SELECT value FROM valuable").get()).toEqual({ value: "preserve" })
    } finally { unrelated.close() }
  })

  test("rejects corrupted persisted source and extraction records on access", () => {
    // given
    const { store } = fixture()
    ready(store)
    const db = new Database(store.path)
    try {
      const ticket = store.pending("ses_a")
      expect(ticket).toEqual([])
      // when / then
      db.query("UPDATE graph_turns SET sources = ? WHERE session_id = ?").run(JSON.stringify([turn().sources[0]]), "ses_a")
      expect(() => store.search("ses_a", "Orchard")).toThrow(GraphStorageError)
      const changed = turn().sources.map(source => ({ ...source, text: "Unverified replacement text" }))
      db.query("UPDATE graph_turns SET sources = ? WHERE session_id = ?").run(JSON.stringify(changed), "ses_a")
      expect(() => store.search("ses_a", "Orchard")).toThrow(GraphStorageError)
      db.query("UPDATE graph_turns SET sources = ?, extraction = ? WHERE session_id = ?")
        .run(JSON.stringify(turn().sources), JSON.stringify({ summary: "malformed" }), "ses_a")
      expect(() => store.inherit("child", "ses_a", turn().sources as Source[])).toThrow(GraphStorageError)
      expect(store.status("child").initialized).toBe(false)
    } finally { db.close() }
  })
})
