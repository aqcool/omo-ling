import { Database, type SQLQueryBindings } from "bun:sqlite"
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs"
import { dirname, isAbsolute } from "node:path"
import {
  GRAPH_BROWSE_LIMITS, graphBrowseRecord, graphCursor, graphHash, graphIdentitySchema, graphNormalized,
  graphSnapshotInput, readGraphCursor, type GraphDetail, type GraphSnapshot, type GraphSnapshotInput,
} from "./graph-browse"
import {
  GRAPH_LIMITS, GraphValidationError, graphFailureReason, sourceDigest, turnIdentity, validateGraphExtraction,
  validateGraphTurn, validateSessionID, visibleSourceDigests,
  type Extraction, type GraphSearchOptions, type GraphSearchResult, type GraphStatus,
  type GraphTicket, type GraphTurn, type GraphWork, type Source,
} from "./graph-types"

type SessionRow = { epoch: number; generation: number; initialized: number; deleted: number }
type TurnRow = {
  turn_key: string; digest: string; epoch: number; created_at: number; updated_at: number
  state: "pending" | "ready" | "failed"; sources: string; extraction: string | null
  error: string | null; lease_expires_at: number
}
type Candidate = TurnRow & { score: number }
type Binding = SQLQueryBindings
const one = <T>(db: Database, sql: string, ...bindings: Binding[]) => db.query<T, Binding[]>(sql).get(...bindings)
const rows = <T>(db: Database, sql: string, ...bindings: Binding[]) => db.query<T, Binding[]>(sql).all(...bindings)
const run = (db: Database, sql: string, ...bindings: Binding[]) => db.query(sql).run(...bindings)
const normalized = (text: string) => text.normalize("NFKC").toLowerCase()
const placeholders = (length: number) => Array(length).fill("?").join(",")
const interrupted = "Graph extraction interrupted or its lease expired"

export class GraphStorageError extends Error {
  constructor(message = "Graph memory storage is unavailable") {
    super(message)
    this.name = "GraphStorageError"
  }
}

/** Source-linked navigation, adapted from graph-memory; see GRAPH-MEMORY-LICENSE.txt.
 * The caller resolves the profile/project directory. Every data operation is native-session scoped.
 */
export class GraphStore {
  private db?: Database
  private disposed = false
  private readonly now: () => number
  private readonly leaseMs: number

  constructor(readonly path: string, options: { now?: () => number; leaseMs?: number } = {}) {
    if (!isAbsolute(path)) throw new GraphValidationError("Graph memory database path must be absolute")
    this.now = options.now ?? Date.now
    this.leaseMs = options.leaseMs ?? GRAPH_LIMITS.leaseMs
    if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1 || this.leaseMs > GRAPH_LIMITS.leaseMs) throw new GraphValidationError()
  }

  private open(): Database {
    if (this.disposed) throw new GraphStorageError("Graph memory store is disposed")
    if (this.db) return this.db
    let db: Database | undefined
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      if (existsSync(this.path) && lstatSync(this.path).isSymbolicLink()) throw new GraphStorageError()
      db = new Database(this.path, { create: true, strict: true })
      chmodSync(this.path, 0o600)
      db.exec("PRAGMA busy_timeout = 250; PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL")
      const connection = db
      connection.transaction(() => {
        const version = one<{ user_version: number }>(connection, "PRAGMA user_version")?.user_version
        if (version !== 0 && version !== 1) throw new GraphStorageError("Graph memory storage schema is unsupported")
        if (version === 0) {
          if (one<{ count: number }>(connection, "SELECT count(*) AS count FROM sqlite_master WHERE type = 'table'")?.count) {
            throw new GraphStorageError("Graph memory storage contains an unrelated schema")
          }
          connection.exec(`
            CREATE TABLE graph_sessions (
              session_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0, generation INTEGER NOT NULL DEFAULT 0,
              initialized INTEGER NOT NULL DEFAULT 0 CHECK (initialized IN (0,1)),
              deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0,1))
            );
            CREATE TABLE graph_turns (
              session_id TEXT NOT NULL, turn_key TEXT NOT NULL, digest TEXT NOT NULL,
              epoch INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
              state TEXT NOT NULL CHECK (state IN ('pending','ready','failed')),
              lease_expires_at INTEGER NOT NULL, sources TEXT NOT NULL,
              extraction TEXT, error TEXT, search_text TEXT NOT NULL DEFAULT '',
              PRIMARY KEY (session_id, turn_key),
              FOREIGN KEY (session_id) REFERENCES graph_sessions(session_id)
            );
            CREATE INDEX graph_turns_state ON graph_turns(session_id, state, updated_at);
            CREATE TABLE graph_triples (
              session_id TEXT NOT NULL, turn_key TEXT NOT NULL, ordinal INTEGER NOT NULL,
              subject_norm TEXT NOT NULL, object_norm TEXT NOT NULL,
              PRIMARY KEY (session_id, turn_key, ordinal),
              FOREIGN KEY (session_id, turn_key) REFERENCES graph_turns(session_id, turn_key) ON DELETE CASCADE
            );
            CREATE INDEX graph_triples_subject ON graph_triples(session_id, subject_norm);
            CREATE INDEX graph_triples_object ON graph_triples(session_id, object_norm);
            PRAGMA user_version = 1;
          `)
        }
      }).immediate()
      if (one<{ quick_check: string }>(db, "PRAGMA quick_check(1)")?.quick_check !== "ok") throw new GraphStorageError()
      this.db = db
      return db
    } catch (error) {
      db?.close()
      throw error instanceof GraphStorageError ? error : new GraphStorageError()
    }
  }

  private scoped<T>(sessionID: string, operation: (db: Database, now: number) => T): T {
    validateSessionID(sessionID)
    try {
      const db = this.open()
      return db.transaction(() => {
        const now = this.now()
        if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + this.leaseMs)) throw new GraphValidationError()
        run(db, `UPDATE graph_turns SET state = 'failed', error = ?, updated_at = ?
          WHERE session_id = ? AND state = 'pending' AND lease_expires_at <= ?`, interrupted, now, sessionID, now)
        return operation(db, now)
      }).immediate()
    } catch (error) {
      if (error instanceof GraphValidationError || error instanceof GraphStorageError) throw error
      throw new GraphStorageError()
    }
  }

  private session(db: Database, sessionID: string): SessionRow | null {
    return one<SessionRow>(db, "SELECT epoch, generation, initialized, deleted FROM graph_sessions WHERE session_id = ?", sessionID)
  }

  private advance(db: Database, sessionID: string, clear = false): number {
    run(db, "INSERT OR IGNORE INTO graph_sessions(session_id) VALUES (?)", sessionID)
    run(db, "UPDATE graph_sessions SET epoch = epoch + 1, generation = generation + ?, initialized = 1 WHERE session_id = ?", clear ? 1 : 0, sessionID)
    const session = this.session(db, sessionID)!
    if (!Number.isSafeInteger(session.epoch) || !Number.isSafeInteger(session.generation)) throw new GraphStorageError("Graph memory fencing revision is exhausted")
    return session.epoch
  }

  private turn(row: TurnRow): GraphTurn {
    try {
      const turn = validateGraphTurn({ sources: JSON.parse(row.sources), createdAt: row.created_at })
      const identity = turnIdentity(turn)
      if (identity.key !== row.turn_key || identity.digest !== row.digest) throw new GraphValidationError()
      return turn
    } catch {
      throw new GraphStorageError("Graph memory storage contains invalid source records")
    }
  }

  private extraction(row: TurnRow): Extraction {
    try { return validateGraphExtraction(JSON.parse(row.extraction ?? "")) }
    catch { throw new GraphStorageError("Graph memory storage contains invalid extraction records") }
  }

  private ticket(sessionID: string, row: Pick<TurnRow, "turn_key" | "digest" | "epoch">): GraphTicket {
    return { sessionID, key: row.turn_key, digest: row.digest, epoch: row.epoch }
  }

  private validateTicket(ticket: GraphTicket): void {
    validateSessionID(ticket.sessionID)
    if (!/^[a-f0-9]{64}$/.test(ticket.key) || !/^[a-f0-9]{64}$/.test(ticket.digest)
      || !Number.isSafeInteger(ticket.epoch) || ticket.epoch < 1) throw new GraphValidationError()
  }

  private makeRoom(db: Database, sessionID: string): void {
    const count = one<{ count: number }>(db, "SELECT count(*) AS count FROM graph_turns WHERE session_id = ?", sessionID)!.count
    if (count < GRAPH_LIMITS.records) return
    const oldest = one<{ turn_key: string }>(db, `SELECT turn_key FROM graph_turns WHERE session_id = ? AND state <> 'pending'
      ORDER BY created_at, turn_key LIMIT 1`, sessionID)
    if (!oldest) throw new GraphStorageError("Graph memory pending capacity is exhausted")
    run(db, "DELETE FROM graph_turns WHERE session_id = ? AND turn_key = ?", sessionID, oldest.turn_key)
  }

  schedule(sessionID: string, input: GraphTurn): GraphTicket | undefined {
    const turn = validateGraphTurn(input)
    const identity = turnIdentity(turn)
    return this.scoped(sessionID, (db, now) => {
      if (this.session(db, sessionID)?.deleted) return undefined
      const existing = one<TurnRow>(db, "SELECT * FROM graph_turns WHERE session_id = ? AND turn_key = ?", sessionID, identity.key)
      if (existing?.digest === identity.digest) return undefined
      const pending = one<{ count: number }>(db, "SELECT count(*) AS count FROM graph_turns WHERE session_id = ? AND state = 'pending'", sessionID)!.count
      if (pending >= GRAPH_LIMITS.pending && existing?.state !== "pending") throw new GraphStorageError("Graph memory pending capacity is exhausted")
      if (!existing) this.makeRoom(db, sessionID)
      const epoch = this.advance(db, sessionID)
      run(db, "DELETE FROM graph_turns WHERE session_id = ? AND turn_key = ?", sessionID, identity.key)
      run(db, `INSERT INTO graph_turns(session_id, turn_key, digest, epoch, created_at, updated_at, state, lease_expires_at, sources)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      sessionID, identity.key, identity.digest, epoch, turn.createdAt, now, now + this.leaseMs, JSON.stringify(turn.sources))
      return { sessionID, ...identity, epoch }
    })
  }

  complete(ticket: GraphTicket, input: Extraction): boolean {
    if (this.disposed) return false
    this.validateTicket(ticket)
    const extraction = validateGraphExtraction(input)
    return this.scoped(ticket.sessionID, (db, now) => {
      const row = one<TurnRow>(db, `SELECT * FROM graph_turns WHERE session_id = ? AND turn_key = ?
        AND digest = ? AND epoch = ? AND state = 'pending' AND lease_expires_at > ?`,
      ticket.sessionID, ticket.key, ticket.digest, ticket.epoch, now)
      if (!row || this.session(db, ticket.sessionID)?.deleted) return false
      const turn = this.turn(row)
      this.writeReady(db, ticket, turn, extraction, now)
      return true
    })
  }

  private writeReady(db: Database, ticket: GraphTicket, turn: GraphTurn, extraction: Extraction, now: number): void {
    const search = normalized([extraction.summary, ...turn.sources.map(source => source.text),
      ...extraction.triples.flatMap(triple => [triple.subject, triple.predicate, triple.object])].join("\n"))
    run(db, `UPDATE graph_turns SET state = 'ready', extraction = ?, search_text = ?, error = NULL, updated_at = ?
      WHERE session_id = ? AND turn_key = ? AND digest = ? AND epoch = ?`,
    JSON.stringify(extraction), search, now, ticket.sessionID, ticket.key, ticket.digest, ticket.epoch)
    run(db, "DELETE FROM graph_triples WHERE session_id = ? AND turn_key = ?", ticket.sessionID, ticket.key)
    extraction.triples.forEach((triple, index) => run(db, `INSERT INTO graph_triples(session_id, turn_key, ordinal, subject_norm, object_norm)
      VALUES (?, ?, ?, ?, ?)`, ticket.sessionID, ticket.key, index, normalized(triple.subject), normalized(triple.object)))
  }

  fail(ticket: GraphTicket, reason: unknown): void {
    if (this.disposed) return
    this.validateTicket(ticket)
    this.scoped(ticket.sessionID, (db, now) => {
      run(db, `UPDATE graph_turns SET state = 'failed', error = ?, updated_at = ? WHERE session_id = ? AND turn_key = ?
        AND digest = ? AND epoch = ? AND state = 'pending'`,
      graphFailureReason(reason), now, ticket.sessionID, ticket.key, ticket.digest, ticket.epoch)
    })
  }

  status(sessionID: string): GraphStatus {
    return this.scoped(sessionID, db => this.readStatus(db, sessionID))
  }

  private readStatus(db: Database, sessionID: string): GraphStatus {
    const session = this.session(db, sessionID)
    const counts = rows<{ state: TurnRow["state"]; count: number }>(db, "SELECT state, count(*) AS count FROM graph_turns WHERE session_id = ? GROUP BY state", sessionID)
    const last = one<{ error: string }>(db, "SELECT error FROM graph_turns WHERE session_id = ? AND state = 'failed' ORDER BY updated_at DESC, turn_key LIMIT 1", sessionID)
    return { initialized: Boolean(session?.initialized), deleted: Boolean(session?.deleted), epoch: session?.epoch ?? 0, generation: session?.generation ?? 0,
      ready: counts.find(row => row.state === "ready")?.count ?? 0,
      pending: counts.find(row => row.state === "pending")?.count ?? 0,
      failed: counts.find(row => row.state === "failed")?.count ?? 0,
      ...(last ? { lastError: graphFailureReason(last.error) } : {}) }
  }

  private revision(db: Database, sessionID: string): string {
    // Metadata covers each allowed state transition, including same-millisecond
    // completion/failure. Extraction can only be written once per fenced attempt.
    const metadata = rows(db, `SELECT turn_key, digest, epoch, state, updated_at, error
      FROM graph_turns WHERE session_id = ? ORDER BY turn_key`, sessionID)
    return graphHash([sessionID, this.session(db, sessionID), metadata])
  }

  snapshot(sessionID: string, options: GraphSnapshotInput = {}): GraphSnapshot {
    const parsed = graphSnapshotInput.safeParse(options)
    if (!parsed.success) throw new GraphValidationError("Graph browser options are invalid")
    const query = graphNormalized(parsed.data.query ?? "").trim()
    const scope = graphHash([this.path, sessionID, query])
    const cursor = readGraphCursor(parsed.data.cursor, scope)
    return this.scoped(sessionID, db => {
      const revision = this.revision(db, sessionID), status = this.readStatus(db, sessionID)
      const result: GraphSnapshot = { sessionID, revision, status, records: [], hasMore: false,
        truncated: false, resetRequired: Boolean(cursor && cursor.revision !== revision) }
      if (result.resetRequired || status.deleted) return result
      const offset = cursor?.offset ?? 0, limit = parsed.data.limit ?? GRAPH_BROWSE_LIMITS.records
      const candidates = rows<TurnRow>(db, `SELECT * FROM graph_turns WHERE session_id = ? AND state = 'ready'
        AND instr(search_text, ?) > 0 ORDER BY created_at DESC, turn_key LIMIT ? OFFSET ?`, sessionID, query, limit + 1, offset)
      for (const row of candidates.slice(0, limit)) {
        const detail = graphBrowseRecord(sessionID, row.turn_key, row.digest, row.created_at, this.extraction(row), this.turn(row).sources)
        const record = { ...detail, sources: detail.sources.map(({ id, role }) => ({ id, role })) }
        if (Buffer.byteLength(JSON.stringify({ ...result, records: [...result.records, record] }), "utf8")
          > GRAPH_BROWSE_LIMITS.snapshotBytes - 4096) break
        result.records.push(record)
      }
      if (candidates.length && !result.records.length) throw new GraphStorageError("Graph record exceeds browser output bounds")
      result.hasMore = result.records.length < candidates.length
      result.truncated = result.hasMore
      if (result.hasMore) result.nextCursor = graphCursor(scope, revision, offset + result.records.length)
      return result
    })
  }

  detail(sessionID: string, key: string, expectedRevision?: string): GraphDetail {
    if (!graphIdentitySchema.safeParse(key).success
      || (expectedRevision !== undefined && !graphIdentitySchema.safeParse(expectedRevision).success)) {
      throw new GraphValidationError("Graph browser record identity is invalid")
    }
    return this.scoped(sessionID, db => {
      const revision = this.revision(db, sessionID), status = this.readStatus(db, sessionID)
      const result: GraphDetail = { sessionID, revision, status, record: null,
        resetRequired: expectedRevision !== undefined && expectedRevision !== revision }
      if (result.resetRequired || status.deleted) return result
      const row = one<TurnRow>(db, "SELECT * FROM graph_turns WHERE session_id = ? AND turn_key = ? AND state = 'ready'", sessionID, key)
      if (row) result.record = graphBrowseRecord(sessionID, row.turn_key, row.digest, row.created_at, this.extraction(row), this.turn(row).sources)
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > GRAPH_BROWSE_LIMITS.detailBytes - 4096) {
        throw new GraphStorageError("Graph source group exceeds browser output bounds")
      }
      return result
    })
  }

  pending(sessionID: string): GraphWork[] {
    return this.scoped(sessionID, db => rows<TurnRow>(db,
      "SELECT * FROM graph_turns WHERE session_id = ? AND state = 'pending' ORDER BY created_at, turn_key LIMIT ?",
      sessionID, GRAPH_LIMITS.pending).map(row => ({ ticket: this.ticket(sessionID, row), turn: this.turn(row) })))
  }

  retry(sessionID: string): GraphWork[] {
    return this.scoped(sessionID, (db, now) => {
      if (this.session(db, sessionID)?.deleted) return []
      const pending = one<{ count: number }>(db, "SELECT count(*) AS count FROM graph_turns WHERE session_id = ? AND state = 'pending'", sessionID)!.count
      const failed = rows<TurnRow>(db, `SELECT * FROM graph_turns WHERE session_id = ? AND state = 'failed'
        ORDER BY created_at, turn_key LIMIT ?`, sessionID, Math.max(0, GRAPH_LIMITS.pending - pending))
      return failed.map(row => {
        const turn = this.turn(row)
        const epoch = this.advance(db, sessionID)
        run(db, `UPDATE graph_turns SET state = 'pending', error = NULL, epoch = ?, updated_at = ?, lease_expires_at = ?
          WHERE session_id = ? AND turn_key = ? AND state = 'failed'`, epoch, now, now + this.leaseMs, sessionID, row.turn_key)
        return { ticket: this.ticket(sessionID, { ...row, epoch }), turn }
      })
    })
  }

  clear(sessionID: string): void {
    this.scoped(sessionID, db => {
      this.advance(db, sessionID, true)
      run(db, "DELETE FROM graph_turns WHERE session_id = ?", sessionID)
    })
  }

  delete(sessionID: string): void {
    this.scoped(sessionID, db => {
      this.advance(db, sessionID, true)
      run(db, "UPDATE graph_sessions SET deleted = 1 WHERE session_id = ?", sessionID)
      run(db, "DELETE FROM graph_turns WHERE session_id = ?", sessionID)
    })
  }

  inherit(childID: string, parentID: string, visibleSources: Source[], sourceIDMap?: ReadonlyMap<string, string>): number {
    validateSessionID(parentID)
    if (childID === parentID) throw new GraphValidationError("Graph inheritance requires distinct native sessions")
    const visible = visibleSourceDigests(visibleSources)
    const positions = new Map(visibleSources.map((source, index) => [source.id, index]))
    if (sourceIDMap) {
      if (!(sourceIDMap instanceof Map) || sourceIDMap.size > GRAPH_LIMITS.records * GRAPH_LIMITS.sources) throw new GraphValidationError()
      const mapped = new Set<string>()
      for (const [sourceID, childSourceID] of sourceIDMap) {
        if ([sourceID, childSourceID].some(id => typeof id !== "string" || !id.trim() || id.length > GRAPH_LIMITS.idChars || id.includes("\0"))
          || mapped.has(childSourceID)) throw new GraphValidationError("Graph inheritance requires a one-to-one native source ID map")
        mapped.add(childSourceID)
      }
    }
    return this.scoped(childID, (db, now) => {
      if (this.session(db, childID)?.initialized) return 0
      const epoch = this.advance(db, childID)
      const candidates = rows<TurnRow>(db, `SELECT * FROM graph_turns WHERE session_id = ? AND state = 'ready'
        ORDER BY created_at DESC, turn_key LIMIT ?`, parentID, GRAPH_LIMITS.records)
      let copied = 0
      for (const row of candidates) {
        const original = this.turn(row)
        if (!original.sources.every(source => visible.get(source.id) === sourceDigest(source))) continue
        if (original.sources.some((source, index) => index > 0 && positions.get(source.id)! <= positions.get(original.sources[index - 1].id)!)) continue
        if (sourceIDMap && original.sources.some(source => !sourceIDMap.has(source.id))) continue
        const turn = validateGraphTurn({ ...original, sources: original.sources.map(source => ({
          ...source, id: sourceIDMap?.get(source.id) ?? source.id,
        })) })
        const identity = turnIdentity(turn)
        const extraction = this.extraction(row)
        run(db, `INSERT INTO graph_turns(session_id, turn_key, digest, epoch, created_at, updated_at, state, lease_expires_at, sources)
          VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`, childID, identity.key, identity.digest, epoch, turn.createdAt, now, now + this.leaseMs, JSON.stringify(turn.sources))
        this.writeReady(db, { sessionID: childID, ...identity, epoch }, turn, extraction, now)
        copied++
      }
      return copied
    })
  }

  search(sessionID: string, query: string, options: GraphSearchOptions = {}): GraphSearchResult[] {
    if (typeof query !== "string") throw new GraphValidationError()
    const limit = options.limit ?? 4
    const maxChars = options.maxChars ?? GRAPH_LIMITS.outputBytes
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > GRAPH_LIMITS.results || !Number.isSafeInteger(maxChars) || maxChars < 2) {
      throw new GraphValidationError("Graph search limits are invalid")
    }
    return this.scoped(sessionID, db => {
      const terms = queryTerms(query)
      if (!terms.length || this.session(db, sessionID)?.deleted) return []
      const scored = terms.map(() => "CASE WHEN instr(search_text, ?) > 0 THEN 1 ELSE 0 END").join(" + ")
      const direct = rows<Candidate>(db, `SELECT *, (${scored}) AS score FROM graph_turns
        WHERE session_id = ? AND state = 'ready' AND (${terms.map(() => "instr(search_text, ?) > 0").join(" OR ")})
        ORDER BY score DESC, created_at DESC, turn_key LIMIT 32`, ...terms, sessionID, ...terms)
      const candidates = new Map<string, { row: TurnRow; match: "lexical" | "graph" }>(
        direct.map(row => [row.turn_key, { row, match: "lexical" }]))
      const seeds = [...new Set(direct.slice(0, 8).flatMap(row => this.extraction(row).triples.flatMap(triple => [normalized(triple.subject), normalized(triple.object)])))].slice(0, 64)
      if (seeds.length) {
        const neighbors = rows<TurnRow>(db, `SELECT DISTINCT t.* FROM graph_turns t JOIN graph_triples g
          ON g.session_id = t.session_id AND g.turn_key = t.turn_key WHERE t.session_id = ? AND g.session_id = ?
          AND t.state = 'ready' AND (g.subject_norm IN (${placeholders(seeds.length)}) OR g.object_norm IN (${placeholders(seeds.length)}))
          ORDER BY t.created_at DESC, t.turn_key LIMIT 32`, sessionID, sessionID, ...seeds, ...seeds)
        for (const row of neighbors) if (!candidates.has(row.turn_key)) candidates.set(row.turn_key, { row, match: "graph" })
      }
      const result: GraphSearchResult[] = []
      for (const { row, match } of candidates.values()) {
        if (result.length >= limit) break
        const candidate: GraphSearchResult = { ...this.extraction(row), sessionID, key: row.turn_key, digest: row.digest,
          createdAt: row.created_at, sources: this.turn(row).sources, match, truncated: false }
        const fitted = fitResult(candidate, result, Math.min(maxChars, GRAPH_LIMITS.outputBytes))
        if (fitted) result.push(fitted)
      }
      return result
    })
  }

  dispose(): void {
    this.disposed = true
    this.db?.close()
    this.db = undefined
  }
}

function queryTerms(query: string): string[] {
  const value = normalized(query.slice(0, GRAPH_LIMITS.queryChars)).trim()
  if (!value || !/[\p{L}\p{N}]/u.test(value)) return []
  const terms = [value, ...value.matchAll(/[\p{L}\p{N}_-]+/gu)].map(item => typeof item === "string" ? item : item[0])
  for (const match of value.matchAll(/\p{Script=Han}{2,}/gu)) {
    const chars = [...match[0]]
    for (let index = 0; index + 1 < chars.length && terms.length < 32; index++) terms.push(chars[index] + chars[index + 1])
  }
  return [...new Set(terms)].slice(0, 32)
}

function fitResult(candidate: GraphSearchResult, previous: GraphSearchResult[], maxChars: number): GraphSearchResult | undefined {
  const fits = (value: GraphSearchResult) => {
    const json = JSON.stringify([...previous, value])
    return json.length <= maxChars && Buffer.byteLength(json, "utf8") <= Math.min(maxChars, GRAPH_LIMITS.outputBytes)
  }
  if (fits(candidate)) return candidate
  const base = { ...candidate, triples: [...candidate.triples], truncated: true }
  const clipped = (cap: number): GraphSearchResult => ({ ...base, sources: candidate.sources.map(source => {
    let text = source.text.slice(0, cap)
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1)
    return { id: source.id, role: source.role, text, ...(text.length < source.text.length ? { truncated: true } : {}) }
  }) })
  while (base.triples.length && !fits(clipped(0))) base.triples.pop()
  while (base.summary.length && !fits(clipped(0))) base.summary = base.summary.slice(0, Math.floor(base.summary.length / 2))
  if (!fits(clipped(0))) return undefined
  let low = 0
  let high = Math.max(...candidate.sources.map(source => source.text.length))
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (fits(clipped(middle))) low = middle
    else high = middle - 1
  }
  return clipped(low)
}
