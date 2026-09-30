import assert from "node:assert/strict";
import { test } from "node:test";
import { addWorkingDays, defaultDeadline, resolveDeadline } from "../skills/loop/scripts/deadline.ts";
import { cli, tmpHome } from "./helpers.ts";

const SP = "America/Sao_Paulo"; // UTC-3, no DST
// Wednesday 30 Sep 2026, 10:00 in São Paulo.
const WED = "2026-09-30T13:00:00Z";
const r = (text: string, sentAt = WED, locale = "pt-BR", tz = SP) => resolveDeadline({ text, sentAt, tz, locale });
const at = (text: string, sentAt = WED, locale = "pt-BR", tz = SP) => {
  const x = r(text, sentAt, locale, tz);
  assert.equal(x.kind, "date", `${text} → ${JSON.stringify(x)}`);
  return x.kind === "date" ? x.at : "";
};
// 18:00 in São Paulo on that day, as UTC.
const eod = (ymd: string) => `${ymd}T21:00:00.000Z`;

test("tomorrow and today are read from when the message was sent, in the owner's zone", () => {
  assert.equal(at("amanhã"), eod("2026-10-01"));
  assert.equal(at("I'll send it tomorrow", WED, "en"), eod("2026-10-01"));
  assert.equal(at("hoje"), eod("2026-09-30"));
  assert.equal(at("by EOD", WED, "en"), eod("2026-09-30"));
  assert.equal(at("depois de amanhã"), eod("2026-10-02"));
  // 23:30 on Wednesday in São Paulo is already Thursday in UTC: "amanhã" is still Thursday.
  assert.equal(at("amanhã", "2026-10-01T02:30:00Z"), eod("2026-10-01"));
  // A backfill two weeks later reads the same message the same way.
  assert.equal(at("amanhã", "2026-09-16T13:00:00Z"), eod("2026-09-17"));
});

test("a weekday is the next one, today only if it is that day and not yet evening", () => {
  assert.equal(at("sexta"), eod("2026-10-02"));
  assert.equal(at("by Friday", WED, "en"), eod("2026-10-02"));
  assert.equal(at("até sexta-feira"), eod("2026-10-02"));
  assert.equal(at("quarta"), eod("2026-09-30"), "Wednesday morning: this Wednesday");
  assert.equal(at("quarta", "2026-09-30T22:00:00Z"), eod("2026-10-07"), "Wednesday 19:00: next Wednesday");
  assert.equal(at("segunda"), eod("2026-10-05"));
  assert.equal(at("next Tuesday", WED, "en"), eod("2026-10-06"));
  assert.equal(at("terça que vem"), eod("2026-10-06"));
  assert.equal(r("next Tuesday", WED, "en").kind === "date" && (r("next Tuesday", WED, "en") as { certainty: string }).certainty, "soft");
});

test("next week is Monday of next week, soft; end of the month and the week are their last days", () => {
  const next = r("semana que vem");
  assert.deepEqual(next, { kind: "date", at: eod("2026-10-05"), text: "semana que vem", certainty: "soft" });
  assert.equal(at("next week", WED, "en"), eod("2026-10-05"));
  assert.equal(at("até o fim do mês"), eod("2026-09-30"));
  assert.equal(at("end of month", "2026-10-02T13:00:00Z", "en"), eod("2026-10-31"));
  assert.equal(at("fim da semana"), eod("2026-10-02"));
  assert.equal(at("end of the week", "2026-10-03T13:00:00Z", "en"), eod("2026-10-09"), "on a Saturday: next Friday");
});

test("day numbers and dates: this month if still ahead, else the next; day/month by locale", () => {
  assert.equal(at("até dia 10"), eod("2026-10-10"));
  assert.equal(at("no dia 30"), eod("2026-09-30"));
  assert.equal(at("by the 5th", "2026-10-08T13:00:00Z", "en"), eod("2026-11-05"));
  assert.equal(at("10/10"), eod("2026-10-10"));
  assert.equal(at("até 05/10"), eod("2026-10-05"));
  assert.equal(at("by 10/5", WED, "en-US"), eod("2026-10-05"));
  assert.equal(at("15/01"), eod("2027-01-15"), "a date already past this year is next year's");
  assert.equal(at("2026-11-02"), eod("2026-11-02"));
  assert.equal(at("10 de outubro"), eod("2026-10-10"));
  assert.equal(at("October 12", WED, "en"), eod("2026-10-12"));
});

test("a time in the words replaces the end of the day", () => {
  assert.equal(at("amanhã às 15h"), "2026-10-01T18:00:00.000Z");
  assert.equal(at("tomorrow at 9:30 am", WED, "en"), "2026-10-01T12:30:00.000Z");
  assert.equal(at("friday at 3pm", WED, "en"), "2026-10-02T18:00:00.000Z");
});

test("'after the board' is an event, not a date; after lunch is today", () => {
  assert.deepEqual(r("mando depois do board"), { kind: "event", event: "board", text: "depois do board", certainty: "soft" });
  const ev = r("I'll send it after the meeting with Sarah", WED, "en");
  assert.equal(ev.kind, "event");
  assert.equal(ev.kind === "event" && ev.event, "meeting with sarah");
  assert.equal(at("depois do almoço"), eod("2026-09-30"));
});

test("no deadline in the words is none; the default is 3 working days for a promise and 5 for a request, inferred", () => {
  assert.deepEqual(r("vou te mandar o deck"), { kind: "none", text: "vou te mandar o deck" });
  assert.deepEqual(defaultDeadline("promise", WED, SP), { kind: "date", at: eod("2026-10-05"), certainty: "inferred", text: null });
  assert.equal(defaultDeadline("request", WED, SP).at, eod("2026-10-07"));
  assert.deepEqual(addWorkingDays({ y: 2026, m: 10, d: 2 }, 1), { y: 2026, m: 10, d: 5 }, "Friday + 1 working day = Monday");
});

test("the CLI reads the owner's zone from the config when none is given", () => {
  const home = tmpHome();
  const env = { LOOP_HOME: home, LOOP_OPENCLAW_CLI: "/nonexistent" };
  const out = cli("deadline.ts", ["--text", "amanhã", "--sent-at", WED, "--tz", SP], env);
  assert.equal(out.status, 0, out.stderr);
  assert.equal(out.json.at, eod("2026-10-01"));
  const none = cli("deadline.ts", ["--text", "sem prazo", "--sent-at", WED, "--tz", SP, "--type", "promise"], env).json;
  assert.equal(none.inferred.certainty, "inferred");
});
