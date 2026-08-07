# AI Worklog — Ecom Refund Copilot (MCP)

## AI tools and models used

| Tool | Model / mode | Role in this project |
|------|----------------|----------------------|
| **Grok Build** (xAI CLI / agent) | **Grok 4.5** (`grok-4.5` / `grok-4.5-build`) | Primary tool for implementation and debugging |
| **Opencode** | **Deepseek V4 Flash** | Used for small tasks like updating docs and writing tests | 
| **MCP Inspector** / AI MCP clients | Client-side models vary | Manual end-to-end verification of tools over Streamable HTTP (not used to author the server) |

## Why particular models / tools for each phase

### Planning and research

- I really like the planning mode in Grok CLI. It creates an implementation plan according to the specification provided to it by the user and, unlike Opencode which starts executing the plan by breaking it into tasks, it waits for the user's approval and asks for changes if any.

- It allows the user to edit the plan and make suitable changes and review it before actually implementing anything. 

- The Grok 4.5 model is very capable and creates very extensive plans that scopes out edge cases from the start making it easier for me to review and make the changes that I want.

### Implementation, debugging and testing

- Mostly used Grok 4.5 for implementation and debugging, I rarely have issues with the implementation that I get from that model, inference is pretty fast and it explains the changes it made at the end of every turn.

- I used Opencode with free Deepseek models for writing tests, opensource models are pretty good at working with rich context. If I had used the Deepseek V4 Flash Free model for one-shotting the codebase from scratch, it would have been more likely to make some bad decisions that are harder to reverse down the road.


## How AI was used to plan and break down the work

I used Grok CLI in the plan-mode. I gave it the initial problem statement that I was solving along with the corrections that were given to me by the team. 
After reviewing the plan I made some minor changes to the scope. It had created the plan to add authentication and frontend etc, so I reduced the scope to keep the server light and within bounds. Once that was settled I decided it was enough to create the first version of the server and allowed it to implement the plan.

Most of the documentation on model context protocol implements the server using stdio which is what the agent assumed, I had to correct it and bring it back to HTTP server using express. 
I found the documentation for using express to serve it in some TS SDK documentation and gave it to the agent for reference.

The test suite that it created only covered the very basic implementation of the tools, so I had to prompt it to cover some edge cases where the refunds are denied and orders are escalated etc.

After every session I used Opencode to update the tests and documentation based on the current version of tools.


## AI suggestions corrected, rejected, or substantially changed

At least these material corrections happened:

### Mid-call elicitation → manager escalation (product-critical)

Early design paused on policy failure and completed the refund via MCP elicitation; this was rejected in favour of a manager-approval escalation with no money moved on any failed-policy refund.

### Escalation approve ≠ policy override

`resolve_escalation(approve)` originally completed refunds under "manager authority" re-checking only balance and duplicates, so over-cap/high-risk/chargeback cases could still pay on approve; after a follow-up with the team it now re-runs all policy checks at execution time and moves money only if every gate passes, otherwise the escalation stays pending.

### Stdio (and optional auth) → Streamable HTTP only, no auth

Defaulted toward stdio (and optional auth) like typical local MCP demos, corrected to a remote Express + Streamable HTTP server with stdio and auth removed as out of scope, exposing a single `/mcp` surface plus `/health`.

### Tool-schema tests and curl-based testing docs

Drop the proposed Zod/tool-schema unit tests and curl-based docs; document only `bun test` and MCP-client walks, because evaluators exercise tools through a client and schema tests added noise without proving the agent workflow.

### Scope creep

No frontend, auth, full commerce, or heavy CI/CD — push back on anything that would bloat the demo beyond a focused MCP copilot. 


## How AI-generated work was verified

I made the test suite extensive enough to cover all edge cases which helped me understand whether the tools really work the way they are supposed to work.

I used `@modelcontextprotocol/inspector` to test the tool behaviour before deploying the server.

After deploying I added the server as an MCP connection in ChatGPT and, using the questions from **[TEST_QUESTIONS.md](./TEST_QUESTIONS.md)**, tested the end-to-end workflow.


## Remaining risks or unfinished work

| Item | Status / risk |
|------|----------------|
| **In-memory store** | State resets on process restart; not multi-instance safe. Fine for demo; not production-ready persistence. |
| **No authentication** | Intentional for assignment scope; anyone who can reach `/mcp` can call write tools. |
| **Risk score is seed data** | Documented as “external provider” shape; not a live fraud model. |
| **`action` key is caller-supplied** | Duplicate detection depends on stable `action` + `amount`; a sloppy agent can weaken duplicate protection. |
| **Streamable HTTP + shared process state** | Concurrent clients share one store—good for a live demo, surprising if treated as multi-tenant. |
| **Broader E2E automation** | Unit tests are strong; full MCP-protocol integration tests in CI are not a focus. |