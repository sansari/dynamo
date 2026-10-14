import { StrictMode, useEffect, useLayoutEffect, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { DynamoSession } from "../../src/session";
import type { DashboardRequirement, DashboardSpec } from "../../src/wizard";
import "./styles.css";

interface WizardModel {
  repository: { name: string; path: string };
  session: DynamoSession;
  specs: DashboardSpec[];
}

type WizardAction =
  | { action: "confirm-discovery"; testCommand: string }
  | { action: "select-concern"; concern: string }
  | { action: "confirm-boundary"; boundary: string }
  | { action: "reset" };

const searchParams = new URLSearchParams(window.location.search);
const token = searchParams.get("token") ?? "";
const startsInDashboard = searchParams.get("view") === "dashboard";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      "x-dynamo-token": token,
      ...options.headers,
    },
  });
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "Request failed");
  return body;
}

function App() {
  const [model, setModel] = useState<WizardModel | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedSpecPath, setSelectedSpecPath] = useState<string | null>(null);
  const dashboardOnly = startsInDashboard;

  useEffect(() => {
    request<WizardModel>("/api/state").then(setModel).catch((cause: Error) => setError(cause.message));
  }, []);

  useLayoutEffect(() => {
    window.scrollTo({ top: 0, left: 0 });
  }, [model?.session.phase, model?.session.discovery.confirmed]);

  async function act(action: WizardAction) {
    if (!model) return;
    setBusy(true);
    setError("");
    try {
      setModel(
        await request<WizardModel>("/api/action", {
          method: "POST",
          body: JSON.stringify({ ...action, revision: model.session.revision }),
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setBusy(true);
    setError("");
    try {
      setModel(await request<WizardModel>("/api/state"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!model) {
    return (
      <PageShell active={dashboardOnly ? "dashboard" : "discover"} dashboardOnly={dashboardOnly} specs={[]} selectedSpecPath={null} onSelectSpec={setSelectedSpecPath} repository={undefined}>
        <section className="card loading-card" aria-live="polite">
          <div className="loader" />
          <p>{error || "Reading repository…"}</p>
        </section>
      </PageShell>
    );
  }

  const selectedSpec = model.specs.find((spec) => spec.path === selectedSpecPath) ?? model.specs[0];
  const active = dashboardOnly
    ? "dashboard"
    : !model.session.discovery.confirmed
      ? "discover"
      : model.session.phase === "discovering"
        ? "focus"
        : model.session.phase === "concern-selected"
          ? "boundary"
          : "dashboard";

  return (
    <PageShell active={active} dashboardOnly={dashboardOnly} specs={model.specs} selectedSpecPath={selectedSpec?.path ?? null} onSelectSpec={setSelectedSpecPath} repository={model.repository}>
      {dashboardOnly ? (
        <Ready
          model={model}
          busy={busy}
          error={error}
          act={act}
          refresh={refresh}
          dashboardOnly
          selectedSpec={selectedSpec}
        />
      ) : !model.session.discovery.confirmed ? (
        <Discovery model={model} busy={busy} error={error} act={act} />
      ) : model.session.phase === "discovering" ? (
        <Concern model={model} busy={busy} error={error} act={act} />
      ) : model.session.phase === "concern-selected" ? (
        <Boundary model={model} busy={busy} error={error} act={act} />
      ) : (
        <Ready
          model={model}
          busy={busy}
          error={error}
          act={act}
          refresh={refresh}
          dashboardOnly={false}
          selectedSpec={undefined}
        />
      )}
    </PageShell>
  );
}

function PageShell({ active, dashboardOnly = false, specs, selectedSpecPath, onSelectSpec, repository, children }: {
  active: string;
  dashboardOnly?: boolean;
  specs: DashboardSpec[];
  selectedSpecPath: string | null;
  onSelectSpec(path: string): void;
  repository: WizardModel["repository"] | undefined;
  children: ReactNode;
}) {
  const steps = [
    ["discover", "Detect repo"],
    ["focus", "Choose concern"],
    ["boundary", "Narrow boundary"],
    ["dashboard", "Draft specs"],
  ];
  const activeIndex = steps.findIndex(([id]) => id === active);
  return (
    <div className="shell">
      <header>
        <div className="brand">
          <span className="brand-mark">D</span>
          <div className="brand-copy">
            <strong>Dynamo{dashboardOnly && repository ? ` / ${repository.name}` : ""}</strong>
            {dashboardOnly && repository && <code>{repository.path}</code>}
          </div>
        </div>
        <span className="pill">{dashboardOnly ? "Repository local" : "Local first run"}</span>
      </header>
      <div className="layout">
        {dashboardOnly ? (
          <nav className="spec-navigation" aria-label="Specifications">
            <div className="eyebrow">Specifications</div>
            {specs.length === 0 ? <p>No specs found</p> : specs.map((spec) => (
              <button
                className={spec.path === selectedSpecPath ? "selected" : ""}
                key={spec.path}
                onClick={() => onSelectSpec(spec.path)}
                type="button"
              >
                <strong>{displaySpecTitle(spec.title)}</strong>
                <code>{spec.path}</code>
              </button>
            ))}
          </nav>
        ) : (
          <nav className="steps" aria-label="Setup progress">
            {steps.map(([id, label], index) => (
              <div className={`step ${index === activeIndex ? "active" : ""} ${index < activeIndex ? "done" : ""}`} key={id}>
                <span>{index < activeIndex ? "✓" : index + 1}</span><span>{label}</span>
              </div>
            ))}
          </nav>
        )}
        <main>{children}</main>
      </div>
    </div>
  );
}

function Discovery({ model, busy, error, act }: ScreenProps) {
  const [testCommand, setTestCommand] = useState(model.session.discovery.testCommands[0] ?? "");
  function submit(event: FormEvent) {
    event.preventDefault();
    void act({ action: "confirm-discovery", testCommand });
  }
  return (
    <section className="card">
      <Intro eyebrow="Step 1 · Repository discovery" title="We found your project." description="Confirm what Dynamo detected before choosing one area to protect." />
      <Repository model={model} />
      <div className="grid">
        <InfoBox title="Project structure">
          <div className="tags">{model.session.discovery.projectStructure.map((item) => <code className="tag" key={item}>{item}</code>)}</div>
        </InfoBox>
        <InfoBox title="Existing specification setup">
          <div className="tags">
            {model.session.discovery.existing2119Artifacts.length
              ? model.session.discovery.existing2119Artifacts.map((item) => <code className="tag" key={item}>{item}</code>)
              : <span className="tag">No existing 2119 setup</span>}
          </div>
        </InfoBox>
      </div>
      <form onSubmit={submit}>
        <label htmlFor="test-command">Test command</label>
        <input id="test-command" value={testCommand} onChange={(event) => setTestCommand(event.target.value)} placeholder="e.g. npm test" />
        <ErrorMessage error={error} />
        <div className="actions actions-end"><button className="primary" disabled={busy}>Confirm repository</button></div>
      </form>
    </section>
  );
}

function Concern({ model, busy, error, act }: ScreenProps) {
  const [concern, setConcern] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    void act({ action: "select-concern", concern });
  }
  return (
    <section className="card">
      <Intro eyebrow="Step 2 · Choose a concern" title="What keeps you up at night?" description="Pick one product behavior that feels risky, unclear, or under-tested. We will keep the first pass deliberately narrow." />
      <Repository model={model} />
      <form onSubmit={submit}>
        <label htmlFor="concern">Worrying area</label>
        <textarea id="concern" rows={5} value={concern} onChange={(event) => setConcern(event.target.value)} placeholder="Promotion eligibility and discount limits worry me because only the happy path is tested." autoFocus />
        <ErrorMessage error={error} />
        <div className="actions"><button className="secondary" type="button" onClick={() => void act({ action: "reset" })}>Start over</button><button className="primary" disabled={busy}>Narrow this concern</button></div>
      </form>
    </section>
  );
}

function Boundary({ model, busy, error, act }: ScreenProps) {
  const [boundary, setBoundary] = useState("");
  function submit(event: FormEvent) {
    event.preventDefault();
    void act({ action: "confirm-boundary", boundary });
  }
  return (
    <section className="card">
      <Intro eyebrow="Step 3 · Narrow the boundary" title="Make the concern testable." description="Describe the smallest user-visible behavior worth specifying first." />
      <Repository model={model} />
      <div className="notice"><small>Concern</small>{model.session.focus?.area}</div>
      <form onSubmit={submit}>
        <label htmlFor="boundary">Behavior boundary</label>
        <textarea id="boundary" rows={5} value={boundary} onChange={(event) => setBoundary(event.target.value)} placeholder="Whether a promotion is eligible and how much it may reduce an order." autoFocus />
        <ErrorMessage error={error} />
        <div className="actions"><button className="secondary" type="button" onClick={() => void act({ action: "reset" })}>Start over</button><button className="primary" disabled={busy}>Confirm boundary</button></div>
      </form>
    </section>
  );
}

function Ready({ model, busy, error, act, refresh, dashboardOnly, selectedSpec }: ScreenProps & {
  refresh(): Promise<void>;
  dashboardOnly: boolean;
  selectedSpec: DashboardSpec | undefined;
}) {
  const handoff = model.session.handoffs.find((item) => item.kind === "draft-requirements");
  const visibleSpecs = dashboardOnly ? (selectedSpec ? [selectedSpec] : []) : model.specs;
  return (
    <section className="card dashboard-card">
      <Intro
        eyebrow="Repository dashboard"
        title={dashboardOnly ? "Repository specifications." : "Your specification workspace."}
        description={dashboardOnly
          ? `Dynamo found ${model.specs.length} specification${model.specs.length === 1 ? "" : "s"} in this repository.`
          : "Give the generated handoff to your coding agent to complete the focused specification."}
      />
      {!dashboardOnly && <Repository model={model} />}
      {!dashboardOnly && <>
        <div className="summary">
          <Summary label="Worrying area">{model.session.focus?.area}</Summary>
          <Summary label="Behavior boundary">{model.session.focus?.boundary}</Summary>
        </div>

        <section className="handoff-panel" aria-labelledby="handoff-title">
          <div>
            <div className="eyebrow">Agent handoff ready</div>
            <h2 id="handoff-title">Draft the focused specification</h2>
            <p>Ask your coding agent to complete the repository-backed task below. No agent or model is selected by Dynamo.</p>
          </div>
          <code className="agent-command">Read {handoff?.path ?? ".dynamo/handoffs/draft-requirements.md"} and complete the requested specification work.</code>
        </section>
      </>}

      <div className="dashboard-heading">
        <div><div className="eyebrow">{dashboardOnly ? "Selected specification" : "Specifications"}</div><h2>{dashboardOnly && selectedSpec ? displaySpecTitle(selectedSpec.title) : "Repository specs"}</h2></div>
        {dashboardOnly && <button className="primary" disabled={busy} onClick={() => void refresh()}>{busy ? "Refreshing…" : "Refresh specs"}</button>}
      </div>
      <ErrorMessage error={error} />
      {visibleSpecs.length === 0 ? (
        <div className="empty-state"><strong>No specifications found yet.</strong><span>{dashboardOnly ? "Add a compatible Markdown specification under specs/, then refresh this view." : "Complete the agent handoff to add the focused specification."}</span></div>
      ) : dashboardOnly ? (
        <div className="requirement-workspace">
          <div className="spec-list">
            {visibleSpecs.map((spec) => <SpecCard spec={spec} key={spec.path} showEvidence />)}
          </div>
        </div>
      ) : (
        <div className="spec-list">
          {visibleSpecs.map((spec) => <SpecCard spec={spec} key={spec.path} />)}
        </div>
      )}
      {dashboardOnly ? (
        <div className="actions actions-end"><span className="pill">{model.specs.length} specification{model.specs.length === 1 ? "" : "s"}</span></div>
      ) : (
        <div className="actions"><button className="secondary" disabled={busy} onClick={() => void act({ action: "reset" })}>Run the wizard again</button><span className="pill">Saved · revision {model.session.revision}</span></div>
      )}
    </section>
  );
}

function SpecCard({ spec, showEvidence = false }: { spec: DashboardSpec; showEvidence?: boolean }) {
  return (
    <article className="spec-card">
      <div className="spec-title"><div><h3>{displaySpecTitle(spec.title)}</h3><code>{spec.path}</code></div><span className={`pill ${spec.issues.length ? "pill-warning" : "pill-success"}`}>{spec.issues.length ? `${spec.issues.length} format issue${spec.issues.length === 1 ? "" : "s"}` : "Format clean"}</span></div>
      {spec.requirements.length ? (
        <ol className="requirements">{spec.requirements.map((requirement) => <li className={showEvidence ? "requirement-entry" : ""} key={requirement.id}>
          {showEvidence ? (
            <div className="requirement-row" tabIndex={0} aria-describedby={`evidence-${requirement.id}`}>
              <code>{requirement.id}</code><span>{requirement.text}</span>
              <RequirementEvidence requirement={requirement} id={`evidence-${requirement.id}`} />
            </div>
          ) : <><code>{requirement.id}</code><span>{requirement.text}</span></>}
        </li>)}</ol>
      ) : <p className="muted">No requirements were parsed from this file.</p>}
      {spec.issues.length > 0 && <div className="issue-list">{spec.issues.map((issue, index) => <p key={`${issue.line}-${index}`}><strong>Line {issue.line}</strong>{issue.message}</p>)}</div>}
    </article>
  );
}

function RequirementEvidence({ requirement, id }: { requirement: DashboardRequirement; id: string }) {
  const qualityLabels = {
    pass: "Quality passed",
    fail: "Quality failed",
    pending: "Quality review needed",
    uncovered: "No test coverage",
    "not-required": "Quality review not required",
  };
  return (
    <aside className="evidence-popover" id={id} role="tooltip">
      <div className="eyebrow">Requirement evidence</div>
      <code className="evidence-id">{requirement.id}</code>
      <p>{requirement.text}</p>
      <div className={`quality-status quality-${requirement.quality.status}`}>{qualityLabels[requirement.quality.status]}</div>
      {requirement.quality.summary && <p className="quality-summary">{requirement.quality.summary}</p>}
      <h3>Covering tests</h3>
      {requirement.tests.length > 0 ? (
        <ul className="test-evidence">{requirement.tests.map((test) => <li key={`${test.path}:${test.line}`}><code>{test.path}:{test.line}</code></li>)}</ul>
      ) : <p className="muted">No annotated tests cover this requirement.</p>}
    </aside>
  );
}

interface ScreenProps {
  model: WizardModel;
  busy: boolean;
  error: string;
  act(action: WizardAction): Promise<void>;
}

function displaySpecTitle(title: string): string {
  return title.replace(/^[A-Z][A-Z0-9-]*-\d+:\s*/, "");
}

function Intro({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return <><div className="eyebrow">{eyebrow}</div><h1>{title}</h1><p className="lede">{description}</p></>;
}

function Repository({ model }: { model: WizardModel }) {
  return <div className="repository"><div><strong>{model.repository.name}</strong><code>{model.repository.path}</code></div><span className="pill">Repository local</span></div>;
}

function InfoBox({ title, children }: { title: string; children: ReactNode }) {
  return <div className="info-box"><h2>{title}</h2>{children}</div>;
}

function Summary({ label, children }: { label: string; children: ReactNode }) {
  return <div><small>{label}</small>{children}</div>;
}

function ErrorMessage({ error }: { error: string }) {
  return <p className="error" role="alert">{error}</p>;
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
