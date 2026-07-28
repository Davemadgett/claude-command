/**
 * The Mac app exposes a small bridge so the page can ask for real Finder
 * dialogs. In a plain browser the bridge is absent, and every caller has to have
 * a web fallback — so `hasNative()` is a question worth asking before offering a
 * button that only works in one of the two.
 */

type Bridge = { postMessage(body: unknown): Promise<unknown> };

function bridge(): Bridge | null {
  const w = window as unknown as { webkit?: { messageHandlers?: { host?: Bridge } } };
  return w.webkit?.messageHandlers?.host ?? null;
}

export function hasNative(): boolean {
  return bridge() !== null;
}

/** The macOS folder chooser. Resolves to null if it isn't available or is cancelled. */
export async function chooseFolder(startAt?: string): Promise<string | null> {
  const b = bridge();
  if (!b) return null;
  try {
    const result = await b.postMessage({ cmd: 'chooseFolder', start: startAt ?? '' });
    return typeof result === 'string' && result ? result : null;
  } catch {
    return null;
  }
}
