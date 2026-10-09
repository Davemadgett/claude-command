/**
 * Which board window this page is. The Mac shell opens each window with `?w=N`,
 * and anything that is a property of *this window* rather than of the board —
 * which section is showing, which board is selected — is remembered under that
 * number. Otherwise two windows fight over one setting and the second one to be
 * touched decides what both show after a relaunch.
 *
 * Window 1 uses the plain keys, so nothing already saved is lost, and a browser
 * tab (no `?w=`) behaves exactly as it always did.
 */
const windowId = (() => {
  const n = Number(new URLSearchParams(window.location.search).get('w'));
  return Number.isFinite(n) && n > 1 ? Math.floor(n) : 1;
})();

export function perWindow(key: string): string {
  return windowId === 1 ? key : `${key}:w${windowId}`;
}
