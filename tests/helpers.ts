import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const SCRIPTS = resolve(import.meta.dirname, "..", "skills", "loop", "scripts");

export function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "loop-"));
}

export type CliResult = { status: number | null; stdout: string; stderr: string; json: any };

export function cli(script: string, args: string[], env: Record<string, string>, input?: string): CliResult {
  const proc = spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    env: { ...process.env, ...env },
    input,
    encoding: "utf8",
  });
  let json: unknown;
  try {
    json = proc.stdout.trim() ? JSON.parse(proc.stdout) : undefined;
  } catch {
    json = undefined;
  }
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr, json };
}
