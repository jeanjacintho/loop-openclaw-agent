import assert from "node:assert/strict";
import { test } from "node:test";
import { parseField, parseSources, parseTime } from "../skills/loop/scripts/config.ts";
import { statusFilling } from "../skills/loop/scripts/setup-status.ts";
import { cli, tmpHome } from "./helpers.ts";

const NOW = "2026-09-30T11:00:00Z"; // Wednesday, 08:00 in São Paulo

test("setup asks name, time zone, digest time and sources, in that order, then finishes", () => {
  const env = { LOOP_HOME: tmpHome(), LOOP_NOW: NOW };
  const record = (field: string, value: string) => cli("record-setup.ts", ["--field", field, "--value", value], env);
  assert.equal(record("ownerName", "Ana Lima").json.next, "timezone");
  assert.equal(record("timezone", "America/Sao_Paulo").json.next, "digestTime");
  const digest = record("digestTime", "default").json;
  assert.equal(digest.next, "sources");
  assert.match(digest.question, /only read what you sent/);
  assert.equal(record("sources", '{"mail":{"accounts":["Ana@Startup.com"]},"imessage":true}').json.next, null);
  assert.equal(record("language", "pt-BR").json.saved, "language");
  const done = cli("record-setup.ts", ["--done"], env);
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(done.json.config.sources, { mail: { accounts: ["ana@startup.com"] }, imessage: true });
  assert.equal(done.json.config.digestTime, "08:30");
  assert.equal(done.json.config.language, "pt-BR");
  const status = cli("setup-status.ts", [], { ...env, PLOW_API_BASE: "", PLOW_MCP_BRIDGE_TOKEN: "" }).json;
  assert.equal(status.status, "READY");
  assert.equal(status.now, "2026-09-30T08:00:00-03:00");
  assert.equal(status.weekday, "wed");
});

test("after setup, a change in plain words updates the config, and pause/resume flip it", () => {
  const env = { LOOP_HOME: tmpHome(), LOOP_NOW: NOW };
  for (const [f, v] of [["ownerName", "Ana"], ["timezone", "UTC"], ["digestTime", "8h30"], ["sources", '{"mail":null,"imessage":true}']]) {
    cli("record-setup.ts", ["--field", f!, "--value", v!], env);
  }
  cli("record-setup.ts", ["--done"], env);
  assert.equal(cli("record-setup.ts", ["--field", "digestTime", "--value", "7"], env).json.config.digestTime, "07:00");
  assert.equal(cli("record-setup.ts", ["--pause"], env).json.config.paused, true);
  assert.equal(cli("record-setup.ts", ["--resume"], env).json.config.paused, false);
  const bad = cli("record-setup.ts", ["--field", "sources", "--value", '{"mail":null,"imessage":false}'], env);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /at least one source/);
});

test("pausing before setup is refused, and --done without answers says what is missing", () => {
  const env = { LOOP_HOME: tmpHome() };
  assert.match(cli("record-setup.ts", ["--pause"], env).stderr, /setup is not finished/);
  cli("record-setup.ts", ["--field", "ownerName", "--value", "Ana"], env);
  assert.match(cli("record-setup.ts", ["--done"], env).stderr, /setup is missing: timezone, digestTime, sources/);
});

test("answers are validated", () => {
  assert.equal(parseTime("7"), "07:00");
  assert.equal(parseTime("18h45"), "18:45");
  assert.throws(() => parseTime("25:00"), /not a time/);
  assert.throws(() => parseField("timezone", "Mars/Olympus"), /unknown time zone/);
  assert.throws(() => parseSources('{"mail":{"accounts":["not-an-email"]}}'), /not an email account/);
  assert.throws(() => parseSources("mail and imessage"), /must be JSON/);
  assert.deepEqual(parseField("domainRoles", '{"@Fund.VC":"investor"}'), { domainRoles: { "fund.vc": "investor" } });
  assert.throws(() => parseField("domainRoles", '{"fund.vc":"boss"}'), /role for fund.vc/);
  assert.throws(() => parseField("language", "portuguese"), /language must be a tag/);
  assert.throws(() => parseField("paused", "true"), /unknown setting/);
});

test("the owner's name comes from Plow and the time zone from the Mac, asked only when those have no answer", async () => {
  process.env.LOOP_HOME = tmpHome();
  try {
    const filled = await statusFilling({ ownerName: async () => "Ana Lima", timezone: async () => "America/Sao_Paulo" }, Date.parse(NOW));
    assert.equal(filled.status, "SETUP_NEEDED");
    assert.equal(filled.status === "SETUP_NEEDED" && filled.next, "digestTime");
    process.env.LOOP_HOME = tmpHome();
    const asked = await statusFilling({ ownerName: async () => undefined, timezone: async () => { throw new Error("mac offline"); } }, Date.parse(NOW));
    assert.equal(asked.status === "SETUP_NEEDED" && asked.next, "ownerName");
  } finally {
    delete process.env.LOOP_HOME;
  }
});
