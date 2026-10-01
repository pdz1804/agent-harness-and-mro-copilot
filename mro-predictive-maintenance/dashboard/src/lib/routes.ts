/** Information architecture + hash-route table. Single source of truth for
 * the primary nav (areas), the contextual sub-nav (pages), page titles and
 * which pages are "cockpit" (fill the viewport, scroll internally) vs
 * normal document pages (one scroll container: the main column). */

export type AreaId = "overview" | "ops" | "model" | "about";

export interface PageDef {
  /** Route path without the leading slash, e.g. "ops/fleet". */
  id: string;
  label: string;
  title: string;
  description: string;
  /** Fill-viewport layout: the page manages its own internal scrolling. */
  fill?: boolean;
}

export interface AreaDef {
  id: AreaId;
  label: string;
  /** One-line job statement for the area. */
  job: string;
  home: string;
  pages: PageDef[];
}

export const AREAS: AreaDef[] = [
  {
    id: "overview",
    label: "Overview",
    job: "What is this and does it work?",
    home: "overview",
    pages: [
      {
        id: "overview",
        label: "Overview",
        title: "Overview",
        description: "What the model predicts, how well it does, and where to go next.",
      },
    ],
  },
  {
    id: "ops",
    label: "Operate",
    job: "Triage risk, act on alerts, close the loop.",
    home: "ops/fleet",
    pages: [
      {
        id: "ops/fleet",
        label: "Fleet",
        title: "Fleet risk",
        description: "Every component ranked by live model risk. Scan, filter, drill into one.",
      },
      {
        id: "ops/alerts",
        label: "Alerts",
        title: "Alerts",
        description: "Threshold crossings raised by fleet scan: acknowledge, raise a work order, close.",
      },
      {
        id: "ops/work-orders",
        label: "Work orders",
        title: "Work orders",
        description: "Close each work order with an outcome: it feeds live precision and the no-fault-found rate.",
      },
      {
        id: "ops/copilot",
        label: "Copilot",
        title: "Copilot",
        description: "Ask questions, review its tool calls, approve or deny risky actions inline.",
        fill: true,
      },
      {
        id: "ops/knowledge-base",
        label: "Knowledge",
        title: "Knowledge base",
        description: "Hybrid search over AMM and MEL documents, with a full document viewer.",
      },
    ],
  },
  {
    id: "model",
    label: "Model",
    job: "Can I trust it, and what would change its mind?",
    home: "model/performance",
    pages: [
      {
        id: "model/performance",
        label: "Performance",
        title: "Performance",
        description: "Did it hit the target on held-out data? Head to head, threshold curves, stress test.",
      },
      {
        id: "model/explainability",
        label: "Explainability",
        title: "Explainability",
        description: "What drives risk overall, and why specific components rank where they do.",
      },
      {
        id: "model/what-if",
        label: "What-if",
        title: "What-if scoring",
        description: "Edit a component's sensor values and see the live risk and factor shift versus its baseline.",
      },
      {
        id: "model/monitoring",
        label: "Monitoring",
        title: "Monitoring",
        description: "Input and score drift, the live outcome loop, and the model registry.",
      },
    ],
  },
  {
    id: "about",
    label: "About",
    job: "How is it built and run in production?",
    home: "about/architecture",
    pages: [
      {
        id: "about/architecture",
        label: "Architecture",
        title: "Architecture",
        description: "Every stage mapped to a real module in the repo.",
      },
      {
        id: "about/how-it-works",
        label: "How it works",
        title: "How it works",
        description: "The pipeline narrated step by step, including the leakage bug found and fixed.",
      },
      {
        id: "about/production-design",
        label: "Production design",
        title: "Production design",
        description: "Deployment, retraining, cold start, missing data and drift handling.",
      },
    ],
  },
];

export const DEFAULT_PATH = "overview";

/** Legacy routes kept alive so old links and bookmarks never dead-end. */
const ALIASES: Record<string, string> = {
  "about/overview": "overview",
  ops: "ops/fleet",
  model: "model/performance",
  about: "about/architecture",
};

export interface ResolvedRoute {
  area: AreaDef;
  page: PageDef;
  /** Everything after the page id, e.g. ["AC-113"] for ops/aircraft/AC-113. */
  params: string[];
  /** Detail pages that belong to a nav page but are not nav items. */
  detail: "component" | "aircraft" | null;
  /** False when the hash did not match any page (fell back to landing). */
  known: boolean;
}

function findPage(id: string): { area: AreaDef; page: PageDef } | null {
  for (const area of AREAS) {
    const page = area.pages.find((p) => p.id === id);
    if (page) return { area, page };
  }
  return null;
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** Resolve hash segments (already split on "/") to a route. Unknown paths
 * fall back to the landing page rather than rendering nothing. */
export function resolveRoute(segments: string[]): ResolvedRoute {
  const cleaned = segments.filter(Boolean).map(decode);

  // Detail pages: ops/component/<id>, ops/aircraft/<id>. They live under
  // Operate / Fleet in the nav.
  if (cleaned[0] === "ops" && (cleaned[1] === "component" || cleaned[1] === "aircraft") && cleaned[2]) {
    const parent = findPage("ops/fleet")!;
    const kind = cleaned[1];
    return {
      area: parent.area,
      page: {
        id: `ops/${kind}`,
        label: kind === "component" ? "Component" : "Aircraft",
        title: cleaned[2],
        description: "",
      },
      params: [cleaned.slice(2).join("/")],
      detail: kind,
      known: true,
    };
  }

  const candidates = [cleaned.slice(0, 2).join("/"), cleaned[0] ?? ""].filter(Boolean);
  for (const raw of candidates) {
    const id = ALIASES[raw] ?? raw;
    const hit = findPage(id);
    if (hit) {
      const consumed = raw.split("/").length;
      return { ...hit, params: cleaned.slice(consumed), detail: null, known: true };
    }
  }
  const fallback = findPage(DEFAULT_PATH)!;
  return { ...fallback, params: [], detail: null, known: cleaned.length === 0 };
}

export function hrefFor(path: string): string {
  return `#/${path.split("/").map(encodeURIComponent).join("/")}`;
}
