import { Fragment } from "react";
import { PageHead } from "./ui/primitives";
import { DocLayout, DocSection } from "./ui/doc-layout";

interface Node {
  title: string;
  path: string;
}

interface Stage {
  id: string;
  label: string;
  summary: string;
  nodes: Node[];
}

// Mirrors the mermaid flowchart in docs/design-report.md section 6
// ("Serving architecture"): same stages, same file paths, rendered as a
// React flow so a reviewer can trace code from here.
const STAGES: Stage[] = [
  {
    id: "training",
    label: "Offline data and training",
    summary: "python -m src.pipeline. Deterministic: same seed, same fleet, same model.",
    nodes: [
      { title: "Generate synthetic fleet", path: "data/generate_dataset.py" },
      { title: "Build model-ready table", path: "src/features.py" },
      { title: "Leakage-safe split", path: "src/splitting.py" },
      { title: "Fit and compare models", path: "src/modeling.py" },
      { title: "Threshold and explain", path: "src/evaluation.py, src/explainability.py" },
    ],
  },
  {
    id: "artifacts",
    label: "Artifacts on disk",
    summary: "Training writes everything the service and the offline pages need.",
    nodes: [
      { title: "Fitted pipelines", path: "models/*.joblib" },
      { title: "Model card, metrics, high-risk examples", path: "reports/*.json, *.csv, *.md" },
    ],
  },
  {
    id: "serving",
    label: "Serving",
    summary: "uvicorn src.service.app:app --port 8100. Artifacts load once at startup.",
    nodes: [
      { title: "Loads artifacts once at startup", path: "src/service/app.py (ModelStore)" },
      { title: "Health, model card, score, fleet ranking", path: "GET /health, /model-card, POST /score, GET /fleet/top-risk" },
      { title: "Ops, monitoring, copilot, knowledge base", path: "src/service/routers/*.py" },
    ],
  },
  {
    id: "ui",
    label: "This UI",
    summary: "Vite and React on :5173 (dev) or :4173 (preview), calling the service over CORS.",
    nodes: [
      { title: "Offline pages, built from reports/", path: "dashboard/scripts/build_dashboard_data.py to dashboard_data.json" },
      { title: "Live pages call the service", path: "dashboard/src/lib/api.ts" },
    ],
  },
];

export function ArchitectureSection() {
  return (
    <div className="page">
      <PageHead title="Architecture" description="Every stage mapped to a real module in the repo." />
      <div>
        <DocLayout toc={[...STAGES.map((s) => ({ id: s.id, label: s.label })), { id: "retraining", label: "Retraining" }]}>
          <p className="prose">
            Every stage below maps to a real module, the same flow documented as a mermaid diagram in{" "}
            <code>docs/design-report.md</code> &sect;6. Training runs offline and writes artifacts to disk; the
            FastAPI service loads them once at startup and serves this UI over CORS.
          </p>

          {STAGES.map((stage, i) => (
            <Fragment key={stage.id}>
              <DocSection id={stage.id} num={i + 1} title={stage.label}>
                <p className="prose">{stage.summary}</p>
                <div className="arch-flow">
                  {stage.nodes.map((node, j) => (
                    <Fragment key={node.path}>
                      <div className="arch-node">
                        <div className="arch-node-title">{node.title}</div>
                        <div className="arch-node-path">{node.path}</div>
                      </div>
                      {j < stage.nodes.length - 1 && (
                        <span className="arch-arrow" aria-hidden="true">
                          &rarr;
                        </span>
                      )}
                    </Fragment>
                  ))}
                </div>
              </DocSection>
            </Fragment>
          ))}

          <DocSection id="retraining" title="Retraining">
            <p className="prose">
              Retraining runs the same offline path (<code>python -m src.pipeline --retrain</code>) and overwrites
              the artifacts in place; the service process restarts to pick up a new model version. The full
              deployment story is on the Production design page.
            </p>
          </DocSection>
        </DocLayout>
      </div>
    </div>
  );
}
