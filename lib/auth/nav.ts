/** Client-side navigation shared by the account menu, profile dialog and
 *  feature locks: the login page returns to where the user was. */

function nextQuery(): string {
  const next = `${window.location.pathname}${window.location.search}`;
  return next === "/" ? "" : `next=${encodeURIComponent(next)}`;
}

/** Send the user to /login (SSO), preserving the current page for return. */
export function goSignIn(): void {
  const query = nextQuery();
  window.location.assign(query ? `/login?${query}` : "/login");
}

/** Send the user to /login in "request access" mode, preserving the page. */
export function goRequestAccess(): void {
  const query = nextQuery();
  window.location.assign(
    query ? `/login?mode=request&${query}` : "/login?mode=request",
  );
}
