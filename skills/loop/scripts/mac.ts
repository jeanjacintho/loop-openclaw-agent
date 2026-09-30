// A read-only command on the owner's Mac, through the Latch relay that boot
// bridges to loopback: the MCP tool plow_run_command, with the bridge's own
// per-boot token from the gateway's environment (Meetly's mac.ts).
//
// `callMac` says why a command produced nothing: a scheduled scan has to tell
// "no new messages" from "could not read" (and from "Latch wants approval"),
// or a sleeping Mac would look like a quiet week.
export const BRIDGE_URL = "http://127.0.0.1:18790/mcp";

export type BridgeOptions = { fetch?: typeof fetch; url?: string; token?: string };
export type MacCommand = { argv: string[]; readPaths: string[]; goal: string; timeoutMs?: number };

export type MacFailure = "no-bridge" | "unreachable" | "blocked" | "refused" | "failed";
export type MacResult =
  | { ok: true; output: string }
  | { ok: false; reason: MacFailure; detail?: string; ownerAction?: string };

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function callMac(command: MacCommand, opts: BridgeOptions = {}): Promise<MacResult> {
  const token = opts.token ?? process.env.PLOW_MCP_BRIDGE_TOKEN;
  if (!token) return { ok: false, reason: "no-bridge", detail: "no Latch bridge in this environment" };
  let body: string;
  try {
    const res = await (opts.fetch ?? fetch)(opts.url ?? BRIDGE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "plow_run_command", arguments: { argv: command.argv, read_paths: command.readPaths, goal: command.goal } },
      }),
      signal: AbortSignal.timeout(command.timeoutMs ?? 30_000),
    });
    if (!res.ok) return { ok: false, reason: "unreachable", detail: `the relay answered HTTP ${res.status}` };
    body = await res.text();
  } catch (err) {
    return { ok: false, reason: "unreachable", detail: err instanceof Error ? err.message : String(err) };
  }
  const data = body.split("\n").find((line) => line.startsWith("data:"));
  const reply = parse(data ? data.slice(5) : body) as
    { result?: { isError?: boolean; content?: { type: string; text?: string }[] }; error?: { message?: string } } | undefined;
  if (!reply) return { ok: false, reason: "unreachable", detail: "the relay's answer is not JSON" };
  if (reply.error) return { ok: false, reason: "unreachable", detail: reply.error.message ?? "relay error" };
  const text = reply.result?.content?.find((c) => c.type === "text")?.text ?? "";
  const out = parse(text) as { exit_code?: number; output?: string; status?: string; message?: string; owner_action?: string } | undefined;
  // Latch answers a command the owner has not approved with status "blocked"
  // and, when it can, the sentence to tell them.
  if (out?.status === "blocked" || /\bblocked\b/i.test(reply.result?.isError ? text : "")) {
    return { ok: false, reason: "blocked", detail: out?.message ?? text.slice(0, 300), ...(out?.owner_action ? { ownerAction: out.owner_action } : {}) };
  }
  if (reply.result?.isError) return { ok: false, reason: "refused", detail: text.slice(0, 300) };
  if (!out || typeof out.output !== "string") return { ok: false, reason: "failed", detail: "no output from the command" };
  if (out.exit_code !== 0) return { ok: false, reason: "failed", detail: `exit ${out.exit_code}: ${out.output.slice(0, 300)}` };
  return { ok: true, output: out.output };
}

// The output, or undefined when there is none for any reason.
export async function runOnMac(command: MacCommand, opts: BridgeOptions = {}): Promise<string | undefined> {
  const res = await callMac(command, opts);
  return res.ok ? res.output : undefined;
}
