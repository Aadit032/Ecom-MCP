# AI Worklog — Ecom Refund Copilot (MCP)

This log describes how AI was used to plan, implement, test, and document the refund investigation and approval MCP server. It is written from the developer’s perspective (human + AI collaboration), based on the actual build and review sessions for this repository.

---

## 1. AI tools and models used

| Tool | Model / mode | Role in this project |
|------|----------------|----------------------|
| **Grok Build** (xAI CLI / agent) | **Grok 4.5** (`grok-4.5` / `grok-4.5-build`) | Primary tool for implementation, debugging, tests, docs, emails, evaluator materials, and demo script |
| Grok Build session modes | Plan-oriented agent (`grok-build-plan`), high reasoning effort | Used for multi-file implementation and policy-heavy work |
| Project instructions | `CLAUDE.md` (Bun defaults) | Constrained runtime choices (Bun, `bun test`, etc.) even though implementation ran in Grok Build |
| **MCP Inspector** / AI MCP clients (Claude Desktop, Cursor, VS Code-style remote MCP) | Client-side models vary | Manual end-to-end verification of tools over Streamable HTTP (not used to author the server) |
| Stakeholder email thread | Human (no model) | Scope approval and product constraints that overrode early design ideas |

**Primary model for almost all coding and writing:** Grok 4.5 via Grok Build.

Sessions (approximate timeline):

| When | Focus |
|------|--------|
| 2026-07-31 → 2026-08-01 | Core implementation: domain model, policy, MCP tools, Express + Streamable HTTP, unit tests, README, stakeholder update drafts |
| 2026-08-05 | Evaluator-facing `TEST_QUESTIONS.md` (prompt set for AI-client testing) |
| 2026-08-05 | Demo video flow → `script.md`; this AI worklog → `worklog.md` |
| 2026-08-06 | Stakeholder follow-up: rework `resolve_escalation` — full policy re-check on approve; no money when checks still fail; update tests + all docs |

---

## 2. Why particular models / tools for each phase

### Planning and research

- **Human-led first:** Problem framing and a pre-build check-in email were drafted before heavy coding (refund investigation copilot, synthetic data, eligibility + guarded write path).
- **Grok 4.5 for planning/breakdown:** Once stakeholder feedback landed, Grok was used to turn that into a concrete file layout, tool list, seed matrix, and implementation todos—not to invent product policy from scratch.
- **Why not a separate “research” model:** Scope was bounded by the assignment (no full commerce backend, no real credentials). Research was mostly MCP SDK usage (Streamable HTTP + Express) and matching the approved safety rules.

### Implementation

- **Grok 4.5 (high effort) for implementation:** Multi-file TypeScript (types, seed, store, policy, tool registration, HTTP entry) benefits from a strong coding agent with repo context and edit tools.
- **Bun + Express + official MCP packages:** Chosen under human direction after the deploy question (“I want this on a server, not only local”)—not stdio-only.

### Debugging and testing

- **Same model for debug/test loops:** Fix types, expand `policy.test.ts`, re-run `bun test`. Continuity in one session reduced context loss on policy edge cases.
- **No separate test-only model:** Policy tests are domain-heavy; the model that wrote `policy.ts` was also best placed to extend coverage when edge cases were listed.

### Review, communication, and demo materials

- **Grok 4.5 for drafts:** Stakeholder update emails, README testing sections, `TEST_QUESTIONS.md`, `script.md`, `worklog.md`.
- **Human for tone/length:** Emails shortened to “short and formal”; test-question lists trimmed and rebalanced; demo scope kept to 4–5 minutes.

---

## 3. How AI was used to plan and break down the work

### Product plan (before / at start of build)

**Initial proposal (human → stakeholder):**

- Read tools: order / payment / shipment lookup  
- Eligibility-check tool  
- Guarded `issue_refund`  
- Auto-refund under a threshold; failures pause mid-call via **MCP elicitation** for human approval  

**Stakeholder response (authoritative product constraints — Jul 31):**

- Refund investigation/approval is a suitable ops workflow  
- Read tools + eligibility form a coherent flow  
- **Revise the write path:** if any policy check fails, **do not** complete the refund via elicitation; **create a manager-approval escalation and move no money**  
- Auto-execute only when **all** hold: amount ≤ $150, ≤ paid amount, order ≤ 30 days, customer risk &lt; 70, verified carrier exception, no duplicate for same action+amount; otherwise escalate  
- Synthetic local data only  

**Stakeholder follow-up (authoritative — Aug 5):**

- Existing policy and escalation **coverage** is sufficient; stay in the same workflow  
- On manager resolution: **re-check the relevant policy conditions at execution time**  
- An escalation is **not** authorization for the MCP to bypass a failed policy check  
- Keep any **manual** exception resolution **outside** the automated refund path  

That boundary (Jul 31 + Aug 5) is the product source of truth for implementation and for the later `resolve_escalation` rework.

### Technical breakdown (AI + human)

Grok was directed to build the server under those rules. Work was decomposed (and tracked as todos in-session) roughly as:

1. Domain types + policy constants  
2. Synthetic seed catalog (happy path + escalation scenarios)  
3. In-memory store (orders, payments, shipments, refunds, escalations)  
4. Eligibility evaluation (read-only)  
5. `issue_refund` (auto vs escalate) + `resolve_escalation`  
6. MCP tool registration (`create-server.ts`)  
7. Transport: Streamable HTTP over Express (`index.ts`)  
8. Unit tests (`policy.test.ts`) + README  
9. Later: MCP-client question bank, demo script, worklog  

Deployment/scope constraints were injected as standing project memory:

- No frontend or design system  
- No authentication / user-management infrastructure  
- No complete commerce backend  
- No complex CI/CD  

Transport decisions were sequential:

1. Human: “I want to deploy on a server—does it need stdio?”  
2. Human: “Use Express as the HTTP server; Streamable HTTP for MCP.”  
3. Human: “Remove the stdio part and the auth part as well.”  

### Collaboration / evaluation process

The assignment explicitly rewards ongoing communication (assumptions, tradeoffs, progress)—not a silent final drop. AI was used to **draft** update emails from the current codebase; the human owned sending, timing, and what to surface in the email thread.

---

## 4. Division of responsibilities (human vs AI)

### Human (me)

- Chose the problem domain and framed the stakeholder check-in  
- Incorporated stakeholder policy (especially **no elicitation-complete path**)  
- Set non-goals (no frontend, no auth, no full commerce stack)  
- Chose deployable transport direction (HTTP / Streamable HTTP, Express)  
- Directed scope cuts (drop stdio, drop auth)  
- Identified missing edge cases for tests and asked for coverage  
- Rejected low-value tests and wrong testing docs (tool-schema tests; curl-first instructions)  
- Tuned evaluator materials length (~20 questions, not a huge suite)  
- Owned product judgment, email send decisions, deployment host binding, and final review of AI output  
- Will record the demo video and submit assignment artifacts  

### AI (Grok 4.5 / Grok Build)

- Scaffolded and implemented most of the TypeScript codebase  
- Encoded policy checks and auto vs escalate vs reject paths  
- Built seed scenarios aligned to the policy matrix  
- Registered MCP tools and Streamable HTTP entrypoint  
- Expanded unit tests from an edge-case list  
- Wrote/rewrote README testing guidance  
- Drafted stakeholder emails (then shortened on request)  
- Produced `TEST_QUESTIONS.md`, `script.md`, and this `worklog.md`  
- Answered design Q&A (e.g. “when policy fails, does money move?”; carrier exception coverage)  

### Shared

- Policy interpretation: human supplied exact bullets; AI implemented and we re-checked coverage together  
- Verification: AI ran tests; human reviewed outcomes and directed gaps  

---

## 5. Important prompts, instructions, and context supplied

### Standing project context

- `CLAUDE.md`: prefer Bun, `bun test`, Bun APIs where applicable (HTTP stack later overridden to Express for MCP SDK fit)  
- Assignment non-goals: no frontend, auth, full commerce backend, complex CI/CD  
- Evaluation culture: communicate assumptions and tradeoffs in the email thread; don’t only ship a black-box finished product  

### Highest-signal implementation prompt (paraphrased / embedded)

Stakeholder-approved boundaries were pasted into the main build session:

- Coherent read + eligibility flow  
- On policy failure: **manager escalation, no money moved** (not elicitation completion)  
- Auto only if: ≤ $150, ≤ paid, ≤ 30 days, risk &lt; 70, **verified carrier exception**, no duplicate action+amount  
- Synthetic data only  

### Transport / scope prompts

- Deploy remote → prefer not stdio-only  
- Express + Streamable HTTP  
- Remove stdio and auth  

### Testing prompts

- Explicit list of uncovered edge cases (nonexistent order, amount ≤ 0, missing customer/shipment/payment, authorized/failed payment, approve-time balance/duplicate guards, nonexistent escalation, partial refund status flips, boundaries at $150 / 30 days / risk 70 / amount == remaining, clock injection, etc.)  
- “Remove the tool schema tests; in README talk about testing via `bun test` or MCP client—not curl.”  

### Evaluator / demo prompts

- List natural-language questions + expected results for AI-client testing  
- Iterate length: not too many, not over-trimmed → ~20 important cases  
- 4–5 minute Loom/OBS-style flow: deployed E2E, MCP usage, key product/technical decisions → written to `script.md`  

### Communication prompts

- Draft stakeholder email reflecting assumptions and what is implemented  
- “Make it short and formal.”  

---

## 6. AI suggestions corrected, rejected, or substantially changed

At least these material corrections happened:

### 6.1 Mid-call elicitation → manager escalation (product-critical)

- **Early design (my proposal / AI-adjacent default for “human in the loop”):** pause on policy failure and complete the refund via **MCP elicitation**.  
- **Rejected by stakeholder (and enforced in implementation):** never complete a failed-policy refund through elicitation; **open a manager-approval escalation and move no money**.  
- **Why it matters:** This is the core safety model of the product, not a polish item.

### 6.1b Escalation approve ≠ policy override (Aug 5 — product-critical)

- **Early post–Jul 31 implementation:** `resolve_escalation(approve)` completed the refund under “manager authority,” re-checking only remaining balance and duplicates. Over-cap / high-risk / chargeback escalations could still pay via MCP after approve.  
- **Rejected by stakeholder follow-up:** re-check **all** auto-refund policy conditions at execution time; escalation is **not** authorization to bypass a failed check; keep true exception refunds **outside** the automated path.  
- **Human commitment in email thread:** rework so approve does not push the refund through when the case has not cleared on its own.  
- **Enforced in implementation (2026-08-06):** `resolve_escalation(approve)` runs full `checkEligibility`; money moves only if every gate passes; otherwise escalation stays **pending**, no money moved. Docs/tests/demo script updated to match.

### 6.2 Stdio (and optional auth) → Streamable HTTP only, no auth

- **AI path risk:** Local MCP demos often default to stdio; early store comments even referred to a “stdio server.”  
- **Human correction:** Remote deploy → Express + Streamable HTTP; **remove stdio**; **remove auth** as out of assignment scope.  
- **Result:** Single `/mcp` HTTP surface + `/health`; README documents Inspector / desktop clients against Streamable HTTP.

### 6.3 Tool-schema tests and curl-based testing docs

- **AI tendency:** Broad automated coverage including Zod/tool schema tests; docs that show raw HTTP/curl.  
- **Human rejection:** Drop tool-schema tests; document **`bun test`** and **MCP client** walks only.  
- **Why:** Evaluators and real users exercise tools through an MCP client; schema unit tests added noise without proving the agent workflow.

### 6.4 Evaluator question volume

- **First AI draft of test questions:** Larger / more exhaustive set.  
- **Human:** “Keep only the important ones—I can’t ask them to test this much.”  
- **Then:** “Don’t trim this much… ~20 questions with edge cases and refund cases.”  
- **Result:** `TEST_QUESTIONS.md` balanced for a reviewer’s time while still covering auto path, major escalations, and a few edges.

### 6.5 Scope creep

- Standing instruction not to build frontend, auth, full commerce, or heavy CI/CD—used to push back on anything that would bloat the demo beyond a focused MCP copilot.

---

## 7. How AI-generated work was verified

### Automated

- **`bun test`** — policy eligibility, `issue_refund` outcomes, store status flips, boundary cases, manager resolve guards (including full re-check on approve).  
- Suite updated when `resolve_escalation` was reworked (2026-08-06); re-run after that change before submission.  

### Policy / product checklist (manual review against stakeholder bullets)

- Auto only when all gates pass (amount, paid balance, age, risk, carrier exception verified, no duplicate, captured payment, no chargeback/dispute)  
- Failure → escalation, no money movement  
- **No elicitation complete-on-fail path**  
- **Manager approve re-runs full policy at execution time; still-failing checks → no money, escalation remains pending**  
- **Escalation is not a policy override; exception refunds outside automated MCP path**  
- Manager reject closes without money movement  
- Seed matrix in README matches expected auto vs escalate outcomes  
- Demo / TEST_QUESTIONS / worklog describe approve-blocked-on-over-cap, not “manager authority pays”  

### MCP / integration-style verification

- Documented (and intended) path: start server → connect Inspector or desktop client to `http://…/mcp` → walk `list_seed_scenarios` → lookups → `check_refund_eligibility` → `issue_refund` → escalate/resolve  
- `TEST_QUESTIONS.md` encodes expected answers for that style of review  
- Domain state is in-process; **restart server** between full manual passes  

### Documentation review

- README: tools table, seed scenarios, policy, assumptions (`action` key, external risk score, in-memory store)  
- Human re-read AI email drafts and shortened them before send  
- Carrier-exception question re-checked against code before claiming full policy coverage  

### What verification does *not* claim

- Not a formal load/security audit  
- Not multi-process durable storage tests  
- Not production payment-rail certification  

---

## 8. Remaining risks or unfinished work

| Item | Status / risk |
|------|----------------|
| **In-memory store** | State resets on process restart; not multi-instance safe. Fine for demo; not production-ready persistence. |
| **No authentication** | Intentional for assignment scope; anyone who can reach `/mcp` can call write tools. |
| **Risk score is seed data** | Documented as “external provider” shape; not a live fraud model. |
| **`action` key is caller-supplied** | Duplicate detection depends on stable `action` + `amount`; a sloppy agent can weaken duplicate protection. |
| **Synthetic-only world** | No real PSP, carrier, or OMS integration. |
| **Streamable HTTP + shared process state** | Concurrent clients share one store—good for a live demo, surprising if treated as multi-tenant. |
| **Demo video** | Script exists (`script.md`); recording/upload may still be pending. |
| **Deployment ops** | Host bind / public URL / process manager / TLS left as lightweight ops choices (assignment de-emphasized complex deploy/CI). |
| **Host-wide acceptance** | Later commit opened listen address for remote connections; still depends on how the server is actually hosted. |
| **Elicitation permanently out of write path** | Correct per stakeholder; if someone reintroduces “confirm in-tool to pay,” that would regress safety. |
| **Manager approve cannot override policy** | Correct per Aug 5; if someone reintroduces “approve pays anyway,” that would regress safety. |
| **Broader E2E automation** | Unit tests are strong; full MCP-protocol integration tests in CI are not a focus. |
| **This worklog / script** | Updated 2026-08-06 with resolve_escalation rework; keep in sync if product behavior changes. |

---

## 9. Collaboration summary (what “using AI well” looked like here)

1. **Lock product policy with humans first** (email), then implement.  
2. **Feed exact constraints** into the coding agent instead of open-ended “build a refund system.”  
3. **Cut scope aggressively** (stdio, auth, frontend) when the assignment said not required.  
4. **Use AI for volume work** (code, seed matrix, tests, docs) and **human for gates** (safety model, test strategy, length of evaluator ask).  
5. **Verify with executable checks** (`bun test`) plus a realistic MCP-client path, not only generated prose.  
6. **Document assumptions** in README so reviewers know what is synthetic or caller-dependent.  
7. **Re-check stakeholder follow-ups against code** — Aug 5 execution-time re-check required a deliberate rework of `resolve_escalation` after the first implementation only partially matched Jul 31.  

---

## 10. Artifact map (AI-assisted deliverables)

| Artifact | Purpose |
|----------|---------|
| `src/*`, `index.ts` | MCP server + policy engine |
| `src/policy.test.ts` | Automated policy/write-path coverage |
| `README.md` | Runbook, tools, seed matrix, assumptions |
| `TEST_QUESTIONS.md` | AI-client evaluation prompts + expected results |
| `script.md` | 4–5 minute demo video script |
| `worklog.md` | This AI collaboration record |

---

*Model used for the bulk of implementation and for drafting this worklog: Grok 4.5 (Grok Build). Product policy and major design rejections originated from stakeholder feedback and human review, not from the model alone.*
