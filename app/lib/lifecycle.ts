import { CoreSeverity, CoreStateCode } from "@/app/lib/core-boundary";

export type LifecycleEventType = "enter" | "escalate" | "persist" | "clear";

export interface LifecycleObservedState {
  stateCode: CoreStateCode;
  severity: CoreSeverity;
  reasonCodes: string[];
  fallbackText: string;
  primaryKey: string;
}

export interface LifecycleEvent {
  type: LifecycleEventType;
  stateCode: CoreStateCode;
  severity: CoreSeverity;
  timestampMs: number;
  reasonCodes: string[];
  fallbackText: string;
}

interface TimingRule {
  debounceMs: number;
  cooldownMs: number;
  clearStableMs: number;
  persistEveryMs: number;
  priority: number;
}

interface LifecycleTrack {
  active: boolean;
  candidateSinceMs: number | null;
  clearCandidateSinceMs: number | null;
  activeSinceMs: number | null;
  lastPersistMs: number | null;
  cooldownUntilMs: number;
  lastSeverity: CoreSeverity;
  lastObserved: LifecycleObservedState | null;
}

export interface LifecycleRuntime {
  tracks: Record<CoreStateCode, LifecycleTrack>;
  activeStates: LifecycleObservedState[];
  dominantState: LifecycleObservedState | null;
  events: LifecycleEvent[];
  updatedAtMs: number;
}

const TIMING: Record<CoreStateCode, TimingRule> = {
  structural_break: {
    debounceMs: 0,
    cooldownMs: 0,
    clearStableMs: 0,
    persistEveryMs: 10_000,
    priority: 0
  },
  alignment_degrading: {
    debounceMs: 5_000,
    cooldownMs: 10_000,
    clearStableMs: 5_000,
    persistEveryMs: 20_000,
    priority: 1
  },
  stability_warning: {
    debounceMs: 3_000,
    cooldownMs: 15_000,
    clearStableMs: 5_000,
    persistEveryMs: 15_000,
    priority: 2
  },
  capacity_under_load: {
    debounceMs: 8_000,
    cooldownMs: 20_000,
    clearStableMs: 10_000,
    persistEveryMs: 25_000,
    priority: 3
  },
  informational: {
    debounceMs: 5_000,
    cooldownMs: 5_000,
    clearStableMs: 3_000,
    persistEveryMs: 30_000,
    priority: 4
  }
};

const STATE_CODES: CoreStateCode[] = [
  "structural_break",
  "alignment_degrading",
  "stability_warning",
  "capacity_under_load",
  "informational"
];

const SEVERITY_RANK: Record<CoreSeverity, number> = {
  green: 0,
  amber: 1,
  red: 2
};

function emptyTrack(): LifecycleTrack {
  return {
    active: false,
    candidateSinceMs: null,
    clearCandidateSinceMs: null,
    activeSinceMs: null,
    lastPersistMs: null,
    cooldownUntilMs: 0,
    lastSeverity: "green",
    lastObserved: null
  };
}

export function createLifecycleRuntime(nowMs: number): LifecycleRuntime {
  return {
    tracks: {
      structural_break: emptyTrack(),
      alignment_degrading: emptyTrack(),
      stability_warning: emptyTrack(),
      capacity_under_load: emptyTrack(),
      informational: emptyTrack()
    },
    activeStates: [],
    dominantState: null,
    events: [],
    updatedAtMs: nowMs
  };
}

function selectObservedByState(observedStates: LifecycleObservedState[]): Map<CoreStateCode, LifecycleObservedState> {
  const selected = new Map<CoreStateCode, LifecycleObservedState>();
  for (const observed of observedStates) {
    const current = selected.get(observed.stateCode);
    if (!current) {
      selected.set(observed.stateCode, observed);
      continue;
    }
    if (SEVERITY_RANK[observed.severity] > SEVERITY_RANK[current.severity]) {
      selected.set(observed.stateCode, observed);
    }
  }
  return selected;
}

function eventFromObserved(
  type: LifecycleEventType,
  observed: LifecycleObservedState,
  timestampMs: number
): LifecycleEvent {
  return {
    type,
    stateCode: observed.stateCode,
    severity: observed.severity,
    timestampMs,
    reasonCodes: [...observed.reasonCodes],
    fallbackText: observed.fallbackText
  };
}

export function advanceLifecycle(
  runtime: LifecycleRuntime,
  observedStates: LifecycleObservedState[],
  nowMs: number
): LifecycleRuntime {
  const selected = selectObservedByState(observedStates);
  const nextTracks: Record<CoreStateCode, LifecycleTrack> = {
    structural_break: { ...runtime.tracks.structural_break },
    alignment_degrading: { ...runtime.tracks.alignment_degrading },
    stability_warning: { ...runtime.tracks.stability_warning },
    capacity_under_load: { ...runtime.tracks.capacity_under_load },
    informational: { ...runtime.tracks.informational }
  };
  const events: LifecycleEvent[] = [];

  for (const stateCode of STATE_CODES) {
    const rule = TIMING[stateCode];
    const track = nextTracks[stateCode];
    const observed = selected.get(stateCode) ?? null;

    if (observed) {
      track.lastObserved = observed;
      track.clearCandidateSinceMs = null;

      if (!track.active) {
        const inCooldown = nowMs < track.cooldownUntilMs;
        const escalatedDuringCooldown = SEVERITY_RANK[observed.severity] > SEVERITY_RANK[track.lastSeverity];
        if (inCooldown && !escalatedDuringCooldown) {
          track.candidateSinceMs = null;
        } else {
          if (track.candidateSinceMs === null) {
            track.candidateSinceMs = nowMs;
          }
          const elapsed = nowMs - track.candidateSinceMs;
          if (elapsed >= rule.debounceMs) {
            track.active = true;
            track.activeSinceMs = nowMs;
            track.lastPersistMs = nowMs;
            track.lastSeverity = observed.severity;
            track.candidateSinceMs = null;
            events.push(eventFromObserved("enter", observed, nowMs));
          }
        }
      } else {
        const previousSeverityRank = SEVERITY_RANK[track.lastSeverity];
        const nextSeverityRank = SEVERITY_RANK[observed.severity];
        if (nextSeverityRank > previousSeverityRank) {
          track.lastSeverity = observed.severity;
          events.push(eventFromObserved("escalate", observed, nowMs));
        } else if (track.lastSeverity !== observed.severity) {
          track.lastSeverity = observed.severity;
        }

        if (track.lastPersistMs === null || nowMs - track.lastPersistMs >= rule.persistEveryMs) {
          track.lastPersistMs = nowMs;
          events.push(eventFromObserved("persist", observed, nowMs));
        }
      }
    } else {
      track.candidateSinceMs = null;
      if (track.active) {
        if (track.clearCandidateSinceMs === null) {
          track.clearCandidateSinceMs = nowMs;
        }
        const elapsed = nowMs - track.clearCandidateSinceMs;
        if (elapsed >= rule.clearStableMs) {
          const lastObserved = track.lastObserved ?? {
            stateCode,
            severity: track.lastSeverity,
            reasonCodes: [],
            fallbackText: "State cleared.",
            primaryKey: "STATE_CLEARED"
          };
          events.push(eventFromObserved("clear", lastObserved, nowMs));
          track.active = false;
          track.activeSinceMs = null;
          track.clearCandidateSinceMs = null;
          track.cooldownUntilMs = nowMs + rule.cooldownMs;
          track.lastPersistMs = null;
          track.lastObserved = null;
          track.lastSeverity = "green";
        }
      } else {
        track.clearCandidateSinceMs = null;
      }
    }
  }

  const activeStates = STATE_CODES.map((code) => nextTracks[code])
    .filter((track) => track.active && track.lastObserved)
    .map((track) => track.lastObserved as LifecycleObservedState)
    .sort((left, right) => {
      const priorityGap = TIMING[left.stateCode].priority - TIMING[right.stateCode].priority;
      if (priorityGap !== 0) {
        return priorityGap;
      }
      return SEVERITY_RANK[right.severity] - SEVERITY_RANK[left.severity];
    });

  return {
    tracks: nextTracks,
    activeStates,
    dominantState: activeStates[0] ?? null,
    events,
    updatedAtMs: nowMs
  };
}
