// Saves one setup answer (to the draft, or to config.json once set up),
// finishes setup with --done, or pauses and resumes Loop.
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import { isSettable, nextField, parseField, QUESTIONS, validateConfig, type Config, type Field } from "./config.ts";
import { file, nowMs } from "./paths.ts";
import { readJson, removeFile, updateJson, withLock, writeJson } from "./store.ts";

export type Recorded =
  | { saved: string; config: Config }
  | { saved: string; next: Field | null; question: string | null };

export function record(field: string, value: string): Recorded {
  if (!isSettable(field)) throw new Error(`unknown setting: ${field}`);
  const patch = parseField(field, value);
  const configPath = file("config.json");
  if (readJson<Config | null>(configPath, null)?.setupDoneAt) {
    const config = updateJson<Config | null>(configPath, null, (c) => validateConfig({ ...c!, ...patch }));
    return { saved: field, config: config! };
  }
  const draft = updateJson<Partial<Config>>(file("config.draft.json"), {}, (d) => ({ ...d, ...patch }));
  const next = nextField(draft) ?? null;
  return { saved: field, next, question: next ? QUESTIONS[next] : null };
}

export function finish(now: number = nowMs()): { done: true; config: Config } {
  const configPath = file("config.json");
  const draftPath = file("config.draft.json");
  const config = withLock(configPath, () => {
    const draft = readJson<Partial<Config> | null>(draftPath, null);
    const current = readJson<Config | null>(configPath, null);
    if (!draft) {
      if (current?.setupDoneAt) return current;
      throw new Error("there is no setup to finish; answer the setup questions first");
    }
    const done = { ...validateConfig({ ...current, ...draft }), setupDoneAt: new Date(now).toISOString() };
    writeJson(configPath, done);
    removeFile(draftPath);
    return done;
  });
  return { done: true, config };
}

export function setPaused(paused: boolean): { paused: boolean; config: Config } {
  const path = file("config.json");
  if (!readJson<Config | null>(path, null)?.setupDoneAt) throw new Error("setup is not finished; run the setup first");
  const config = updateJson<Config | null>(path, null, (c) => ({ ...c!, paused }))!;
  return { paused, config };
}

if (isMain(import.meta.url)) {
  run(() => {
    const { values } = parseArgs({
      options: {
        field: { type: "string" }, value: { type: "string" }, done: { type: "boolean" },
        pause: { type: "boolean" }, resume: { type: "boolean" },
      },
    });
    const modes = [values.done, values.pause, values.resume, values.field !== undefined].filter(Boolean).length;
    if (modes > 1) throw new Error("pass one of --field/--value, --done, --pause, --resume");
    if (values.done) return finish();
    if (values.pause) return setPaused(true);
    if (values.resume) return setPaused(false);
    if (values.field === undefined || values.value === undefined) {
      throw new Error("usage: record-setup.ts --field F --value V | --done | --pause | --resume");
    }
    return record(values.field, values.value);
  });
}
