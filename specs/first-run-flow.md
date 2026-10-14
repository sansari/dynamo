# Guided First-Run Flow
## Overview
Dynamo helps an existing repository adopt continuously maintained, test-backed specifications without asking the user to model the whole product at once. Running `dynamo init` starts a local web experience that begins as an adoption wizard and remains useful as the repository's spec dashboard. Its state is stored with the repository so the flow can be resumed and audited.

The first run follows one narrow thread: understand the repository, choose one area the user worries about, narrow the concern into a tractable boundary, draft a small set of requirements, map relevant existing tests, hand the approved work to the user's coding agent, and show the results of the project's tests and Dynamo's checks. CI setup is outside this first milestone.

Dynamo does not choose or invoke a language model. The wizard owns durable workflow state, explicit user approvals, and deterministic validation. It produces structured, agent-ready handoffs for reasoning and code changes; the user's agent performs that work and records results back into repository files. This keeps Dynamo language- and agent-agnostic while leaving room for agents to control the same workflow through a future machine-facing interface.
## Requirements
### 1: Repository discovery and session safety
1. `dynamo init` MUST start a local web session for the repository from which it was invoked.

2. Repository-local session state MUST preserve the discovery-confirmation decision, selected concern, and confirmed behavior boundary when a new Dynamo server starts for the same repository.

3. `dynamo init` MUST present the first-run session in the browser. [manual]

4. The local web server MUST listen on `127.0.0.1` rather than a non-loopback interface.

### 2: Repository focus and specification
1. Repository discovery SHOULD report the detected project structure, suggested test commands, and existing 2119 setup. [manual]

2. The wizard MUST require the user to confirm repository discovery, enter a product concern, and confirm a non-empty behavior boundary in that order before making a drafting handoff available.

3. After the user confirms a behavior boundary, Dynamo MUST write a repository-local handoff for an agent of the user's choice that requests three to eight user-observable requirements in a 2119-compatible specification.

4. Dynamo MUST NOT invoke a language model when producing the drafting handoff. [review: src/wizard.ts]

5. The repository dashboard MUST show each discovered specification's source path, requirement IDs and text, and format issues. [manual]

6. The repository dashboard MUST let the user explicitly refresh its view after repository files change. [manual]

7. Users MUST be able to launch the repository dashboard without completing the first-run wizard steps. [manual]

8. The direct repository dashboard MUST let the user select a discovered specification and show only that specification's details in the main pane. [manual]

9. When the user hovers over or focuses a requirement, the direct dashboard MUST show its annotated test files and current test-quality review status in a popover. [manual]

10. The wizard SHOULD present imported draft requirements for individual user approval before treating them as an accepted specification.

### 3: Evidence and agent handoff
1. The wizard SHOULD show which existing tests, if any, appear to exercise each approved requirement and distinguish user-confirmed mappings from unconfirmed agent suggestions.

2. Dynamo SHOULD provide a repository-backed handoff that the user can give to an agent of their choice, containing the approved requirements, confirmed and unresolved test mappings, preserved user edits, and a request to generate or update tests without Dynamo invoking a language model itself.

3. After the user returns the agent's changes, Dynamo SHOULD run the configured project test command and its 2119 checks and show each result separately.

## Implementation Plan
This plan is non-normative. Requirement IDs above define the product behavior; the phases below describe the current delivery approach and may change as the implementation is explored.
### Product decisions to validate first
- Use a **wizard-owned workflow with agent handoffs** for the first milestone. The browser owns navigation, durable state, and approvals; it emits a structured prompt/task that the user gives to their existing agent. This avoids coupling Dynamo to one agent runtime while preserving a future path for agents to drive the workflow through the same file-backed state model.

- Treat “specs” in the onboarding promise as three to eight requirements in one focused spec, not three to eight separate documents.

- Ask the user to confirm discovered test commands before execution. Never infer and execute an arbitrary repository command without approval.

- Keep CI setup visible as a later step, but do not include it in first-run completion.

### Phase 1: Define the file-backed workflow model
- Design a repository-local session record for discovery results, the selected concern and boundary, requirement drafts and approvals, test mappings, agent handoffs, and run results.

- Define atomic writes, schema versioning, recovery from malformed state, and which generated state belongs in version control versus ignore rules.

- Separate durable domain operations from HTTP and browser concerns so a future CLI or agent adapter can use the same transitions.

### Phase 2: Add the local application shell
- Change `dynamo init` from direct scaffolding into a local-only server launch that selects a safe available port and opens the repository dashboard.

- Provide `dynamo dash` as a direct entry point that skips first-run questions and shows repository specifications immediately.

- Preserve a non-interactive compatibility path for deterministic setup and automation; settle its command name or flag before changing existing `init` behavior.

- Add lifecycle handling for startup failures, an already-running repository session, browser reconnects, and clean shutdown without relying on delays.

### Phase 3: Build discovery and narrowing
- Inventory repository metadata, likely test files, existing commands, current specs, annotations, and Dynamo/2119 configuration without assuming a language.

- Present findings for correction and store confirmations separately from guesses.

- Implement the concern selection and narrowing screens, with a clear summary checkpoint before requirement drafting.

### Phase 4: Draft and approve requirements
- Generate a repository-local, agent-agnostic handoff for drafting three to eight observable requirements from the confirmed context and narrow boundary.

- Show a repository dashboard that reads compatible specification files directly, lists selectable specifications in a compact left pane, displays only the selected specification's details, and reveals requirement-level test evidence and quality status in a hover/focus popover.

- Report format issues and refresh repository data only when the user requests it.

- Import the agent's proposed draft into the session, validate its format, and let the user edit, accept, or reject each requirement.

- Write only approved content to the product spec and preserve stable IDs and user edits on subsequent passes.

### Phase 5: Map tests and request implementation
- Discover candidate existing tests and create an agent handoff for semantic mapping; label returned mappings as suggestions until the user confirms them.

- Build the implementation handoff from approved requirements and mapping gaps, asking the agent to update or generate honest tests with requirement annotations.

- Record changed files and evidence reported by the agent without claiming that agent-reported success is validation.

### Phase 6: Validate and report
- Run the user-approved project test command and Dynamo checks as distinct operations, preserving command, exit status, and useful output for each.

- Render requirement-level status from approved specs, mappings, test evidence, judgment-review state, and command results.

- Provide actionable recovery for failed tests, malformed specs, uncovered requirements, pending reviews, and interrupted runs.

### Phase 7: Harden and document
- Test file-state transitions, restart/resume behavior, path and port safety, cancellation, preservation of user edits, command approval, and failure recovery.

- Verify the complete browser flow in temporary repositories representing several languages plus a repository with no recognizable test setup.

- Update naming, CLI help, README onboarding, inherited 2119 design boundaries, and migration notes from `rfc2119`/`2119` to Dynamo.

### Likely implementation areas
- CLI routing and command compatibility in `src/cli.ts` and `src/init.ts`

- Repository discovery and approved command configuration

- Versioned session storage and workflow transitions

- Local HTTP server and browser application

- Agent handoff import/export format

- Test execution orchestration and dashboard status projection

- Focused unit, integration, CLI, and browser-flow tests

### Risks and deferred questions
- **Trust boundary:** repository content and agent output are untrusted inputs; paths, rendered text, imported state, and commands need explicit validation.

- **Compatibility:** inherited `2119 init` currently performs immediate scaffolding, so changing bare `init` may break scripts unless a deterministic path remains available.

- **Terminology:** “spec” can mean a document or an individual requirement; UI copy and file output need one consistent distinction.

- **Agent transport:** clipboard prompts, task files, and direct agent adapters can share one handoff schema, but the first transport remains to be selected.

- **Dashboard scope:** history, multi-area planning, CI, and remote collaboration are intentionally deferred until the single-area first-run loop works.
