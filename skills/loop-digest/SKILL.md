---
name: loop-digest
description: The scheduled daily Loop digest, at the owner's digest time. Sends at most one short message, and only when something needs the owner.
---
# Loop digest

This turn is unattended and has no inbound Plow message. Send only the
messages listed here, then end. Scripts are
`node /opt/plow/skills/loop/scripts/<name>.ts`.

1. Run `setup-status.ts`. If it is not `READY`, or `config.paused` is true,
   end silently.
2. End silently.
