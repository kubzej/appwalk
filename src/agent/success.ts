import type { NetworkEntry } from "../evidence/recorder.js";

const SUCCESS_URL_PATTERN = /success|thank|complete|confirmation|confirmed/i;
const SUCCESS_SNAPSHOT_PATTERN =
  /thank you for your|successfully (submitted|completed|placed|created|registered)|(submitted|completed|placed|created|registered) successfully|your order has been|order confirmed|registration (successful|complete)/i;
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function looksLikeSuccessByUrl(url: string): boolean {
  return SUCCESS_URL_PATTERN.test(url);
}

export function looksLikeSuccessBySnapshot(snapshot: string): boolean {
  return SUCCESS_SNAPSHOT_PATTERN.test(snapshot);
}

// Restrict to same-origin requests so third-party ad/telemetry beacons can't count.
export function looksLikeSuccessByNetwork(network: NetworkEntry[], pageUrl: string): boolean {
  let origin: string;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return false;
  }

  return network.some((entry) => {
    if (!STATE_CHANGING_METHODS.has(entry.method)) return false;
    if (entry.status === undefined || entry.status < 200 || entry.status >= 400) return false;
    try {
      return new URL(entry.url).origin === origin;
    } catch {
      return false;
    }
  });
}

export function looksLikeSuccess(url: string, network: NetworkEntry[] = [], snapshot = ""): boolean {
  return (
    looksLikeSuccessByUrl(url) ||
    looksLikeSuccessByNetwork(network, url) ||
    looksLikeSuccessBySnapshot(snapshot)
  );
}
