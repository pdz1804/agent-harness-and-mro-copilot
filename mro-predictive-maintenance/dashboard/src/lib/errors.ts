import { ServiceUnreachableError } from "./api";

/** Human summary + raw technical detail for any error this dashboard's API
 * client can throw. `ServiceStatusBanner` renders `message` up front and
 * `detail` behind a collapsible `<details>` -- never the reverse. Replaces
 * the old behaviour of always appending a dev-facing "expected at
 * http://localhost:8100" line even for errors that have nothing to do with
 * reachability (e.g. a 403 from a role check). */
export interface HumanError {
  message: string;
  detail: string;
}

export function humanizeError(err: unknown): HumanError {
  const raw = err instanceof Error ? err.message : String(err);

  if (err instanceof ServiceUnreachableError || /Could not reach the scoring service/.test(raw)) {
    return {
      message: "Could not reach the scoring service. Make sure it is running, then reload this page.",
      detail: raw,
    };
  }
  if (/^403\b/.test(raw)) {
    return {
      message:
        "You don't have permission to do that. Switch to an identity with approval rights (e.g. Lead engineer) in the top bar and try again.",
      detail: raw,
    };
  }
  if (/^404\b/.test(raw)) {
    return {
      message: "That item could not be found. It may have already been resolved elsewhere.",
      detail: raw,
    };
  }
  if (/^42[02]\b/.test(raw)) {
    return {
      message: "That request wasn't valid. Nothing was changed.",
      detail: raw,
    };
  }
  if (/^5\d\d\b/.test(raw)) {
    return {
      message: "The service hit an unexpected error handling that request. Nothing was changed; try again.",
      detail: raw,
    };
  }
  return { message: "Something went wrong talking to the service.", detail: raw };
}
