import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import gate, { gateContext, isOwnerDmTurn, SETUP_STATUS } from "../gate/index.js";

const status = (s: unknown) => JSON.stringify(s) + "\n";

test("only the owner's own DM user turn is gated", () => {
  assert.equal(isOwnerDmTurn({ channel: "plow", accountId: "chat", sessionKey: "agent:main:main", trigger: "user" }), true);
  assert.equal(isOwnerDmTurn({ channel: "plow", sessionKey: "agent:main:main" }), true);
  for (const ctx of [
    { channel: "plow", accountId: "chat", sessionKey: "agent:main:plow:group:cht_x", trigger: "user" },
    { channel: "plow", accountId: "email", sessionKey: "agent:main:main" },
    { channel: "plow", sessionKey: "agent:main:main", trigger: "cron" },
    { channel: "webchat", sessionKey: "agent:main:main" },
    undefined,
  ]) assert.equal(isOwnerDmTurn(ctx), false, JSON.stringify(ctx));
});

test("unfinished setup tells the model to introduce Loop and ask the current question, not an old one", () => {
  const context = gateContext(status({ status: "SETUP_NEEDED", next: "digestTime", question: "When should your daily digest arrive?", draft: {} }))!;
  assert.match(context, /SETUP_NEEDED/);
  assert.match(context, /ignore any earlier setup question in the chat/);
  assert.match(context, /you are Loop, their follow-through agent/);
  assert.match(context, /translated into the owner's language, and end the turn: When should your daily digest arrive\?/);
  assert.match(context, /answers the digestTime question, record it first with record-setup\.ts/);
  const done = gateContext(status({ status: "SETUP_NEEDED", next: null, question: null, draft: {} }))!;
  assert.match(done, /record-setup\.ts --done/);
});

test("a finished setup passes the owner's local time along, and output that is not a status adds nothing", () => {
  const ready = gateContext(status({ status: "READY", config: { timezone: "America/Sao_Paulo" }, now: "2026-09-30T08:00:00-03:00", weekday: "wed" }))!;
  assert.match(ready, /READY/);
  assert.match(ready, /local time is 2026-09-30T08:00:00-03:00 \(wed\), time zone America\/Sao_Paulo/);
  assert.equal(gateContext("error: boom"), undefined);
  assert.equal(gateContext(status({ ok: true })), undefined);
});

test("the plugin registers one before_prompt_build hook that skips other turns", async () => {
  const hooks: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
  gate.register({ on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => { hooks[name] = fn; }, logger: { info() {} } });
  assert.deepEqual(Object.keys(hooks), ["before_prompt_build"]);
  assert.equal(await hooks.before_prompt_build!({}, { channel: "plow", sessionKey: "agent:main:plow:group:x" }), undefined);
});

test("the gate's manifest id matches the config entry, and it runs the script the image ships", async () => {
  const manifest = JSON.parse(await readFile(new URL("../gate/openclaw.plugin.json", import.meta.url), "utf8"));
  assert.equal(manifest.id, "loop");
  assert.equal(gate.id, "loop");
  assert.equal(SETUP_STATUS, "/opt/plow/skills/loop/scripts/setup-status.ts");
});
