// ── Marker helpers (extracted for reuse without circular deps) ────────────────

export interface MarkerPair {
  start: string;
  end: string;
}

export function buildMarkers(markerName: string): MarkerPair {
  return {
    start: `<!-- openslack:${markerName}:start -->`,
    end: `<!-- openslack:${markerName}:end -->`,
  };
}

export class MarkerNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarkerNotFoundError';
  }
}
