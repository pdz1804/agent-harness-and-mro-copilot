import { useState } from "react";
import type { CopilotPendingItem } from "../../types";
import type { CopilotResolution } from "../../lib/api";

interface OptionCardProps {
  item: CopilotPendingItem;
  onDraftChange: (pendingId: string, resolution: CopilotResolution | null) => void;
}

/** Option form (ask_user), rendered inside its tool-call block: question, option buttons (radio-group semantics,
 * keyboard accessible), and an "Other..." free-text fallback. */
export function OptionCard({ item, onDraftChange }: OptionCardProps) {
  const question = item.question;
  const options = question?.options ?? [];
  const [choice, setChoice] = useState<string | null>(null);
  const [freeText, setFreeText] = useState("");
  const usingOther = choice === "__other__";

  const pick = (optionId: string) => {
    setChoice(optionId);
    if (optionId === "__other__") {
      onDraftChange(item.id, freeText ? { pending_id: item.id, decision: "answer", answer_text: freeText } : null);
    } else {
      onDraftChange(item.id, { pending_id: item.id, decision: "answer", option_id: optionId });
    }
  };

  const onFreeTextChange = (text: string) => {
    setFreeText(text);
    if (usingOther) {
      onDraftChange(item.id, text ? { pending_id: item.id, decision: "answer", answer_text: text } : null);
    }
  };

  return (
    <div className="tcb-form">
      <p className="hitl-question">{question?.question}</p>

      <div className="stack" style={{ gap: 6 }} role="radiogroup" aria-label={question?.question}>
        {options.map((opt) => (
          <button key={opt.id} type="button" role="radio" aria-checked={choice === opt.id} className="choice" onClick={() => pick(opt.id)}>
            <span className="choice-radio" aria-hidden="true" />
            <span>
              <span className="choice-label">{opt.label}</span>
              {opt.description && <span className="choice-hint">{opt.description}</span>}
            </span>
          </button>
        ))}
        <button type="button" role="radio" aria-checked={usingOther} className="choice" onClick={() => pick("__other__")}>
          <span className="choice-radio" aria-hidden="true" />
          <span className="choice-label">Other…</span>
        </button>
      </div>

      {usingOther && (
        <input
          className="input"
          name="answer"
          autoComplete="off"
          placeholder="Type your answer…"
          aria-label="Your answer"
          value={freeText}
          onChange={(e) => onFreeTextChange(e.target.value)}
          autoFocus
        />
      )}
    </div>
  );
}
