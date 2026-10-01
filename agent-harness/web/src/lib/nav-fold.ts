/** Pure rules for the foldable sidebar groups. */

/** localStorage key holding whether a group is open (`true` = open). */
export function navGroupStorageKey(label: string): string {
  return `nav.groups.${label}`
}

/** A group is shown open when the user left it open, and always when it holds
 * the current page (you can never fold away where you are). */
export function isGroupOpen(storedOpen: boolean, containsActivePage: boolean): boolean {
  return containsActivePage || storedOpen
}

/** Whether `pathname` is (or is under) one of `paths`. `/sessions` also owns
 * the run permalinks `/runs/...`. */
export function groupContainsPath(paths: readonly string[], pathname: string): boolean {
  return paths.some((to) => pathname === to || pathname.startsWith(`${to}/`))
}
