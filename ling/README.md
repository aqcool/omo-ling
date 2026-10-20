# omo-ling

OpenCode plugin for LING Studio. Maintained at https://github.com/aqcool/omo-ling.

## Install

Requires **OpenCode 2.0.32**. Until npm publication, build a fixed commit with the recipe below, copy the resulting `ling/dist/` directory to a permanent writable directory, and reference that absolute directory in the selected OpenCode configuration:

```json
{
  "plugins": ["/absolute/path/to/omo-ling/commit"]
}
```

This is the relevant field only; preserve all other configuration fields. OpenCode 2.0.32's `plugin add` command accepts registry/Git package specifiers, not local directories. Local directory references are supported by the plugin loader.

Keep a source commit and file digests alongside the copy. Install directories must not be temporary worktrees or signed application resources. Back up the selected configuration before removing the previous `oh-my-openagent` entry. Reconnect and verify `omo-ling` is active.

After the npm version is published, replace the local directory entry with:

```sh
opencode plugin add omo-ling@0.3.0
```

LING users should add the same fixed version through the application's plugin manager, using its bundled OpenCode. Reconnect and check that the plugin is **active**. An installed configuration entry alone is not proof of successful loading. Remove the old `oh-my-openagent` entry from the same configuration when switching, preserving other settings.

## Included

- Community port's agent definitions, glob/grep tools, hooks and background task manager.
- Background tasks use the current hosting OpenCode instance, including private `serve --stdio` instances; native child sessions carry the parent's ID.
- Todo RPC persistence in the current host's session metadata; failed reads return an error.
- Host-owned MCP servers and skills; no extra default remote servers or home-directory skill scan.

The community port's shortened agent prompts and partial hook/tool surface are not equivalent to all features of the original plugin. TUI extensions are not included in this desktop server package. No model-provider defaults or credentials are bundled.

## Goal mode and memory

Both features register native commands and tools by default. They do not create a goal for an ordinary conversation.

- `/goal <objective>` starts a session goal. `/goal` or `/goal status` reads it. `/goal pause`, `resume`, `complete`, and `clear` manage it explicitly.
- Tools `create_goal`, `get_goal`, `update_goal` use the executing session identity. Creation requires explicit user intent; unfinished goals cannot be silently replaced. In OpenCode Code Mode these are called through the native `execute` catalog.
- A successful execution with an unfinished active goal schedules the next round. Failure, interruption or the iteration limit pauses it. The default limit is 100 rounds per explicit start/resume (1000 cumulative maximum); it is an execution limit, not a token or spending budget. Token totals include observed input/output usage, not estimated cost. An in-flight pause must finish before resuming.
- Goals persist in the hosting plugin's storage by session ID. Restarted active goals become paused; reconnecting does not automatically request model work. Completion requires an evidence check against the actual objective.
- `/memory` or `/memory status` reports repository health. `/memory list`, `/memory read system/project.md`, `/memory search <words>` inspect committed content without a model request.
- Tools `memory` and `memory_read` write and retrieve durable facts and preferences. Writes reuse upstream memory-core validation, writer locks and Git commits. Supported mutations: create, replace, insert, delete, rename, description update and transactional patch. Read-only blocks and dirty repositories are protected.
- Manually written Git memory is shared by conversations and agent roles in the same **profile + canonical project**. Different profiles/projects are isolated. For folders outside Git, the actual folder supplies project identity. A moved project/config path currently gets a new identity; there is no implicit migration.
- Default location: `${XDG_DATA_HOME:-~/.local/share}/omo-ling/memory/agents/<identity>/repo`. `OMO_LING_MEMORY_HOME` can override the root with an absolute path. `system/*.md` is concise injected context; other blocks can be retrieved. Both context and compaction hooks use committed HEAD only and bounded output. No secrets should be saved.
- Automatic session graph memory complements these explicit project notes. Both run in the native plugin on the execution host; LING delivers the plugin and shows native results. Remote synchronization is not included.

### Automatic session graph memory

Graph extraction is **enabled by default**. After a newly observed real user turn completes successfully, the plugin makes one additional stateless native model request to summarize the visible user/assistant text and produce navigation triples. The request uses the completed assistant's actual model, with OpenCode's base provider configuration. It follows that provider's actual billing; no separate model account is configured. A project-only provider unavailable in base configuration produces a visible extraction failure rather than a silent model substitution. Normal conversation completion is independent of extraction success.

The SQLite database is local to the execution host at `${OMO_LING_MEMORY_HOME:-${XDG_DATA_HOME:-~/.local/share}/omo-ling/memory}/graphs/<identity>.sqlite`. Every record is scoped by profile, canonical project, and native session ID. The database retains the bounded visible source Q/A, native message IDs, summary, outcome, and triples. Extraction sends that visible source text to the selected model provider through the host; no external graph database, embedding endpoint, or vector service is used.

Recall uses bounded lexical matching, including CJK terms, and one-hop navigation through stored triples. Normal context and compaction requests receive relevant results as ordinary historical data with source roles and IDs. Summaries remain model-derived and may be wrong. Tools, reasoning, recalled context, and compaction summaries are not treated as new user source facts. Synthetic-only continuations, failed/interrupted runs, and ambiguous or incomplete source turns do not trigger extraction. There is no automatic historical backfill or promotion into shared project memory.

Native forks have their own session scope. OpenCode rewrites copied message IDs; inheritance verifies the native fork edge and exact boundary, compares the ordered raw parent/child prefix, and remaps retained facts to the child's actual source IDs. Editing a sent message creates a native fork before that message, so its old text and later history are excluded. If compaction has hidden the boundary or raw sources needed to prove a prefix, inheritance fails closed. Existing memory in the original session remains available across compaction.

Use the existing memory entry:

- `/memory graph status` shows initialized, ready, pending, failed, queued, generating, and provider-waiting state, plus a bounded failure reason.
- `/memory graph search <words>` returns matching summaries and their actual source Q/A.
- `/memory graph retry` explicitly retries failed work whose raw native sources are still valid. There is no automatic retry.
- `/memory graph clear` removes this session's graph records and invalidates queued/in-flight writes. It does not alter native chat history or shared Git memory.
- `memory_read` accepts `graph_status` and `graph_search` (with `query`). The executing tool context supplies the native session; callers cannot choose a different session in the tool input.

The default extraction timeout is 30 seconds, with a 120-second durable work lease. The queue is bounded. A crash can leave work pending until its lease expires, after which status reports failure; restarting does not replay it automatically. OpenCode 2.0.32's in-process Promise adapter does not propagate a generation AbortSignal. Timeout, clear, deletion, and plugin disposal discard late results, but cannot promise to cancel the provider request or its cost. A timed-out native call holds the generation slot until it settles; `waitingForNativeCall` reports that distinction.

Optional native plugin configuration (preserve all other fields):

```json
{
  "plugins": [{
    "package": "/absolute/path/to/omo-ling/commit",
    "options": {
      "goal": {"default_max_iterations": 100},
      "memory": {
        "enabled": true,
        "graph": {"enabled": true, "timeout_ms": 30000, "max_pending": 32}
      }
    }
  }]
}
```

Set `memory.graph.enabled` to `false` (or `memory.graph` to `false`) to disable automatic graph extraction and recall while keeping explicit project memory. Set `goal.enabled` or `memory.enabled` to `false` to disable the corresponding entire registration. Data is retained. Graph `timeout_ms` is capped at 120000 and `max_pending` at 32. Command reports use native synthetic messages with `resume: false`; hosts must display these messages/inbox entries to show a result without inference.

Goal behavior is adapted from upstream `d1317056` (`hooks/goal`); persistence and lifecycle use the native API. Explicit project memory reuses this fork's `packages/memory-core` public domain APIs. The graph summary/outcome/triples contract and source-linked navigation are adapted from [adoresever/graph-memory](https://github.com/adoresever/graph-memory/tree/5841b1987c3967998818764c9d4238add5f3aa7c), fixed commit `5841b1987c3967998818764c9d4238add5f3aa7c`, under its MIT license. This is a scoped adaptation, not the full upstream SDK or its host adapters. The upstream copyright and license are included in the built `THIRD-PARTY-NOTICES.md`.

### Session graph RPC

`POST /api/rpc/omo.memory.graph/<method>` requires `{"input":{"sessionID":"..."}}`. `status`, `clear`, and `retry` return native RPC outputs containing `{"status":{...}}`; `search` additionally requires `query` and returns `{"results":[...]}`. Each call validates the native session's execution location and project. Missing or mismatched session identity returns an error. The sessionless project-memory RPC cannot read graph data.

Status distinguishes enabled/available, persistent ready/pending/failed counts, queue activity, and `waitingForNativeCall`. Search results contain `sessionID`, `key`, `digest`, `createdAt`, `summary`, `outcome`, `triples`, `sources` (`id`, `role`, `text`), lexical/graph match type, and truncation flags. Output is bounded; truncated source text is marked. Reading status or searching does not request model work.

### Goal editor RPC

`POST /api/rpc/omo.goal/get` accepts `{"input":{"sessionID":"..."}}` and returns a native RPC output containing `{ "goal": Goal | null }`. Desktop editors save the existing goal with `POST /api/rpc/omo.goal/edit`:

```json
{
  "input": {
    "sessionID": "...",
    "objective": "Revised objective",
    "expectedObjective": "Original objective from get",
    "expectedCreatedAt": 1700000000000
  }
}
```

Both methods validate the native session. The edit compares the original objective and creation time atomically with the write; a missing, replaced, or concurrently edited goal returns an error without overwriting it. Usage updates do not cause an edit conflict. The response contains the updated goal. The objective is trimmed and must contain 1 to 16000 characters. Editing preserves status, creation time and cumulative usage, does not resume or enqueue a model round, and supplies the revised objective to subsequent active-goal context and compaction hooks.

Declared RPC failures are `goal.not_found` for a session with no goal and `goal.conflict` for a stale editor snapshot. On a conflict, keep the unsaved text and reload the current goal before explicitly retrying. Invalid input uses the host's `rpc.invalid_input` response. A nonexistent native session fails the host validation before goal storage is accessed.

Returned goals may include `runningSince`, an epoch timestamp in milliseconds for the current active execution. It is a transient snapshot, never persisted. `timeUsedSeconds` remains the completed execution total; while `runningSince` is present, a client can add elapsed time since that timestamp for its live display. Paused, completed, idle and restarted goals omit it. Reading either snapshot never starts model work.

## Reproduce the package

From the repository root, with Node/npm and Bun 1.2.19 or later:

```sh
npm ci --prefix ling --ignore-scripts
cd ling
bun run build
npm pack ./dist --ignore-scripts
python3 qa.py --cli /absolute/path/to/opencode
python3 qa-goal-memory.py --cli /absolute/path/to/opencode
python3 qa-graph-memory.py --cli /absolute/path/to/opencode
```

The build produces a standalone `dist/` directory without TypeScript sources or node_modules and bundles runtime dependencies into `index.js`; end users need no install scripts, compiler, or runtime dependency download beyond the package. Build dependencies are pinned in `package-lock.json`. Goal/project-memory QA explicitly disables graph extraction to isolate its commands, Code Mode tools, execution events, continuation limits, interruption, and restart behavior. Graph QA exercises the real native HTTP/SSE surface with a deterministic local model, source IDs, native before/through forks, failure/retry, late-result fences, recall, compaction, restart, and opt-out. Both use isolated HOME/XDG roots, compare the real session database count before/after, and make no paid model requests. The no-inference QA tests actual loading, agents, todo roundtrip, missing-session errors, and filesystem tools.

Source: `fazulfi/omo-v2` commit `8907576a64e6c1357581033f0195e742946059bc`, itself based on `code-yeongyu/oh-my-openagent` 5.1.4. Sustainable Use License 1.0 and original third-party notices are included. The name change does not change those license terms.
