import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";

const ROOT = resolve(import.meta.dirname, "..");
const SKILLS = join(ROOT, "skills");
const SCRIPTS = join(SKILLS, "loop", "scripts");
const prompt = readFileSync(join(ROOT, "prompt", "AGENTS.md"), "utf8");
const skillFiles = readdirSync(SKILLS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith("loop"))
  .map((d) => ({ dir: d.name, path: join(SKILLS, d.name, "SKILL.md") }))
  .filter((s) => existsSync(s.path));

test("every Loop skill has frontmatter naming its directory and a description", () => {
  assert.ok(skillFiles.length >= 1);
  for (const { dir, path } of skillFiles) {
    const m = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(path, "utf8"));
    assert.ok(m, `${dir}: no frontmatter`);
    const fields = Object.fromEntries(m[1]!.split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
    assert.equal(fields.name, dir);
    assert.ok(fields.description && fields.description.length > 20, `${dir}: description`);
  }
});

test("every script the prompt or a Loop skill names exists", () => {
  const texts = [prompt, ...skillFiles.map((s) => readFileSync(s.path, "utf8"))];
  const named = new Set(texts.flatMap((t) => [...t.matchAll(/\b([a-z][a-z-]*)\.ts\b/g)].map((m) => m[1]!)));
  assert.ok(named.has("ledger"));
  for (const name of named) assert.ok(existsSync(join(SCRIPTS, `${name}.ts`)), `missing script ${name}.ts`);
});

test("the scheduled messages are what the prompt keys on, and each has its skill", async () => {
  const { POLL_MESSAGE, DIGEST_MESSAGE } = await import("../skills/loop/scripts/register-crons.ts");
  assert.ok(prompt.replace(/\s+/g, " ").includes("`Loop poll.` → `loop-poll`"));
  assert.ok(prompt.replace(/\s+/g, " ").includes("`Loop digest.` → `loop-digest`"));
  assert.ok(POLL_MESSAGE.startsWith("Loop poll.") && POLL_MESSAGE.includes("loop-poll skill"));
  assert.ok(DIGEST_MESSAGE.startsWith("Loop digest.") && DIGEST_MESSAGE.includes("loop-digest skill"));
  for (const dir of ["loop-poll", "loop-digest"]) assert.ok(existsSync(join(SKILLS, dir, "SKILL.md")), dir);
  for (const dir of ["loop-poll", "loop-digest"]) {
    assert.match(readFileSync(join(SKILLS, dir, "SKILL.md"), "utf8"), /If it is not `READY`, or `config.paused` is true,\s+end silently/);
  }
});
