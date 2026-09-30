// Is Loop set up? READY with the config and the owner's local "now", or
// SETUP_NEEDED with the next question.
import { isMain, run } from "./cli.ts";
import { nextField, QUESTIONS, type Config, type Field } from "./config.ts";
import { macTimezone } from "./mac-timezone.ts";
import { ownerDisplayName } from "./owner-chat.ts";
import { file, nowMs } from "./paths.ts";
import { record } from "./record-setup.ts";
import { readJson } from "./store.ts";
import { localIso, wallParts } from "./time.ts";

export type Status =
  | { status: "READY"; config: Config; now: string; weekday: string }
  | { status: "SETUP_NEEDED"; next: Field | null; question: string | null; draft: Partial<Config> };

export function status(now: number = nowMs()): Status {
  const config = readJson<Config | null>(file("config.json"), null);
  if (config?.setupDoneAt) {
    return { status: "READY", config, now: localIso(now, config.timezone), weekday: wallParts(now, config.timezone).weekday };
  }
  const draft = readJson<Partial<Config>>(file("config.draft.json"), {});
  const next = nextField(draft) ?? null;
  return { status: "SETUP_NEEDED", next, question: next ? QUESTIONS[next] : null, draft };
}

// Setup asks only what nobody else can answer. The owner's name is the one on
// their Plow profile, and their time zone is the one their Mac is set to; each
// fills its question when setup reaches it, and is asked only when that source
// has no answer or cannot be reached. The owner can change either afterwards.
export type Lookups = { ownerName?: () => Promise<string | undefined>; timezone?: () => Promise<string | undefined> };

export async function statusFilling(lookups: Lookups = { ownerName: ownerDisplayName, timezone: macTimezone }, now: number = nowMs()): Promise<Status> {
  for (;;) {
    const current = status(now);
    if (current.status !== "SETUP_NEEDED" || !current.next) return current;
    const lookup = current.next === "ownerName" || current.next === "timezone" ? lookups[current.next] : undefined;
    if (!lookup) return current;
    let value: string | undefined;
    try {
      value = (await lookup())?.trim().slice(0, 60);
    } catch {
      return current;
    }
    if (!value) return current;
    try {
      record(current.next, value);
    } catch {
      return current;
    }
  }
}

if (isMain(import.meta.url)) run(() => statusFilling());
