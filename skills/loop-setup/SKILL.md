---
name: loop-setup
description: Loop's first-run questions in the owner's DM, and changing settings, pausing or resuming afterwards.
---
# Loop setup

Only in the owner's DM. Never ask setup questions anywhere else. Scripts are
`node /opt/plow/skills/loop/scripts/<name>.ts`.

The value has to show within ten minutes, so setup is four short questions at
most, and two of them usually answer themselves.

## First run

1. Ask the `question` that `setup-status.ts` returns on this turn, translated
   into the owner's language, one per message, then end the turn. A question
   asked earlier in the chat is not the current one: always use what the
   script returns now. The first setup message opens with one line saying you
   are Loop, their follow-through agent, and that a few quick questions set
   you up. If the owner asked for something else, say in that line that you
   will do it once setup is done.
2. When the owner answers, normalize the answer and run
   `record-setup.ts --field <next> --value <v>`:
   - `ownerName` → the name as they gave it.
   - `timezone` → an IANA name, like `America/Sao_Paulo`.
   - `digestTime` → `HH:MM`. "ok", "pode ser", "default" or no preference →
     `default` (08:30).
   - `sources` → JSON `{"mail":{"accounts":["<gmail>"]},"imessage":true}`;
     `"mail":null` or `"imessage":false` for a source they do not want.
     Before asking, run `plow-gog accounts` on the Mac (follow the Mac's
     `google-workspace` skill) and offer the Gmail accounts it lists. Loop
     reads only what the owner **sent**; say so if they ask.
   Right after `sources` is recorded, while the owner is here, run the
   probe of each source they turned on: `scan-mail.ts probe` and
   `scan-imessage.ts probe`. Each runs, once, the exact command the
   scheduled poll will run, so Latch asks now: tell the owner to choose
   **Always allow**, or the 15-minute poll will be blocked while they are
   away. A probe that is not `ok` → say which source and why in one line; if
   it has an `ownerAction`, give it word for word. Setup still goes on.
3. The first time the owner's language is clear, also run
   `record-setup.ts --field language --value <tag>` (like `pt-BR`, `en`).
   Never ask for it: scheduled digests are written in it.
4. On a script error, say the problem in one line and ask again.
5. When the output has `next: null`, run `record-setup.ts --done`. It saves
   the settings and registers Loop's two jobs (the poll every 15 minutes and
   the daily digest). Then confirm in one or two lines that Loop is on: which
   sources it reads and when the digest comes, and ask: "Can I look at the
   last two weeks now, to show you what is still open?" (in their language).
   If `--done` fails, show its error line; running it again is safe.
6. On yes, follow **Look back** below, in this turn.

## Look back

The owner is here, so Latch can ask them for these one-off reads now.

1. Run `backfill.ts run`. If `degraded` has entries, say in one line which
   source could not be read and pass on any `ownerAction` word for word.
2. For each candidate, follow the **Extract** section of `loop-poll` and
   record it with `detect.ts record --item <item> --json '<extraction>'`,
   exactly as the poll does.
3. Run `resolve.ts candidates`, and for each pair follow `loop-poll`'s
   **Judge** and run `resolve.ts judge …`: what was already delivered in
   these two weeks is closed now, not reported as open.
4. Run `backfill.ts summary` and send its `text` to the owner as printed:
   how many promises and requests are open, which are past due (with the
   quote), and the ones Loop is unsure about, numbered for "4 sim" / "5 não".
5. Run `backfill.ts done`.

On no, say Loop starts from now and will send the first digest when
something needs them.

Never skip a question, invent an answer or fill one in from a guess.

## What setup fills by itself

`setup-status.ts` answers two questions before they are asked: the owner's
name, from their Plow profile, and their time zone, from their Mac
(`readlink /etc/localtime` through Latch, read-only). Neither is announced;
setup simply moves on. When `next` is still `ownerName` or `timezone`, that
source had no answer (no name on Plow, the Mac not connected): ask the owner.

## After setup

- "Digest at 7" / "digest às 7" → `record-setup.ts --field digestTime --value 07:00`.
- "Stop reading my iMessages" / "desliga o iMessage", or turning a source on
  → `record-setup.ts --field sources --value '<the whole JSON>'`: start from
  `config.sources` in `setup-status.ts` and change only that source.
- "People at fund.vc are investors" → `record-setup.ts --field domainRoles
  --value '<the whole map>'`: start from `config.domainRoles` and add to it.
- "Michael is an investor" / "o Lucas é do time" → `people.ts role --person
  <their handle> --role investor|customer|team|partner|other`; find the
  handle with `people.ts show --person <name>`. If several people match,
  ask which one.
- "Pause Loop" / "pausa o Loop" → `record-setup.ts --pause`. "Resume" →
  `record-setup.ts --resume`. Pausing disables both jobs: a paused Loop reads
  nothing and sends nothing. A new digest time or time zone moves the digest
  job by itself.
- "Status" → summarize `setup-status.ts`: sources, digest time, and whether
  it is paused.

Confirm each change in one line.
