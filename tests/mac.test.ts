import assert from "node:assert/strict";
import { test } from "node:test";
import { callMac } from "../skills/loop/scripts/mac.ts";

const reply = (inner: unknown, isError = false) => async () =>
  new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError, content: [{ type: "text", text: JSON.stringify(inner) }] } })}\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } });
const cmd = { argv: ["echo", "hi"], readPaths: [], goal: "test" };

test("a command's output comes back, and each way of failing says why", async () => {
  assert.deepEqual(await callMac(cmd, { token: "t", fetch: reply({ exit_code: 0, output: "hi\n" }) as typeof fetch }), { ok: true, output: "hi\n" });
  assert.equal((await callMac(cmd, { token: "" })).ok, false);
  assert.deepEqual(await callMac(cmd, { token: "", fetch: reply({}) as typeof fetch }), { ok: false, reason: "no-bridge", detail: "no Latch bridge in this environment" });
  const blocked = await callMac(cmd, { token: "t", fetch: reply({ status: "blocked", message: "needs approval", owner_action: "Open Latch and allow Messages." }) as typeof fetch });
  assert.deepEqual(blocked, { ok: false, reason: "blocked", detail: "needs approval", ownerAction: "Open Latch and allow Messages." });
  assert.equal((await callMac(cmd, { token: "t", fetch: reply({ exit_code: 1, output: "nope" }) as typeof fetch })).ok === false, true);
  const failed = await callMac(cmd, { token: "t", fetch: reply({ exit_code: 1, output: "nope" }) as typeof fetch });
  assert.equal(!failed.ok && failed.reason, "failed");
  const refused = await callMac(cmd, { token: "t", fetch: (async () => new Response(JSON.stringify({ result: { isError: true, content: [{ type: "text", text: "denied by the owner" }] } }))) as typeof fetch });
  assert.equal(!refused.ok && refused.reason, "refused");
  const down = await callMac(cmd, { token: "t", fetch: (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch });
  assert.equal(!down.ok && down.reason, "unreachable");
  const http = await callMac(cmd, { token: "t", fetch: (async () => new Response("no", { status: 502 })) as typeof fetch });
  assert.equal(!http.ok && http.reason, "unreachable");
});

test("the request is Latch's plow_run_command with the bridge token", async () => {
  let seen: { url: string; auth: string | null; body: any } | undefined;
  const fake = (async (url: string, init: RequestInit) => {
    seen = { url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) };
    return reply({ exit_code: 0, output: "" })();
  }) as unknown as typeof fetch;
  await callMac({ argv: ["plow-messages", "search"], readPaths: ["~/Library/Messages"], goal: "g" }, { token: "tok", fetch: fake });
  assert.equal(seen!.url, "http://127.0.0.1:18790/mcp");
  assert.equal(seen!.auth, "Bearer tok");
  assert.deepEqual(seen!.body.params, { name: "plow_run_command", arguments: { argv: ["plow-messages", "search"], read_paths: ["~/Library/Messages"], goal: "g" } });
});
