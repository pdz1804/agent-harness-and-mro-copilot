import { useState } from "react";
import { FeatureImportanceSection } from "../components/FeatureImportanceSection";
import { HighRiskLeaderboard } from "../components/HighRiskLeaderboard";
import { ButtonLink, PageHead } from "../components/ui/primitives";
import { Segmented } from "../components/ui/widgets";
import { hrefFor } from "../lib/routes";
import type { DashboardData } from "../types";

type View = "global" | "cases";

/** What drives risk overall (permutation importance) and why individual
 * components rank where they do (SHAP). The live, interactive version of
 * "why" is What-if. */
export function ExplainabilityPage({ data }: { data: DashboardData }) {
  const [view, setView] = useState<View>("global");
  return (
    <div className="page">
      <PageHead
        title="Explainability"
        description="What drives risk overall, and why specific components rank where they do."
        actions={
          <>
            <Segmented<View>
              label="Explainability view"
              value={view}
              onChange={setView}
              options={[
                { id: "global", label: "Global drivers" },
                { id: "cases", label: "High-risk cases" },
              ]}
            />
            <ButtonLink href={hrefFor("model/what-if")}>Try what-if</ButtonLink>
          </>
        }
      />
      {view === "global" && <FeatureImportanceSection data={data} />}
      {view === "cases" && <HighRiskLeaderboard data={data} />}
    </div>
  );
}
