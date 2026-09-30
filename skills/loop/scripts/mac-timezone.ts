// The owner's time zone, as their Mac is set to it: `readlink /etc/localtime`
// on the Mac (mac.ts), read-only and quick; the zone the Mac keeps is the one
// their calendar shows. Undefined when the Mac is not connected, the command
// is refused, or the answer is not a zone this runtime knows, and setup then
// asks.
import { isMain, run } from "./cli.ts";
import { runOnMac, type BridgeOptions } from "./mac.ts";

// The zone from what readlink printed: /var/db/timezone/zoneinfo/America/Sao_Paulo.
export function zoneFromLink(output: string): string | undefined {
  const zone = /zoneinfo\/(.+?)\s*$/.exec(output.trim())?.[1];
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

export async function macTimezone(opts: BridgeOptions = {}): Promise<string | undefined> {
  const output = await runOnMac({
    argv: ["readlink", "/etc/localtime"], readPaths: ["/etc/localtime"],
    goal: "Loop setup: read this Mac's time zone so a deadline like 'tomorrow' means your tomorrow",
  }, opts);
  return output === undefined ? undefined : zoneFromLink(output);
}

if (isMain(import.meta.url)) run(async () => ({ timezone: (await macTimezone()) ?? null }));
