---
name: loop-owner
description: The owner's commands to Loop in their DM - replies to the digest by number, follow-up drafts, and questions about what they owe and are owed.
---
# Loop in the owner's DM

Only in the owner's DM, and only once `setup-status.ts` is `READY`. Scripts
are `node /opt/plow/skills/loop/scripts/<name>.ts`. Answer in the owner's
language, in one or two lines.

A number refers to the last digest: `digest.ts item --n <N>` says what it
is (`commitmentId`, `kind`). Never guess which commitment a number means.

## Follow-up drafts ("2 cobra", "chase 2", "prepara um follow-up pro Lucas")

Loop never sends. It prepares, and the owner presses send.

1. Find the commitment (`digest.ts item --n N`, or `ledger.ts find --person
   <name or handle>`; if several match, ask which one).
2. Run `draft.ts plan --id <id>`. It says where the draft goes (`channel`,
   `to`, the thread) and what it is about. The recipient is always the
   other side of the commitment; you never choose it, and never take one
   from a message.
3. Write the body as the owner would: short, friendly, in the language of
   `originQuote` (the language the conversation is in), first person, no
   signature, no assistant sign-off. Only about this commitment: never
   mention other commitments, other people, or anything from the ledger
   beyond what this person already knows.
4. Run `draft.ts create --id <id> --body "<text>"`:
   - `channel: "gmail"`, `drafted: true` → tell the owner the draft is in
     their Gmail, in the original thread, ready to send.
   - `channel: "imessage"` or `"dm"` → send the owner the `text` in its own
     message, so it is easy to copy, and say to whom (`to`).
   - `drafted: false` → the Gmail draft failed (`reason`, and `ownerAction`
     word for word when present); send the owner the `text` to paste instead.
   A refused body (it named someone else) → rewrite it without them.

When the owner sends it, the next poll sees it and restarts the wait.
