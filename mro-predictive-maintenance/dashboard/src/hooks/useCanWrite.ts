import { useEffect, useState } from "react";
import { IDENTITY_CHANGE_EVENT, canWrite } from "../lib/identity";

/** Re-renders when the identity picker changes so write controls enable or
 * disable without a reload. */
export function useCanWrite(): boolean {
  const [allowed, setAllowed] = useState(() => canWrite());
  useEffect(() => {
    const on = () => setAllowed(canWrite());
    window.addEventListener(IDENTITY_CHANGE_EVENT, on);
    return () => window.removeEventListener(IDENTITY_CHANGE_EVENT, on);
  }, []);
  return allowed;
}
