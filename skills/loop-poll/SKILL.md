---
name: loop-poll
description: The scheduled Loop poll, every 15 minutes. Reads what the owner sent, updates the commitment ledger and checks critical deadlines.
---
# Loop poll

This turn is unattended and has no inbound Plow message. Do the work, send only
the messages listed here, then end. Scripts are
`node /opt/plow/skills/loop/scripts/<name>.ts`.

1. Run `setup-status.ts`. If it is not `READY`, or `config.paused` is true,
   end silently.
2. End silently.
