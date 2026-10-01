import { ApiError } from './api'

/** True when the API refused the request for the current role (HTTP 403). */
export function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && err.status === 403
}
