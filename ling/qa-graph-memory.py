"""Native OpenCode HTTP/SSE graph-memory QA against a local deterministic provider."""

import argparse
import base64
import contextlib
import http.server
import json
import pathlib
import re
import secrets
import selectors
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request


EXTRACTION_MARKER = "<omo_ling_graph_extract_v1>"
CASE_PATTERN = re.compile(r"QA_GRAPH_[A-Z_]+")
ALPHA = "QA_GRAPH_ALPHA"
BETA = "QA_GRAPH_BETA"


def wait(check, label, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.05)
    raise AssertionError("Timed out: " + label)


def real_session_count():
    path = pathlib.Path.home() / ".local/share/opencode/opencode.db"
    if not path.exists():
        return None
    with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as database:
        return database.execute("SELECT count(*) FROM session").fetchone()[0]


class Fixture:
    """The only model endpoint reachable by the isolated host configuration."""

    def __init__(self):
        self.requests = []
        self.lock = threading.Lock()
        self.phase = "normal"
        self.modes = {}
        self.holds = {}
        self.released = {}
        self.errors = []
        self.tool_plan = []
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                try:
                    body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                    text = json.dumps(body, ensure_ascii=False)
                    extracting = EXTRACTION_MARKER in text
                    markers = CASE_PATTERN.findall(text)
                    case = markers[-1] if markers else "QA_GRAPH_GENERIC"
                    with fixture.lock:
                        ordinal = len(fixture.requests) + 1
                        mode = fixture.modes.get(case, "normal") if extracting else "normal"
                        request = {
                            "ordinal": ordinal, "path": self.path,
                            "kind": "extract" if extracting else fixture.phase,
                            "case": case, "mode": mode,
                            "stream": bool(body.get("stream")), "body": body,
                            "completed": False,
                        }
                        fixture.requests.append(request)
                        action = fixture.tool_plan.pop(0) if not extracting and fixture.tool_plan else None
                    tool = None
                    if action:
                        names = [item.get("name", item.get("function", {}).get("name"))
                                 for item in body.get("tools", [])]
                        matches = [name for name in names if name == "memory_read"
                                   or (name and (name.endswith("_memory_read") or name.endswith(".memory_read")))]
                        if not matches and "execute" in names:
                            assert "tools.memory_read(" in body.get("instructions", ""), "memory_read not exposed"
                            tool = ("execute", {"code": "return await tools.memory_read(" + json.dumps(action) + ")"})
                        else:
                            assert len(matches) == 1, "memory_read tool is unavailable"
                            tool = (matches[0], action)
                        request["tool"] = tool[0]
                    if mode == "hold":
                        fixture.holds[case].set()
                        if not fixture.released[case].wait(90):
                            raise AssertionError("Fixture generation was never released")
                    if extracting:
                        output = "{malformed" if mode == "malformed" else json.dumps({
                            "summary": case + ": the user selected cobalt and the assistant acknowledged it.",
                            "outcome": "informational",
                            "triples": [{"subject": case, "predicate": "selected", "object": "cobalt"}],
                        })
                    elif fixture.phase == "compaction":
                        # OpenCode validates this native summary template before
                        # emitting compaction.ended; plain text is a failed operation.
                        output = (
                            "## Objective\n- Retain the user's cobalt choice.\n\n"
                            "## Requirements\n- The user chose cobalt.\n\n"
                            "## Decisions\n- Cobalt is the chosen color.\n\n"
                            "## Work State\n### Completed\n- The assistant acknowledged the choice.\n\n"
                            "### Active\n- (none)\n\n### Blocked\n- (none)\n\n"
                            "## Next Move\n1. (none)\n\n## Relevant Files\n- (none)\n\n"
                            "## Important Context\n- The choice belongs to this conversation."
                        )
                    else:
                        output = "The assistant acknowledges " + case + " and the user's cobalt choice."
                    self.respond(body, ordinal, output, tool)
                    with fixture.lock:
                        request["completed"] = True
                except (BrokenPipeError, ConnectionResetError):
                    # A disposed host may disconnect; this is not a provider failure.
                    with fixture.lock:
                        if "request" in locals():
                            request["completed"] = True
                except Exception as error:
                    with fixture.lock:
                        fixture.errors.append(type(error).__name__ + ": " + str(error))
                    with contextlib.suppress(OSError):
                        self.send_error(500, "fixture failure")

            def respond(self, body, ordinal, output, tool=None):
                call = "fixture_" + str(ordinal)
                usage = {"input_tokens": 10, "output_tokens": 5,
                         "input_tokens_details": {"cached_tokens": 0},
                         "output_tokens_details": {"reasoning_tokens": 0}}
                if "/responses" in self.path:
                    item = {"type": "function_call", "id": "fc_" + call, "call_id": call,
                            "name": tool[0], "arguments": json.dumps(tool[1]), "status": "completed"} if tool else {
                            "type": "message", "id": "msg_" + call, "role": "assistant",
                            "content": [{"type": "output_text", "text": output, "annotations": []}],
                            "status": "completed"}
                    result = {"id": "resp_" + call, "object": "response", "created_at": int(time.time()),
                              "model": "gpt-fake", "status": "completed", "output": [item], "usage": usage}
                    events = [
                        {"type": "response.created", "response": dict(result, status="in_progress", output=[])},
                        {"type": "response.output_item.added", "output_index": 0,
                         "item": dict(item, arguments="") if tool else dict(item, content=[])},
                        {"type": "response.function_call_arguments.delta", "item_id": item["id"], "output_index": 0,
                         "delta": item["arguments"]} if tool else {
                         "type": "response.output_text.delta", "item_id": item["id"], "output_index": 0,
                         "content_index": 0, "delta": output},
                        {"type": "response.output_item.done", "output_index": 0, "item": item},
                        {"type": "response.completed", "response": result},
                    ]
                else:
                    common = {"id": call, "model": "gpt-fake", "created": int(time.time())}
                    tool_call = {"id": call, "type": "function",
                                 "function": {"name": tool[0], "arguments": json.dumps(tool[1])}} if tool else None
                    message = {"role": "assistant", "tool_calls": [tool_call]} if tool else {
                        "role": "assistant", "content": output}
                    delta = {"role": "assistant", "tool_calls": [dict(tool_call, index=0)]} if tool else message
                    result = dict(common, object="chat.completion",
                                  choices=[{"index": 0, "message": message,
                                            "finish_reason": "tool_calls" if tool else "stop"}],
                                  usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15})
                    events = [
                        dict(common, object="chat.completion.chunk",
                             choices=[{"index": 0, "delta": delta,
                                       "finish_reason": None}]),
                        dict(common, object="chat.completion.chunk",
                             choices=[{"index": 0, "delta": {}, "finish_reason": "tool_calls" if tool else "stop"}],
                             usage=result["usage"]),
                    ]
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream" if body.get("stream") else "application/json")
                self.end_headers()
                if body.get("stream"):
                    for event in events:
                        self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
                    self.wfile.write(b"data: [DONE]\n\n")
                else:
                    self.wfile.write(json.dumps(result).encode())

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def hold(self, case):
        self.modes[case] = "hold"
        self.holds[case] = threading.Event()
        self.released[case] = threading.Event()

    def extract_requests(self, case=None):
        with self.lock:
            return [request for request in self.requests
                    if request["kind"] == "extract" and (case is None or request["case"] == case)]

    def receipt(self):
        with self.lock:
            return [{key: value for key, value in request.items() if key != "body"} for request in self.requests]

    def close(self):
        for release in self.released.values():
            release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)


class Host:
    def __init__(self, cli, package, fixture, root, enabled=True):
        self.cli, self.package, self.fixture, self.root = cli, package, fixture, root
        self.proc = None
        self.url = None
        self.events = []
        self.last_status = {}
        self.sessions = []
        self.processes = []
        self.watchers = []
        self.password = secrets.token_hex(24)
        self.authorization = "Basic " + base64.b64encode(("opencode:" + self.password).encode()).decode()
        for name in ("home", "config/opencode", "data", "cache", "state", "workspace"):
            (root / name).mkdir(parents=True, exist_ok=True)
        self.configure(enabled)
        self.env = {
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "HOME": str(root / "home"), "OPENCODE_TEST_HOME": str(root / "home"),
            "OPENCODE_CONFIG_DIR": str(root / "config/opencode"),
            "OPENCODE_SERVER_PASSWORD": self.password, "OPENCODE_DISABLE_AUTOUPDATE": "1",
            "OPENCODE_DISABLE_MODELS_FETCH": "1", "OMO_LING_MEMORY_HOME": str(root / "memory"),
        }
        for name in ("CONFIG", "DATA", "CACHE", "STATE"):
            self.env["XDG_" + name + "_HOME"] = str(root / name.lower())
        self.log = (root / "host.log").open("w+")

    def configure(self, enabled):
        options = {"goal": False, "memory": {"graph": {"timeout_ms": 60000} if enabled else False}}
        config = {
            "plugins": [{"package": str(self.package), "options": options}],
            "model": "fixture/gpt-fake", "update": "disable", "instructions": [],
            "permissions": [{"action": "*", "resource": "*", "effect": "allow"}],
            "providers": {"fixture": {
                "canonical": "openai",
                "settings": {"baseURL": "http://127.0.0.1:" + str(self.fixture.server.server_port) + "/v1",
                             "apiKey": "isolated-fake-key", "transport": "http", "encoding": "none"},
                "models": {"gpt-fake": {"capabilities": {"tools": True},
                                      "limit": {"context": 200000, "output": 8192}}},
            }},
        }
        (self.root / "config/opencode/opencode.json").write_text(json.dumps(config))

    def start(self):
        self.proc = subprocess.Popen(
            [str(self.cli), "serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"],
            cwd=self.root / "workspace", env=self.env, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=self.log, text=True,
        )
        self.processes.append(self.proc)
        with selectors.DefaultSelector() as ready:
            ready.register(self.proc.stdout, selectors.EVENT_READ)
            assert ready.select(25), "native host did not publish its ready address"
        self.url = json.loads(self.proc.stdout.readline())["url"].rstrip("/")
        # Loading the location is required on a cold host; HTTP readiness alone is insufficient.
        wait(lambda: any(plugin.get("id") == "omo-ling" and plugin.get("state", {}).get("status") == "active"
                         for plugin in self.api("/api/plugin")["data"]), "cold plugin active")
        connected = threading.Event()
        url = self.url

        def watch():
            request = urllib.request.Request(url + "/api/event", headers={"Authorization": self.authorization})
            try:
                with urllib.request.urlopen(request, timeout=120) as stream:
                    connected.set()
                    for line in stream:
                        if line.startswith(b"data:"):
                            event = json.loads(line[5:])
                            data = event.get("data", {})
                            self.events.append({
                                "type": event.get("type"), "id": event.get("id"),
                                "created": event.get("created"), "seq": event.get("durable", {}).get("seq"),
                                "location": event.get("location"),
                                "sessionID": data.get("sessionID"), "inboxID": data.get("inboxID"),
                                "itemType": data.get("item", {}).get("type"),
                                "assistantMessageID": data.get("assistantMessageID"), "finish": data.get("finish"),
                                **({"error": data["error"]} if "error" in data else {}),
                            })
            except (OSError, ValueError):
                pass

        thread = threading.Thread(target=watch, daemon=True)
        self.watchers.append(thread)
        thread.start()
        assert connected.wait(5), "native SSE did not connect"

    def api(self, path, data=None, allow_error=False, method=None):
        separator = "&" if "?" in path else "?"
        query = urllib.parse.urlencode({"location[directory]": str(self.root / "workspace")})
        request = urllib.request.Request(
            self.url + path + separator + query,
            data=None if data is None else json.dumps(data).encode(), method=method,
            headers={"Content-Type": "application/json", "Authorization": self.authorization},
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as error:
            raw = error.read().decode()
            with contextlib.suppress(ValueError):
                payload = json.loads(raw)
                if allow_error:
                    return {"status": error.code, "type": payload.get("type")}
                raise AssertionError(path + " returned " + str(error.code) + ": " + str(payload.get("type")))
            if allow_error:
                return {"status": error.code, "type": "unstructured_error"}
            raise AssertionError(path + " returned " + str(error.code)) from error

    def rpc(self, method, session, **fields):
        output = self.api("/api/rpc/omo.memory.graph/" + method,
                          {"input": {"sessionID": session, **fields}})
        output = output.get("data", output)
        return output.get("output", output)

    def status(self, session):
        status = self.rpc("status", session)["status"]
        self.last_status[session] = status
        return status

    def search(self, session, query):
        return self.rpc("search", session, query=query)["results"]

    def new(self):
        session = self.api("/api/session", {
            "title": "QA graph memory; suppress automatic title request",
            "location": {"directory": str(self.root / "workspace")},
        })["data"]["id"]
        self.sessions.append(session)
        return session

    def prompt(self, session, case):
        return self.api("/api/session/" + session + "/prompt",
                        {"text": case + ": I choose cobalt for this task."})["data"]["id"]

    def terminal(self, session):
        self.api("/api/experimental/session/" + session + "/wait", {})
        wait(lambda: any(event["sessionID"] == session and event["type"] == "session.execution.succeeded"
                         for event in self.events), "native execution success")
        info = self.api("/api/session/" + session)["data"]
        assert info.get("outcome") == "succeeded", "normal prompt failed"

    def messages(self, session):
        messages = []
        cursor = None
        for _ in range(10):
            query = {"limit": 200, **({"cursor": cursor} if cursor else {"order": "asc"})}
            result = self.api("/api/session/" + session + "/message?" + urllib.parse.urlencode(query))
            messages.extend(result["data"])
            cursor = result.get("cursor", {}).get("next")
            if not cursor:
                return messages
        raise AssertionError("fixture exceeded native history page bound")

    def settled(self, session, ready, failed=0):
        def check():
            status = self.status(session)
            return status if (status["ready"] == ready and status["failed"] == failed
                              and status["pending"] == 0 and not status.get("queued")
                              and not status.get("generating") and not status.get("waitingForNativeCall")) else None
        return wait(check, "graph status ready=" + str(ready) + " failed=" + str(failed))

    def graph_snapshot(self, session):
        """Read the isolated graph database when native session removal forbids RPC."""
        files = list((self.root / "memory/graphs").glob("*.sqlite"))
        assert len(files) == 1, "isolated workspace should own exactly one graph database"
        with sqlite3.connect(files[0].as_uri() + "?mode=ro", uri=True) as database:
            row = database.execute(
                "SELECT deleted, epoch, generation FROM graph_sessions WHERE session_id = ?", (session,),
            ).fetchone()
            return {
                "deleted": bool(row and row[0]), "epoch": row[1] if row else None,
                "generation": row[2] if row else None,
                "turns": database.execute("SELECT count(*) FROM graph_turns WHERE session_id = ?", (session,)).fetchone()[0],
                "triples": database.execute("SELECT count(*) FROM graph_triples WHERE session_id = ?", (session,)).fetchone()[0],
            }

    def diagnostics(self):
        """Only native identity/state receipts; no raw prompt or host log contents."""
        result = {"lastStatus": self.last_status, "events": self.events[-160:],
                  "requestedLocation": {"directory": str(self.root / "workspace")},
                  "sessions": []}
        for session in self.sessions[-6:]:
            try:
                info = self.api("/api/session/" + session)["data"]
                messages = self.api("/api/session/" + session + "/context")["data"]
                result["sessions"].append({
                    "id": session, "projectID": info.get("projectID"),
                    "location": info.get("location"), "fork": info.get("fork"),
                    "outcome": info.get("outcome"), "context": message_receipt(messages),
                })
            except Exception as error:
                result["sessions"].append({"id": session, "error": type(error).__name__})
        return result

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.stdin.close()
            try:
                self.proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait(timeout=5)
            self.proc.stdout.close()
        for watcher in self.watchers:
            watcher.join(timeout=1)

    def close(self):
        self.stop()
        self.log.close()


def message_receipt(messages):
    return [{"id": message["id"], "type": message["type"], "time": message.get("time"),
             "metadata": message.get("metadata"),
             **({"status": message["status"]} if "status" in message else {}),
             **({"error": message["error"]} if "error" in message else {}),
             **({"finish": message.get("finish"), "model": message.get("model")}
                if message["type"] == "assistant" else {})} for message in messages]


def source_ids(results):
    return {source["id"] for result in results for source in result["sources"]}


def recall_blocks(value):
    """Find the injected structured results, without asserting authored prompt prose."""
    if isinstance(value, dict):
        return [block for child in value.values() for block in recall_blocks(child)]
    if isinstance(value, list):
        return [block for child in value for block in recall_blocks(child)]
    if not isinstance(value, str):
        return []
    blocks = []
    for match in re.finditer(r"\[\{", value):
        try:
            parsed, _end = json.JSONDecoder().raw_decode(value, match.start())
        except ValueError:
            continue
        if isinstance(parsed, list) and parsed and all(
            isinstance(item, dict) and "sessionID" in item and "sources" in item and "summary" in item
            for item in parsed
        ):
            blocks.extend(parsed)
    return blocks


def assert_sources(host, session, results, expected_user):
    history = {message["id"]: message for message in host.messages(session)}
    assert results and expected_user in source_ids(results), "graph omitted the real user source"
    for result in results:
        assert result["sessionID"] == session, "graph returned another native session"
        assert {source["role"] for source in result["sources"]} == {"user", "assistant"}, "Q/A sources incomplete"
        for source in result["sources"]:
            native = history[source["id"]]
            assert native["type"] == source["role"], "graph source role differs from native history"
            text = native["text"] if native["type"] == "user" else "\n".join(
                part["text"] for part in native["content"] if part["type"] == "text")
            assert source["text"] == text, "graph source text differs from the native message"


def native_prefix_probe(host, graph_ready=False):
    session = host.new()
    first_user = host.prompt(session, ALPHA)
    host.terminal(session)
    if graph_ready:
        host.settled(session, 1)
    second_user = host.prompt(session, BETA)
    host.terminal(session)
    if graph_ready:
        host.settled(session, 2)
    history = host.messages(session)
    native_ids = [message["id"] for message in history]
    before = host.api("/api/session/" + session + "/fork", {"before": second_user})["data"]
    through = host.api("/api/session/" + session + "/fork", {})["data"]
    before_history = host.messages(before["id"])
    through_history = host.messages(through["id"])
    assert before["fork"] == {"sessionID": session, "boundary": {"type": "before", "messageID": second_user}}
    assert through["fork"] == {"sessionID": session,
                              "boundary": {"type": "through", "messageID": native_ids[-1]}}
    before_ids = [message["id"] for message in before_history]
    through_ids = [message["id"] for message in through_history]
    # Native v2 forks rewrite IDs, including user/assistant IDs. Verify the exact
    # ordered projected prefix and retain the observed parent -> child mapping.
    without_id = lambda rows: [{key: value for key, value in row.items() if key != "id"} for row in rows]
    parent_prefix = history[:native_ids.index(second_user)]
    assert without_id(before_history) == without_id(parent_prefix), "native before fork changed its projected prefix"
    assert without_id(through_history) == without_id(history), "native through fork changed projected history"
    before_map = {parent["id"]: child["id"] for parent, child in zip(parent_prefix, before_history)}
    through_map = {parent["id"]: child["id"] for parent, child in zip(history, through_history)}
    assistants = [message for message in history if message["type"] == "assistant"]
    assert len(assistants) == 2 and sum(message["type"] == "user" for message in history) == 2, \
        "stateless extraction polluted native conversation history"
    assert assistants and all(message.get("finish") == "stop" and message["time"].get("completed")
                              for message in assistants), "terminal assistant lacks completion fields"
    return {
        "sessionID": session, "firstUserID": first_user, "secondUserID": second_user,
        "beforeSessionID": before["id"], "throughSessionID": through["id"],
        "beforeFirstUserID": before_map[first_user], "throughSecondUserID": through_map[second_user],
        "beforeFork": before["fork"], "throughFork": through["fork"],
        "nativeMessages": message_receipt(history),
        "beforeMessageIDs": before_ids, "throughMessageIDs": through_ids,
        "beforeSourceIDMap": before_map, "throughSourceIDMap": through_map,
        "forkRewritesMessageIDs": before_map[first_user] != first_user,
        "events": [event for event in host.events if event["sessionID"] == session],
    }


def graph_checks(host, fixture, prefix, checks):
    session, first_user, second_user = prefix["sessionID"], prefix["firstUserID"], prefix["secondUserID"]
    host.settled(session, 2)
    alpha = host.search(session, ALPHA)
    beta = host.search(session, BETA)
    assert_sources(host, session, alpha, first_user)
    assert_sources(host, session, beta, second_user)
    assert len(fixture.extract_requests(ALPHA)) == 1 and len(fixture.extract_requests(BETA)) == 1
    checks["completed_turn_extracted_once"] = {
        "status": host.status(session), "alphaSourceIDs": sorted(source_ids(alpha)),
        "betaSourceIDs": sorted(source_ids(beta)),
    }
    other = host.new()
    assert not host.search(other, ALPHA), "independent session leaked graph facts"
    checks["independent_session_isolated"] = True

    queued = host.new()
    queued_first = host.api("/api/session/" + queued + "/prompt", {
        "text": "QA_GRAPH_QUEUED_FIRST: I choose cobalt.", "resume": False, "delivery": "steer",
    })["data"]["id"]
    queued_second = host.api("/api/session/" + queued + "/prompt", {
        "text": "QA_GRAPH_QUEUED_SECOND: Acknowledge the choice above.", "delivery": "steer",
    })["data"]["id"]
    host.terminal(queued)
    host.settled(queued, 1)
    queued_results = host.search(queued, "cobalt")
    assert_sources(host, queued, queued_results, queued_first)
    assert queued_second in source_ids(queued_results), "co-delivered user input was dropped"
    queued_messages = [message for message in host.messages(queued) if message["type"] in {"user", "assistant"}]
    assert [message["type"] for message in queued_messages] == ["user", "user", "assistant"]
    assert len(fixture.extract_requests("QA_GRAPH_QUEUED_SECOND")) == 1
    checks["co_delivered_users_preserve_both_sources"] = {
        "userIDs": [queued_first, queued_second], "sourceIDs": sorted(source_ids(queued_results)),
    }

    before, through = prefix["beforeSessionID"], prefix["throughSessionID"]
    # Fork inheritance is intentionally lazy; a scoped search initializes it.
    host.search(before, ALPHA)
    host.search(through, BETA)
    host.settled(before, 1)
    host.settled(through, 2)
    assert_sources(host, before, host.search(before, ALPHA), prefix["beforeFirstUserID"])
    assert not host.search(before, BETA), "edited-away future turn leaked into fork"
    assert_sources(host, through, host.search(through, BETA), prefix["throughSecondUserID"])
    replacement_user = host.prompt(before, "QA_GRAPH_REPLACEMENT")
    host.terminal(before)
    host.settled(before, 2)
    assert_sources(host, before, host.search(before, "QA_GRAPH_REPLACEMENT"), replacement_user)
    assert not host.search(before, BETA), "replacement execution restored the excluded future"
    checks["fork_prefix_and_edit_exclusion"] = True

    count = len(fixture.extract_requests())
    host.api("/api/session/" + session + "/synthetic", {
        "text": "QA_GRAPH_SYNTHETIC: internal continuation, not a human turn.",
        "description": "graph QA internal input", "resume": True,
    })
    host.terminal(session)
    host.settled(session, 2)
    assert len(fixture.extract_requests()) == count, "synthetic-only run triggered extraction"
    checks["synthetic_no_extraction"] = True

    malformed = "QA_GRAPH_MALFORMED"
    fixture.modes[malformed] = "malformed"
    failed_session = host.new()
    failed_user = host.prompt(failed_session, malformed)
    host.terminal(failed_session)
    failed = host.settled(failed_session, 0, 1)
    assert failed.get("lastError"), "failed extraction was not visible"
    assert len(fixture.extract_requests(malformed)) == 1, "invalid output retried without user action"
    fixture.modes[malformed] = "normal"
    host.rpc("retry", failed_session)
    host.settled(failed_session, 1)
    assert_sources(host, failed_session, host.search(failed_session, malformed), failed_user)
    assert len(fixture.extract_requests(malformed)) == 2, "explicit retry did not make exactly one request"
    checks["malformed_fail_open_explicit_retry"] = {"failed": failed, "ready": host.status(failed_session)}

    held = "QA_GRAPH_CLEAR"
    fixture.hold(held)
    cleared_session = host.new()
    host.prompt(cleared_session, held)
    host.terminal(cleared_session)
    assert fixture.holds[held].wait(10), "extraction did not reach the controlled hold"
    clear = host.rpc("clear", cleared_session)["status"]
    assert clear["ready"] == 0 and clear["pending"] == 0 and clear["failed"] == 0
    fixture.released[held].set()
    wait(lambda: all(request["completed"] for request in fixture.extract_requests(held)), "late provider response")
    host.settled(cleared_session, 0)
    assert not host.search(cleared_session, held), "late generation wrote after clear"
    checks["clear_discards_late_generation"] = True

    held = "QA_GRAPH_DELETE"
    fixture.hold(held)
    deleted_session = host.new()
    host.prompt(deleted_session, held)
    host.terminal(deleted_session)
    assert fixture.holds[held].wait(10), "delete case never began extraction"
    host.api("/api/session/" + deleted_session, method="DELETE")
    wait(lambda: any(event["sessionID"] == deleted_session and event["type"] == "session.deleted"
                     for event in host.events), "native session deletion")
    deleted = wait(lambda: (snapshot if (snapshot := host.graph_snapshot(deleted_session))["deleted"] else None),
                   "plugin deletion tombstone")
    assert deleted["turns"] == 0 and deleted["triples"] == 0
    missing = host.api("/api/rpc/omo.memory.graph/status", {"input": {"sessionID": deleted_session}}, allow_error=True)
    assert missing.get("status", 0) >= 400, "deleted native session remained readable by graph RPC"
    sentinel = host.new()
    host.prompt(sentinel, "QA_GRAPH_AFTER_DELETE")
    host.terminal(sentinel)
    wait(lambda: host.status(sentinel)["queued"] == 1, "next extraction waits for deleted native request")
    fixture.released[held].set()
    host.settled(sentinel, 1)
    # The process-wide native-generation slot must settle before this following
    # extraction can complete, so this is stronger than waiting for an HTTP write.
    deleted_after = host.graph_snapshot(deleted_session)
    assert deleted_after == deleted, "late native result changed the deleted graph"
    checks["native_delete_discards_late_generation"] = {
        "sessionID": deleted_session, "tombstone": deleted_after, "rpcRejected": missing,
        "followingGenerationReady": True,
    }

    fixture.phase = "recall"
    recall_start = len(fixture.requests)
    host.api("/api/session/" + session + "/synthetic", {
        "text": "QA_GRAPH_RECALL: use the current task's cobalt choice.", "resume": True,
    })
    host.terminal(session)
    recalled = [request for request in fixture.requests[recall_start:] if request["kind"] == "recall"]
    assert recalled, "normal context request was not observed"
    checks["context_recall_requests"] = [request["ordinal"] for request in recalled
                                        if second_user in source_ids(recall_blocks(request["body"]))]
    assert checks["context_recall_requests"], "normal context omitted graph recall/source IDs"

    fixture.phase = "compaction"
    compact_start = len(fixture.requests)
    host.api("/api/session/" + session + "/compact", {})
    compaction = wait(lambda: next((event for event in reversed(host.events)
                                   if event["sessionID"] == session and event["type"] in {
                                       "session.compaction.ended", "session.compaction.failed"}), None),
                      "native compaction completed")
    assert compaction["type"] == "session.compaction.ended", "native compaction failed: " + str(compaction.get("error"))
    compacted = [request for request in fixture.requests[compact_start:] if request["kind"] == "compaction"]
    checks["compaction_recall_requests"] = [request["ordinal"] for request in compacted
                                           if second_user in source_ids(recall_blocks(request["body"]))]
    assert checks["compaction_recall_requests"], "compaction request omitted graph recall/source IDs"
    fixture.phase = "normal"
    host.settled(session, 2)
    compacted_fork = host.api("/api/session/" + session + "/fork", {"before": second_user})["data"]["id"]
    assert not host.search(compacted_fork, ALPHA), "unverifiable compacted parent prefix leaked into fork"
    host.settled(compacted_fork, 0)
    checks["compacted_fork_fails_closed"] = True

    held = "QA_GRAPH_DISPOSE"
    fixture.hold(held)
    disposed_session = host.new()
    host.prompt(disposed_session, held)
    host.terminal(disposed_session)
    assert fixture.holds[held].wait(10), "dispose case never began extraction"
    host.stop()
    fixture.released[held].set()
    wait(lambda: all(request["completed"] for request in fixture.extract_requests(held)), "disposed provider response")
    count = len(fixture.extract_requests())
    host.start()
    assert host.status(session)["ready"] == 2, "restart lost committed graph memory"
    assert host.search(session, ALPHA), "restart lost searchable memory"
    assert host.status(disposed_session)["ready"] == 0, "disposed extraction committed after restart"
    assert not host.search(disposed_session, held), "disposed source appeared in recall"
    assert len(fixture.extract_requests()) == count, "restart automatically replayed extraction"
    checks["restart_persistence_and_dispose_fence"] = True

    for action in ("graph status", "graph search " + ALPHA):
        host.api("/api/session/" + session + "/command", {"name": "memory", "text": action})
    assert len(fixture.extract_requests()) == count, "read-only graph command generated a model request"
    command_messages = host.messages(session)
    command_inbox = host.api("/api/session/" + session + "/inbox")["data"]
    assert any(item["type"] == "synthetic" and "ready" in item["payload"].get("text", "")
               for item in command_inbox), "memory graph status command produced no native inbox output"
    checks["memory_command_entry"] = True

    prior_ids = {message["id"] for message in command_messages}
    fixture.tool_plan = [{"command": "graph_status"}, {"command": "graph_search", "query": ALPHA}]
    fixture.phase = "memory_read"
    host.api("/api/session/" + session + "/synthetic", {
        "text": "QA_GRAPH_READ_TOOL: inspect the graph state and search its earlier cobalt choice.",
        "description": "graph QA tool request", "resume": True,
    })
    host.terminal(session)
    tool_parts = [part for message in host.messages(session)
                  if message["id"] not in prior_ids and message["type"] == "assistant"
                  for part in message["content"] if part["type"] == "tool"]
    assert len(tool_parts) == 2 and all(part["state"]["status"] == "completed" for part in tool_parts), \
        "memory_read graph tool calls did not complete"
    assert first_user in json.dumps(tool_parts[1]["state"]["content"]), \
        "memory_read graph_search omitted the native session source"
    assert not fixture.tool_plan and len(fixture.extract_requests()) == count, \
        "read-only graph tools generated extraction"
    fixture.phase = "normal"
    checks["memory_read_tool_entry"] = {"tools": [part["name"] for part in tool_parts],
                                       "sourceID": first_user}
    return checks


def run(args):
    before = real_session_count()
    fixture = Fixture()
    report = {"host": "2.0.32", "expect": args.expect, "real_model_requests": 0,
              "real_session_count_before": before}
    processes = []
    temp_path = None
    try:
        with tempfile.TemporaryDirectory(prefix="omo-graph-memory-") as tmp:
            temp_path = pathlib.Path(tmp)
            host = Host(args.cli, args.package, fixture, temp_path)
            try:
                host.start()
                report["cold_plugin_active"] = True
                probe_session = host.new()
                probe = host.api("/api/rpc/omo.memory.graph/status",
                                 {"input": {"sessionID": probe_session}}, allow_error=True)
                if args.expect == "missing":
                    assert isinstance(probe, dict) and probe.get("status", 0) >= 400, "old package unexpectedly has graph RPC"
                    report["verdict"] = "RED"
                    report["graph_rpc_missing"] = probe
                else:
                    assert not (isinstance(probe, dict) and probe.get("status", 0) >= 400), "graph RPC unavailable"
                prefix = native_prefix_probe(host, args.expect == "ready")
                report["native_prefix"] = prefix
                if args.expect == "ready":
                    report["checks"] = {}
                    graph_checks(host, fixture, prefix, report["checks"])
                    # Restart the same isolated host with opt-out; no fresh application copy.
                    host.stop()
                    host.configure(False)
                    host.start()
                    count = len(fixture.extract_requests())
                    disabled = host.new()
                    host.prompt(disabled, "QA_GRAPH_DISABLED")
                    host.terminal(disabled)
                    assert len(fixture.extract_requests()) == count, "graph:false still extracted"
                    report["checks"]["graph_disabled_zero_extraction"] = True
                    report["verdict"] = "PASS"
                report["observed_events"] = sorted({event["type"] for event in host.events})
                required = {"session.execution.started", "session.execution.succeeded",
                            "session.inbox.enqueued", "session.inbox.delivered",
                            "session.step.started", "session.step.ended"}
                assert required <= set(report["observed_events"]), "required native lifecycle events missing"
            except Exception:
                report["failure_diagnostics"] = host.diagnostics()
                raise
            finally:
                host.close()
                processes.extend(host.processes)
    except Exception as error:
        report["verdict"] = "FAIL"
        report["error"] = type(error).__name__ + ": " + str(error)
    finally:
        fixture.close()
        report["model_requests"] = fixture.receipt()
        report["local_model_requests"] = len(fixture.requests)
        report["real_session_count_after"] = real_session_count()
        report["cleanup"] = {
            "temporary_directory_removed": temp_path is None or not temp_path.exists(),
            "host_processes": [{"pid": process.pid, "returncode": process.poll()} for process in processes],
            "fixture_server_stopped": not fixture.thread.is_alive(),
        }
        if report["real_session_count_after"] != before:
            report["verdict"], report["error"] = "FAIL", "QA changed the real OpenCode session database"
        if any(process.poll() is None for process in processes):
            report["verdict"], report["error"] = "FAIL", "native host was left running"
        if fixture.errors:
            report["verdict"], report["error"] = "FAIL", "local fixture failed: " + "; ".join(fixture.errors)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", type=pathlib.Path, required=True)
    parser.add_argument("--package", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parent / "dist")
    parser.add_argument("--expect", choices=("ready", "missing"), default="ready",
                        help="missing records the pre-change RED surface and native fork/event contracts")
    args = parser.parse_args()
    args.cli, args.package = args.cli.resolve(), args.package.resolve()
    try:
        result = run(args)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        if result["verdict"] == "FAIL":
            raise SystemExit(1)
    except Exception as error:
        print(json.dumps({"verdict": "FAIL", "error": type(error).__name__ + ": " + str(error)},
                         ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1) from error
