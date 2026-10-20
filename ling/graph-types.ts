import { createHash } from "node:crypto"
import { z } from "zod"

export const GRAPH_LIMITS = Object.freeze({
  records: 2_000,
  pending: 32,
  sources: 32,
  sourceBytes: 32 * 1024,
  idChars: 256,
  summaryChars: 1_000,
  triples: 16,
  entityChars: 160,
  predicateChars: 80,
  extractionBytes: 32 * 1024,
  queryChars: 512,
  results: 8,
  outputBytes: 8 * 1024,
  leaseMs: 120_000,
})

const nonblank = (max: number) => z.string().min(1).max(max).refine(value => value.trim().length > 0 && !value.includes("\0"))
const sourceSchema = z.object({
  id: nonblank(GRAPH_LIMITS.idChars),
  role: z.enum(["user", "assistant"]),
  text: z.string().min(1).max(GRAPH_LIMITS.sourceBytes).refine(value => value.trim().length > 0),
}).strict()

// The summary/outcome/navigation contract is adapted from graph-memory.
// See GRAPH-MEMORY-LICENSE.txt for upstream attribution and its MIT license.
export const graphExtractionSchema = z.object({
  summary: nonblank(GRAPH_LIMITS.summaryChars),
  outcome: z.enum(["completed", "partial", "failed", "informational", "unknown"]),
  triples: z.array(z.object({
    subject: nonblank(GRAPH_LIMITS.entityChars),
    predicate: nonblank(GRAPH_LIMITS.predicateChars),
    object: nonblank(GRAPH_LIMITS.entityChars),
  }).strict()).max(GRAPH_LIMITS.triples),
}).strict()

export type Source = z.infer<typeof sourceSchema>
export type Extraction = z.infer<typeof graphExtractionSchema>
export type GraphTurn = { sources: Source[]; createdAt: number }
export type GraphTicket = { sessionID: string; key: string; digest: string; epoch: number }
export type GraphWork = { ticket: GraphTicket; turn: GraphTurn }
export type GraphStatus = {
  initialized: boolean
  deleted: boolean
  epoch: number
  generation: number
  ready: number
  pending: number
  failed: number
  lastError?: string
}
export type GraphSearchResult = Extraction & {
  sessionID: string
  key: string
  digest: string
  createdAt: number
  sources: (Source & { truncated?: boolean })[]
  match: "lexical" | "graph"
  truncated: boolean
}
export type GraphSearchOptions = { limit?: number; maxChars?: number }

export class GraphValidationError extends Error {
  constructor(message = "Graph memory input does not match the bounded data contract") {
    super(message)
    this.name = "GraphValidationError"
  }
}

export function validateSessionID(value: unknown): asserts value is string {
  if (!nonblank(GRAPH_LIMITS.idChars).safeParse(value).success) throw new GraphValidationError("Graph memory requires a native session ID")
}

export function validateGraphTurn(value: unknown): GraphTurn {
  const parsed = z.object({
    sources: z.array(sourceSchema).min(2).max(GRAPH_LIMITS.sources),
    createdAt: z.number().int().nonnegative().safe(),
  }).strict().safeParse(value)
  if (!parsed.success) throw new GraphValidationError()
  const turn = parsed.data
  const firstAssistant = turn.sources.findIndex(source => source.role === "assistant")
  if (firstAssistant < 1 || turn.sources.slice(firstAssistant).some(source => source.role !== "assistant")
    || new Set(turn.sources.map(source => source.id)).size !== turn.sources.length
    || turn.sources.reduce((bytes, source) => bytes + Buffer.byteLength(source.text, "utf8"), 0) > GRAPH_LIMITS.sourceBytes) {
    throw new GraphValidationError("Graph memory requires unique visible user/assistant sources within 32 KiB")
  }
  return turn
}

export function validateGraphExtraction(value: unknown): Extraction {
  const parsed = graphExtractionSchema.safeParse(value)
  if (!parsed.success) throw new GraphValidationError("Graph extraction does not match the bounded data contract")
  return parsed.data
}

export function sourceDigest(source: Source): string {
  return createHash("sha256").update(JSON.stringify([source.id, source.role, source.text])).digest("hex")
}

export function turnIdentity(turn: GraphTurn): { key: string; digest: string } {
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
  return {
    key: hash(turn.sources.map(source => [source.id, source.role])),
    digest: hash(turn.sources.map(source => sourceDigest(source))),
  }
}

/** Visible fork history is not itself a turn and may contain multiple user messages. */
export function visibleSourceDigests(sources: Source[]): Map<string, string> {
  if (!Array.isArray(sources) || sources.length > GRAPH_LIMITS.records * GRAPH_LIMITS.sources) throw new GraphValidationError()
  const result = new Map<string, string>()
  for (const value of sources) {
    const parsed = sourceSchema.safeParse(value)
    if (!parsed.success || Buffer.byteLength(parsed.data.text, "utf8") > GRAPH_LIMITS.sourceBytes || result.has(parsed.data.id)) {
      throw new GraphValidationError("Graph inheritance requires unique bounded visible source messages")
    }
    result.set(parsed.data.id, sourceDigest(parsed.data))
  }
  return result
}

/** Never retain provider bodies, credentials, or excerpts of conversation text in errors. */
export function graphFailureReason(reason: unknown): string {
  const message = reason instanceof Error ? `${reason.name} ${reason.message}` : typeof reason === "string" ? reason : ""
  if (/timeout|timed out|deadline/i.test(message)) return "Graph extraction timed out"
  if (/interrupt|lease.*expir/i.test(message)) return "Graph extraction interrupted or its lease expired"
  if (/abort|cancel/i.test(message)) return "Graph extraction cancelled"
  if (/capacity|queue.*full/i.test(message)) return "Graph extraction queue capacity exceeded"
  if (/runtime.*stop|dispos/i.test(message)) return "Graph extraction runtime stopped"
  if (/source.*unavailable|source.*not.*visible|scope.*mismatch/i.test(message)) return "Graph extraction native source is unavailable"
  if (/storage|database|sqlite/i.test(message)) return "Graph memory storage is unavailable"
  if (/contract|invalid.*(?:json|structured)|parse|schema|validation/i.test(message)) return "Graph extraction returned invalid structured data"
  if (/rate.?limit|\b429\b/i.test(message)) return "Graph extraction provider rate limited the request"
  if (/auth|\b401\b|\b403\b/i.test(message)) return "Graph extraction provider authorization failed"
  if (/unavailable|not available|model.*missing|not found/i.test(message)) return "Graph extraction provider or source model is unavailable"
  return "Graph extraction failed"
}
