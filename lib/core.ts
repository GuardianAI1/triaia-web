export type AssistantResponseStyle = "tactical" | "detailed";
export type AssistantResponseLength = "short" | "medium" | "long";
export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
}

export interface APIErrorPayload {
  error: string;
}

export interface MissionStatus {
  mission_id: string;
  grounding_active: boolean;
  timestamp: string;
  risk_level: string;
  status: string;
  recommendation: string;
  confidence: number;
}

export interface GroundingControlResponse {
  mission_id: string;
  grounding_active: boolean;
  sampling_seconds?: number;
  samples?: number;
  duration_seconds?: number;
}

export interface HealthResponse {
  status: string;
  service?: string;
  timestamp?: string;
  assistant_enabled?: boolean;
  assistant_provider?: string;
  assistant_model?: string;
  endpoints?: {
    get: string[];
    post: string[];
  };
}

export interface CreateMissionRequest {
  mission: string;
  departure_time: string;
  airport: string;
  gate: string;
}

export interface UpdateStateRequest {
  mission_id: string;
  schema_version: "1.0";
  source: "ui_manual" | "ui_scan" | "ui_continuous_scan" | "meta_glasses" | "api_integration" | "simulator";
  timestamp: string;
  location?: string;
  gate_detected?: string;
  gate?: string;
  confidence?: number;
}

export interface GroundingRequest {
  mission_id: string;
}

export interface AssistantChatRequest {
  mission_id?: string;
  message: string;
  response_style: AssistantResponseStyle;
  response_length: AssistantResponseLength;
}

export interface AssistantChatResponse {
  mission_id?: string;
  reply: string;
  provider: string;
  model: string;
  timestamp: string;
  response_style?: AssistantResponseStyle;
  response_length?: AssistantResponseLength;
}

export interface AssistantConstructMissionRequest {
  session_id?: string;
  message: string;
}

export interface AssistantConstructMissionResponse {
  session_id: string;
  status: "needs_input" | "mission_created";
  missing_fields?: string[];
  captured_fields?: Record<string, string>;
  reply: string;
  mission_id?: string;
  mission?: MissionStatus;
}

const CORE_HEADER = "x-triaia-core-url";

function sanitizeCoreUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Core URL is required.");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Core URL must be a valid http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Core URL must use http or https.");
  }
  parsed.pathname = "";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function makePath(path: string): string {
  return path.startsWith("/") ? path.slice(1) : path;
}

async function parseResponse<T>(response: Response): Promise<T> {
  const raw = await response.text();
  const payload = raw ? (JSON.parse(raw) as unknown) : {};

  if (!response.ok) {
    const error = payload as APIErrorPayload;
    const detail = typeof error?.error === "string" ? error.error : `Request failed (${response.status})`;
    throw new Error(detail);
  }

  return payload as T;
}

async function requestCore<T>(
  coreUrl: string,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const normalizedCoreUrl = sanitizeCoreUrl(coreUrl);
  const headers = new Headers(init.headers);
  headers.set(CORE_HEADER, normalizedCoreUrl);

  const response = await fetch(`/api/core/${makePath(path)}`, {
    ...init,
    headers,
    cache: "no-store"
  });

  return parseResponse<T>(response);
}

export async function checkCoreHealth(coreUrl: string): Promise<HealthResponse> {
  return requestCore<HealthResponse>(coreUrl, "/health", { method: "GET" });
}

export async function createMission(coreUrl: string, body: CreateMissionRequest): Promise<MissionStatus> {
  return requestCore<MissionStatus>(coreUrl, "/create_mission", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

export async function fetchMissionStatus(coreUrl: string, missionId: string): Promise<MissionStatus> {
  const encodedMission = encodeURIComponent(missionId);
  return requestCore<MissionStatus>(coreUrl, `/mission_status?mission_id=${encodedMission}`, {
    method: "GET"
  });
}

export async function startGrounding(coreUrl: string, body: GroundingRequest): Promise<GroundingControlResponse> {
  return requestCore<GroundingControlResponse>(coreUrl, "/start_grounding", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

export async function stopGrounding(coreUrl: string, body: GroundingRequest): Promise<GroundingControlResponse> {
  return requestCore<GroundingControlResponse>(coreUrl, "/stop_grounding", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

export async function sendStructuredUpdate(coreUrl: string, body: UpdateStateRequest): Promise<MissionStatus> {
  return requestCore<MissionStatus>(coreUrl, "/update_state", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

export async function assistantChat(coreUrl: string, body: AssistantChatRequest): Promise<AssistantChatResponse> {
  return requestCore<AssistantChatResponse>(coreUrl, "/assistant_chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

export async function assistantConstructMission(
  coreUrl: string,
  body: AssistantConstructMissionRequest
): Promise<AssistantConstructMissionResponse> {
  return requestCore<AssistantConstructMissionResponse>(coreUrl, "/assistant_construct_mission", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
}
