# LOOP — AI Follow-Through Agent for Founders

## Context

I already have an ecosystem of AI agents focused on helping founders:

- **The Founder Times** — helps the founder understand what matters and what to focus on.
- **Meetly** — handles scheduling, calendar organization, and time.
- **AHA** — monitors social networks and the market for mentions of the company, competitors, and relevant signals.

I want to explore a fourth agent that complements these instead of overlapping with them.

My current idea is LOOP.

---

## Product thesis

**LOOP — The commitment layer for founders.**

Core idea:

> LOOP knows what you owe, what you're owed, and makes sure it gets done.

Alternative positioning:

- AI Follow-Through Agent
- Your commitments, handled.
- Nothing falls through.
- Give LOOP an outcome. It makes sure it happens.

The goal is NOT to build another generic AI Chief of Staff or task manager.

The goal is to create an agent specialized in commitments, follow-ups, dependencies, and unfinished obligations.

---

## Problem

Founders constantly create commitments across many places:

- Email
- Slack
- WhatsApp / Telegram
- Meetings
- Calendar
- Notes
- Browser-based tools
- CRM
- Internal conversations

Examples:

- "I'll send you the deck tomorrow."
- "Send me the metrics by Friday."
- "Let's reconnect after the board meeting."
- "I'll introduce you to Pedro."
- "They said they'll send the contract next week."

Most of these never become explicit tasks.

As a result, founders forget:

- things they promised;
- things others promised them;
- follow-ups;
- dependencies;
- deadlines;
- decisions that are waiting for an event.

LOOP should capture this automatically.

---

## Fundamental unit: Commitment, not Task

Instead of treating everything as a task, LOOP works with Commitments.

Example:

```json
{
  "debtor": "Jean",
  "creditor": "Michael",
  "commitment": "send updated investor deck",
  "deadline": "tomorrow",
  "type": "promise",
  "confidence": 0.96,
  "source": "meeting",
  "evidence": "I'll send you the updated deck tomorrow",
  "status": "open"
}
```

Main distinction:

**I OWE** — Things the founder promised to someone else.

**THEY OWE** — Things someone else promised to the founder.

Simple interface example:

```
YOU OWE                     THEY OWE

Michael — Investor deck     Lucas — Revenue metrics
Sarah — Intro to Pedro      ACME — Signed contract
James — Proposal            Ana — Final design
```

---

## Commitment types

Initial categories:

1. **Promise** — "I'll send it tomorrow."
2. **Request** — "Can you send this by Friday?"
3. **Delegation** — "Lucas, finish this by Wednesday."
4. **Waiting** — "They'll get back to us next week."
5. **Decision** — "Let's decide after the board meeting."

The last category matters because some commitments depend on an event rather than a date.

---

## Core workflow

```
Message / Meeting / Event
        ↓
Commitment Detection
        ↓
Entity Resolution
        ↓
Commitment Graph
        ↓
Priority / Risk Analysis
        ↓
Wait or Act
        ↓
Follow-up / Execution
        ↓
Verify Result
        ↓
Resolved
```

LOOP should not stop after performing an action.

The key concept is closed-loop execution.

Example:

```
Promise detected
↓
Deadline arrives
↓
No response
↓
Follow-up prepared
↓
Founder approves
↓
Message sent
↓
LOOP waits
↓
Response received
↓
LOOP verifies whether the commitment was fulfilled
↓
Commitment CLOSED
```

---

## Key feature: Commitment Graph

Instead of a flat list, LOOP should maintain relationships between:

- people;
- commitments;
- companies;
- projects;
- deadlines;
- dependencies;
- conversations;
- outcomes.

Example:

```
Jean
│
├── owes → Michael
│   └── investor deck
│
├── waiting on → Lucas
│   └── revenue metrics
│
├── owes → Sarah
│   └── intro to Pedro
│
└── waiting on → ACME
    └── signed contract
```

This could evolve into a Relationship + Commitment Operating System.

---

## Important capabilities

### 1. Automatic commitment detection

The founder should not need to manually create tasks.

LOOP should detect phrases such as:

- "I'll send…"
- "I'll get back to you…"
- "Can you…"
- "Let's revisit…"
- "I'll introduce…"
- "We'll decide after…"

The product philosophy should be:

> Zero bookkeeping.

### 2. Evidence-first UX

LOOP should always be able to explain why it thinks a commitment exists.

Example:

> **Why LOOP thinks this**
>
> Slack · #fundraising · Sep 28
> Jean: "I'll send Michael the updated deck tomorrow."

This is essential for user trust.

### 3. Confidence system

Not every inferred commitment should be treated equally.

Possible internal logic:

```
95–100% → Track automatically
75–94%  → Track with low priority
50–74%  → Ask user
<50%    → Ignore
```

The goal is to avoid creating notification noise.

### 4. Resolution detection

LOOP should determine whether a commitment was actually fulfilled.

Example:

Commitment:

> Lucas will send revenue metrics.

Later an email arrives:

> "Here are the numbers."

LOOP should automatically connect the new event with the old commitment and close it.

This should work across channels.

Example:

- Commitment created in Slack
- Resolution detected in Email

### 5. Dependency detection

LOOP should understand chains such as:

```
Lucas
↓
Revenue metrics
↓
Jean
↓
Investor update
↓
Michael
```

Instead of simply saying:

> Lucas is late.

LOOP could say:

> The investor update is due tomorrow and still depends on Lucas' metrics.

This enables preventive follow-up.

### 6. Silence interpretation

LOOP should understand that silence is contextual.

Example:

Proposal sent 7 days ago with no response:
→ likely follow-up.

But:

Customer says:

> "We'll review this internally next month."

7 days of silence:
→ normal.

### 7. Operational Trust

LOOP should learn the founder's preferred level of autonomy.

Example:

```
Customer follow-up drafts
Approved 38/40 times
→ High trust

Internal calendar changes
Approved 19/20 times
→ High trust

Investor email sends
Approved 5/12 times
→ Low trust
```

Then LOOP could ask:

> You've approved this type of action 95% of the time. Should I do these automatically in the future?

---

## Interaction model

LOOP should be primarily proactive and conversational.

Not dashboard-first.

Example morning message:

```
🔁 LOOP

3 things need your attention today.

1. Michael is waiting for your deck.
   You promised it yesterday.

2. Lucas hasn't sent the metrics.
   They're blocking tomorrow's investor update.

3. Sarah hasn't replied.
   Proposal sent 8 days ago.

I've prepared the next actions.
```

The ideal behavior:

> LOOP stays quiet when everything is under control.

It should surface only:

- risk;
- overdue commitments;
- blockers;
- important new commitments;
- decisions;
- opportunities to close a loop.

---

## Integration with my existing agents

### The Founder Times

LOOP becomes an operational-memory source.

Example:

LOOP knows:

```
17 open loops
3 require attention
1 critical blocker
2 commitments due tomorrow
```

The Founder Times can use this to choose the founder's top priorities.

### Meetly

Meetly can act when a commitment needs a meeting.

Example:

LOOP:

> Pricing decision has been blocked for 5 days because Carlos and Jean haven't aligned.

Meetly:

> Both have 30 minutes free at 14:30.

Possible action:

> "Pricing has been blocked for 5 days. Want me to schedule 20 minutes with Carlos?"

### AHA

AHA detects an external trigger.

Example:

AHA:

> Michael posted that he's looking for AI infrastructure startups.

LOOP knows:

- Michael is an investor;
- last conversation was months ago;
- an old loop exists.

LOOP can suggest:

> Good reason to reconnect. Draft ready.

---

## Founder OS vision

```
                FOUNDER OS

                   Founder
                     │
        ┌────────────┼────────────┐
        │            │            │
       KNOW         TIME        REMEMBER
        │            │            │
Founder Times     Meetly        LOOP
        │            │            │
        └────────────┼────────────┘
                     │
                    AHA
                   LISTEN
```

Possible role definitions:

- The Founder Times → KNOW
- Meetly → TIME
- AHA → LISTEN
- LOOP → FOLLOW THROUGH / REMEMBER

LOOP may eventually become the operational-memory layer connecting all other agents.

---

## Technical stack

Current stack:

- OpenClaw
- Plow / Latch

Potential architecture:

```
                 LOOP
          Commitment Intelligence
                    │
               OpenClaw
              Agent Runtime
                    │
       ┌────────────┼────────────┐
       │            │            │
     Email        Slack       WhatsApp
       │            │            │
       └────────────┼────────────┘
                    │
               Plow / Latch
             Controlled Actions
                    │
       ┌────────────┼────────────┐
       │            │            │
     Browser       Files        Apps
```

OpenClaw can handle:

- memory;
- agent orchestration;
- channels;
- automations;
- standing intents;
- standing orders;
- scheduled actions;
- hooks.

Plow/Latch can act as the execution layer:

- browser actions;
- Gmail;
- web apps;
- local files;
- CLI;
- tools with approval gates.

---

## Security / autonomy model

LOOP should make autonomy explicit.

Three levels:

- **Observe** — Can read and detect commitments.
- **Prepare** — Can draft actions.
- **Act** — Can execute actions.

Example:

```
Email
Observe   ✓
Prepare   ✓
Act       Ask

Calendar
Observe   ✓
Prepare   ✓
Act       ✓

Banking
Observe   ✓
Prepare   ✗
Act       ✗
```

This could be part of the product's differentiation.

---

## Competitive landscape

The obvious danger is becoming another generic AI Chief of Staff.

Competitors already cover parts of this space:

- AI Chief of Staff products;
- follow-up agents;
- inbox assistants;
- meeting assistants;
- task managers;
- CRM follow-up tools.

Therefore:

> "LOOP finds your follow-ups"

is NOT strong enough differentiation.

Potential differentiation should come from:

1. Commitment Graph
2. I Owe / They Owe
3. Cross-channel resolution detection
4. Dependency analysis
5. Evidence-first inference
6. Closed-loop execution
7. Contextual silence interpretation
8. Operational Trust / adaptive autonomy
9. Cross-agent integration
10. Acting until the outcome is actually complete

---

## Main differentiation

The key positioning should be:

> Most assistants know what you said.
> LOOP knows what needs to happen next.

And:

> LOOP doesn't stop when the email is sent.
> It stays responsible until the loop is actually closed.

This is the core idea behind Autonomous Follow Through.

---

## Potential future evolution

Instead of tracking only individual commitments, the founder could give LOOP a desired outcome.

Example:

> "Get the contract signed."

LOOP would turn this into:

```
GOAL
Get contract signed

Current state:
Contract with Sarah

Next expected event:
Sarah review

Deadline:
Friday

If no response:
Follow up

If legal question:
Escalate to Jean

If signed:
Save document
Notify Jean
Close goal
```

This would move LOOP from a follow-up assistant to an outcome ownership agent.

---

## Suggested MVP

### v0.1

Integrations:

- Gmail
- Google Calendar
- OpenClaw conversations

Capabilities:

1. Detect commitments
2. Separate I Owe / They Owe
3. Infer deadlines
4. Detect resolution
5. Prepare follow-ups

Goal: validate whether founders trust the system enough to let it automatically identify their commitments.

### v0.2

Add:

- Slack
- meeting transcripts
- cross-source resolution
- dependency detection

### v0.3

Add:

- Plow/Latch execution
- approval-based actions
- automatic follow-ups
- verification after action

### v1

Introduce **Autonomous Follow Through**.

The founder gives LOOP an outcome. LOOP stays responsible for progressing it until completion or until human input is required.

---

## Questions for brainstorming

Please challenge this idea critically.

I want to explore:

1. Is "AI Follow-Through Agent" a strong enough category?
2. What existing products are closest to LOOP?
3. Which features are truly differentiated versus easy to copy?
4. What should the initial wedge be?
5. What is the strongest single use case for the MVP?
6. What could make LOOP feel indispensable after one week?
7. What could make founders distrust or abandon it?
8. How can we avoid notification overload?
9. How should the Commitment Graph be modeled?
10. What are the best signals for identifying a real commitment?
11. How should commitment resolution be detected?
12. How should cross-channel identity resolution work?
13. How should LOOP decide when to act autonomously?
14. What should require explicit human approval?
15. How can OpenClaw + Plow/Latch create a meaningful advantage?
16. What defensibility or moat could LOOP develop?
17. Should LOOP remain an independent agent or become the shared memory layer for the whole Founder OS?
18. What would be a better name or positioning if LOOP is too generic?
19. What business model would fit this product?
20. What would a compelling onboarding and first 10-minute experience look like?

---

## Brainstorming objective

The goal is to turn this concept into a focused product that:

- solves a painful founder problem;
- has a very clear category;
- is easy to explain in one sentence;
- produces value without manual bookkeeping;
- can act proactively;
- earns autonomy over time;
- is meaningfully differentiated from generic AI Chief of Staff products;
- integrates naturally with The Founder Times, Meetly, and AHA;
- takes advantage of OpenClaw + Plow/Latch;
- can eventually become part of a broader Founder OS.

Please be critical rather than agreeable.

Identify weak assumptions, direct competitors, technical risks, UX risks, and opportunities to create a stronger wedge.
