import { createHash } from "node:crypto"
import { z } from "zod"
import { GRAPH_LIMITS, GraphValidationError, type Extraction, type GraphStatus, type Source } from "./graph-types"

export const GRAPH_BROWSE_LIMITS = Object.freeze({ records: 20, snapshotBytes: 256 * 1024, detailBytes: 512 * 1024, cursorChars: 2048 })
export const graphHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
export const graphNormalized = (value: string) => value.normalize("NFKC").toLowerCase()
export const graphIdentitySchema = z.string().regex(/^[a-f0-9]{64}$/)
export const graphSnapshotInput = z.object({
  query: z.string().max(GRAPH_LIMITS.queryChars).refine(value => !value.includes("\0")).optional(),
  cursor: z.string().min(1).max(GRAPH_BROWSE_LIMITS.cursorChars).optional(),
  limit: z.number().int().min(1).max(GRAPH_BROWSE_LIMITS.records).optional(),
}).strict()
export const graphBrowseRecordSchema = z.object({
  sessionID: z.string(), key: graphIdentitySchema, digest: graphIdentitySchema, createdAt: z.number(),
  summary: z.string(), outcome: z.enum(["completed", "partial", "failed", "informational", "unknown"]),
  triples: z.array(z.object({
    id: graphIdentitySchema, subjectID: graphIdentitySchema, subject: z.string(), predicate: z.string(),
    objectID: graphIdentitySchema, object: z.string(),
  })),
  sources: z.array(z.object({ id: z.string(), role: z.enum(["user", "assistant"]) })),
  truncated: z.literal(false),
})
export const graphDetailRecordSchema = graphBrowseRecordSchema.extend({
  sources: z.array(z.object({ id: z.string(), role: z.enum(["user", "assistant"]), text: z.string() })),
})
export type GraphSnapshotInput = z.infer<typeof graphSnapshotInput>
export type GraphBrowseRecord = z.infer<typeof graphBrowseRecordSchema>
export type GraphDetailRecord = z.infer<typeof graphDetailRecordSchema>
export type GraphSnapshot = {
  sessionID: string; revision: string; status: GraphStatus; records: GraphBrowseRecord[]
  hasMore: boolean; nextCursor?: string; truncated: boolean; resetRequired: boolean
}
export type GraphDetail = {
  sessionID: string; revision: string; status: GraphStatus; record: GraphDetailRecord | null; resetRequired: boolean
}
const cursorSchema = z.object({ v: z.literal(1), scope: graphIdentitySchema, revision: graphIdentitySchema,
  offset: z.number().int().min(1).max(GRAPH_LIMITS.records) }).strict()
export function graphCursor(scope: string, revision: string, offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, scope, revision, offset })).toString("base64url")
}
export function readGraphCursor(value: string | undefined, scope: string) {
  if (!value) return undefined
  let decoded: z.infer<typeof cursorSchema>
  try {
    if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("encoding")
    decoded = cursorSchema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")))
  } catch { throw new GraphValidationError("Graph browser cursor is invalid") }
  if (decoded.scope !== scope) throw new GraphValidationError("Graph browser cursor scope does not match this session and query")
  return decoded
}
export function graphBrowseRecord(sessionID: string, key: string, digest: string, createdAt: number,
  extraction: Extraction, sources: Source[]): GraphDetailRecord {
  return { sessionID, key, digest, createdAt, ...extraction, sources, truncated: false,
    triples: extraction.triples.map((triple, ordinal) => ({ ...triple,
      id: graphHash([sessionID, key, digest, ordinal, triple]),
      subjectID: graphHash([sessionID, graphNormalized(triple.subject)]),
      objectID: graphHash([sessionID, graphNormalized(triple.object)]),
    })) }
}
