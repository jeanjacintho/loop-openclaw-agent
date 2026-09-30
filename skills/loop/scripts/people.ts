// Who is who. A person is found by handle, never by name ("Pedro" is not
// "Pedro"): the exact handle first (phones match on their last digits), then
// the owner's Mac contacts, which tie one person's emails and phones
// together, then a new person. Two people with the same name and no shared
// handle are a question for the owner, asked once in the digest.
//
// Contacts are read with one fixed command (the whole address book: names,
// emails and phones, no notes) at most once a day and cached here, so the
// unattended poll never asks Latch for a new approval per person (D8).
//
//   people.ts contacts-refresh [--max-age-hours 24]
//   people.ts role --person <handle|id> --role investor|customer|team|partner|other|unknown
//   people.ts questions                → pairs that may be one person, not asked yet
//   people.ts answer --a A --b B --same|--different
//   people.ts show --person <handle|name|id>
import { parseArgs } from "node:util";
import { isMain, run } from "./cli.ts";
import type { Config } from "./config.ts";
import { withStore, type Store } from "./db.ts";
import { isEmail, isPhone, normalizeHandle, sameHandle } from "./handles.ts";
import { foldName, personByHandle, personView, ROLES, type PersonInput, type PersonView, type Role } from "./ledger.ts";
import { callMac, type BridgeOptions } from "./mac.ts";
import { file, nowMs } from "./paths.ts";
import { readJson, writeJson } from "./store.ts";

export type Contact = { name: string; org: string | null; handles: string[] };
export type ContactsCache = { fetchedAt: string; contacts: Contact[] };

const CONTACTS_SQL = [
  "SELECT r.Z_PK, coalesce(r.ZFIRSTNAME,''), coalesce(r.ZLASTNAME,''), coalesce(r.ZORGANIZATION,''), 'email', e.ZADDRESS",
  "FROM ZABCDRECORD r JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK",
  "UNION ALL",
  "SELECT r.Z_PK, coalesce(r.ZFIRSTNAME,''), coalesce(r.ZLASTNAME,''), coalesce(r.ZORGANIZATION,''), 'phone', p.ZFULLNUMBER",
  "FROM ZABCDRECORD r JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK;",
].join(" ");

// One fixed argv: every address book source on the Mac, read-only, one line
// per handle: `<source db>|<record>|<first>|<last>|<org>|<email|phone>|<value>`.
export const CONTACTS_ARGV = [
  "/bin/sh", "-c",
  'for db in "$HOME/Library/Application Support/AddressBook/Sources/"*/AddressBook-v22.abcddb; do [ -f "$db" ] && /usr/bin/sqlite3 -readonly -separator "|" "$db" "$1" | sed "s#^#$db|#"; done; exit 0',
  "sh", CONTACTS_SQL,
];

export function parseContacts(output: string): Contact[] {
  const byRecord = new Map<string, Contact>();
  for (const line of output.split("\n")) {
    const parts = line.split("|");
    if (parts.length < 7) continue;
    const [db, id, first, last, org, kind, ...rest] = parts;
    const value = rest.join("|").trim();
    const handle = kind === "email" && isEmail(value) ? normalizeHandle(value) : kind === "phone" && isPhone(value) ? normalizeHandle(value) : null;
    if (!handle) continue;
    const key = `${db}|${id}`;
    const name = [first, last].map((x) => x?.trim()).filter(Boolean).join(" ") || org?.trim() || "";
    const c = byRecord.get(key) ?? { name, org: org?.trim() || null, handles: [] };
    if (!c.handles.includes(handle)) c.handles.push(handle);
    byRecord.set(key, c);
  }
  return [...byRecord.values()].filter((c) => c.name);
}

const CACHE = () => file("contacts.json");

export async function refreshContacts(opts: BridgeOptions = {}, maxAgeHours = 24, now = nowMs()): Promise<{ refreshed: boolean; contacts: number; reason?: string }> {
  const cached = readJson<ContactsCache | null>(CACHE(), null);
  if (cached && now - Date.parse(cached.fetchedAt) < maxAgeHours * 3_600_000) return { refreshed: false, contacts: cached.contacts.length };
  const res = await callMac({
    argv: CONTACTS_ARGV, readPaths: ["~/Library/Application Support/AddressBook"], timeoutMs: 60_000,
    goal: "Loop: read your contacts' names, emails and phones (nothing else) so one person's email and phone count as the same person",
  }, opts);
  if (!res.ok) return { refreshed: false, contacts: cached?.contacts.length ?? 0, reason: res.reason };
  const contacts = parseContacts(res.output);
  writeJson(CACHE(), { fetchedAt: new Date(now).toISOString(), contacts });
  return { refreshed: true, contacts: contacts.length };
}

export function contactFor(handle: string, contacts: Contact[] = readJson<ContactsCache | null>(CACHE(), null)?.contacts ?? []): Contact | undefined {
  return contacts.find((c) => c.handles.some((h) => sameHandle(h, handle)));
}

// The role a domain carries in the owner's config ("fund.vc": investor).
export function roleFromDomain(handles: string[], domainRoles: Config["domainRoles"] = {}): Role | undefined {
  for (const h of handles) {
    if (!isEmail(h)) continue;
    const domain = h.split("@")[1]!.toLowerCase();
    const hit = Object.entries(domainRoles ?? {}).find(([d]) => domain === d || domain.endsWith(`.${d}`));
    if (hit) return hit[1];
  }
  return undefined;
}

// A person as the ledger should store them: every handle the owner's contacts
// know for them, their contact name when the message gave none, and the role
// their email domain carries. Never a handle from message text.
export function enrich(input: PersonInput, contacts?: Contact[], domainRoles?: Config["domainRoles"]): PersonInput {
  if (input === "owner") return input;
  const handles = [...(input.handles ?? [])];
  let name = input.name;
  let org = input.org;
  for (const h of input.handles ?? []) {
    const c = contactFor(h, contacts);
    if (!c) continue;
    for (const extra of c.handles) if (!handles.some((x) => sameHandle(x, extra))) handles.push(extra);
    name ??= c.name;
    org ??= c.org ?? undefined;
  }
  const role = input.role ?? roleFromDomain(handles, domainRoles);
  return { ...(name ? { name } : {}), handles, ...(role ? { role } : {}), ...(org ? { org } : {}) };
}

export function personRef(store: Store, who: string): number {
  if (/^\d+$/.test(who)) return Number(who);
  const id = personByHandle(store, who);
  if (id === undefined) throw new Error(`no known person with the handle ${who}`);
  return id;
}

export function setRole(store: Store, who: string, role: string): PersonView {
  if (!ROLES.includes(role as Role)) throw new Error(`role must be one of ${ROLES.join(", ")}`);
  const id = personRef(store, who);
  store.db.prepare("UPDATE people SET role = ? WHERE id = ? AND is_owner = 0").run(role, id);
  return personView(store, id);
}

export function openQuestions(store: Store): { a: PersonView; b: PersonView }[] {
  return (store.db.prepare("SELECT a_id, b_id FROM person_questions WHERE answer IS NULL ORDER BY created_at").all() as { a_id: number; b_id: number }[])
    .map((q) => ({ a: personView(store, q.a_id), b: personView(store, q.b_id) }));
}

// "Same" moves b's handles and commitments to a; "different" only records the answer.
export function answer(store: Store, a: number, b: number, same: boolean, at = new Date(nowMs()).toISOString()): { kept: PersonView; answer: "same" | "different" } {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return store.tx(() => {
    const q = store.db.prepare("SELECT 1 FROM person_questions WHERE a_id = ? AND b_id = ?").get(lo, hi);
    if (!q) throw new Error(`no open question about people ${lo} and ${hi}`);
    store.db.prepare("UPDATE person_questions SET answer = ?, asked_at = coalesce(asked_at, ?) WHERE a_id = ? AND b_id = ?").run(same ? "same" : "different", at, lo, hi);
    if (!same) return { kept: personView(store, lo), answer: "different" as const };
    store.db.prepare("UPDATE OR IGNORE handles SET person_id = ? WHERE person_id = ?").run(lo, hi);
    store.db.prepare("DELETE FROM handles WHERE person_id = ?").run(hi);
    store.db.prepare("UPDATE commitments SET debtor_id = ? WHERE debtor_id = ?").run(lo, hi);
    store.db.prepare("UPDATE commitments SET creditor_id = ? WHERE creditor_id = ?").run(lo, hi);
    store.db.prepare("UPDATE evidence SET author_id = ? WHERE author_id = ?").run(lo, hi);
    store.db.prepare("UPDATE people SET role = (SELECT role FROM people WHERE id = ?) WHERE id = ? AND role = 'unknown'").run(hi, lo);
    store.db.prepare("UPDATE person_questions SET answer = 'same' WHERE (a_id = ? OR b_id = ?) AND answer IS NULL").run(hi, hi);
    return { kept: personView(store, lo), answer: "same" as const };
  });
}

export function markAsked(store: Store, a: number, b: number, at: string): void {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  store.db.prepare("UPDATE person_questions SET asked_at = ? WHERE a_id = ? AND b_id = ? AND asked_at IS NULL").run(at, lo, hi);
}

if (isMain(import.meta.url)) {
  run(async () => {
    const [cmd, ...rest] = process.argv.slice(2);
    const { values } = parseArgs({
      args: rest,
      options: {
        person: { type: "string" }, role: { type: "string" }, a: { type: "string" }, b: { type: "string" },
        same: { type: "boolean" }, different: { type: "boolean" }, "max-age-hours": { type: "string" },
      },
    });
    switch (cmd) {
      case "contacts-refresh":
        return refreshContacts({}, values["max-age-hours"] ? Number(values["max-age-hours"]) : 24);
      case "role":
        if (!values.person || !values.role) throw new Error("usage: people.ts role --person <handle|id> --role R");
        return withStore((s) => ({ person: setRole(s, values.person!, values.role!) }));
      case "questions":
        return withStore((s) => ({ questions: openQuestions(s) }));
      case "answer": {
        if (!values.a || !values.b || values.same === values.different) throw new Error("usage: people.ts answer --a A --b B --same|--different");
        return withStore((s) => answer(s, Number(values.a), Number(values.b), values.same === true));
      }
      case "show": {
        if (!values.person) throw new Error("usage: people.ts show --person <handle|name|id>");
        return withStore((s) => {
          let ids: number[];
          try {
            ids = [personRef(s, values.person!)];
          } catch {
            const needle = foldName(values.person!);
            ids = (s.db.prepare("SELECT id, display_name FROM people WHERE is_owner = 0").all() as { id: number; display_name: string | null }[])
              .filter((p) => foldName(p.display_name).includes(needle)).map((p) => p.id);
          }
          const count = s.db.prepare("SELECT count(*) AS n FROM commitments WHERE debtor_id = ? OR creditor_id = ?");
          return { people: ids.map((id) => ({ ...personView(s, id), commitments: (count.get(id, id) as { n: number }).n })) };
        });
      }
      default:
        throw new Error("usage: people.ts contacts-refresh | role --person P --role R | questions | answer --a A --b B --same|--different | show --person P");
    }
  });
}
