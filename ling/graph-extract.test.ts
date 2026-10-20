import { describe, expect, test } from "bun:test"
import { buildGraphExtractionPrompt, GRAPH_EXTRACTION_MARKER, parseGraphExtraction } from "./graph-extract"
import {
  GRAPH_LIMITS, GraphValidationError, graphFailureReason, turnIdentity, validateGraphTurn,
  visibleSourceDigests, type Extraction, type GraphTurn,
} from "./graph-types"

const turn: GraphTurn = {
  createdAt: 1_700_000_000_000,
  sources: [
    { id: "msg-user-1", role: "user", text: "把项目 Quartz 的周会移到周四。\n不要改变参与人。" },
    { id: "msg-assistant-1", role: "assistant", text: "周会已移到周四，参与人保持不变。" },
  ],
}
const extraction: Extraction = {
  summary: "Quartz 项目周会已移到周四，参与人不变。",
  outcome: "completed",
  triples: [{ subject: "Quartz 项目周会", predicate: "移到", object: "周四" }],
}

describe("bounded visible-turn extraction", () => {
  test("round trips the strict data contract and sends only validated visible sources", () => {
    // given
    const prompt = buildGraphExtractionPrompt(turn)
    // when
    const parsed = parseGraphExtraction(JSON.stringify(extraction))
    // then
    expect(parsed).toEqual(extraction)
    expect(prompt.startsWith(GRAPH_EXTRACTION_MARKER)).toBe(true)
    expect(prompt.includes(JSON.stringify(turn.sources))).toBe(true)
    expect(parseGraphExtraction(JSON.stringify({ ...extraction, triples: [], outcome: "unknown" })).triples).toEqual([])
  })

  test("rejects fences, multiple objects, primitives, missing fields and extra fields", () => {
    // given
    const invalid = [
      "```json\n" + JSON.stringify(extraction) + "\n```",
      JSON.stringify(extraction) + JSON.stringify(extraction),
      "null", "[]", '"text"', "{}",
      JSON.stringify({ summary: extraction.summary, triples: [] }),
      JSON.stringify({ ...extraction, outcome: "success" }),
      JSON.stringify({ ...extraction, reasoning: "PRIVATE_REASONING" }),
      JSON.stringify({ ...extraction, triples: [{ ...extraction.triples[0], confidence: 1 }] }),
    ]
    // when / then
    for (const input of invalid) expect(() => parseGraphExtraction(input)).toThrow(GraphValidationError)
  })

  test("enforces summary, triples, field and raw output budgets", () => {
    // given
    const invalid: unknown[] = [
      { ...extraction, summary: "x".repeat(GRAPH_LIMITS.summaryChars + 1) },
      { ...extraction, summary: "  " },
      { ...extraction, triples: Array(GRAPH_LIMITS.triples + 1).fill(extraction.triples[0]) },
      { ...extraction, triples: [{ subject: "x".repeat(GRAPH_LIMITS.entityChars + 1), predicate: "is", object: "y" }] },
      { ...extraction, triples: [{ subject: "x", predicate: "x".repeat(GRAPH_LIMITS.predicateChars + 1), object: "y" }] },
      { ...extraction, triples: [{ subject: "x", predicate: "is", object: "" }] },
    ]
    // when / then
    for (const input of invalid) expect(() => parseGraphExtraction(JSON.stringify(input))).toThrow(GraphValidationError)
    expect(() => parseGraphExtraction(" ".repeat(GRAPH_LIMITS.extractionBytes + 1))).toThrow(GraphValidationError)
  })

  test("rejects tool/reasoning records, assistant-only turns, duplicates and oversized UTF-8 sources", () => {
    // given
    const invalid: unknown[] = [
      { ...turn, sources: [{ id: "tool", role: "tool", text: "tool content" }, turn.sources[1]] },
      { ...turn, sources: [{ ...turn.sources[0], reasoning: "private" }, turn.sources[1]] },
      { ...turn, sources: [turn.sources[1], { ...turn.sources[1], id: "a2" }] },
      { ...turn, sources: [turn.sources[0], { ...turn.sources[1], id: turn.sources[0].id }] },
      { ...turn, sources: [turn.sources[0], { ...turn.sources[1], text: "中".repeat(11_000) }] },
      { ...turn, sources: [turn.sources[0], turn.sources[1], { ...turn.sources[0], id: "user-2" }] },
      { ...turn, sources: [turn.sources[0], ...Array.from({ length: GRAPH_LIMITS.sources }, (_, index) => ({ ...turn.sources[1], id: `assistant-${index}` }))] },
      { ...turn, createdAt: Number.NaN },
      { ...turn, sources: [turn.sources[0]] },
    ]
    // when / then
    for (const input of invalid) {
      expect(() => validateGraphTurn(input)).toThrow(GraphValidationError)
      expect(() => buildGraphExtractionPrompt(input as GraphTurn)).toThrow(GraphValidationError)
    }
  })

  test("keys stable native identities separately from exact role/text digests", () => {
    // given
    const identity = turnIdentity(validateGraphTurn(turn))
    // when
    const repeated = turnIdentity(validateGraphTurn({ ...turn, createdAt: turn.createdAt + 1 }))
    const edited = turnIdentity(validateGraphTurn({ ...turn, sources: [turn.sources[0], { ...turn.sources[1], text: "修订后的回答。" }] }))
    // then
    expect(repeated).toEqual(identity)
    expect(edited.key).toBe(identity.key)
    expect(edited.digest).not.toBe(identity.digest)
    expect(() => visibleSourceDigests([turn.sources[0], turn.sources[0]])).toThrow(GraphValidationError)
  })

  test("preserves consecutive queued users as one bounded turn with their shared answer", () => {
    // given
    const combined: GraphTurn = { ...turn, sources: [
      turn.sources[0], { id: "queued-user", role: "user", text: "也请保留原来的会议链接。" }, turn.sources[1],
    ] }
    // when / then
    expect(validateGraphTurn(combined).sources).toEqual(combined.sources)
    expect(buildGraphExtractionPrompt(combined).includes(JSON.stringify(combined.sources))).toBe(true)
    expect(() => validateGraphTurn({ ...combined, sources: combined.sources.slice(0, 2) })).toThrow(GraphValidationError)
    expect(() => validateGraphTurn({ ...combined, sources: [
      { ...combined.sources[0], text: "x".repeat(16_384) },
      { ...combined.sources[1], text: "y".repeat(16_384) }, combined.sources[2],
    ] })).toThrow(GraphValidationError)
  })

  test("errors never expose model output, credentials or conversation text", () => {
    // given
    const secret = "PRIVATE_USER_CONTENT_AND_API_KEY=sk-sensitive"
    // when / then
    try { parseGraphExtraction('{"summary": "' + secret) }
    catch (error) { expect(String(error)).not.toContain(secret) }
    for (const reason of [
      new Error("provider timeout " + secret), "schema violation " + secret,
      "401 " + secret, "queue capacity exceeded " + secret, "runtime stopped " + secret,
      "source unavailable " + secret, "storage unavailable " + secret, secret,
    ]) {
      const message = graphFailureReason(reason)
      expect(message).not.toContain(secret)
      expect(message.length).toBeLessThanOrEqual(160)
      expect(graphFailureReason(message)).toBe(message)
    }
  })
})
