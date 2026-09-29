import type { ReactNode } from "react";

interface StatusBadgeProps {
  tone: "good" | "bad" | "neutral";
  children: ReactNode;
}

export function StatusBadge({ tone, children }: StatusBadgeProps) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}
