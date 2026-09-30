---
name: loop
description: Reference for Loop's scripts (the ledger of commitments, people and evidence). Read it when a loop-* skill names a script.
---
# Loop scripts

Run each as `node /opt/plow/skills/loop/scripts/<name>.ts` with `exec`.
Success prints one JSON line. Failure prints `error: <message>` on stderr and
exits non-zero: report that line; never guess a result. State lives in
`/var/lib/plow/loop/` (`loop.db`, SQLite). Never edit it by hand: every change
goes through these scripts.

| Script | Arguments | Prints |
|---|---|---|
| `setup-status.ts` | | `{status:"READY", config, now, weekday}` or `{status:"SETUP_NEEDED", next, question, draft}` |
| `record-setup.ts` | `--field F --value V` \| `--done` \| `--pause` \| `--resume` | before setup `{saved, next, question}`; after `{saved, config}`; `--done` → `{done, config}`; pause/resume → `{paused, config}` |
| `register-crons.ts` | | `{paused, actions}`: makes the `loop-poll` and `loop-digest` jobs match the config (record-setup runs it for you) |
| `owner-chat.ts` | | `{chatUid}`: the owner's DM |
| `scan-mail.ts` | `scan` \| `commit` \| `probe` | `scan` → `{candidates, dropped, degraded, initialized?, failing?, disabled?}`; `commit` → `{pos, committed}`; `probe` → `{accounts:[{account, ok, reason?, ownerAction?}]}` |
| `scan-imessage.ts` | `scan` \| `commit` \| `probe` | same shapes, for the owner's sent iMessages |
| `detect.ts` | `record --item I --json '<extraction>'` | `{recorded:"commitment", created, band, commitment, ambiguous?}`, `{recorded:"update", change, commitment}`, `{recorded:"dropped"}` or `{recorded:"not_commitment"}` |
| `people.ts` | `contacts-refresh` \| `role --person <handle\|id> --role R` \| `questions` \| `answer --a A --b B --same\|--different` \| `show --person P` | `{refreshed, contacts}`; `{person}`; `{questions:[{a, b}]}` (same name, no shared handle); `{kept, answer}`; `{people}` |
| `resolve.ts` | `candidates` \| `judge --commitment C --item I --verdict fulfilled\|partial\|unrelated\|cancelled [--quote Q]` | `{pairs:[{commitment, message, role, sameThread, sameObject, hasFile}]}`; `{action:"resolved"\|"looks_done"\|"dropped"\|"evidence"\|"none", commitment}` |
| `deadline.ts` | `--text T --sent-at ISO [--tz Z] [--locale L] [--type promise\|request…]` | `{kind:"date", at, text, certainty}`, `{kind:"event", event, text, certainty}` or `{kind:"none", text}` (+ `inferred` with `--type`) |
| `cursor.ts` | `health` \| `get --source mail\|imessage` | `health` → per source `{lastOkAt, failingSince}` |
| `mac-timezone.ts` | | `{timezone}` from the Mac, or `null` |
| `ledger.ts` | `add --json '<commitment>'` \| `--json-file F` | `{commitment, created}`; `created:false` when the same (source, item, what) is already there |
| | `event --id X --kind K [--json '<payload>'] [--actor owner\|loop\|auto]` | `{commitment}` after the event |
| | `evidence --id X --json '<evidence>'` | `{commitment, added}` |
| | `get --id X` | `{commitment, evidence, events}` |
| | `list [--status open[,candidate,…]] [--direction i_owe\|they_owe]` | `{commitments}` (default `open`) |
| | `find --person <handle or name> [--all]` | `{commitments}` with that person on either side (live only unless `--all`) |
| | `due --until ISO` | `{commitments}` open with a date deadline up to then |
| | `stats` | counts by status, band and direction |
| | `retain` | `{cleared}`: quotes of commitments closed > 90 days ago are erased |

## A commitment

```json
{"direction":"i_owe","type":"promise","debtor":"owner",
 "creditor":{"name":"Michael","handles":["michael@fund.vc"]},
 "what":"send the updated deck","objectKind":"file","band":"open",
 "deadline":{"kind":"date","at":"2026-09-29T21:00:00Z","text":"tomorrow","certainty":"firm"},
 "evidence":[{"source":"gmail","item":"gmail:<account>:<thread>@<message>",
              "quote":"I'll send you the updated deck tomorrow","at":"2026-09-28T14:00:00Z","author":"owner","thread":"<thread>"}]}
```

- `direction`: `i_owe` (the owner is the debtor) or `they_owe` (the owner is
  the creditor). `type`: `promise`, `request`, `delegation`, `waiting`,
  `decision`. `objectKind`: `file`, `intro`, `reply`, `meeting`, `decision`, `other`.
- A person is `"owner"` or `{name, handles}`; handles are emails, phones or
  `plow:<uid>`. People are matched by handle only, never by name.
- Evidence is required, and its `item` reopens the source:
  `gmail:<account>:<thread>@<message>`, `imessage:<rowid>`,
  `plow:<chat>:<message>`. Quotes are cut to 280 characters.
- Status: `candidate` (ask the owner), `open`, `snoozed`, `done`, `dropped`.
  It changes only by events: `confirmed`, `rejected`, `deadline_changed`
  (`{"deadline":{…}}`), `snoozed` (`{"until":ISO}`), `resolved`, `reopened`,
  `dropped`, `nudged`, `drafted`.

## Scans

A scan never moves its cursor: it hands over `candidates` (the owner's own
sent messages that passed the prefilter, oldest first, at most 40) and keeps
them in a pending file; `commit` moves the cursor past them once they are in
the ledger. A crash in between re-reads the same messages, and the ledger
ignores an item it already has. Each candidate:
`{source, item, thread, to, cc, toNames, sentAt, subject?, text, signals, attachments, links}`.
`text` is only the owner's own words (quoted history removed). Scans also hand over `evidence`: new messages to or from someone with a
live commitment (for mail, the inbox is read only while a commitment is
live, and only those people's messages are kept), for `resolve.ts`. `degraded`
lists what could not be read and why (`blocked` with Latch's `ownerAction`,
`unreachable`, `mail-no-body`, `imessage-gap`); `failing.warn` is true once,
30 minutes into a run of failures.

## People

A person is matched by handle only: the exact email or phone (phones on
their last digits), or any other handle the owner's contacts list for them.
Never by name: two Pedros stay two people, and the digest asks the owner once
whether they are the same (`people.ts questions` / `answer`). A role
(`investor`, `customer`, `team`, `partner`, `other`) comes from the owner
("Michael is an investor" → `people.ts role`) or from `config.domainRoles`.
The same commitment seen again within a week (the same two people, the same
kind of object, a shared word, as in "send the deck" by email and "mando o
deck" by text) becomes more evidence on the first one.
