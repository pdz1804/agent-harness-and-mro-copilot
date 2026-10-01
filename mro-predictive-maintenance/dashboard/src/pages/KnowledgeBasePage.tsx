import { useState } from "react";
import retrievalEval from "../data/retrieval_eval.json";
import { getKbDoc, listKbDocs, searchKb } from "../lib/api";
import { useAsync } from "../hooks/useAsync";
import { formatPct } from "../lib/format";
import { hrefFor } from "../lib/routes";
import { Button, Chip, PageHead, Panel } from "../components/ui/primitives";
import { Segmented } from "../components/ui/widgets";
import { DocMarkdown } from "../components/ui/doc-markdown";
import { EmptyState, LoadingRows, Notice, ServiceStatusBanner } from "../components/ui/states";
import type { KbSearchHit } from "../types";

interface RetrievalMethodStats {
  recall_at_1: number;
  recall_at_k: number;
  mrr: number;
  k: number;
  n_queries: number;
}

interface RetrievalEval {
  results: Record<string, RetrievalMethodStats>;
  slices: Record<string, Record<string, RetrievalMethodStats>>;
  gate: { hybrid_recall_at_3: number; gate_threshold: number; hybrid_meets_gate: boolean; note: string };
  n_docs: number;
  n_chunks: number;
}

const evalData = retrievalEval as unknown as RetrievalEval;

type View = "docs" | "quality";

const DOC_TYPE_LABEL: Record<string, string> = {
  amm_task: "AMM task",
  tsm: "Troubleshooting",
  mel: "MEL",
  policy: "Policy",
  reliability: "Reliability",
};
const docTypeLabel = (t: string): string => DOC_TYPE_LABEL[t] ?? t;

/** Knowledge base: hybrid search (POST /kb/search), a document list (GET /kb)
 * and a full viewer (GET /kb/{id}). The open document lives in the URL. On
 * phones the list and the viewer take turns instead of stacking. */
export function KnowledgeBasePage({ docId }: { docId?: string }) {
  const [view, setView] = useState<View>("docs");
  const [query, setQuery] = useState("");
  const [docType, setDocType] = useState("all");
  const [hits, setHits] = useState<KbSearchHit[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  const docs = useAsync(() => listKbDocs(), []);
  const doc = useAsync(() => (docId ? getKbDoc(docId) : Promise.resolve(null)), [docId]);

  const runSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) {
      setHits(null);
      return;
    }
    setSearching(true);
    setSearchError(null);
    try {
      setHits(await searchKb(query, 5, undefined, docType === "all" ? undefined : docType));
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  const types = [...new Set((docs.data ?? []).map((d) => d.doc_type))].sort();

  return (
    <div className="page">
      <PageHead
        title={
          <span className="title-with-chips">
            Knowledge base
            <Chip tone="warn">Fictional KB · not for real maintenance</Chip>
          </span>
        }
        description="Hybrid (BM25 + TF-IDF) search over AMM and MEL documents, with a full document viewer."
        actions={
          <Segmented<View>
            label="Knowledge base view"
            value={view}
            onChange={setView}
            options={[
              { id: "docs", label: "Documents" },
              { id: "quality", label: "Retrieval quality" },
            ]}
          />
        }
      />

      {view === "docs" && (
        <div className={`kb${docId ? " is-doc" : ""}`}>
          <Panel flush className="kb-list" title="Documents" sub={docs.data ? `${docs.data.length} documents` : undefined}>
            <form className="toolbar" onSubmit={runSearch}>
              <input
                className="input input-sm"
                style={{ flex: 1, minWidth: 0 }}
                type="search"
                name="kb-query"
                autoComplete="off"
                aria-label="Search the knowledge base"
                placeholder="e.g. hydraulic pump elevated vibration…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <Button type="submit" variant="primary" size="sm" loading={searching}>
                {searching ? "Searching…" : "Search"}
              </Button>
            </form>
            <div className="toolbar">
              <label className="field-label" htmlFor="kb-type">
                Type
              </label>
              <select id="kb-type" className="select select-sm" value={docType} onChange={(e) => setDocType(e.target.value)}>
                <option value="all">All</option>
                {types.map((t) => (
                  <option key={t} value={t}>
                    {docTypeLabel(t)}
                  </option>
                ))}
              </select>
              {hits && (
                <Button size="sm" variant="ghost" onClick={() => setHits(null)}>
                  Clear results
                </Button>
              )}
            </div>

            {searchError && (
              <div style={{ padding: 16 }}>
                <ServiceStatusBanner message={searchError} />
              </div>
            )}

            <div className="kb-scroll">
              {hits ? (
                <>
                  <div className="muted" style={{ padding: "8px 16px" }}>
                    {hits.length} result{hits.length === 1 ? "" : "s"} for “{query}”, ranked by hybrid score
                  </div>
                  {hits.length === 0 && <EmptyState title="No hits">Try fewer or different words.</EmptyState>}
                  <div className="rows">
                    {hits.map((h) => (
                      <a key={h.doc_id} className="row-item kb-item" href={hrefFor(`ops/knowledge-base/${h.doc_id}`)} aria-current={docId === h.doc_id ? "true" : undefined}>
                        <span className="row-main" style={{ whiteSpace: "normal" }}>
                          <span className="row-title" style={{ whiteSpace: "normal" }}>{h.title}</span>
                          <span className="row-sub mono">
                            {h.doc_id} · score {formatPct(h.score, 1)}
                          </span>
                          <span className="kb-snippet">{h.snippet}</span>
                        </span>
                      </a>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  {docs.loading && !docs.data && <LoadingRows rows={6} height={40} />}
                  {docs.error && (
                    <div style={{ padding: 16 }}>
                      <ServiceStatusBanner message={docs.error} onRetry={docs.reload} />
                    </div>
                  )}
                  <div className="rows">
                    {(docs.data ?? [])
                      .filter((d) => docType === "all" || d.doc_type === docType)
                      .map((d) => {
                        const id = String(d.id ?? d.doc_id);
                        return (
                          <a key={id} className="row-item kb-item" href={hrefFor(`ops/knowledge-base/${id}`)} aria-current={docId === id ? "true" : undefined}>
                            <span className="row-main">
                              <span className="row-title">{d.title}</span>
                              <span className="row-sub">
                                {docTypeLabel(d.doc_type)}
                                {d.component_types && d.component_types.length > 0 ? ` · ${d.component_types.join(", ")}` : ""}
                              </span>
                            </span>
                          </a>
                        );
                      })}
                  </div>
                </>
              )}
            </div>
          </Panel>

          <Panel className="kb-viewer">
            {!docId && <EmptyState title="Select a document">Search above, or pick a document from the list, to read it in full.</EmptyState>}
            {docId && doc.loading && <LoadingRows rows={6} height={20} />}
            {docId && doc.error && <ServiceStatusBanner message={doc.error} onRetry={doc.reload} />}
            {docId && doc.data && (
              <>
                <div className="row row-between" style={{ alignItems: "flex-start", marginBottom: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <h2 className="page-title" style={{ fontSize: "var(--fs-xl)" }}>{doc.data.title}</h2>
                    <div className="row" style={{ marginTop: 8 }}>
                      <Chip tone="info" icon={null}>{docTypeLabel(doc.data.doc_type)}</Chip>
                      {doc.data.ata_chapter && <span className="tag">ATA {doc.data.ata_chapter}</span>}
                      {(doc.data.component_types ?? []).map((t) => (
                        <span key={t} className="tag">{t}</span>
                      ))}
                      {(doc.data.fault_codes ?? []).map((f) => (
                        <span key={f} className="tag mono">{f}</span>
                      ))}
                    </div>
                  </div>
                  <Button size="sm" onClick={() => (window.location.hash = "#/ops/knowledge-base")}>
                    Close
                  </Button>
                </div>
                <DocMarkdown source={doc.data.body ?? ""} />
              </>
            )}
          </Panel>
        </div>
      )}

      {view === "quality" && (
        <>
          <Notice tone="plain">
            Offline, static report from <code>reports/retrieval_eval.json</code> ({evalData.n_docs} docs, {evalData.n_chunks} chunks, {evalData.results.hybrid.n_queries * 2} queries including paraphrase, symptom-only and cross-chapter confusers). Gated on the <em>easy</em> slice only; the <em>hard</em> slice is measured and reported but intentionally not gated.
          </Notice>
          <div className="grid-2">
            {(["recall_at_1", "recall_at_k"] as const).map((metric) => (
              <Panel key={metric} title={metric === "recall_at_1" ? "Recall@1" : "Recall@3"} sub="All queries and the hard slice, per retrieval method.">
                {Object.entries(evalData.results).map(([method, stats]) => (
                  <div className="bullet-group" key={method}>
                    <div className="bullet-group-label">{method}</div>
                    {[
                      { label: "All queries", value: stats[metric], primary: false },
                      { label: "Hard slice", value: evalData.slices.hard[method][metric], primary: true },
                    ].map((row) => (
                      <div className="bullet" key={row.label}>
                        <span className="bullet-label">{row.label}</span>
                        <div className="bullet-track" aria-hidden="true">
                          <div className={`bullet-fill${row.primary ? " is-primary" : ""}`} style={{ width: `${row.value * 100}%` }} />
                        </div>
                        <span className="bullet-val">{formatPct(row.value, 0)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </Panel>
            ))}
          </div>
          <Panel flush title="Retrieval metrics" sub={`Gate: hybrid recall@3 = ${formatPct(evalData.gate.hybrid_recall_at_3, 0)} vs threshold ${formatPct(evalData.gate.gate_threshold, 0)} on the easy slice: ${evalData.gate.hybrid_meets_gate ? "meets gate" : "does not meet gate"}. ${evalData.gate.note}`}>
            <div className="table-scroll">
              <table className="dt" aria-label="Retrieval metrics by method">
                <thead>
                  <tr>
                    <th scope="col">Method</th>
                    <th scope="col" className="num">Recall@1</th>
                    <th scope="col" className="num">Recall@3</th>
                    <th scope="col" className="num">MRR</th>
                    <th scope="col" className="num">Hard R@1</th>
                    <th scope="col" className="num">Hard R@3</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(evalData.results).map(([method, stats]) => (
                    <tr key={method}>
                      <td>{method}</td>
                      <td className="num">{formatPct(stats.recall_at_1, 0)}</td>
                      <td className="num">{formatPct(stats.recall_at_k, 0)}</td>
                      <td className="num">{stats.mrr.toFixed(3)}</td>
                      <td className="num">{formatPct(evalData.slices.hard[method].recall_at_1, 0)}</td>
                      <td className="num">{formatPct(evalData.slices.hard[method].recall_at_k, 0)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
