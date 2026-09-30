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
3. The first time the owner's language is clear, also run
   `record-setup.ts --field language --value <tag>` (like `pt-BR`, `en`).
   Never ask for it: scheduled digests are written in it.
4. On a script error, say the problem in one line and ask again.
5. When the output has `next: null`, run `record-setup.ts --done`, then
   confirm in one or two lines that Loop is on: which sources it reads and
   when the digest comes. If `--done` fails, show its error line.

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
- "Pause Loop" / "pausa o Loop" → `record-setup.ts --pause`. "Resume" →
  `record-setup.ts --resume`. A paused Loop reads nothing and sends nothing.
- "Status" → summarize `setup-status.ts`: sources, digest time, and whether
  it is paused.

Confirm each change in one line.
