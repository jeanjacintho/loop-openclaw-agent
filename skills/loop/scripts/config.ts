// The owner's Loop settings: types, answer parsing and validation. Kept in
// config.json (setup draft in config.draft.json), apart from the ledger.
import { file } from "./paths.ts";
import { readJson } from "./store.ts";
import { isEmail } from "./handles.ts";
import { ROLES, type Role } from "./ledger.ts";

export type Sources = { mail: { accounts: string[] } | null; imessage: boolean };

export type Config = {
  ownerName: string;
  timezone: string;
  digestTime: string; // HH:MM in the owner's zone
  sources: Sources;
  language?: string; // the language the owner writes in (BCP 47), recorded, never asked
  domainRoles?: Record<string, Role>; // "fund.vc": "investor"
  setupDoneAt?: string;
  paused?: boolean;
};

// The question order of the setup conversation.
export const FIELDS = ["ownerName", "timezone", "digestTime", "sources"] as const;
export type Field = (typeof FIELDS)[number];
// Settings the owner can set at any time, never asked for during setup.
export const EXTRA = ["language", "domainRoles"] as const;
export type Extra = (typeof EXTRA)[number];

export const DEFAULT_DIGEST_TIME = "08:30";

export const QUESTIONS: Record<Field, string> = {
  ownerName: "What name should I use for you?",
  timezone: "What time zone are you in?",
  digestTime: `When should your daily digest arrive? ${DEFAULT_DIGEST_TIME} unless you prefer another time. It only comes on days something needs you.`,
  sources: "Where do you make promises: your sent email, your iMessages, or both? I only read what you sent, never your inbox.",
};

export function isSettable(name: string): name is Field | Extra {
  return (FIELDS as readonly string[]).includes(name) || (EXTRA as readonly string[]).includes(name);
}

const pad = (n: number) => String(n).padStart(2, "0");

// "9", "9h", "9:30", "9h30", "07:00" → "HH:MM".
export function parseTime(raw: string): string {
  const m = /^(\d{1,2})(?:[:h](\d{2})?)?$/i.exec(raw.trim());
  const hh = m ? Number(m[1]) : NaN;
  const mm = m?.[2] ? Number(m[2]) : 0;
  if (!m || hh > 23 || mm > 59) throw new Error(`not a time: "${raw}" (use HH:MM, like 08:30)`);
  return `${pad(hh)}:${pad(mm)}`;
}

function parseJson(value: string, example: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`the value must be JSON, like ${example}`);
  }
}

export function parseSources(value: string): Sources {
  const example = '{"mail":{"accounts":["you@company.com"]},"imessage":true}';
  const raw = parseJson(value, example) as { mail?: unknown; imessage?: unknown } | null;
  if (!raw || typeof raw !== "object") throw new Error(`sources must be an object, like ${example}`);
  let mail: Sources["mail"] = null;
  if (raw.mail !== null && raw.mail !== undefined && raw.mail !== false) {
    const accounts = (raw.mail as { accounts?: unknown }).accounts;
    if (!Array.isArray(accounts) || accounts.length === 0) throw new Error(`mail needs the Gmail accounts to read, like ${example}`);
    const list = [...new Set(accounts.map((a) => {
      if (typeof a !== "string" || !isEmail(a)) throw new Error(`not an email account: ${JSON.stringify(a)}`);
      return a.trim().toLowerCase();
    }))];
    mail = { accounts: list };
  }
  if (raw.imessage !== undefined && typeof raw.imessage !== "boolean") throw new Error("imessage must be true or false");
  const imessage = raw.imessage === true;
  if (!mail && !imessage) throw new Error("turn on at least one source: mail or imessage");
  return { mail, imessage };
}

export function parseField(field: string, value: string): Partial<Config> {
  switch (field) {
    case "ownerName": {
      const name = value.trim();
      if (name.length < 1 || name.length > 60) throw new Error("the name must be 1 to 60 characters");
      return { ownerName: name };
    }
    case "timezone": {
      const tz = value.trim();
      try {
        if (!tz) throw new Error();
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
      } catch {
        throw new Error(`unknown time zone: ${value} (use an IANA name like America/Sao_Paulo)`);
      }
      return { timezone: tz };
    }
    case "digestTime":
      return { digestTime: parseTime(value.trim() === "" || /^default$/i.test(value.trim()) ? DEFAULT_DIGEST_TIME : value) };
    case "sources":
      return { sources: parseSources(value) };
    case "language": {
      const tag = value.trim();
      if (!/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(tag)) throw new Error(`language must be a tag like pt-BR or en, got "${value}"`);
      return { language: tag };
    }
    case "domainRoles": {
      const raw = parseJson(value, '{"fund.vc":"investor"}') as Record<string, unknown> | null;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error('domainRoles must be an object, like {"fund.vc":"investor"}');
      const out: Record<string, Role> = {};
      for (const [domain, role] of Object.entries(raw)) {
        const d = domain.trim().toLowerCase().replace(/^@/, "");
        if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) throw new Error(`not a domain: ${domain}`);
        if (!ROLES.includes(role as Role)) throw new Error(`role for ${domain} must be one of ${ROLES.join(", ")}`);
        out[d] = role as Role;
      }
      return { domainRoles: out };
    }
    default:
      throw new Error(`unknown setting: ${field} (one of ${[...FIELDS, ...EXTRA].join(", ")})`);
  }
}

export function nextField(draft: Partial<Config>): Field | undefined {
  return FIELDS.find((f) => draft[f] === undefined);
}

export function validateConfig(partial: Partial<Config>): Config {
  const missing = FIELDS.filter((f) => partial[f] === undefined);
  if (missing.length) throw new Error(`setup is missing: ${missing.join(", ")}`);
  const p = partial as Config;
  const config: Config = { ownerName: p.ownerName, timezone: p.timezone, digestTime: p.digestTime, sources: p.sources };
  for (const key of ["language", "domainRoles", "setupDoneAt", "paused"] as const) {
    if (p[key] !== undefined) (config as Record<string, unknown>)[key] = p[key];
  }
  return config;
}

export function loadConfig(): Config {
  const config = readJson<Config | null>(file("config.json"), null);
  if (!config?.setupDoneAt) throw new Error("Loop is not set up yet");
  return config;
}
