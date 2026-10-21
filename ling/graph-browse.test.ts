import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GraphStore } from "./graph-store"
import { type Extraction, type GraphTurn } from "./graph-types"

const paths: string[] = [], stores: GraphStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose()
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omo-graph-browse-")); paths.push(root)
  const path = join(root, "graph.sqlite")
  const open = () => { const store = new GraphStore(path); stores.push(store); return store }
  return { store: open(), open }
}
function source(index: number): GraphTurn {
  return { createdAt: index, sources: [
    { id: `user-${index}`, role: "user", text: `Choose SQLite ${index}` },
    { id: `assistant-${index}`, role: "assistant", text: `Saved SQLite ${index}` },
  ] }
}
const extraction: Extraction = { summary: "SQLite stores memory", outcome: "completed",
  triples: [{ subject: "SQLite", predicate: "stores", object: "Memory" }] }
function ready(store: GraphStore, index: number, sessionID = "one") {
  const ticket = store.schedule(sessionID, source(index))!
  expect(store.complete(ticket, extraction)).toBe(true)
  return ticket
}

describe("graph browser snapshots", () => {
  test("pages every ready group independently of prompt search limits and reads original sources", () => {
    // given
    const { store, open } = fixture()
    for (let index = 1; index <= 23; index++) ready(store, index)
    const pending = store.schedule("one", source(24))!
    store.fail(store.schedule("one", source(25))!, "timeout")
    // when
    const first = store.snapshot("one", { limit: 20 })
    const second = store.snapshot("one", { limit: 20, cursor: first.nextCursor })
    const record = first.records[0]
    const detail = store.detail("one", record.key, first.revision)
    // then
    expect(first.status).toMatchObject({ ready: 23, pending: 1, failed: 1 })
    expect(first.records).toHaveLength(20)
    expect(first).toMatchObject({ hasMore: true, truncated: true, resetRequired: false })
    expect(second.records).toHaveLength(3)
    expect(second).toMatchObject({ revision: first.revision, hasMore: false, truncated: false, resetRequired: false })
    expect(new Set([...first.records, ...second.records].map(row => row.key)).size).toBe(23)
    expect(first.records.map(row => row.createdAt)).toEqual(Array.from({ length: 20 }, (_, index) => 23 - index))
    expect(record.sources).toEqual(source(23).sources.map(({ id, role }) => ({ id, role })))
    expect(detail.record?.sources).toEqual(source(23).sources)
    expect(detail.record?.triples[0]).toMatchObject(extraction.triples[0])
    expect(record.triples[0].id).toMatch(/^[a-f0-9]{64}$/)
    expect(record.triples[0].subjectID).toBe(first.records[1].triples[0].subjectID)
    expect(record.triples[0].id).not.toBe(first.records[1].triples[0].id)
    expect(open().snapshot("one")).toEqual(first)
    expect(store.pending("one")[0].ticket).toEqual(pending)
  })

  test("cursor and detail revisions reset atomically after completion, retry and clear", () => {
    // given
    const { store } = fixture()
    ready(store, 1); ready(store, 2)
    const pending = store.schedule("one", source(3))!
    const before = store.snapshot("one", { limit: 1 })
    // when / then
    store.complete(pending, extraction)
    const changed = store.snapshot("one", { cursor: before.nextCursor })
    expect(changed.revision).not.toBe(before.revision)
    expect(changed).toMatchObject({ records: [], resetRequired: true, hasMore: false, truncated: false })
    expect(store.detail("one", before.records[0].key, before.revision)).toMatchObject({ record: null, resetRequired: true })
    store.fail(store.schedule("one", source(4))!, "timeout")
    const failed = store.snapshot("one")
    store.retry("one")
    expect(store.snapshot("one").revision).not.toBe(failed.revision)
    const stale = store.snapshot("one", { limit: 1 })
    store.clear("one")
    expect(store.snapshot("one", { cursor: stale.nextCursor })).toMatchObject({ records: [], resetRequired: true })
    expect(store.detail("one", stale.records[0].key)).toMatchObject({ record: null, resetRequired: false })
    expect(store.snapshot("one")).toMatchObject({ records: [], status: { ready: 0, pending: 0, failed: 0 } })
  })

  test("queries are literal bounded text and cursors cannot cross session or query scopes", () => {
    // given
    const { store } = fixture()
    ready(store, 1); ready(store, 2); ready(store, 1, "two")
    const first = store.snapshot("one", { limit: 1, query: "sqlite" })
    // when / then
    expect(store.snapshot("one", { query: "no match" }).records).toEqual([])
    expect(store.snapshot("one", { query: "\" OR 1=1 --" }).records).toEqual([])
    expect(store.snapshot("one", { query: "SQLITE", cursor: first.nextCursor }).records).toHaveLength(1)
    expect(() => store.snapshot("two", { query: "sqlite", cursor: first.nextCursor })).toThrow("scope")
    expect(() => store.snapshot("one", { query: "different", cursor: first.nextCursor })).toThrow("scope")
    expect(() => store.snapshot("one", { cursor: "bogus" })).toThrow()
    expect(() => store.snapshot("one", { limit: 21 })).toThrow()
    expect(() => store.snapshot("one", { query: "x".repeat(513) })).toThrow()
    expect(() => store.detail("one", "not-a-key")).toThrow()
    expect(store.snapshot("two").records[0].triples[0].subjectID).not.toBe(first.records[0].triples[0].subjectID)
    expect(store.detail("unknown", first.records[0].key).record).toBeNull()
  })

  test("byte limits page whole records and detail retains fully escaped source text", () => {
    // given: every field reaches its stored bound and control characters expand in JSON.
    const { store } = fixture()
    for (let index = 0; index < 6; index++) {
      const sources = Array.from({ length: 32 }, (_, ordinal) => ({
        id: `${index}-${ordinal}`.padEnd(256, "\u0001"), role: ordinal === 0 ? "user" as const : "assistant" as const,
        text: "x".padEnd(1024, "\u0001"),
      }))
      const ticket = store.schedule("one", { createdAt: index, sources })!
      store.complete(ticket, { summary: "s".padEnd(1000, "\u0001"), outcome: "completed",
        triples: Array.from({ length: 16 }, (_, ordinal) => ({ subject: `${ordinal}`.padEnd(160, "\u0001"),
          predicate: "p".padEnd(80, "\u0001"), object: "o".padEnd(160, "\u0001") })) })
    }
    // when
    const first = store.snapshot("one")
    const detail = store.detail("one", first.records[0].key)
    // then
    expect(first.records.length).toBeGreaterThan(0)
    expect(first.records.length).toBeLessThan(6)
    expect(first.hasMore).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(256 * 1024)
    expect(Buffer.byteLength(JSON.stringify(detail))).toBeGreaterThan(256 * 1024)
    expect(Buffer.byteLength(JSON.stringify(detail))).toBeLessThanOrEqual(512 * 1024)
    expect(detail.record?.sources).toHaveLength(32)
    expect(detail.record?.sources[31].text).toBe("x".padEnd(1024, "\u0001"))
    expect(first.records.every(record => record.triples.length === 16 && !record.truncated)).toBe(true)
    let cursor = first.nextCursor
    const seen = new Set(first.records.map(record => record.key))
    while (cursor) {
      const page = store.snapshot("one", { cursor })
      for (const record of page.records) { expect(seen.has(record.key)).toBe(false); seen.add(record.key) }
      cursor = page.nextCursor
    }
    expect(seen.size).toBe(6)
  })

  test("an expiring lease and a tombstone invalidate a stored browser revision", () => {
    // given
    const directory = mkdtempSync(join(tmpdir(), "omo-graph-browse-lease-")); paths.push(directory)
    let now = 1
    const store = new GraphStore(join(directory, "graph.sqlite"), { now: () => now, leaseMs: 10 }); stores.push(store)
    ready(store, 1); ready(store, 2)
    store.schedule("one", source(3))
    const before = store.snapshot("one", { limit: 1 })
    // when / then
    now = 11
    const expired = store.snapshot("one", { cursor: before.nextCursor })
    expect(expired).toMatchObject({ resetRequired: true, records: [], status: { ready: 2, pending: 0, failed: 1 } })
    const current = store.snapshot("one", { limit: 1 })
    store.delete("one")
    expect(store.snapshot("one", { cursor: current.nextCursor })).toMatchObject({ resetRequired: true, records: [], status: { deleted: true } })
  })
})
