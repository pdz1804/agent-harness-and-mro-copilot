import { SERVICE_BASE_URL } from "../lib/api";

interface ServiceStatusBannerProps {
  message: string;
}

/** Shown when the live scoring service (src/service/app.py) can't be
 * reached or returned an error -- explicit, not a silent empty page. */
export function ServiceStatusBanner({ message }: ServiceStatusBannerProps) {
  return (
    <div className="gap-callout" role="alert">
      {message}
      <div style={{ marginTop: 6, fontFamily: "var(--font-mono)", fontSize: 11 }}>
        expected at {SERVICE_BASE_URL}
      </div>
    </div>
  );
}
