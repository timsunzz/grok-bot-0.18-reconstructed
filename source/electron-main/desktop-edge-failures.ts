/**
 * A telemetry-shaped record of an edge call that failed: where it happened and what class of error
 * it was, deliberately without the message, which can carry a path or a token. Reporting here keeps
 * a fire-and-forget promise from crashing Electron main on `unhandledRejection`; it does not tell
 * the person anything, and before a reporter is installed at most `PRE_INSTALL_BUFFER_CAP` records
 * are kept. A failure a person has to act on needs to reach them by another route.
 */
export interface DesktopEdgeFailure {
  readonly area: string;
  readonly leg: string;
  readonly errorClass: string;
}

export type DesktopEdgeFailureReporter = (failure: DesktopEdgeFailure) => void;

const PRE_INSTALL_BUFFER_CAP = 32;

let reporter: DesktopEdgeFailureReporter | null = null;
let pendingPreInstall: DesktopEdgeFailure[] = [];

export function installDesktopEdgeFailureReporter(next: DesktopEdgeFailureReporter | null): void {
  reporter = next;
  const flush = pendingPreInstall;
  pendingPreInstall = [];
  if (next == null) return;
  for (const failure of flush) next(failure);
}

export function errorClassOf(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  return error.name.length > 0 ? error.name : "Error";
}

export function reportDesktopEdgeFailure(area: string, leg: string, error: unknown): void {
  reportDesktopEdgeFailureClass(area, leg, errorClassOf(error));
}

export function reportDesktopEdgeFailureClass(area: string, leg: string, errorClass: string): void {
  const failure = { area, leg, errorClass };
  if (reporter != null) {
    reporter(failure);
    return;
  }
  if (pendingPreInstall.length >= PRE_INSTALL_BUFFER_CAP) return;
  pendingPreInstall.push(failure);
}
