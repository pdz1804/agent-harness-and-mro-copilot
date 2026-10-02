import type { ReactNode } from "react";
import { PageHead, Chip } from "./ui/primitives";
import { DocLayout, DocSection } from "./ui/doc-layout";
import { formatDecimal, formatNumber, formatPct } from "../lib/format";
import type { DashboardData } from "../types";

interface HowItWorksSectionProps {
  data: DashboardData;
}

interface Step {
  title: string;
  body: ReactNode;
  callouts?: { text: string; tone?: "good" | "bad" }[];
}

/** Narrated pipeline walkthrough. Every claim/number here traces to
 * docs/design-report.md (sections 1, 2, 3, 4, 5, 6, 7.1) or the live
 * dashboard_data.json -- nothing is invented for this tab. */
export function HowItWorksSection({ data }: HowItWorksSectionProps) {
  const { dataset, target, models } = data;
  const primary = models.find((m) => m.is_primary) ?? models[0];
  const other = models.find((m) => m.id !== primary.id);

  const steps: Step[] = [
    {
      title: "1. Why the dataset is synthetic, and how it's generated",
      body: (
        <>
          <p>
            No real fleet dataset was provided for this project, so{" "}
            <code>data/generate_dataset.py</code> builds one: {formatNumber(dataset.aircraft)}{" "}
            aircraft &times; 6 component types ={" "}
            {formatNumber(dataset.components_total)} components, observed from each
            aircraft&rsquo;s delivery date to a fixed study-end date. Each component gets a
            hidden intrinsic wear-out cycle drawn from a Weibull distribution (increasing
            hazard, i.e. mechanical wear-out rather than random failure); a 0&rarr;1
            &ldquo;fraction of life used&rdquo; index drives sensor drift, fault-code
            intensity, and severity for every component &mdash; whether it ultimately fails
            unscheduled, gets caught early by scheduled maintenance, or simply outlives the
            study window.
          </p>
          <p>
            This is deliberate: scheduled-caught components show the <em>same underlying wear
            signal</em>, just interrupted earlier by an inspection finding, so the classifier
            can&rsquo;t trivially separate classes on raw sensor values &mdash; it has to learn
            the actual risk pattern.
          </p>
        </>
      ),
      callouts: [
        { text: `${formatNumber(dataset.components_unscheduled)} unscheduled removals` },
        { text: `${formatNumber(dataset.components_scheduled)} scheduled-caught (hard negatives)` },
        { text: `${formatNumber(dataset.components_survived)} survived / censored` },
        { text: `${formatDecimal(dataset.positive_rate_pct, 3)}% positive rate` },
      ],
    },
    {
      title: "2. The leakage bug found and fixed (real case study)",
      body: (
        <>
          <p>
            The original feature pipeline computed{" "}
            <code>cycles_since_last_check</code> from <em>every</em> maintenance event,
            including the &ldquo;final inspection&rdquo; checks the generator injects inside the
            30-cycle label window right before an unscheduled removal. Because that
            symptom-triggered check always lands just before a positive label, the feature
            became a near-perfect proxy for the label itself &mdash; a target leak, not a
            genuine early-warning signal. Reproduced live against the running service: with
            every other field held fixed, changing only <code>cycles_since_last_check</code>{" "}
            used to move a component&rsquo;s risk score from 1.000 straight to 0.000.
          </p>
          <p>
            <strong>Fix:</strong> <code>maintenance_events.csv</code> now tags each event as{" "}
            <code>scheduled_check</code> (routine, ~300-cycle grid) or{" "}
            <code>unscheduled_check</code> (symptom-triggered); only{" "}
            <code>scheduled_check</code> rows feed the maintenance-recency features in{" "}
            <code>src/features.py</code>, and the terminal removal event itself is excluded
            outright. Post-fix, the same monotonicity probe returns an identical score
            (0.0053) regardless of <code>cycles_since_last_check</code>&rsquo;s value &mdash;
            covered by{" "}
            <code>tests/test_no_target_leakage.py::test_cycles_since_last_scheduled_check_never_decreases_risk_monotonically</code>.
          </p>
        </>
      ),
      callouts: [
        { text: "before: score 1.000 → 0.000 on one field change", tone: "bad" },
        { text: "after: score identical (0.0053) regardless of the field", tone: "good" },
      ],
    },
    {
      title: "3. Splitting strategy — why it's leakage-safe",
      body: (
        <>
          <p>
            Panel data (many repeated checks per component over time) has two leakage modes:
            group leakage (same component/aircraft in both train and test) and time leakage
            (training on aircraft that entered service later than validation/test aircraft).{" "}
            <code>src/splitting.py</code> groups by <code>aircraft_id</code> &mdash; all of an
            aircraft&rsquo;s 6 components stay in one split, the stricter of the two boundaries
            the spec allows &mdash; and anchors time ordering on aircraft delivery date: sorted
            ascending, sliced 60/20/20. This guarantees a strict, testable, group-level
            chronological ordering (<code>assert_no_leakage()</code>, covered by{" "}
            <code>tests/test_splitting_leakage.py</code>).
          </p>
          <p>
            A first design anchored on each component&rsquo;s <em>last observed</em> date
            instead, but that interacted badly with censoring: it pushed almost every real
            removal into the earliest-finishing bucket, starving test of positives. Delivery
            date is independent of whether/when a component ever fails, so positives land
            proportionally across splits.
          </p>
        </>
      ),
      callouts: [
        {
          text: `train ${formatNumber(dataset.splits.train.rows)} rows / ${dataset.splits.train.aircraft} aircraft / ${dataset.splits.train.positives} positive`,
        },
        {
          text: `val ${formatNumber(dataset.splits.val.rows)} rows / ${dataset.splits.val.aircraft} aircraft / ${dataset.splits.val.positives} positive`,
        },
        {
          text: `test ${formatNumber(dataset.splits.test.rows)} rows / ${dataset.splits.test.aircraft} aircraft / ${dataset.splits.test.positives} positive`,
        },
      ],
    },
    {
      title: "4. Model comparison approach",
      body: (
        <p>
          Two models are trained and compared: <strong>LogisticRegression</strong> (interpretable
          linear baseline, median-impute + standardize + one-hot, <code>class_weight="balanced"</code>)
          and <strong>HistGradientBoostingClassifier</strong> (captures non-linearities/interactions,
          handles NaN natively so it needs no separate imputation). Both are plain scikit-learn
          &mdash; no GPU/CUDA. Reweighting was used for class imbalance instead of oversampling
          because oversampling before a group split risks generating synthetic neighbors that
          straddle the train/test boundary; reweighting only touches the training-fold loss.
          See the &ldquo;Model comparison&rdquo; tab for the full metrics table and
          threshold-sweep curves.
        </p>
      ),
    },
    {
      title: "5. Threshold selection methodology",
      body: (
        <>
          <p>
            Thresholds are swept on the <strong>validation</strong> split only (never test), at
            199 points from 0.01 to 0.99. <code>select_operating_threshold()</code> picks the
            lowest-alert-rate threshold among those with recall &ge; {formatPct(target.min_recall, 0)}{" "}
            on validation, falls back to the highest-recall threshold that still respects the
            &le; {formatDecimal(target.max_alerts_per_100, 1)} alerts/100 cap if no threshold hits
            both, and reports honestly if neither is achievable. The chosen threshold is then
            simply <em>applied</em> to test &mdash; no re-tuning &mdash; and the resulting
            recall/alert-rate is reported as-is, even when it falls short.
          </p>
          <p>
            On the current run, <strong>{primary.label}</strong> is the deployed model:
            recall {formatPct(primary.test_recall)} at {formatDecimal(primary.test_alerts_per_100)}{" "}
            alerts/100 on the held-out test split (target met).
            {other ? (
              <>
                {" "}
                {other.label} does not clear the recall target on this held-out split (
                {formatPct(other.test_recall)}), so it is not the deployed model even though
                its threshold also satisfied both constraints on validation &mdash; that
                val&rarr;test gap is reported honestly rather than re-picked after the fact.
              </>
            ) : null}
          </p>
        </>
      ),
      callouts: [
        {
          text: `${primary.label}: recall ${formatPct(primary.test_recall)} @ ${formatDecimal(primary.test_alerts_per_100)} alerts/100`,
          tone: "good",
        },
        ...(other
          ? [
              {
                text: `${other.label}: recall ${formatPct(other.test_recall)} @ ${formatDecimal(other.test_alerts_per_100)} alerts/100`,
                tone: (other.target_met ? "good" : "bad") as "good" | "bad",
              },
            ]
          : []),
      ],
    },
    {
      title: "6. Explainability approach",
      body: (
        <>
          <p>
            <strong>Global:</strong> permutation importance (scored by average precision on
            validation, 10 repeats) for both models &mdash;{" "}
            <code>HistGradientBoostingClassifier</code> has no native{" "}
            <code>feature_importances_</code>, so permutation importance is used uniformly for
            both rather than mixing methods. See the &ldquo;Feature importance&rdquo; tab.
          </p>
          <p>
            <strong>Local:</strong> SHAP (<code>TreeExplainer</code> for HGB,{" "}
            <code>LinearExplainer</code> for logistic regression) produces per-row signed
            feature contributions for the top-5 highest-risk test-split rows. If SHAP fails at
            runtime, <code>src/explainability.py</code> falls back to a documented alternative
            (largest z-score vs. training-population mean/std, signed by direction) so the
            pipeline degrades gracefully rather than crashing &mdash; this fallback wasn&rsquo;t
            needed in the current run. See the &ldquo;High-risk leaderboard&rdquo; tab for real
            examples.
          </p>
        </>
      ),
    },
    {
      title: "7. Serving architecture",
      body: (
        <p>
          The same fitted scikit-learn <code>Pipeline</code> objects trained offline are loaded
          once at startup by <code>src/service/app.py</code> (FastAPI + uvicorn) &mdash; no
          preprocessing is re-implemented at serving time. The dashboard calls the service over
          CORS for live scoring and fleet ranking; the offline tabs are built once from{" "}
          <code>reports/*</code> by <code>dashboard/scripts/build_dashboard_data.py</code>. Full
          diagram in the &ldquo;Architecture&rdquo; tab; deployment/monitoring/retraining detail
          in &ldquo;Production design&rdquo;.
        </p>
      ),
    },
  ];

  const short = [
    "Synthetic data",
    "The leakage bug",
    "Leakage-safe split",
    "Model comparison",
    "Threshold selection",
    "Explainability",
    "Serving",
  ];
  const toc = steps.map((_, i) => ({ id: `step-${i + 1}`, label: short[i] ?? `Step ${i + 1}` }));

  return (
    <div className="page">
      <PageHead
        title="How it works"
        description="The pipeline narrated step by step, including the leakage bug found and fixed."
        actions={
          <Chip plain icon={null}>
            seed {dataset.seed} · run {dataset.run_date}
          </Chip>
        }
      />
      <div>
        <DocLayout toc={toc}>
          {steps.map((step, i) => (
            <DocSection key={step.title} id={`step-${i + 1}`} num={i + 1} title={step.title.replace(/^\d+\.\s*/, "")}>
              <div className="prose">{step.body}</div>
              {step.callouts && (
                <div className="doc-pills">
                  {step.callouts.map((c) => (
                    <Chip key={c.text} tone={c.tone ?? "neutral"} icon={null}>
                      {c.text}
                    </Chip>
                  ))}
                </div>
              )}
            </DocSection>
          ))}
          <p className="muted">
            Full detail, including the pre-fix and post-fix numbers side by side, is in{" "}
            <code>docs/design-report.md</code> &sect;7.1 and <code>docs/demo-evidence.md</code> &sect;4.
          </p>
        </DocLayout>
      </div>
    </div>
  );
}
