// Turns a deadline as the owner wrote it ("amanhã", "by Friday", "até dia
// 10", "depois do board") into a time, always relative to when the message
// was SENT and in the owner's time zone, never to when it was scanned: a
// "tomorrow" found by a backfill two weeks later is two weeks overdue, not due
// tomorrow. A day without a time means the end of the working day (18:00).
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { loadConfig } from "./config.ts";
import { fold } from "./prefilter.ts";
import { addDays, DAYS, wallParts, zonedToUtc, type Day } from "./time.ts";

export type Resolved =
  | { kind: "date"; at: string; text: string; certainty: "firm" | "soft" }
  | { kind: "event"; event: string; text: string; certainty: "soft" }
  | { kind: "none"; text: string | null };

export const END_OF_DAY = { hh: 18, mm: 0 };

type Ymd = { y: number; m: number; d: number };

const WEEKDAYS: Record<string, Day> = {
  segunda: "mon", terca: "tue", quarta: "wed", quinta: "thu", sexta: "fri", sabado: "sat", domingo: "sun",
  monday: "mon", tuesday: "tue", wednesday: "wed", thursday: "thu", friday: "fri", saturday: "sat", sunday: "sun",
  mon: "mon", tue: "tue", tues: "tue", wed: "wed", thu: "thu", thurs: "thu", fri: "fri",
};
const WEEKDAY = Object.keys(WEEKDAYS).join("|");
const MONTHS: Record<string, number> = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const b = (re: string) => new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:${re})(?=$|[^\\p{L}\\p{N}])`, "u");

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function weekdayOf(d: Ymd): Day {
  return DAYS[(new Date(Date.UTC(d.y, d.m - 1, d.d)).getUTCDay() + 6) % 7]!;
}

// Days from `from` to the next `target` weekday, 1..7 (never 0).
function until(from: Day, target: Day): number {
  const diff = (DAYS.indexOf(target) - DAYS.indexOf(from) + 7) % 7;
  return diff === 0 ? 7 : diff;
}

// "às 15h", "15:30", "at 3pm", "at 10:30 am"
function timeOfDay(t: string): { hh: number; mm: number } | null {
  const pt = /(?:as|a partir das|ate as)\s+(\d{1,2})(?:[:h](\d{2}))?\s*h?(?![\d/])/.exec(t);
  const en = /\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/.exec(t);
  const m = pt ?? en;
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = m[2] ? Number(m[2]) : 0;
  if (en && m === en && m[3] === "pm" && hh < 12) hh += 12;
  if (en && m === en && m[3] === "am" && hh === 12) hh = 0;
  if (hh > 23 || mm > 59) return null;
  return { hh, mm };
}

function dayMonthOrder(locale: string | undefined): "dm" | "md" {
  return /^en(-US)?$/i.test(locale ?? "") ? "md" : "dm";
}

export type Input = { text: string; sentAt: string; tz: string; locale?: string };

export function resolveDeadline({ text, sentAt, tz, locale }: Input): Resolved {
  const sent = Date.parse(sentAt);
  if (Number.isNaN(sent)) throw new Error(`sentAt is not a date: ${sentAt}`);
  const t = fold(text).replace(/\s+/g, " ").trim();
  const now = wallParts(sent, tz);
  const today: Ymd = { y: now.y, m: now.m, d: now.d };
  const at = (day: Ymd, certainty: "firm" | "soft", matched: string): Resolved => {
    const time = timeOfDay(t) ?? END_OF_DAY;
    return { kind: "date", at: new Date(zonedToUtc(day.y, day.m, day.d, time.hh, time.mm, tz)).toISOString(), text: matched, certainty };
  };
  let m: RegExpExecArray | null;

  // An event, not a date: "depois do board", "after the call with Sarah".
  if ((m = /(?:^|[^\p{L}])(?:depois d[oae]s? |apos (?:[oa]s? )?|after (?:the |our |my )?)([\p{L}\p{N}][^.,;!?\n]{1,60})/u.exec(t))) {
    const event = m[1]!.trim();
    // "depois do almoço" is later today, not an event to wait for.
    if (/^(almoco|lunch|jantar|dinner|cafe)\b/.test(event)) return at(today, "firm", m[0].trim());
    if (!/^(amanha|hoje|tomorrow|today|sexta|friday|\d)/.test(event)) {
      return { kind: "event", event, text: m[0].trim(), certainty: "soft" };
    }
  }
  if ((m = /\d{4}-\d{2}-\d{2}/.exec(t))) {
    const [y, mo, d] = m[0].split("-").map(Number);
    if (mo! >= 1 && mo! <= 12 && d! >= 1 && d! <= daysInMonth(y!, mo!)) return at({ y: y!, m: mo!, d: d! }, "firm", m[0]);
  }
  if ((m = /(?:^|[^\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?![\d/])/.exec(t))) {
    const [p, q] = [Number(m[1]), Number(m[2])];
    const [d, mo] = dayMonthOrder(locale) === "dm" ? [p, q] : [q, p];
    let y = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : today.y;
    if (!m[3] && (mo < today.m || (mo === today.m && d < today.d))) y++;
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo)) return at({ y, m: mo, d }, "firm", m[0].trim());
  }
  // "10 de outubro", "October 10", "10th of October"
  const monthNames = Object.keys(MONTHS).join("|");
  if ((m = new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?(?: de| of)? (${monthNames})|(${monthNames}) (\\d{1,2})(?:st|nd|rd|th)?`).exec(t))) {
    const d = Number(m[1] ?? m[4]);
    const mo = MONTHS[m[2] ?? m[3]!]!;
    const y = mo < today.m || (mo === today.m && d < today.d) ? today.y + 1 : today.y;
    if (d >= 1 && d <= daysInMonth(y, mo)) return at({ y, m: mo, d }, "firm", m[0]);
  }
  if ((m = b("depois de amanha|day after tomorrow").exec(t))) return at(addDays(today.y, today.m, today.d, 2), "firm", m[0].trim());
  if ((m = b("amanha|tomorrow|tmrw").exec(t))) return at(addDays(today.y, today.m, today.d, 1), "firm", m[0].trim());
  if ((m = b("hoje|today|tonight|hoje a noite|eod|end of (?:the )?day|fim do dia|final do dia|ainda hoje").exec(t))) return at(today, "firm", m[0].trim());
  if ((m = /(?:em|in|within) (\d{1,2}|uma|um|one|two|dois|duas|three|tres) (dias?|days?|semanas?|weeks?)/.exec(t))) {
    const words: Record<string, number> = { uma: 1, um: 1, one: 1, two: 2, dois: 2, duas: 2, three: 3, tres: 3 };
    const n = Number(m[1]) || words[m[1]!]!;
    const days = /^(semana|week)/.test(m[2]!) ? n * 7 : n;
    return at(addDays(today.y, today.m, today.d, days), "soft", m[0]);
  }
  if ((m = b("fim do mes|final do mes|end of (?:the )?month|eom").exec(t))) {
    return at({ y: today.y, m: today.m, d: daysInMonth(today.y, today.m) }, "firm", m[0].trim());
  }
  if ((m = b("fim da semana|final da semana|end of (?:the )?week|eow|this week|essa semana|esta semana").exec(t))) {
    const w = now.weekday;
    const n = w === "sat" || w === "sun" ? until(w, "fri") : (DAYS.indexOf("fri") - DAYS.indexOf(w));
    return at(addDays(today.y, today.m, today.d, n), "soft", m[0].trim());
  }
  // "next Tuesday", "terça que vem", "próxima terça": the coming one, never today.
  if ((m = new RegExp(`(?:next|proxima|proximo) (${WEEKDAY})(?:-feira)?|(${WEEKDAY})(?:-feira)? que vem`).exec(t))) {
    const target = WEEKDAYS[(m[1] ?? m[2])!]!;
    return at(addDays(today.y, today.m, today.d, until(now.weekday, target)), "soft", m[0]);
  }
  if ((m = b("semana que vem|proxima semana|next week").exec(t))) {
    return at(addDays(today.y, today.m, today.d, until(now.weekday, "mon")), "soft", m[0].trim());
  }
  // "sexta", "by Friday": the next one; today only if it is that day and still before 17:00.
  if ((m = new RegExp(`(?:^|[^\\p{L}])(${WEEKDAY})(?:-feira)?(?=$|[^\\p{L}])`, "u").exec(t))) {
    const target = WEEKDAYS[m[1]!]!;
    const n = target === now.weekday && now.hh < 17 ? 0 : until(now.weekday, target);
    return at(addDays(today.y, today.m, today.d, n), "firm", m[0].trim());
  }
  // "até dia 10", "no dia 10", "by the 10th", "on the 10th"
  if ((m = /(?:dia|the) (\d{1,2})(?:st|nd|rd|th)?(?!\d|\/)/.exec(t))) {
    const d = Number(m[1]);
    let { y, m: mo } = today;
    if (d < today.d) ({ y, m: mo } = mo === 12 ? { y: y + 1, m: 1 } : { y, m: mo + 1 });
    if (d >= 1 && d <= daysInMonth(y, mo)) return at({ y, m: mo, d }, "firm", m[0]);
  }
  return { kind: "none", text: text.trim() || null };
}

// No deadline in the words: the digest still needs a day to ask about. A
// promise gets 3 working days, anything asked of others 5; always "inferred".
export const DEFAULT_WORKING_DAYS: Record<string, number> = { promise: 3, request: 5, delegation: 5, waiting: 5, decision: 5 };

export function addWorkingDays(from: Ymd, n: number): Ymd {
  let d = from;
  let left = n;
  while (left > 0) {
    d = addDays(d.y, d.m, d.d, 1);
    const w = weekdayOf(d);
    if (w !== "sat" && w !== "sun") left--;
  }
  return d;
}

export function defaultDeadline(type: string, sentAt: string, tz: string): { kind: "date"; at: string; certainty: "inferred"; text: null } {
  const p = wallParts(Date.parse(sentAt), tz);
  const day = addWorkingDays({ y: p.y, m: p.m, d: p.d }, DEFAULT_WORKING_DAYS[type] ?? 5);
  return { kind: "date", at: new Date(zonedToUtc(day.y, day.m, day.d, END_OF_DAY.hh, END_OF_DAY.mm, tz)).toISOString(), certainty: "inferred", text: null };
}

if (isMain(import.meta.url)) {
  run(() => {
    const { values } = parseArgs({
      options: { text: { type: "string" }, "sent-at": { type: "string" }, tz: { type: "string" }, locale: { type: "string" }, type: { type: "string" } },
    });
    if (values["sent-at"] === undefined) throw new Error("usage: deadline.ts --text T --sent-at ISO [--tz Zone] [--locale pt-BR] [--type promise]");
    const tz = values.tz ?? loadConfig().timezone;
    const resolved = resolveDeadline({ text: values.text ?? "", sentAt: values["sent-at"], tz, locale: values.locale });
    if (resolved.kind === "none" && values.type) return { ...resolved, inferred: defaultDeadline(values.type, values["sent-at"], tz) };
    return resolved;
  });
}
