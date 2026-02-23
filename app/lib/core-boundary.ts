export type CoreSeverity = "green" | "amber" | "red";

export type CoreStateCode =
  | "structural_break"
  | "alignment_degrading"
  | "stability_warning"
  | "capacity_under_load"
  | "informational";

export interface PlannerSignal {
  totalTasks: number;
  completedTasks: number;
  overdueTasks: number;
  dueNext24h: number;
  lastUpdated: number;
}

export interface CoreUiCopy {
  primary_key: string;
  fallback_text: string;
}

export interface CoreActiveState {
  tone: "instrument_panel";
  severity: CoreSeverity;
  state_code: CoreStateCode;
  reason_codes: string[];
  signal_codes: string[];
  ui_copy: CoreUiCopy;
}

export interface CoreSurfaceState extends CoreActiveState {
  active_states: CoreActiveState[];
  state_codes: CoreStateCode[];
}

export interface EvaluateStructuralStateRequest {
  contract_id: string;
  invariants: Record<string, boolean>;
  eta_minutes?: number;
  time_remaining_minutes?: number;
  distance_km?: number;
  traffic_load?: number;
  planner_signal?: PlannerSignal;
  environmental_load?: number;
  threshold?: number;
  evaluation_interval_seconds?: number;
  alignment_lambda?: number;
  bio_load_hint?: number;
}

export interface EvaluateStructuralStateResponse {
  contract_id: string;
  contract_integrity: boolean;
  contract_integrity_score: number;
  missing_invariants: string[];
  alignment_score: number;
  capacity: number;
  stability_index: number;
  threshold: number;
  violation_duration_seconds: number;
  persistence_gate_n: number;
  intervention_triggered: boolean;
  intervention_reason: string;
  intervention_state: "continue" | "deviate" | "plan_b" | "pause";
  load_components: {
    planner_load: number;
    environmental_load: number;
    biometric_load_effective: number;
    total_load: number;
    biometric_load_raw?: number;
  };
  surface_state: CoreSurfaceState;
  raw_state_codes: CoreStateCode[];
}

export interface ValidatePlanResponse {
  valid: boolean;
  authority: number;
  failed_invariants: string[];
  violations: Array<Record<string, unknown>>;
  derived_metrics: {
    actor_count: number;
    resource_count: number;
    action_count: number;
    dependency_density: number;
    budget_stress_ratio: number;
    resource_pressure_ratio: number;
    budget_by_actor: Record<string, Record<string, unknown>>;
    resource_peaks: Record<string, Record<string, unknown>>;
    synchronization_pair_count: number;
    synchronization_matrix: Record<string, Record<string, Record<string, number | boolean>>>;
  };
}

export interface ProposeInvariantsResponse {
  regime: string;
  context: string;
  invariants: Array<{
    key: string;
    label: string;
    critical: boolean;
  }>;
  note: string;
}

export interface CoreAssistantResponse {
  reply?: string;
  provider?: string;
  model?: string;
  response_style?: string;
  response_length?: string;
  error?: string;
}

interface APIErrorPayload {
  error?: string;
}

async function parseResponse<T>(response: Response): Promise<T> {
  const raw = await response.text();
  const payload = raw ? (JSON.parse(raw) as unknown) : {};

  if (!response.ok) {
    const errorPayload = payload as APIErrorPayload;
    const detail =
      typeof errorPayload?.error === "string" && errorPayload.error.trim()
        ? errorPayload.error
        : `Request failed (${response.status})`;
    throw new Error(detail);
  }

  return payload as T;
}

async function postCore<T>(path: string, body: object): Promise<T> {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  const response = await fetch(`/api/core${normalized}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    cache: "no-store"
  });
  return parseResponse<T>(response);
}

export async function evaluateStructuralState(
  payload: EvaluateStructuralStateRequest
): Promise<EvaluateStructuralStateResponse> {
  return postCore<EvaluateStructuralStateResponse>("/evaluate_structural_state", payload);
}

export async function validatePlan(payload: { plan: Record<string, unknown> }): Promise<ValidatePlanResponse> {
  return postCore<ValidatePlanResponse>("/validate_plan", payload);
}

export async function proposeInvariants(payload: {
  regime: "hard" | "soft" | "resource";
  context: string;
  plan_identifier: string;
  domain: string;
}): Promise<ProposeInvariantsResponse> {
  return postCore<ProposeInvariantsResponse>("/propose_invariants", payload);
}

export async function assistantChat(payload: {
  message: string;
  mission_id?: string;
  response_style: "tactical" | "detailed";
  response_length: "short" | "medium" | "long";
}): Promise<CoreAssistantResponse> {
  if (payload.mission_id) {
    try {
      return await postCore<CoreAssistantResponse>("/assistant_chat", payload);
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      if (!message.includes("not found") || !message.includes("mission_id")) {
        throw error;
      }
    }
  }

  const fallbackPayload = {
    message: payload.message,
    response_style: payload.response_style,
    response_length: payload.response_length
  };
  return postCore<CoreAssistantResponse>("/assistant_chat", fallbackPayload);
}
