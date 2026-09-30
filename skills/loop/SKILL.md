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
