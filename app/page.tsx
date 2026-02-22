"use client";

import Image from "next/image";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type Screen = "activation" | "regime" | "configuration" | "coupling" | "dashboard";
type Regime = "hard" | "soft" | "resource";
type StructuralMode = "automatic" | "manual";
type InterventionState = "CONTINUE" | "DEVIATE" | "PLAN B" | "PAUSE";
type StabilityState = "stable" | "strained" | "critical";
type PlanStatus = "active" | "paused" | "archived" | "completed";

type CouplingKey =
  | "biometric"
  | "geospatial"
  | "calendar"
  | "planner"
  | "fleet"
  | "drone"
  | "satellite"
  | "weather"
  | "financial";

type GpsStatus = "inactive" | "requesting" | "granted" | "denied" | "error" | "unsupported";
type WeatherStatus = "inactive" | "awaiting_gps" | "loading" | "ready" | "error";
type WeatherRisk = "low" | "moderate" | "high";
type ChatRole = "user" | "assistant";
type ScannerStatus = "idle" | "starting" | "scanning" | "detected" | "error";
type PlannerProvider = "todoist" | "google_tasks" | "notion" | "ical";
type PlannerStatus = "inactive" | "loading" | "ready" | "error";
type ContractDocumentType =
  | "flight_itinerary"
  | "boarding_pass"
  | "hotel_booking"
  | "event_ticket"
  | "calendar_invite"
  | "meeting_confirmation"
  | "transport_booking"
  | "visa_or_id"
  | "other";

interface CouplingItem {
  key: CouplingKey;
  label: string;
  source?: string;
  purpose: string;
  group: "human" | "logistics" | "infra";
}

interface Snapshot {
  remainingMargin: string;
  capacityLevel: string;
  uncertaintyEnvelope: string;
  regimeClassification: string;
  intervention: InterventionState;
  stability: StabilityState;
  boundaryScore: number;
  capacityScore: number;
  uncertaintyScore: number;
  overallIndex: number;
  documentCoverage: number;
  documentLinked: number;
  documentExpected: number;
  documentReadinessLabel: string;
}

interface TreeNode {
  id: string;
  label: string;
  stability: StabilityState;
  capacity: string;
  margin: string;
}

interface StoredPlan {
  id: string;
  planIdentifier: string;
  planDomain: string;
  contractDocuments: ContractDocument[];
  regime: Regime;
  structuralMode: StructuralMode;
  hardBoundary: string;
  softObjective: string;
  resourceConstraint: string;
  couplings: Record<CouplingKey, boolean>;
  status: PlanStatus;
  createdAt: string;
  updatedAt: string;
  checkCount: number;
  violationStreak: number;
  lastSnapshot: {
    stability: StabilityState;
    intervention: InterventionState;
    remainingMargin: string;
  };
}

interface PlansStorage {
  plans: StoredPlan[];
  activePlanId: string | null;
}

interface ActivationConflict {
  currentActive: StoredPlan;
  incoming: StoredPlan;
}

interface GeoSignal {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
  speedKmh: number | null;
  movement: "moving" | "stationary" | "unknown";
  updatedAtIso: string;
}

interface WeatherSignal {
  temperatureC: number | null;
  windKph: number | null;
  precipitationMm: number | null;
  weatherCode: number | null;
  risk: WeatherRisk;
  summary: string;
  updatedAtIso: string;
}

interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
}

interface CoreAssistantResponse {
  reply?: string;
  provider?: string;
  model?: string;
  response_style?: string;
  response_length?: string;
  error?: string;
}

interface BoardingPassExtraction {
  sourceFormat: "bcbp" | "generic";
  flightNumber: string | null;
  departureAirport: string | null;
  arrivalAirport: string | null;
  bookingReference: string | null;
  departureDateLocal: string | null;
  departureTimeLocal: string | null;
  boundaryDateTimeLocal: string | null;
  suggestedArrivalByLocal: string | null;
  notes: string[];
  rawPreview: string;
}

interface ComingSoonSignal {
  title: string;
  examples: string[];
  signalType: string;
  affects: string;
  bestFor: string;
}

interface ComingSoonGroup {
  title: string;
  items: ComingSoonSignal[];
}

interface DomainRule {
  id: string;
  label: string;
  keywords: string[];
}

interface DomainDetection {
  blockedRule: DomainRule | null;
}

interface ContractDocument {
  id: string;
  docType: ContractDocumentType;
  title: string;
  sourceLink: string;
  referenceCode: string;
  notes: string;
}

interface PlannerSignal {
  totalTasks: number;
  completedTasks: number;
  overdueTasks: number;
  dueNext24h: number;
  lastUpdated: number;
}

interface PlannerAdapter {
  fetchSignals(contractBoundaryStart: Date, contractBoundaryEnd: Date): Promise<PlannerSignal>;
}

interface DocumentSuggestion {
  docType: ContractDocumentType;
  title: string;
  reason: string;
  required: boolean;
}

interface DocumentReadiness {
  expectedTypes: ContractDocumentType[];
  missingTypes: ContractDocumentType[];
  expectedCount: number;
  linkedExpectedCount: number;
  linkedTotalCount: number;
  coverage: number;
  label: string;
}

const STATUS_STRIP = "LOCAL NODE | DETERMINISTIC ENGINE | CAPACITY-AWARE | NO REMOTE STORAGE";
const LOCAL_NODE_INDICATOR = "NODE: LOCAL | ENGINE: DETERMINISTIC | LLM: VOICE LAYER | DATA PERSISTENCE: ZERO";
const STORAGE_KEY = "triaia_local_plans_v1";
const PLANNER_AUTH_STORAGE_KEY = "triaia_planner_auth_v1";
const DEMO_COUPLINGS: CouplingKey[] = ["geospatial", "weather", "planner"];
const DEFAULT_PLANNER_SIGNAL: PlannerSignal = {
  totalTasks: 0,
  completedTasks: 0,
  overdueTasks: 0,
  dueNext24h: 0,
  lastUpdated: 0
};
const PLANNER_SCOPE_HINTS: Record<PlannerProvider, string> = {
  todoist: "Todoist scope: data:read",
  google_tasks: "Google Tasks scope: tasks.readonly",
  notion: "Notion integration: read-only",
  ical: "iCal local feed: no OAuth required"
};

const ASSISTANT_INTRO =
  "Voice layer is available after contract activation. It explains engine state only and cannot modify contract logic.";

const REGIME_DETAILS: Record<Regime, { title: string; summary: string; examples: string[] }> = {
  hard: {
    title: "HARD REGIME",
    summary: "Irreversible boundary condition. Time-fixed. Intervention escalates to Plan B.",
    examples: ["Launch date", "Flight departure", "Legal deadline"]
  },
  soft: {
    title: "SOFT REGIME",
    summary: "Objective-bound. Quality-constrained. Intervention prioritizes capacity restoration.",
    examples: ["Research module", "Creative work", "Software development"]
  },
  resource: {
    title: "RESOURCE REGIME",
    summary: "Resource-limited system. Budget, supply, labor constrained. Intervention adjusts margin topology.",
    examples: ["Logistics chain", "Industrial production", "Fleet routing"]
  }
};

const COUPLING_ITEMS: CouplingItem[] = [
  {
    key: "biometric",
    label: "Biometric Load Signal (Optional)",
    source: "Local wearable device",
    purpose: "Capacity inertia modulation under sustained load.",
    group: "human"
  },
  {
    key: "geospatial",
    label: "Geospatial Mobility Feed",
    source: "GPS / Mobility feed",
    purpose: "Alignment tracking under time-fixed boundaries.",
    group: "human"
  },
  {
    key: "calendar",
    label: "Calendar / Scheduling Feed",
    purpose: "Load density scaling.",
    group: "human"
  },
  {
    key: "planner",
    label: "Planner Feed (Read-only)",
    purpose: "Execution load and boundary compression telemetry.",
    group: "human"
  },
  {
    key: "fleet",
    label: "Fleet / Asset Telemetry",
    purpose: "Resource margin + alignment monitoring.",
    group: "logistics"
  },
  {
    key: "drone",
    label: "Drone / Aerial Telemetry",
    purpose: "Uncertainty reduction under terrain or infrastructure constraints.",
    group: "logistics"
  },
  {
    key: "satellite",
    label: "Satellite Connectivity Signal",
    purpose: "Latency reliability modeling under remote conditions.",
    group: "logistics"
  },
  {
    key: "weather",
    label: "Weather / Environmental Feed",
    purpose: "Uncertainty multiplier adjustment.",
    group: "infra"
  },
  {
    key: "financial",
    label: "Financial / Budget Stream",
    purpose: "Resource margin tracking.",
    group: "infra"
  }
];

const COMING_SOON_GROUPS: ComingSoonGroup[] = [
  {
    title: "HUMAN-SCALE COUPLINGS (COMING SOON)",
    items: [
      {
        title: "Biometric Load Signals",
        examples: ["Withings ScanWatch", "Apple Watch", "Garmin Fenix 7"],
        signalType: "HRV, load variance, sleep depth",
        affects: "Capacity inertia, persistence gating",
        bestFor: "HARD + SOFT"
      },
      {
        title: "Calendar / Scheduling APIs",
        examples: ["Google Calendar", "Microsoft Outlook"],
        signalType: "Time block density",
        affects: "Load scaling",
        bestFor: "SOFT + HARD"
      }
    ]
  },
  {
    title: "LOGISTICS / INDUSTRIAL COUPLINGS (COMING SOON)",
    items: [
      {
        title: "Fleet / Convoy Tracking",
        examples: ["Tesla fleet telemetry", "Maersk container tracking"],
        signalType: "Asset position, velocity, fuel state",
        affects: "Alignment + resource margin",
        bestFor: "RESOURCE + HARD"
      },
      {
        title: "Drone Telemetry",
        examples: ["DJI", "Skydio"],
        signalType: "Visual confirmation, terrain, battery",
        affects: "Uncertainty scaling + margin",
        bestFor: "HARD + RESOURCE"
      },
      {
        title: "Satellite Connectivity / Latency",
        examples: ["Starlink"],
        signalType: "Latency stability, bandwidth drop",
        affects: "Uncertainty + delay modeling",
        bestFor: "Remote HARD"
      }
    ]
  },
  {
    title: "ECONOMIC / INFRASTRUCTURE COUPLINGS (COMING SOON)",
    items: [
      {
        title: "Financial / Budget Streams",
        examples: ["Stripe", "SAP"],
        signalType: "Burn rate, liquidity",
        affects: "Resource margin",
        bestFor: "RESOURCE"
      },
      {
        title: "Inventory / Supply Sensors",
        examples: ["Warehouse RFID", "Manufacturing IoT"],
        signalType: "Stock depletion rate",
        affects: "Boundary margin",
        bestFor: "RESOURCE"
      },
      {
        title: "Power Grid / Energy Load",
        examples: ["EDF", "National Grid"],
        signalType: "Load stress",
        affects: "Capacity + margin",
        bestFor: "RESOURCE"
      },
      {
        title: "Traffic / Urban Density",
        examples: ["Waze"],
        signalType: "Congestion load",
        affects: "Alignment + boundary compression",
        bestFor: "HARD"
      },
      {
        title: "Security / Threat Feeds",
        examples: ["Public alert APIs"],
        signalType: "Risk escalation",
        affects: "Uncertainty scaling",
        bestFor: "HARD"
      }
    ]
  },
  {
    title: "MACHINE-TO-MACHINE COUPLINGS (COMING SOON)",
    items: [
      {
        title: "CI/CD Pipeline Signals",
        examples: ["GitHub Actions"],
        signalType: "Build failure rate",
        affects: "Alignment",
        bestFor: "SOFT + HARD"
      },
      {
        title: "Server Load / Cloud Health",
        examples: ["AWS", "DigitalOcean"],
        signalType: "CPU load, latency",
        affects: "Capacity",
        bestFor: "SOFT + RESOURCE"
      }
    ]
  }
];

const INITIAL_COUPLINGS: Record<CouplingKey, boolean> = {
  biometric: false,
  geospatial: false,
  calendar: false,
  planner: false,
  fleet: false,
  drone: false,
  satellite: false,
  weather: false,
  financial: false
};

const BLOCKED_DOMAIN_RULES: DomainRule[] = [
  {
    id: "bio_weapon",
    label: "Biological / Chemical weaponization",
    keywords: [
      "bio weap",
      "bio weapon",
      "bioweapon",
      "biological weapon",
      "weaponized pathogen",
      "chemical weapon",
      "nerve agent"
    ]
  },
  {
    id: "weapons_violence",
    label: "Weapons or violent harm",
    keywords: [
      "build a bomb",
      "make a bomb",
      "explosive device",
      "mass shooting",
      "assassination",
      "kill people",
      "weaponize"
    ]
  },
  {
    id: "cyber_abuse",
    label: "Cyber abuse / malware",
    keywords: [
      "ransomware",
      "malware",
      "keylogger",
      "phishing kit",
      "ddos attack",
      "credential stuffing",
      "exploit zero-day"
    ]
  },
  {
    id: "fraud",
    label: "Fraud / scams / forgery",
    keywords: ["credit card fraud", "wire fraud", "fake id", "forge passport", "money laundering", "scam script"]
  },
  {
    id: "illicit_drugs",
    label: "Illegal drug production",
    keywords: ["cook meth", "drug lab", "illegal drug production", "synthesize fentanyl"]
  },
  {
    id: "smuggling_trafficking",
    label: "Smuggling / trafficking / contraband movement",
    keywords: [
      "smuggle",
      "smuggling",
      "human trafficking",
      "weapons trafficking",
      "contraband",
      "cross border illegally",
      "evade customs"
    ]
  },
  {
    id: "sanctions_evasion",
    label: "Sanctions evasion / embargo bypass",
    keywords: ["sanctions evasion", "bypass embargo", "evade sanctions", "illegal export", "illegal import"]
  },
  {
    id: "theft_property_crime",
    label: "Theft / stolen goods / property crime",
    keywords: ["steal", "stolen goods", "car theft", "robbery plan", "burglary plan", "shoplifting ring"]
  }
];

const CONTRACT_DOCUMENT_TYPE_OPTIONS: Array<{ value: ContractDocumentType; label: string }> = [
  { value: "flight_itinerary", label: "Flight itinerary / e-ticket" },
  { value: "boarding_pass", label: "Boarding pass" },
  { value: "hotel_booking", label: "Hotel booking confirmation" },
  { value: "event_ticket", label: "Convention / event ticket" },
  { value: "calendar_invite", label: "Calendar invite" },
  { value: "meeting_confirmation", label: "Meeting confirmation email" },
  { value: "transport_booking", label: "Ground transport booking" },
  { value: "visa_or_id", label: "Visa / ID requirement" },
  { value: "other", label: "Other contract document" }
];

const CONTRACT_DOCUMENT_TYPE_LABELS: Record<ContractDocumentType, string> = {
  flight_itinerary: "Flight itinerary",
  boarding_pass: "Boarding pass",
  hotel_booking: "Hotel booking",
  event_ticket: "Event ticket",
  calendar_invite: "Calendar invite",
  meeting_confirmation: "Meeting confirmation",
  transport_booking: "Transport booking",
  visa_or_id: "Visa or ID",
  other: "Other document"
};

function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createEmptyContractDocument(): ContractDocument {
  return {
    id: uid(),
    docType: "other",
    title: "",
    sourceLink: "",
    referenceCode: "",
    notes: ""
  };
}

function contractDocumentTypeLabel(docType: ContractDocumentType): string {
  return CONTRACT_DOCUMENT_TYPE_LABELS[docType] ?? "Contract document";
}

function hasDocumentSignal(document: ContractDocument): boolean {
  return [document.title, document.sourceLink, document.referenceCode, document.notes].some(
    (value) => value.trim().length > 0
  );
}

function buildContractDocumentPolicyText(documents: ContractDocument[]): string {
  return documents
    .map((document) => [document.title, document.referenceCode, document.notes].filter(Boolean).join(" "))
    .join(" ");
}

function inferContractDocumentSuggestions(params: {
  regime: Regime;
  contextText: string;
  flightContextDetected: boolean;
}): DocumentSuggestion[] {
  const { regime, contextText, flightContextDetected } = params;
  const context = contextText.toLowerCase();
  const suggestions = new Map<ContractDocumentType, DocumentSuggestion>();

  const addSuggestion = (
    docType: ContractDocumentType,
    title: string,
    reason: string,
    required: boolean
  ): void => {
    const existing = suggestions.get(docType);
    if (!existing) {
      suggestions.set(docType, { docType, title, reason, required });
      return;
    }
    if (required && !existing.required) {
      suggestions.set(docType, { ...existing, required: true });
    }
  };

  if (regime === "hard") {
    addSuggestion(
      "calendar_invite",
      "Boundary confirmation",
      "Adds explicit boundary anchoring for a time-fixed contract.",
      false
    );
  }

  const hasFlightContext =
    flightContextDetected || /\b(flight|airport|airline|terminal|gate|boarding|check-in|itinerary)\b/.test(context);
  if (hasFlightContext) {
    addSuggestion("flight_itinerary", "Flight itinerary", "Confirms departure boundary details.", true);
    addSuggestion("boarding_pass", "Boarding pass", "Adds boundary verification close to departure.", true);
    addSuggestion("transport_booking", "Ground transport", "Supports airport alignment under boundary pressure.", false);
  }

  if (/\b(convention|conference|expo|summit|event|blizzcon)\b/.test(context)) {
    addSuggestion("event_ticket", "Event registration or ticket", "Confirms destination-bound contract intent.", true);
    addSuggestion("hotel_booking", "Hotel confirmation", "Stabilizes lodging dependency around the boundary.", false);
    addSuggestion("calendar_invite", "Calendar hold", "Keeps schedule alignment visible.", false);
  }

  if (/\b(hotel|accommodation|lodging|check-in)\b/.test(context)) {
    addSuggestion("hotel_booking", "Hotel confirmation", "Tracks lodging dependency for this contract.", false);
  }

  if (/\b(meeting|interview|appointment|client|demo)\b/.test(context)) {
    addSuggestion(
      "meeting_confirmation",
      "Meeting confirmation",
      "Anchors objective alignment with the counterpart schedule.",
      regime === "hard"
    );
    addSuggestion("calendar_invite", "Calendar invite", "Keeps schedule coupling explicit.", false);
  }

  if (/\b(visa|passport|immigration|border)\b/.test(context)) {
    addSuggestion("visa_or_id", "Visa or ID proof", "Tracks boundary-related compliance dependencies.", false);
  }

  if (/\b(train|bus|taxi|uber|lyft|shuttle|transport|transfer)\b/.test(context)) {
    addSuggestion("transport_booking", "Transport booking", "Tracks alignment dependency on mobility.", false);
  }

  if (regime === "resource") {
    addSuggestion(
      "other",
      "Resource baseline record",
      "Captures resource-constraint assumptions for future checks.",
      true
    );
  }

  const hasRequired = Array.from(suggestions.values()).some((entry) => entry.required);
  if (regime === "hard" && !hasRequired) {
    addSuggestion(
      "meeting_confirmation",
      "Boundary commitment record",
      "Provides at least one explicit hard-boundary confirmation source.",
      true
    );
  }

  return Array.from(suggestions.values()).sort((a, b) => {
    if (a.required !== b.required) {
      return a.required ? -1 : 1;
    }
    return a.title.localeCompare(b.title);
  });
}

function deriveDocumentReadiness(
  documents: ContractDocument[],
  suggestions: DocumentSuggestion[]
): DocumentReadiness {
  const linkedDocuments = documents.filter(hasDocumentSignal);
  const linkedTypes = new Set(linkedDocuments.map((document) => document.docType));
  const expectedTypes = Array.from(
    new Set(suggestions.filter((suggestion) => suggestion.required).map((suggestion) => suggestion.docType))
  );

  const missingTypes = expectedTypes.filter((type) => !linkedTypes.has(type));
  const linkedExpectedCount = expectedTypes.length - missingTypes.length;
  const expectedCount = expectedTypes.length;

  const coverage =
    expectedCount > 0
      ? linkedExpectedCount / expectedCount
      : linkedDocuments.length > 0
      ? 1
      : 0.75;

  let label = "Evidence profile initializing";
  if (expectedCount === 0) {
    label = linkedDocuments.length > 0 ? "Baseline evidence linked" : "No required evidence profile detected yet";
  } else if (coverage >= 0.99) {
    label = "Key evidence linked";
  } else if (coverage >= 0.5) {
    label = "Key evidence partial";
  } else {
    label = "Key evidence thin";
  }

  return {
    expectedTypes,
    missingTypes,
    expectedCount,
    linkedExpectedCount,
    linkedTotalCount: linkedDocuments.length,
    coverage: clamp(coverage, 0, 1),
    label
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function message(role: ChatRole, text: string): ChatMessage {
  return { id: uid(), role, text };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function countCouplings(couplings: Record<CouplingKey, boolean>): number {
  return Object.values(couplings).filter(Boolean).length;
}

function formatDateTimeLocal(date: Date): string {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 16);
}

function defaultHardBoundary(): string {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  tomorrow.setMinutes(0, 0, 0);
  return formatDateTimeLocal(tomorrow);
}

function parseDeadline(localDateTime: string): Date | null {
  const parsed = new Date(localDateTime);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function formatCountdown(totalMinutes: number): string {
  const safe = Math.max(0, Math.floor(totalMinutes));
  const hours = Math.floor(safe / 60);
  const minutes = safe % 60;
  return `${hours}h ${minutes}m`;
}

function formatBoundaryTimestamp(regime: Regime, hardBoundary: string): string {
  if (regime !== "hard") {
    return "N/A (non-time-fixed regime)";
  }
  const boundary = parseDeadline(hardBoundary);
  return boundary ? boundary.toLocaleString() : "Boundary not configured";
}

function isLikelyFlightContext(planIdentifier: string): boolean {
  const normalized = planIdentifier.trim().toUpperCase();
  if (!normalized) {
    return false;
  }

  const flightKeywords =
    /\b(FLIGHT|BOARDING|BOARD|AIRPORT|AIRLINE|TERMINAL|GATE|DEPARTURE|ARRIVAL|ITINERARY|CHECK-IN)\b/;
  const flightNumberPattern = /\b[A-Z]{2,3}\s?-?\d{1,4}\b/;
  const airportRoutePattern = /\b[A-Z]{3}\b\s*(?:-|→|TO)\s*\b[A-Z]{3}\b/;

  return (
    flightKeywords.test(normalized) ||
    flightNumberPattern.test(normalized) ||
    airportRoutePattern.test(normalized)
  );
}

function normalizePolicyText(rawText: string): string {
  return rawText
    .toLowerCase()
    .replace(/[^\w\s/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectByKeyword(rules: DomainRule[], normalizedText: string): DomainRule | null {
  for (const rule of rules) {
    for (const keyword of rule.keywords) {
      if (normalizedText.includes(keyword.toLowerCase())) {
        return rule;
      }
    }
  }
  return null;
}

function classifyPlanDomain(rawText: string): DomainDetection {
  const normalizedText = normalizePolicyText(rawText);
  if (!normalizedText) {
    return {
      blockedRule: null
    };
  }

  const blocked = detectByKeyword(BLOCKED_DOMAIN_RULES, normalizedText);
  if (blocked) {
    return {
      blockedRule: blocked
    };
  }

  return {
    blockedRule: null
  };
}

function buildPolicySourceText(
  planIdentifier: string,
  planDomain: string,
  softObjective: string,
  resourceConstraint: string,
  contractDocumentText: string
): string {
  return [planIdentifier, planDomain, softObjective, resourceConstraint, contractDocumentText]
    .filter((value) => value.trim().length > 0)
    .join(" ");
}

function describeBoundary(plan: Pick<StoredPlan, "regime" | "hardBoundary" | "softObjective" | "resourceConstraint">): string {
  if (plan.regime === "hard") {
    return formatBoundaryTimestamp(plan.regime, plan.hardBoundary);
  }
  if (plan.regime === "soft") {
    return plan.softObjective || "Objective-bound";
  }
  return plan.resourceConstraint || "Resource-bound";
}

function stabilityFromScore(score: number): StabilityState {
  if (score >= 70) {
    return "stable";
  }
  if (score >= 45) {
    return "strained";
  }
  return "critical";
}

function deriveWeatherRisk(values: {
  weatherCode: number | null;
  windKph: number | null;
  precipitationMm: number | null;
}): { risk: WeatherRisk; summary: string } {
  const { weatherCode, windKph, precipitationMm } = values;

  const wind = windKph ?? 0;
  const precip = precipitationMm ?? 0;
  const code = weatherCode ?? 0;

  const highCode = [95, 96, 99, 71, 73, 75, 77, 85, 86];
  const moderateCode = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82];

  if (wind >= 40 || precip >= 4 || highCode.includes(code)) {
    return { risk: "high", summary: "High weather load" };
  }
  if (wind >= 24 || precip >= 1 || moderateCode.includes(code)) {
    return { risk: "moderate", summary: "Moderate weather load" };
  }
  return { risk: "low", summary: "Low weather load" };
}

function gpsStatusLabel(status: GpsStatus): string {
  if (status === "inactive") {
    return "Inactive";
  }
  if (status === "requesting") {
    return "Requesting permission";
  }
  if (status === "granted") {
    return "Signal locked";
  }
  if (status === "denied") {
    return "Permission denied";
  }
  if (status === "unsupported") {
    return "Not supported";
  }
  return "Signal error";
}

function weatherStatusLabel(status: WeatherStatus): string {
  if (status === "inactive") {
    return "Inactive";
  }
  if (status === "awaiting_gps") {
    return "Waiting for GPS lock";
  }
  if (status === "loading") {
    return "Updating";
  }
  if (status === "ready") {
    return "Live";
  }
  return "Update error";
}

function scannerStatusLabel(status: ScannerStatus): string {
  if (status === "idle") {
    return "Idle";
  }
  if (status === "starting") {
    return "Initializing camera";
  }
  if (status === "scanning") {
    return "Scanning";
  }
  if (status === "detected") {
    return "Candidate detected";
  }
  return "Scanner error";
}

function plannerStatusLabel(status: PlannerStatus): string {
  if (status === "inactive") {
    return "Inactive";
  }
  if (status === "loading") {
    return "Loading";
  }
  if (status === "ready") {
    return "Live";
  }
  return "Signal error";
}

function plannerProviderLabel(provider: PlannerProvider): string {
  if (provider === "todoist") {
    return "Todoist";
  }
  if (provider === "google_tasks") {
    return "Google Tasks";
  }
  if (provider === "notion") {
    return "Notion";
  }
  return "iCal";
}

function parseIcalDate(rawValue: string): Date | null {
  const raw = rawValue.trim();
  if (!raw) {
    return null;
  }

  const utcMatch = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (utcMatch) {
    const [, year, month, day, hour, minute, second] = utcMatch;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  }

  const localMatch = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (localMatch) {
    const [, year, month, day, hour, minute, second] = localMatch;
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  }

  const dateOnlyMatch = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnlyMatch) {
    const [, year, month, day] = dateOnlyMatch;
    return new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0);
  }

  return null;
}

class ICalAdapter implements PlannerAdapter {
  constructor(private readonly sourceUrl: string) {}

  async fetchSignals(contractBoundaryStart: Date, contractBoundaryEnd: Date): Promise<PlannerSignal> {
    const response = await fetch(this.sourceUrl, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`iCal fetch failed (${response.status}).`);
    }

    const text = await response.text();
    const events = text.split("BEGIN:VEVENT").slice(1);
    const now = Date.now();
    const next24h = now + 24 * 60 * 60 * 1000;

    let totalTasks = 0;
    let completedTasks = 0;
    let overdueTasks = 0;
    let dueNext24h = 0;

    for (const event of events) {
      const dateLine = event
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith("DTSTART"));
      if (!dateLine) {
        continue;
      }

      const dateValue = dateLine.split(":").slice(1).join(":");
      const eventDate = parseIcalDate(dateValue);
      if (!eventDate) {
        continue;
      }
      if (eventDate < contractBoundaryStart || eventDate > contractBoundaryEnd) {
        continue;
      }

      totalTasks += 1;
      const statusLine = event
        .split("\n")
        .map((line) => line.trim().toUpperCase())
        .find((line) => line.startsWith("STATUS:"));
      if (statusLine?.includes("COMPLETED")) {
        completedTasks += 1;
      }

      const timestamp = eventDate.getTime();
      if (timestamp < now) {
        overdueTasks += 1;
      }
      if (timestamp >= now && timestamp <= next24h) {
        dueNext24h += 1;
      }
    }

    return {
      totalTasks,
      completedTasks,
      overdueTasks,
      dueNext24h,
      lastUpdated: Date.now()
    };
  }
}

class TodoistAdapter implements PlannerAdapter {
  constructor(private readonly token: string) {}

  async fetchSignals(contractBoundaryStart: Date, contractBoundaryEnd: Date): Promise<PlannerSignal> {
    const response = await fetch("https://api.todoist.com/rest/v2/tasks", {
      headers: {
        Authorization: `Bearer ${this.token}`
      },
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error(`Todoist fetch failed (${response.status}).`);
    }

    const payload = (await response.json()) as Array<{
      due?: {
        date?: string;
        datetime?: string;
      };
      is_completed?: boolean;
      completed?: boolean;
    }>;

    const now = Date.now();
    const next24h = now + 24 * 60 * 60 * 1000;
    const tasksInWindow = payload
      .map((task) => {
        const dueRaw = task.due?.datetime ?? task.due?.date ?? "";
        const due = dueRaw ? new Date(dueRaw) : null;
        return { task, due };
      })
      .filter((entry) => entry.due && !Number.isNaN(entry.due.getTime()))
      .filter((entry) => {
        const due = entry.due as Date;
        return due >= contractBoundaryStart && due <= contractBoundaryEnd;
      });

    const completedTasks = tasksInWindow.filter((entry) => Boolean(entry.task.is_completed ?? entry.task.completed)).length;
    const overdueTasks = tasksInWindow.filter((entry) => {
      const due = (entry.due as Date).getTime();
      return due < now;
    }).length;
    const dueNext24h = tasksInWindow.filter((entry) => {
      const due = (entry.due as Date).getTime();
      return due >= now && due <= next24h;
    }).length;

    return {
      totalTasks: tasksInWindow.length,
      completedTasks,
      overdueTasks,
      dueNext24h,
      lastUpdated: Date.now()
    };
  }
}

class UnsupportedPlannerAdapter implements PlannerAdapter {
  constructor(private readonly provider: PlannerProvider) {}

  async fetchSignals(): Promise<PlannerSignal> {
    throw new Error(`${plannerProviderLabel(this.provider)} adapter is not available in this demo build.`);
  }
}

function createPlannerAdapter(params: {
  provider: PlannerProvider;
  token: string;
  iCalUrl: string;
}): PlannerAdapter | null {
  const { provider, token, iCalUrl } = params;
  if (provider === "ical") {
    if (!iCalUrl.trim()) {
      return null;
    }
    return new ICalAdapter(iCalUrl.trim());
  }
  if (provider === "todoist") {
    if (!token.trim()) {
      return null;
    }
    return new TodoistAdapter(token.trim());
  }
  if (provider === "google_tasks" || provider === "notion") {
    return new UnsupportedPlannerAdapter(provider);
  }
  return null;
}

function resolveContractWindow(regime: Regime, hardBoundary: string): { start: Date; end: Date } {
  const start = new Date();
  if (regime === "hard") {
    const boundary = parseDeadline(hardBoundary);
    if (boundary && boundary > start) {
      return { start, end: boundary };
    }
    return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
  }
  return { start, end: new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000) };
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function formatDateOnlyLocal(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function normalizeHhmm(rawValue: string): string | null {
  const value = rawValue.trim();
  if (!value) {
    return null;
  }

  const colonMatch = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (colonMatch) {
    return `${colonMatch[1]}:${colonMatch[2]}`;
  }

  const compactMatch = value.match(/^([01]\d|2[0-3])([0-5]\d)$/);
  if (compactMatch) {
    return `${compactMatch[1]}:${compactMatch[2]}`;
  }

  return null;
}

function inferDateFromJulianDay(dayOfYear: number, referenceDate: Date): Date {
  const year = referenceDate.getFullYear();
  const toDate = (candidateYear: number) => new Date(candidateYear, 0, dayOfYear);
  const candidate = toDate(year);
  const deltaMs = candidate.getTime() - referenceDate.getTime();
  const halfYearMs = 183 * 24 * 60 * 60 * 1000;

  if (deltaMs < -halfYearMs) {
    return toDate(year + 1);
  }
  if (deltaMs > halfYearMs) {
    return toDate(year - 1);
  }
  return candidate;
}

function buildBoundaryDateTime(
  dateLocal: string | null,
  timeLocal: string | null,
  fallbackHardBoundary: string
): string | null {
  if (!dateLocal && !timeLocal) {
    return null;
  }

  const fallbackDate = fallbackHardBoundary.split("T")[0] || formatDateOnlyLocal(new Date());
  const fallbackTime = normalizeHhmm(fallbackHardBoundary.split("T")[1]?.slice(0, 5) ?? "") || "12:00";

  const datePart = dateLocal ?? fallbackDate;
  const timePart = timeLocal ?? fallbackTime;
  return `${datePart}T${timePart}`;
}

function shiftLocalMinutes(dateTimeLocal: string | null, minutes: number): string | null {
  if (!dateTimeLocal) {
    return null;
  }
  const parsed = new Date(dateTimeLocal);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return formatDateTimeLocal(new Date(parsed.getTime() + minutes * 60000));
}

function extractBoardingTimeHeuristic(raw: string): string | null {
  const keywordPatterns = [
    /(?:BOARD(?:ING)?|BRD|BT|DEP(?:ARTURE)?)[:=\s-]*([01]\d[0-5]\d)/i,
    /(?:BOARD(?:ING)?|BRD|BT|DEP(?:ARTURE)?)[:=\s-]*([01]\d:[0-5]\d)/i
  ];

  for (const pattern of keywordPatterns) {
    const match = raw.match(pattern);
    if (match?.[1]) {
      const normalized = normalizeHhmm(match[1]);
      if (normalized) {
        return normalized;
      }
    }
  }

  return null;
}

function previewPayload(raw: string): string {
  const compact = raw.replace(/\s+/g, " ").trim();
  if (compact.length <= 84) {
    return compact;
  }
  return `${compact.slice(0, 84)}…`;
}

function parseBcbpPayload(raw: string, fallbackHardBoundary: string): BoardingPassExtraction | null {
  const compact = raw.replace(/\s+/g, "").toUpperCase();
  if (compact.length < 60) {
    return null;
  }

  const legCount = Number(compact.slice(1, 2));
  if (!Number.isFinite(legCount) || legCount < 1) {
    return null;
  }

  const departureAirport = compact.slice(30, 33).replace(/[^A-Z]/g, "");
  const arrivalAirport = compact.slice(33, 36).replace(/[^A-Z]/g, "");
  const carrier = compact.slice(36, 39).replace(/[^A-Z0-9]/g, "");
  const flightNumberRaw = compact.slice(39, 44).replace(/[^0-9]/g, "");
  const bookingReference = compact.slice(23, 30).replace(/[^A-Z0-9]/g, "");
  const julianRaw = compact.slice(44, 47).replace(/[^0-9]/g, "");

  if (!departureAirport || !arrivalAirport || !carrier) {
    return null;
  }

  const notes: string[] = [];
  const julianDay = Number(julianRaw);
  let departureDateLocal: string | null = null;
  if (Number.isFinite(julianDay) && julianDay >= 1 && julianDay <= 366) {
    departureDateLocal = formatDateOnlyLocal(inferDateFromJulianDay(julianDay, new Date()));
  } else {
    notes.push("Flight date was not available in expected BCBP fields.");
  }

  const departureTimeLocal = extractBoardingTimeHeuristic(raw);
  if (!departureTimeLocal) {
    notes.push("Boarding/departure time was not encoded; retained manual time component.");
  }

  const flightNumber = flightNumberRaw
    ? `${carrier}${String(Number(flightNumberRaw) || flightNumberRaw)}`
    : carrier;

  const boundaryDateTimeLocal = buildBoundaryDateTime(
    departureDateLocal,
    departureTimeLocal,
    fallbackHardBoundary
  );

  return {
    sourceFormat: "bcbp",
    flightNumber,
    departureAirport,
    arrivalAirport,
    bookingReference: bookingReference || null,
    departureDateLocal,
    departureTimeLocal,
    boundaryDateTimeLocal,
    suggestedArrivalByLocal: shiftLocalMinutes(boundaryDateTimeLocal, -120),
    notes,
    rawPreview: previewPayload(raw)
  };
}

function parseGenericBoardingPayload(raw: string, fallbackHardBoundary: string): BoardingPassExtraction {
  const upper = raw.toUpperCase();
  const notes: string[] = [];

  const isoDateTimeMatch = upper.match(/(20\d{2})[-/](\d{2})[-/](\d{2})[ T]([01]\d|2[0-3]):([0-5]\d)/);
  const slashDateTimeMatch = upper.match(/(\d{2})[-/](\d{2})[-/](20\d{2}).*?([01]\d|2[0-3]):([0-5]\d)/);

  let departureDateLocal: string | null = null;
  let departureTimeLocal: string | null = null;

  if (isoDateTimeMatch) {
    departureDateLocal = `${isoDateTimeMatch[1]}-${isoDateTimeMatch[2]}-${isoDateTimeMatch[3]}`;
    departureTimeLocal = `${isoDateTimeMatch[4]}:${isoDateTimeMatch[5]}`;
  } else if (slashDateTimeMatch) {
    departureDateLocal = `${slashDateTimeMatch[3]}-${slashDateTimeMatch[2]}-${slashDateTimeMatch[1]}`;
    departureTimeLocal = `${slashDateTimeMatch[4]}:${slashDateTimeMatch[5]}`;
  } else {
    departureTimeLocal = extractBoardingTimeHeuristic(upper);
  }

  const flightMatch = upper.match(/\b([A-Z0-9]{2,3})\s?-?\s?(\d{1,4})\b/);
  const bookingMatch = upper.match(/\b(?:PNR|BOOK(?:ING)?|REF(?:ERENCE)?)[:=\s-]*([A-Z0-9]{5,8})\b/);
  const airportMatches = Array.from(upper.matchAll(/\b[A-Z]{3}\b/g)).map((entry) => entry[0]);

  const departureAirport = airportMatches[0] ?? null;
  const arrivalAirport = airportMatches[1] ?? null;

  const boundaryDateTimeLocal = buildBoundaryDateTime(
    departureDateLocal,
    departureTimeLocal,
    fallbackHardBoundary
  );

  if (!departureDateLocal) {
    notes.push("Flight date not clearly encoded; keeping manual boundary date.");
  }
  if (!departureTimeLocal) {
    notes.push("Flight time not clearly encoded; keeping manual boundary time.");
  }

  return {
    sourceFormat: "generic",
    flightNumber: flightMatch ? `${flightMatch[1]}${flightMatch[2]}` : null,
    departureAirport,
    arrivalAirport,
    bookingReference: bookingMatch?.[1] ?? null,
    departureDateLocal,
    departureTimeLocal,
    boundaryDateTimeLocal,
    suggestedArrivalByLocal: shiftLocalMinutes(boundaryDateTimeLocal, -120),
    notes,
    rawPreview: previewPayload(raw)
  };
}

function parseBoardingPassPayload(raw: string, fallbackHardBoundary: string): BoardingPassExtraction {
  const bcbp = parseBcbpPayload(raw, fallbackHardBoundary);
  if (bcbp) {
    return bcbp;
  }
  return parseGenericBoardingPayload(raw, fallbackHardBoundary);
}

function buildSnapshot(params: {
  regime: Regime;
  structuralMode: StructuralMode;
  couplingCount: number;
  hardBoundary: string;
  nowMs: number;
  softObjective: string;
  resourceConstraint: string;
  geospatialEnabled: boolean;
  gpsStatus: GpsStatus;
  geoSignal: GeoSignal | null;
  weatherEnabled: boolean;
  weatherSignal: WeatherSignal | null;
  weatherStatus: WeatherStatus;
  plannerEnabled: boolean;
  plannerSignal: PlannerSignal | null;
  plannerStatus: PlannerStatus;
  plannerSignalWeight: number;
  documentReadiness: DocumentReadiness;
}): Snapshot {
  const {
    regime,
    structuralMode,
    couplingCount,
    hardBoundary,
    nowMs,
    softObjective,
    resourceConstraint,
    geospatialEnabled,
    gpsStatus,
    geoSignal,
    weatherEnabled,
    weatherSignal,
    weatherStatus,
    plannerEnabled,
    plannerSignal,
    plannerStatus,
    plannerSignalWeight,
    documentReadiness
  } = params;

  let score = 78;

  if (regime === "hard") {
    score -= 13;
  } else if (regime === "resource") {
    score -= 10;
  } else {
    score -= 7;
  }

  if (structuralMode === "manual") {
    score -= 7;
  }

  if (couplingCount === 0) {
    score -= 11;
  } else {
    score += couplingCount * 2.5;
  }

  if (geospatialEnabled) {
    if (gpsStatus === "granted") {
      score += geoSignal?.movement === "moving" ? 4 : 1;
    } else if (gpsStatus === "requesting") {
      score -= 2;
    } else if (gpsStatus === "denied" || gpsStatus === "error" || gpsStatus === "unsupported") {
      score -= 10;
    }
  }

  if (weatherEnabled) {
    if (weatherStatus === "ready" && weatherSignal) {
      if (weatherSignal.risk === "high") {
        score -= 10;
      } else if (weatherSignal.risk === "moderate") {
        score -= 5;
      } else {
        score -= 1;
      }
    } else if (weatherStatus === "loading" || weatherStatus === "awaiting_gps") {
      score -= 2;
    } else if (weatherStatus === "error") {
      score -= 5;
    }
  }

  if (documentReadiness.expectedCount > 0) {
    if (documentReadiness.coverage < 0.34) {
      score -= 12;
    } else if (documentReadiness.coverage < 0.67) {
      score -= 6;
    } else {
      score += 2;
    }
  }

  if (plannerEnabled) {
    if (plannerSignal) {
      const overduePenalty = Math.min(18, plannerSignal.overdueTasks * 3 * plannerSignalWeight);
      const dueWindowPenalty = Math.min(12, plannerSignal.dueNext24h * 1.6 * plannerSignalWeight);
      const completionSupport =
        plannerSignal.totalTasks > 0
          ? Math.min(8, (plannerSignal.completedTasks / plannerSignal.totalTasks) * 8)
          : 0;

      score -= overduePenalty + dueWindowPenalty - completionSupport;
    } else if (plannerStatus === "error") {
      score -= 6;
    } else {
      score -= 2;
    }
  }

  const hardDate = parseDeadline(hardBoundary);
  let minutesToBoundary = 0;
  if (regime === "hard" && hardDate) {
    minutesToBoundary = Math.max(0, Math.floor((hardDate.getTime() - nowMs) / 60000));
    if (minutesToBoundary <= 240) {
      score -= 34;
    } else if (minutesToBoundary <= 720) {
      score -= 20;
    } else if (minutesToBoundary <= 1440) {
      score -= 9;
    }
  }

  let boundaryScore = clamp(
    regime === "hard" ? score + (minutesToBoundary > 0 ? Math.min(20, minutesToBoundary / 120) : -18) : score + 4,
    5,
    95
  );
  let capacityScore = clamp(score + (structuralMode === "automatic" ? 5 : -4), 5, 95);
  let uncertaintyScore = clamp(32 + couplingCount * 9 + (regime === "soft" ? 6 : 0), 5, 95);

  if (weatherEnabled && weatherSignal) {
    if (weatherSignal.risk === "high") {
      uncertaintyScore = clamp(uncertaintyScore - 14, 5, 95);
    } else if (weatherSignal.risk === "moderate") {
      uncertaintyScore = clamp(uncertaintyScore - 8, 5, 95);
    } else {
      uncertaintyScore = clamp(uncertaintyScore - 2, 5, 95);
    }
  }

  if (documentReadiness.expectedCount > 0) {
    const missingBoundaryEvidenceCount = documentReadiness.missingTypes.filter((type) =>
      ["flight_itinerary", "boarding_pass", "event_ticket", "meeting_confirmation", "calendar_invite"].includes(type)
    ).length;

    if (missingBoundaryEvidenceCount >= 2) {
      boundaryScore = clamp(boundaryScore - 10, 5, 95);
    } else if (missingBoundaryEvidenceCount === 1) {
      boundaryScore = clamp(boundaryScore - 5, 5, 95);
    }

    if (documentReadiness.coverage < 1) {
      uncertaintyScore = clamp(uncertaintyScore - Math.round((1 - documentReadiness.coverage) * 10), 5, 95);
    } else {
      uncertaintyScore = clamp(uncertaintyScore + 2, 5, 95);
    }
  }

  if (plannerEnabled) {
    if (plannerSignal) {
      const dueWindowPenalty = Math.min(10, plannerSignal.dueNext24h * 1.2 * plannerSignalWeight);
      const overduePenalty = Math.min(14, plannerSignal.overdueTasks * 1.8 * plannerSignalWeight);
      const completionSupport =
        plannerSignal.totalTasks > 0
          ? Math.min(7, (plannerSignal.completedTasks / plannerSignal.totalTasks) * 7)
          : 0;

      boundaryScore = clamp(boundaryScore - dueWindowPenalty, 5, 95);
      capacityScore = clamp(capacityScore - overduePenalty + completionSupport, 5, 95);
      uncertaintyScore = clamp(uncertaintyScore - Math.min(8, overduePenalty * 0.5), 5, 95);
    } else if (plannerStatus === "error") {
      uncertaintyScore = clamp(uncertaintyScore - 6, 5, 95);
    }
  }

  if (geospatialEnabled) {
    if (gpsStatus === "granted") {
      boundaryScore = clamp(boundaryScore + (geoSignal?.movement === "moving" ? 7 : 3), 5, 95);
    } else if (gpsStatus === "denied" || gpsStatus === "error" || gpsStatus === "unsupported") {
      boundaryScore = clamp(boundaryScore - 12, 5, 95);
      capacityScore = clamp(capacityScore - 6, 5, 95);
    }
  }

  const aggregate = clamp((boundaryScore + capacityScore + uncertaintyScore) / 3, 5, 95);

  let intervention: InterventionState;
  if (aggregate >= 70) {
    intervention = "CONTINUE";
  } else if (aggregate >= 52) {
    intervention = "DEVIATE";
  } else if (regime === "hard") {
    intervention = "PLAN B";
  } else {
    intervention = "PAUSE";
  }

  let remainingMargin = "--";
  if (regime === "hard") {
    remainingMargin = hardDate
      ? `${formatCountdown(Math.max(0, (hardDate.getTime() - nowMs) / 60000))} to boundary`
      : "Boundary not configured";
  } else if (regime === "soft") {
    remainingMargin = softObjective.trim()
      ? `Objective integrity margin ${Math.round(aggregate)}%`
      : "Objective descriptor required";
  } else {
    remainingMargin = resourceConstraint.trim()
      ? `Resource margin index ${Math.round(aggregate)}%`
      : "Resource constraint required";
  }

  const capacityLevel =
    aggregate >= 70 ? "Nominal" : aggregate >= 52 ? "Tension-adjusted" : "Critical load";

  const uncertaintyEnvelope = couplingCount >= 5 ? "NARROW" : couplingCount >= 2 ? "MODERATE" : "WIDE";

  return {
    remainingMargin,
    capacityLevel,
    uncertaintyEnvelope,
    regimeClassification: `${regime.toUpperCase()} REGIME`,
    intervention,
    stability: stabilityFromScore(aggregate),
    boundaryScore,
    capacityScore,
    uncertaintyScore,
    overallIndex: aggregate,
    documentCoverage: documentReadiness.coverage,
    documentLinked: documentReadiness.linkedExpectedCount,
    documentExpected: documentReadiness.expectedCount,
    documentReadinessLabel: documentReadiness.label
  };
}

function interventionChoices(regime: Regime): string[] {
  if (regime === "hard") {
    return ["Activate Plan B", "Adjust Within Boundary", "Continue (Risk Acknowledged)"];
  }
  if (regime === "soft") {
    return ["Pause & Restore Capacity", "Reduce Scope", "Continue"];
  }
  return ["Reallocate Margin", "Switch Sub-Contract", "Continue"];
}

function describeStateCriteria(params: {
  regime: Regime;
  structuralMode: StructuralMode;
  hardBoundaryMinutes: number | null;
  couplingCount: number;
  geospatialEnabled: boolean;
  gpsStatus: GpsStatus;
  weatherEnabled: boolean;
  weatherStatus: WeatherStatus;
  weatherSignal: WeatherSignal | null;
  plannerEnabled: boolean;
  plannerStatus: PlannerStatus;
  plannerSignal: PlannerSignal | null;
  plannerSignalWeight: number;
  documentReadiness: DocumentReadiness;
  snapshot: Snapshot;
}): string[] {
  const {
    regime,
    structuralMode,
    hardBoundaryMinutes,
    couplingCount,
    geospatialEnabled,
    gpsStatus,
    weatherEnabled,
    weatherStatus,
    weatherSignal,
    plannerEnabled,
    plannerStatus,
    plannerSignal,
    plannerSignalWeight,
    documentReadiness,
    snapshot
  } = params;

  const criteria: string[] = [];

  if (regime === "hard" && hardBoundaryMinutes !== null) {
    if (hardBoundaryMinutes <= 240) {
      criteria.push("Boundary window is tight, so intervention sensitivity is elevated.");
    } else if (hardBoundaryMinutes <= 1440) {
      criteria.push("Boundary is within 24 hours, so margin compression is active.");
    } else {
      criteria.push("Boundary window is still wide, which supports margin stability.");
    }
  }

  if (documentReadiness.expectedCount > 0) {
    if (documentReadiness.coverage >= 0.99) {
      criteria.push(
        `Key contract evidence is linked (${documentReadiness.linkedExpectedCount}/${documentReadiness.expectedCount}).`
      );
    } else {
      criteria.push(
        `Contract evidence is ${documentReadiness.coverage >= 0.5 ? "partial" : "thin"} (${documentReadiness.linkedExpectedCount}/${documentReadiness.expectedCount} key documents linked).`
      );
    }
  } else if (documentReadiness.linkedTotalCount > 0) {
    criteria.push("Baseline contract evidence is linked.");
  }

  if (couplingCount === 0) {
    criteria.push("No live couplings are active, so uncertainty remains wide.");
  } else if (couplingCount === 1) {
    criteria.push("Only one live coupling is active, so uncertainty reduction is limited.");
  } else {
    criteria.push(`${couplingCount} live couplings are active and reducing uncertainty spread.`);
  }

  if (geospatialEnabled) {
    if (gpsStatus === "granted") {
      criteria.push("GPS coupling is locked and contributing alignment signal.");
    } else if (gpsStatus === "requesting") {
      criteria.push("GPS permission is pending, so alignment coupling is not fully active.");
    } else if (gpsStatus === "denied" || gpsStatus === "error" || gpsStatus === "unsupported") {
      criteria.push("GPS coupling is unavailable, reducing alignment confidence.");
    }
  }

  if (weatherEnabled) {
    if (weatherStatus === "ready" && weatherSignal) {
      if (weatherSignal.risk === "high") {
        criteria.push("Weather load is high and is widening the uncertainty envelope.");
      } else if (weatherSignal.risk === "moderate") {
        criteria.push("Weather load is moderate and adds boundary tension.");
      } else {
        criteria.push("Weather load is low and contributes to stable conditions.");
      }
    } else if (weatherStatus === "loading" || weatherStatus === "awaiting_gps") {
      criteria.push("Weather signal is initializing and not fully contributing yet.");
    } else if (weatherStatus === "error") {
      criteria.push("Weather signal is unavailable, which increases uncertainty.");
    }
  }

  if (plannerEnabled) {
    if (plannerSignal) {
      criteria.push(
        `Planner telemetry: ${plannerSignal.totalTasks} total, ${plannerSignal.completedTasks} completed, ${plannerSignal.overdueTasks} overdue, ${plannerSignal.dueNext24h} due next 24h.`
      );
      if (plannerSignal.overdueTasks > 0) {
        criteria.push("Overdue planner load is compressing execution capacity.");
      } else if (plannerSignal.dueNext24h > 0) {
        criteria.push("Near-term planner density is adding boundary compression.");
      }
    } else if (plannerStatus === "error") {
      criteria.push(
        `Planner feed retrieval failed; using last known telemetry with reduced influence (${Math.round(
          plannerSignalWeight * 100
        )}%).`
      );
    } else {
      criteria.push("Planner feed is enabled but telemetry is not yet available.");
    }
  }

  if (structuralMode === "manual") {
    criteria.push("Manual mode is active, so interventions require explicit user confirmation.");
  } else if (snapshot.intervention !== "CONTINUE") {
    criteria.push("Automatic mode is active and intervention posture has shifted from CONTINUE.");
  }

  return criteria.slice(0, 6);
}

function trendDescriptor(delta: number): string {
  if (Math.abs(delta) < 0.05) {
    return "Stable (+0.0)";
  }
  if (delta >= 1.5) {
    return `Rising (+${delta.toFixed(1)})`;
  }
  if (delta <= -1.5) {
    return `Falling (${delta.toFixed(1)})`;
  }
  const signed = delta >= 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1);
  return `Stable (${signed})`;
}

function articulationForState(state: InterventionState): string {
  if (state === "CONTINUE") {
    return "Engine state articulation only. Deterministic evaluation complete. Structure remains coherent under current constraints.";
  }
  if (state === "DEVIATE") {
    return "Engine state articulation only. Deterministic evaluation complete. Structural deviation detected under active constraints.";
  }
  if (state === "PLAN B") {
    return "Engine state articulation only. Deterministic evaluation complete. Escalation pathway is now active under boundary stress.";
  }
  return "Engine state articulation only. Deterministic evaluation complete. Capacity restoration mode is active.";
}

function refreshSnapshotForPlan(
  plan: Pick<
    StoredPlan,
    | "regime"
    | "structuralMode"
    | "couplings"
    | "hardBoundary"
    | "softObjective"
    | "resourceConstraint"
    | "planIdentifier"
    | "planDomain"
    | "contractDocuments"
  >,
  nowMs: number
): Snapshot {
  const contractText = buildPolicySourceText(
    plan.planIdentifier,
    plan.planDomain,
    plan.softObjective,
    plan.resourceConstraint,
    buildContractDocumentPolicyText(plan.contractDocuments)
  );
  const flightDetected = isLikelyFlightContext(contractText);
  const suggestions = inferContractDocumentSuggestions({
    regime: plan.regime,
    contextText: contractText,
    flightContextDetected: flightDetected
  });
  const documentReadiness = deriveDocumentReadiness(plan.contractDocuments, suggestions);

  return buildSnapshot({
    regime: plan.regime,
    structuralMode: plan.structuralMode,
    couplingCount: countCouplings(plan.couplings),
    hardBoundary: plan.hardBoundary,
    nowMs,
    softObjective: plan.softObjective,
    resourceConstraint: plan.resourceConstraint,
    geospatialEnabled: Boolean(plan.couplings.geospatial),
    gpsStatus: "inactive",
    geoSignal: null,
    weatherEnabled: Boolean(plan.couplings.weather),
    weatherSignal: null,
    weatherStatus: "inactive",
    plannerEnabled: Boolean(plan.couplings.planner),
    plannerSignal: null,
    plannerStatus: "inactive",
    plannerSignalWeight: 1,
    documentReadiness
  });
}

function buildAssistantPrompt(params: {
  userInput: string;
  planIdentifier: string;
  planDomain: string;
  regime: Regime;
  structuralMode: StructuralMode;
  snapshot: Snapshot;
  stateCriteria: string[];
  plannerStatus: PlannerStatus;
  plannerSignal: PlannerSignal | null;
  gpsStatus: GpsStatus;
  weatherStatus: WeatherStatus;
  weatherSignal: WeatherSignal | null;
}): string {
  const {
    userInput,
    planIdentifier,
    planDomain,
    regime,
    structuralMode,
    snapshot,
    stateCriteria,
    plannerStatus,
    plannerSignal,
    gpsStatus,
    weatherStatus,
    weatherSignal
  } = params;

  return [
    `User request: ${userInput}`,
    `Plan: ${planIdentifier || "UNASSIGNED"}`,
    `Domain: ${planDomain || "UNSPECIFIED"}`,
    `Regime: ${regime.toUpperCase()}`,
    `Mode: ${structuralMode.toUpperCase()}`,
    `Intervention state: ${snapshot.intervention}`,
    `Stability index: ${Math.round(snapshot.overallIndex)}`,
    `Remaining margin: ${snapshot.remainingMargin}`,
    `Capacity level: ${snapshot.capacityLevel}`,
    `Uncertainty envelope: ${snapshot.uncertaintyEnvelope}`,
    `Evidence readiness: ${snapshot.documentReadinessLabel} (${snapshot.documentLinked}/${snapshot.documentExpected || 0})`,
    `Planner feed: ${plannerStatusLabel(plannerStatus)}${
      plannerSignal
        ? ` (total ${plannerSignal.totalTasks}, completed ${plannerSignal.completedTasks}, overdue ${plannerSignal.overdueTasks}, next24h ${plannerSignal.dueNext24h})`
        : ""
    }`,
    `State criteria: ${stateCriteria.length ? stateCriteria.join(" | ") : "No additional criteria available."}`,
    `GPS signal: ${gpsStatusLabel(gpsStatus)}`,
    `Weather signal: ${weatherStatusLabel(weatherStatus)}${weatherSignal ? ` (${weatherSignal.summary})` : ""}`,
    "Respond in tactical short mode with one or two neutral lines.",
    "Do not issue commands. Do not modify plan state."
  ].join("\n");
}

function buildLocalVoiceFallback(params: {
  userInput: string;
  snapshot: Snapshot;
  stateCriteria: string[];
  plannerStatus: PlannerStatus;
  plannerSignal: PlannerSignal | null;
  gpsStatus: GpsStatus;
  weatherStatus: WeatherStatus;
  weatherSignal: WeatherSignal | null;
}): string {
  const {
    userInput,
    snapshot,
    stateCriteria,
    plannerStatus,
    plannerSignal,
    gpsStatus,
    weatherStatus,
    weatherSignal
  } = params;

  const stateLine =
    snapshot.intervention === "CONTINUE"
      ? "Current state is CONTINUE."
      : `Current state is ${snapshot.intervention}.`;

  const signalLine = `Signals: GPS ${gpsStatusLabel(gpsStatus)}; Weather ${weatherStatusLabel(weatherStatus)}${
    weatherSignal ? ` (${weatherSignal.summary})` : ""
  }.`;

  return [
    `${stateLine} Stability index: ${Math.round(snapshot.overallIndex)}. Remaining margin: ${snapshot.remainingMargin}. Capacity: ${snapshot.capacityLevel}. Uncertainty: ${snapshot.uncertaintyEnvelope}.`,
    `Planner feed: ${plannerStatusLabel(plannerStatus)}${
      plannerSignal
        ? ` (total ${plannerSignal.totalTasks}, completed ${plannerSignal.completedTasks}, overdue ${plannerSignal.overdueTasks}, next24h ${plannerSignal.dueNext24h})`
        : ""
    }.`,
    `State criteria: ${stateCriteria.length ? stateCriteria.join(" | ") : "No additional criteria available."}`,
    `${signalLine} Local fallback response generated because core voice endpoint is temporarily unreachable.`,
    userInput ? `Prompt received: "${userInput}".` : ""
  ]
    .filter(Boolean)
    .join(" ");
}

async function requestAssistantFromCore(prompt: string): Promise<CoreAssistantResponse> {
  const response = await fetch("/api/core/assistant_chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: prompt,
      response_style: "tactical",
      response_length: "short"
    }),
    cache: "no-store"
  });

  let payload: CoreAssistantResponse = {};
  try {
    payload = (await response.json()) as CoreAssistantResponse;
  } catch {
    payload = {};
  }

  if (!response.ok) {
    throw new Error(payload.error || `Assistant request failed (${response.status}).`);
  }

  return payload;
}

export default function HomePage() {
  const [screen, setScreen] = useState<Screen>("activation");
  const [showInfo, setShowInfo] = useState(false);
  const [showPlans, setShowPlans] = useState(false);

  const [consentAccepted, setConsentAccepted] = useState(false);
  const [consentTicked, setConsentTicked] = useState(false);

  const [regime, setRegime] = useState<Regime | null>(null);
  const [planIdentifier, setPlanIdentifier] = useState("");
  const [planDomain, setPlanDomain] = useState("");
  const [contractDocuments, setContractDocuments] = useState<ContractDocument[]>([]);
  const [hardBoundary, setHardBoundary] = useState(defaultHardBoundary);
  const [softObjective, setSoftObjective] = useState("");
  const [resourceConstraint, setResourceConstraint] = useState("");
  const [structuralMode, setStructuralMode] = useState<StructuralMode>("automatic");

  const [couplings, setCouplings] = useState<Record<CouplingKey, boolean>>(INITIAL_COUPLINGS);

  const [plans, setPlans] = useState<StoredPlan[]>([]);
  const [activePlanId, setActivePlanId] = useState<string | null>(null);
  const [currentPlanId, setCurrentPlanId] = useState<string | null>(null);

  const [enginePowering, setEnginePowering] = useState(false);
  const [formError, setFormError] = useState("");
  const [checkFeedback, setCheckFeedback] = useState("");

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [checkCount, setCheckCount] = useState(0);
  const [violationStreak, setViolationStreak] = useState(0);
  const [showInterventionModal, setShowInterventionModal] = useState(false);
  const [advancedVisible, setAdvancedVisible] = useState(false);
  const [activationConflict, setActivationConflict] = useState<ActivationConflict | null>(null);

  const [gpsStatus, setGpsStatus] = useState<GpsStatus>("inactive");
  const [geoSignal, setGeoSignal] = useState<GeoSignal | null>(null);

  const [weatherStatus, setWeatherStatus] = useState<WeatherStatus>("inactive");
  const [weatherSignal, setWeatherSignal] = useState<WeatherSignal | null>(null);
  const [plannerProvider, setPlannerProvider] = useState<PlannerProvider>("ical");
  const [plannerToken, setPlannerToken] = useState("");
  const [plannerIcalUrl, setPlannerIcalUrl] = useState("");
  const [plannerStatus, setPlannerStatus] = useState<PlannerStatus>("inactive");
  const [plannerSignal, setPlannerSignal] = useState<PlannerSignal | null>(null);
  const [plannerSignalWeight, setPlannerSignalWeight] = useState(1);
  const [plannerWarning, setPlannerWarning] = useState("");

  const [assistantInput, setAssistantInput] = useState("");
  const [assistantMessages, setAssistantMessages] = useState<ChatMessage[]>([message("assistant", ASSISTANT_INTRO)]);
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantMeta, setAssistantMeta] = useState("");
  const [showBoundaryScanner, setShowBoundaryScanner] = useState(false);
  const [scannerStatus, setScannerStatus] = useState<ScannerStatus>("idle");
  const [scannerError, setScannerError] = useState("");
  const [scannerPayloadInput, setScannerPayloadInput] = useState("");
  const [scanCandidate, setScanCandidate] = useState<BoardingPassExtraction | null>(null);
  const [lastScanApplied, setLastScanApplied] = useState<BoardingPassExtraction | null>(null);
  const [stabilityHistory, setStabilityHistory] = useState<number[]>([]);

  const longPressTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const geoWatchId = useRef<number | null>(null);
  const scannerVideoRef = useRef<HTMLVideoElement | null>(null);
  const scannerStreamRef = useRef<MediaStream | null>(null);
  const scannerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scannerBusyRef = useRef(false);
  const consentCheckboxRef = useRef<HTMLInputElement | null>(null);
  const plannerLastKnownRef = useRef<PlannerSignal | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = JSON.parse(raw) as Partial<PlansStorage>;
      if (Array.isArray(parsed.plans)) {
        const normalizedPlans = parsed.plans.map((plan) => {
          const candidate = plan as Partial<StoredPlan>;
          return {
            ...candidate,
            planDomain: candidate.planDomain ?? "",
            couplings: {
              ...INITIAL_COUPLINGS,
              ...(candidate.couplings ?? {})
            },
            contractDocuments: Array.isArray(candidate.contractDocuments)
              ? candidate.contractDocuments
              : []
          } as StoredPlan;
        });
        setPlans(normalizedPlans);
      }
      setActivePlanId(typeof parsed.activePlanId === "string" ? parsed.activePlanId : null);

      const plannerRaw = window.localStorage.getItem(PLANNER_AUTH_STORAGE_KEY);
      if (plannerRaw) {
        const plannerParsed = JSON.parse(plannerRaw) as Partial<{
          provider: PlannerProvider;
          token: string;
          iCalUrl: string;
        }>;
        if (
          plannerParsed.provider === "todoist" ||
          plannerParsed.provider === "google_tasks" ||
          plannerParsed.provider === "notion" ||
          plannerParsed.provider === "ical"
        ) {
          setPlannerProvider(plannerParsed.provider);
        }
        if (typeof plannerParsed.token === "string") {
          setPlannerToken(plannerParsed.token);
        }
        if (typeof plannerParsed.iCalUrl === "string") {
          setPlannerIcalUrl(plannerParsed.iCalUrl);
        }
      }
    } catch {
      // Ignore malformed local storage payload and continue with empty state.
    }
  }, []);

  useEffect(() => {
    try {
      const payload: PlansStorage = { plans, activePlanId };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore local storage write errors.
    }
  }, [plans, activePlanId]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        PLANNER_AUTH_STORAGE_KEY,
        JSON.stringify({
          provider: plannerProvider,
          token: plannerToken,
          iCalUrl: plannerIcalUrl
        })
      );
    } catch {
      // Ignore local storage write errors.
    }
  }, [plannerProvider, plannerToken, plannerIcalUrl]);

  const stopBoundaryScannerSession = useCallback(() => {
    if (scannerIntervalRef.current) {
      clearInterval(scannerIntervalRef.current);
      scannerIntervalRef.current = null;
    }
    if (scannerStreamRef.current) {
      for (const track of scannerStreamRef.current.getTracks()) {
        track.stop();
      }
      scannerStreamRef.current = null;
    }
    if (scannerVideoRef.current) {
      scannerVideoRef.current.srcObject = null;
    }
    scannerBusyRef.current = false;
  }, []);

  useEffect(() => {
    if (!showBoundaryScanner) {
      stopBoundaryScannerSession();
      return;
    }

    if (!consentAccepted) {
      setScannerStatus("error");
      setScannerError("Accept local processing agreement before scanning.");
      return;
    }

    if (scanCandidate) {
      stopBoundaryScannerSession();
      if (scannerStatus !== "detected") {
        setScannerStatus("detected");
      }
      return;
    }

    let cancelled = false;

    async function startScanner(): Promise<void> {
      try {
        setScannerStatus("starting");
        setScannerError("");

        if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
          setScannerStatus("error");
          setScannerError("Camera access is not supported in this browser.");
          return;
        }

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false
        });

        if (cancelled) {
          for (const track of stream.getTracks()) {
            track.stop();
          }
          return;
        }

        scannerStreamRef.current = stream;

        if (!scannerVideoRef.current) {
          setScannerStatus("error");
          setScannerError("Scanner video surface is unavailable.");
          return;
        }

        scannerVideoRef.current.srcObject = stream;
        await scannerVideoRef.current.play();

        const BarcodeDetectorCtor = (globalThis as unknown as { BarcodeDetector?: new (options?: { formats?: string[] }) => { detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue?: string }>>; }; }).BarcodeDetector;

        if (!BarcodeDetectorCtor) {
          setScannerStatus("error");
          setScannerError("Barcode detector not supported. Paste payload manually below.");
          return;
        }

        const detector = new BarcodeDetectorCtor({ formats: ["qr_code", "pdf417", "aztec"] });
        setScannerStatus("scanning");

        scannerIntervalRef.current = setInterval(async () => {
          if (!scannerVideoRef.current || scannerBusyRef.current || cancelled) {
            return;
          }
          scannerBusyRef.current = true;
          try {
            const detected = await detector.detect(scannerVideoRef.current);
            const rawValue = detected.find((entry) => typeof entry.rawValue === "string" && entry.rawValue.trim())?.rawValue?.trim();
            if (!rawValue) {
              return;
            }

            const parsed = parseBoardingPassPayload(rawValue, hardBoundary);
            setScanCandidate(parsed);
            setScannerStatus("detected");
            stopBoundaryScannerSession();
          } catch {
            // Ignore per-frame decode errors and keep scanning.
          } finally {
            scannerBusyRef.current = false;
          }
        }, 650);
      } catch {
        setScannerStatus("error");
        setScannerError("Unable to open camera. Check browser/device camera permissions.");
      }
    }

    void startScanner();

    return () => {
      cancelled = true;
      stopBoundaryScannerSession();
    };
  }, [showBoundaryScanner, consentAccepted, hardBoundary, scanCandidate, scannerStatus, stopBoundaryScannerSession]);

  useEffect(() => {
    if (!consentAccepted || !couplings.geospatial) {
      if (geoWatchId.current !== null && typeof navigator !== "undefined" && navigator.geolocation) {
        navigator.geolocation.clearWatch(geoWatchId.current);
      }
      geoWatchId.current = null;
      setGpsStatus("inactive");
      setGeoSignal(null);
      return;
    }

    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGpsStatus("unsupported");
      return;
    }

    setGpsStatus("requesting");

    geoWatchId.current = navigator.geolocation.watchPosition(
      (position) => {
        const speedMs = position.coords.speed;
        const speedKmh = typeof speedMs === "number" && Number.isFinite(speedMs) ? speedMs * 3.6 : null;
        const movement =
          speedKmh === null ? "unknown" : speedKmh >= 4 ? "moving" : "stationary";

        setGeoSignal({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: position.coords.accuracy,
          speedKmh,
          movement,
          updatedAtIso: nowIso()
        });
        setGpsStatus("granted");
      },
      (error) => {
        if (error.code === 1) {
          setGpsStatus("denied");
        } else {
          setGpsStatus("error");
        }
      },
      {
        enableHighAccuracy: true,
        maximumAge: 30000,
        timeout: 15000
      }
    );

    return () => {
      if (geoWatchId.current !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(geoWatchId.current);
      }
      geoWatchId.current = null;
    };
  }, [consentAccepted, couplings.geospatial]);

  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    async function fetchWeather() {
      if (!couplings.weather || !consentAccepted) {
        return;
      }
      if (!geoSignal) {
        setWeatherStatus("awaiting_gps");
        return;
      }

      setWeatherStatus("loading");

      try {
        const url = new URL("https://api.open-meteo.com/v1/forecast");
        url.searchParams.set("latitude", geoSignal.latitude.toFixed(6));
        url.searchParams.set("longitude", geoSignal.longitude.toFixed(6));
        url.searchParams.set("current", "temperature_2m,precipitation,weather_code,wind_speed_10m");
        url.searchParams.set("timezone", "auto");

        const response = await fetch(url.toString(), { cache: "no-store" });
        if (!response.ok) {
          throw new Error(`weather API ${response.status}`);
        }

        const payload = (await response.json()) as {
          current?: {
            temperature_2m?: number;
            precipitation?: number;
            weather_code?: number;
            wind_speed_10m?: number;
          };
        };

        const current = payload.current;
        if (!current) {
          throw new Error("weather payload missing current values");
        }

        const wind = Number.isFinite(current.wind_speed_10m) ? Number(current.wind_speed_10m) : null;
        const precipitation = Number.isFinite(current.precipitation) ? Number(current.precipitation) : null;
        const weatherCode = Number.isFinite(current.weather_code) ? Number(current.weather_code) : null;
        const temperature = Number.isFinite(current.temperature_2m) ? Number(current.temperature_2m) : null;

        const derived = deriveWeatherRisk({
          weatherCode,
          windKph: wind,
          precipitationMm: precipitation
        });

        if (!cancelled) {
          setWeatherSignal({
            temperatureC: temperature,
            windKph: wind,
            precipitationMm: precipitation,
            weatherCode,
            risk: derived.risk,
            summary: derived.summary,
            updatedAtIso: nowIso()
          });
          setWeatherStatus("ready");
        }
      } catch {
        if (!cancelled) {
          setWeatherStatus("error");
        }
      }
    }

    if (!consentAccepted || !couplings.weather) {
      setWeatherStatus("inactive");
      setWeatherSignal(null);
      return;
    }

    void fetchWeather();
    intervalId = setInterval(() => {
      void fetchWeather();
    }, 15 * 60 * 1000);

    return () => {
      cancelled = true;
      if (intervalId) {
        clearInterval(intervalId);
      }
    };
  }, [consentAccepted, couplings.weather, geoSignal]);

  const refreshPlannerSignal = useCallback(async () => {
    if (!consentAccepted || !couplings.planner) {
      setPlannerStatus("inactive");
      setPlannerWarning("");
      return;
    }

    const adapter = createPlannerAdapter({
      provider: plannerProvider,
      token: plannerToken,
      iCalUrl: plannerIcalUrl
    });

    if (!adapter) {
      setPlannerStatus("inactive");
      setPlannerWarning("Planner feed configured but not connected.");
      return;
    }

    setPlannerStatus("loading");
    setPlannerWarning("");

    try {
      const regimeForWindow = regime ?? "hard";
      const windowRange = resolveContractWindow(regimeForWindow, hardBoundary);
      const signal = await adapter.fetchSignals(windowRange.start, windowRange.end);
      setPlannerSignal(signal);
      plannerLastKnownRef.current = signal;
      setPlannerSignalWeight(1);
      setPlannerStatus("ready");
      setPlannerWarning("");
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : "Planner feed unavailable.";
      const fallbackSignal = plannerLastKnownRef.current;
      if (fallbackSignal) {
        setPlannerSignal(fallbackSignal);
        setPlannerSignalWeight((previous) => clamp(previous * 0.8, 0.2, 1));
        setPlannerStatus("error");
        setPlannerWarning(`${detail} Using last known planner signal with decayed influence.`);
      } else {
        setPlannerSignal(DEFAULT_PLANNER_SIGNAL);
        setPlannerSignalWeight(0.2);
        setPlannerStatus("error");
        setPlannerWarning(detail);
      }
    }
  }, [consentAccepted, couplings.planner, plannerProvider, plannerToken, plannerIcalUrl, regime, hardBoundary]);

  useEffect(() => {
    if (!consentAccepted || !couplings.planner) {
      setPlannerStatus("inactive");
      setPlannerWarning("");
      setPlannerSignal(null);
      setPlannerSignalWeight(1);
      return;
    }

    void refreshPlannerSignal();
    const intervalId = window.setInterval(() => {
      void refreshPlannerSignal();
    }, 5 * 60 * 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [consentAccepted, couplings.planner, refreshPlannerSignal]);

  const couplingCount = useMemo(() => countCouplings(couplings), [couplings]);
  const activeRegime = regime ?? "hard";
  const contractDocumentPolicyText = useMemo(
    () => buildContractDocumentPolicyText(contractDocuments),
    [contractDocuments]
  );
  const policySourceText = useMemo(
    () => buildPolicySourceText(planIdentifier, planDomain, softObjective, resourceConstraint, contractDocumentPolicyText),
    [planIdentifier, planDomain, softObjective, resourceConstraint, contractDocumentPolicyText]
  );
  const domainDetection = useMemo(() => classifyPlanDomain(policySourceText), [policySourceText]);
  const isBlockedPlan = Boolean(domainDetection.blockedRule);
  const flightContextDetected = useMemo(() => isLikelyFlightContext(policySourceText), [policySourceText]);
  const canScanBoardingPass = activeRegime === "hard" && flightContextDetected;
  const suggestedDocuments = useMemo(
    () =>
      inferContractDocumentSuggestions({
        regime: activeRegime,
        contextText: policySourceText,
        flightContextDetected
      }),
    [activeRegime, policySourceText, flightContextDetected]
  );
  const linkedDocumentTypes = useMemo(() => {
    const populated = contractDocuments.filter(hasDocumentSignal);
    return new Set(populated.map((document) => document.docType));
  }, [contractDocuments]);
  const pendingSuggestedDocuments = useMemo(
    () => suggestedDocuments.filter((suggestion) => !linkedDocumentTypes.has(suggestion.docType)),
    [suggestedDocuments, linkedDocumentTypes]
  );
  const documentReadiness = useMemo(
    () => deriveDocumentReadiness(contractDocuments, suggestedDocuments),
    [contractDocuments, suggestedDocuments]
  );

  const snapshot = useMemo(
    () =>
      buildSnapshot({
        regime: activeRegime,
        structuralMode,
        couplingCount,
        hardBoundary,
        nowMs,
        softObjective,
        resourceConstraint,
        geospatialEnabled: couplings.geospatial,
        gpsStatus,
        geoSignal,
        weatherEnabled: couplings.weather,
        weatherSignal,
        weatherStatus,
        plannerEnabled: couplings.planner,
        plannerSignal,
        plannerStatus,
        plannerSignalWeight,
        documentReadiness
      }),
    [
      activeRegime,
      structuralMode,
      couplingCount,
      hardBoundary,
      nowMs,
      softObjective,
      resourceConstraint,
      couplings.geospatial,
      couplings.weather,
      couplings.planner,
      gpsStatus,
      geoSignal,
      weatherSignal,
      weatherStatus,
      plannerSignal,
      plannerStatus,
      plannerSignalWeight,
      documentReadiness
    ]
  );

  useEffect(() => {
    setStabilityHistory((previous) => {
      const latest = Math.round(snapshot.overallIndex);
      if (previous.length > 0 && previous[previous.length - 1] === latest) {
        return previous;
      }
      const next = [...previous, latest];
      return next.slice(-24);
    });
  }, [snapshot.overallIndex, currentPlanId]);

  const activePlan = useMemo(() => {
    if (activePlanId) {
      const byId = plans.find((plan) => plan.id === activePlanId && plan.status === "active");
      if (byId) {
        return byId;
      }
    }
    return plans.find((plan) => plan.status === "active") ?? null;
  }, [plans, activePlanId]);

  const sortedPlans = useMemo(
    () => [...plans].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [plans]
  );

  const chatAvailable = useMemo(() => {
    if (screen !== "dashboard" || !currentPlanId) {
      return false;
    }
    const current = plans.find((item) => item.id === currentPlanId);
    return Boolean(current && current.status === "active");
  }, [screen, currentPlanId, plans]);

  const treeNodes: TreeNode[] = useMemo(() => {
    return [
      {
        id: "root",
        label: `Root Contract — ${planIdentifier.trim() || "UNASSIGNED"}`,
        stability: snapshot.stability,
        capacity: snapshot.capacityLevel,
        margin: snapshot.remainingMargin
      },
      {
        id: "boundary",
        label: "Boundary Integrity",
        stability: stabilityFromScore(snapshot.boundaryScore),
        capacity: snapshot.boundaryScore >= 60 ? "Aligned" : "Constrained",
        margin: `${Math.round(snapshot.boundaryScore)} boundary index`
      },
      {
        id: "capacity",
        label: "Capacity Regulation",
        stability: stabilityFromScore(snapshot.capacityScore),
        capacity: snapshot.capacityScore >= 60 ? "Buffered" : "Load pressure",
        margin: `${Math.round(snapshot.capacityScore)} capacity index`
      },
      {
        id: "uncertainty",
        label: "Signal Coupling",
        stability: stabilityFromScore(snapshot.uncertaintyScore),
        capacity: `${couplingCount} coupled signals`,
        margin: `${Math.round(snapshot.uncertaintyScore)} certainty index`
      }
    ];
  }, [planIdentifier, snapshot, couplingCount]);

  const hardBoundaryMinutes = useMemo(() => {
    const parsed = parseDeadline(hardBoundary);
    if (!parsed) {
      return null;
    }
    return Math.max(0, Math.floor((parsed.getTime() - nowMs) / 60000));
  }, [hardBoundary, nowMs]);

  const alertBoundaryTimestamp = useMemo(
    () => formatBoundaryTimestamp(activeRegime, hardBoundary),
    [activeRegime, hardBoundary]
  );
  const stateCriteria = useMemo(
    () =>
      describeStateCriteria({
        regime: activeRegime,
        structuralMode,
        hardBoundaryMinutes,
        couplingCount,
        geospatialEnabled: couplings.geospatial,
        gpsStatus,
        weatherEnabled: couplings.weather,
        weatherStatus,
        weatherSignal,
        plannerEnabled: couplings.planner,
        plannerStatus,
        plannerSignal,
        plannerSignalWeight,
        documentReadiness,
        snapshot
      }),
    [
      activeRegime,
      structuralMode,
      hardBoundaryMinutes,
      couplingCount,
      couplings.geospatial,
      gpsStatus,
      couplings.weather,
      weatherStatus,
      weatherSignal,
      couplings.planner,
      plannerStatus,
      plannerSignal,
      plannerSignalWeight,
      documentReadiness,
      snapshot
    ]
  );
  const stabilityTrendDelta = useMemo(() => {
    if (stabilityHistory.length < 2) {
      return 0;
    }
    return stabilityHistory[stabilityHistory.length - 1] - stabilityHistory[stabilityHistory.length - 2];
  }, [stabilityHistory]);
  const stabilityTrendLabel = useMemo(() => trendDescriptor(stabilityTrendDelta), [stabilityTrendDelta]);

  function clearLongPressTimer() {
    if (longPressTimeout.current) {
      clearTimeout(longPressTimeout.current);
      longPressTimeout.current = null;
    }
  }

  function handleStabilityBarPointerDown() {
    clearLongPressTimer();
    longPressTimeout.current = setTimeout(() => {
      setAdvancedVisible((previous) => !previous);
      longPressTimeout.current = null;
    }, 700);
  }

  function openBoundaryScanner() {
    if (!canScanBoardingPass) {
      setFormError("Boarding pass scan is unavailable until flight context is detected in the contract.");
      return;
    }
    if (!consentAccepted) {
      setFormError("Accept local processing agreement before scanning.");
      return;
    }
    setFormError("");
    setScannerPayloadInput("");
    setScannerError("");
    setScanCandidate(null);
    setScannerStatus("starting");
    setShowBoundaryScanner(true);
  }

  function closeBoundaryScanner() {
    stopBoundaryScannerSession();
    setShowBoundaryScanner(false);
    setScannerStatus("idle");
    setScannerError("");
    setScannerPayloadInput("");
    setScanCandidate(null);
  }

  function parseManualBoardingPayload() {
    const raw = scannerPayloadInput.trim();
    if (!raw) {
      setScannerError("Paste QR/barcode payload text first.");
      return;
    }
    setScannerError("");
    const parsed = parseBoardingPassPayload(raw, hardBoundary);
    setScanCandidate(parsed);
    setScannerStatus("detected");
    stopBoundaryScannerSession();
  }

  function applyScannedBoundary() {
    if (!scanCandidate) {
      return;
    }

    setRegime("hard");
    if (scanCandidate.boundaryDateTimeLocal) {
      setHardBoundary(scanCandidate.boundaryDateTimeLocal);
    }

    if (!planIdentifier.trim() && scanCandidate.flightNumber) {
      setPlanIdentifier(`Flight ${scanCandidate.flightNumber}`);
    }

    if (!resourceConstraint.trim() && scanCandidate.departureAirport && scanCandidate.arrivalAirport) {
      setResourceConstraint(`${scanCandidate.departureAirport}→${scanCandidate.arrivalAirport}`);
    }

    setContractDocuments((previous) => [
      ...previous,
      {
        id: uid(),
        docType: "boarding_pass",
        title: scanCandidate.flightNumber ? `Boarding pass ${scanCandidate.flightNumber}` : "Boarding pass",
        sourceLink: "",
        referenceCode: scanCandidate.bookingReference ?? "",
        notes: "Imported from local boarding pass scan."
      }
    ]);

    setLastScanApplied(scanCandidate);
    closeBoundaryScanner();
  }

  function addContractDocument() {
    setContractDocuments((previous) => [...previous, createEmptyContractDocument()]);
  }

  function addSuggestedDocument(suggestion: DocumentSuggestion) {
    setContractDocuments((previous) => {
      const exists = previous.some((document) => document.docType === suggestion.docType);
      if (exists) {
        return previous;
      }

      return [
        ...previous,
        {
          id: uid(),
          docType: suggestion.docType,
          title: suggestion.title,
          sourceLink: "",
          referenceCode: "",
          notes: `Suggested for contract coherence: ${suggestion.reason}`
        }
      ];
    });
  }

  function addAllSuggestedDocuments() {
    if (pendingSuggestedDocuments.length === 0) {
      return;
    }

    setContractDocuments((previous) => {
      const existingTypes = new Set(previous.map((document) => document.docType));
      const additions = pendingSuggestedDocuments
        .filter((suggestion) => !existingTypes.has(suggestion.docType))
        .map<ContractDocument>((suggestion) => ({
          id: uid(),
          docType: suggestion.docType,
          title: suggestion.title,
          sourceLink: "",
          referenceCode: "",
          notes: `Suggested for contract coherence: ${suggestion.reason}`
        }));

      if (additions.length === 0) {
        return previous;
      }
      return [...previous, ...additions];
    });
  }

  function updateContractDocument(docId: string, patch: Partial<Omit<ContractDocument, "id">>) {
    setContractDocuments((previous) =>
      previous.map((document) => (document.id === docId ? { ...document, ...patch } : document))
    );
  }

  function removeContractDocument(docId: string) {
    setContractDocuments((previous) => previous.filter((document) => document.id !== docId));
  }

  function buildCurrentPlanRecord(nextStatus: PlanStatus, forceId?: string): StoredPlan {
    const createdAt = nowIso();
    const planId = forceId ?? currentPlanId ?? uid();
    const previous = plans.find((item) => item.id === planId);

    return {
      id: planId,
      planIdentifier: planIdentifier.trim() || "UNASSIGNED",
      planDomain: planDomain.trim(),
      contractDocuments: contractDocuments.map((document) => ({ ...document })),
      regime: activeRegime,
      structuralMode,
      hardBoundary,
      softObjective,
      resourceConstraint,
      couplings: { ...couplings },
      status: nextStatus,
      createdAt: previous?.createdAt ?? createdAt,
      updatedAt: createdAt,
      checkCount,
      violationStreak,
      lastSnapshot: {
        stability: snapshot.stability,
        intervention: snapshot.intervention,
        remainingMargin: snapshot.remainingMargin
      }
    };
  }

  function loadPlan(record: StoredPlan, destination: Screen) {
    setCurrentPlanId(record.id);
    setRegime(record.regime);
    setPlanIdentifier(record.planIdentifier);
    setPlanDomain(record.planDomain ?? "");
    setContractDocuments(Array.isArray(record.contractDocuments) ? record.contractDocuments : []);
    setHardBoundary(record.hardBoundary);
    setSoftObjective(record.softObjective);
    setResourceConstraint(record.resourceConstraint);
    setStructuralMode(record.structuralMode);
    setCouplings({ ...INITIAL_COUPLINGS, ...record.couplings });
    setCheckCount(record.checkCount);
    setViolationStreak(record.violationStreak);
    setShowInterventionModal(false);
    setAdvancedVisible(false);
    setFormError("");
    setStabilityHistory([]);
    setScreen(destination);
  }

  function finalizeActivation(planToActivate: StoredPlan, pauseCurrent: boolean) {
    setPlans((previous) => {
      let next = [...previous];

      if (pauseCurrent) {
        next = next.map((plan) =>
          plan.status === "active" && plan.id !== planToActivate.id
            ? { ...plan, status: "paused", updatedAt: nowIso() }
            : plan
        );
      }

      const existingIndex = next.findIndex((plan) => plan.id === planToActivate.id);
      if (existingIndex === -1) {
        next.unshift(planToActivate);
      } else {
        next[existingIndex] = {
          ...next[existingIndex],
          ...planToActivate,
          status: "active",
          updatedAt: nowIso()
        };
      }

      return next.map((plan) =>
        plan.id !== planToActivate.id && plan.status === "active" ? { ...plan, status: "paused" } : plan
      );
    });

    setCurrentPlanId(planToActivate.id);
    setActivePlanId(planToActivate.id);
    setShowInterventionModal(false);
    setAdvancedVisible(false);
    setCheckCount(planToActivate.checkCount);
    setViolationStreak(planToActivate.violationStreak);
    setCheckFeedback("");
    setStabilityHistory([]);
    setScreen("dashboard");
    setFormError("");
  }

  function initializeEngine() {
    if (!consentAccepted) {
      setFormError("Accept local processing agreement before initialization.");
      return;
    }
    setEnginePowering(true);
    setFormError("");
    window.setTimeout(() => {
      setScreen("regime");
      setEnginePowering(false);
    }, 540);
  }

  function goToConfiguration() {
    if (!regime) {
      setFormError("Select a contract regime to continue.");
      return;
    }
    setFormError("");
    setScreen("configuration");
  }

  function goToCoupling() {
    if (!planIdentifier.trim()) {
      setFormError("Plan Identifier is required.");
      return;
    }

    if (!regime) {
      setFormError("Contract regime is required.");
      return;
    }

    if (regime === "hard" && !parseDeadline(hardBoundary)) {
      setFormError("Date / Time boundary is required for HARD regime.");
      return;
    }

    if (regime === "soft" && !softObjective.trim()) {
      setFormError("Target objective descriptor is required for SOFT regime.");
      return;
    }

    if (regime === "resource" && !resourceConstraint.trim()) {
      setFormError("Primary resource constraint is required for RESOURCE regime.");
      return;
    }

    if (isBlockedPlan && domainDetection.blockedRule) {
      setFormError("Plan blocked by policy screening. Revise the contract text and try again.");
      return;
    }

    setFormError("");
    setScreen("coupling");
  }

  function activateContract() {
    if (!regime) {
      setFormError("Contract regime is required.");
      return;
    }

    if (isBlockedPlan && domainDetection.blockedRule) {
      setScreen("configuration");
      setFormError("Plan blocked by policy screening. Revise the contract text and try again.");
      return;
    }

    const candidate = buildCurrentPlanRecord("active");
    const conflictingActive = plans.find((plan) => plan.status === "active" && plan.id !== candidate.id) ?? null;

    if (conflictingActive) {
      setActivationConflict({ currentActive: conflictingActive, incoming: candidate });
      return;
    }

    setCheckCount(0);
    setViolationStreak(0);
    finalizeActivation({ ...candidate, checkCount: 0, violationStreak: 0 }, false);
  }

  function persistCurrentPlanSnapshot(nextCheckCount: number, nextViolationStreak: number) {
    if (!currentPlanId) {
      return;
    }

    setPlans((previous) =>
      previous.map((plan) => {
        if (plan.id !== currentPlanId) {
          return plan;
        }

        return {
          ...plan,
          planIdentifier: planIdentifier.trim() || "UNASSIGNED",
          planDomain: planDomain.trim(),
          contractDocuments: contractDocuments.map((document) => ({ ...document })),
          regime: activeRegime,
          structuralMode,
          hardBoundary,
          softObjective,
          resourceConstraint,
          couplings: { ...couplings },
          checkCount: nextCheckCount,
          violationStreak: nextViolationStreak,
          updatedAt: nowIso(),
          lastSnapshot: {
            stability: snapshot.stability,
            intervention: snapshot.intervention,
            remainingMargin: snapshot.remainingMargin
          }
        };
      })
    );
  }

  function runDeterministicCheck() {
    const violation = snapshot.intervention !== "CONTINUE";
    const nextCheckCount = checkCount + 1;
    const nextViolationStreak = violation ? violationStreak + 1 : 0;

    setCheckCount(nextCheckCount);
    setViolationStreak(nextViolationStreak);

    if (violation && nextViolationStreak >= 2) {
      setShowInterventionModal(true);
    }

    setCheckFeedback(
      violation
        ? `Deterministic check #${nextCheckCount} complete. State: ${snapshot.intervention}. Criteria: ${stateCriteria[0] ?? "Structural pressure detected."} Persistence streak: ${nextViolationStreak}.`
        : `Deterministic check #${nextCheckCount} complete. State remains CONTINUE. Criteria: ${stateCriteria[0] ?? "No elevated structural pressure detected."}`
    );

    persistCurrentPlanSnapshot(nextCheckCount, nextViolationStreak);
  }

  function applyInterventionChoice() {
    const nextCheckCount = checkCount + 1;
    setShowInterventionModal(false);
    setViolationStreak(0);
    setCheckCount(nextCheckCount);
    setCheckFeedback(`Intervention acknowledged. Check counter updated to ${nextCheckCount}.`);
    persistCurrentPlanSnapshot(nextCheckCount, 0);
  }

  function activateStoredPlan(plan: StoredPlan) {
    const storedDetection = classifyPlanDomain(
      buildPolicySourceText(
        plan.planIdentifier,
        plan.planDomain ?? "",
        plan.softObjective,
        plan.resourceConstraint,
        buildContractDocumentPolicyText(plan.contractDocuments ?? [])
      )
    );
    if (storedDetection.blockedRule) {
      setShowPlans(false);
      loadPlan({ ...plan, status: "paused" }, "configuration");
      setFormError("Stored plan blocked by policy screening. Revise the contract text before activation.");
      return;
    }

    const refreshedSnapshot = refreshSnapshotForPlan(plan, nowMs);
    const candidate: StoredPlan = {
      ...plan,
      status: "active",
      updatedAt: nowIso(),
      lastSnapshot: {
        stability: refreshedSnapshot.stability,
        intervention: refreshedSnapshot.intervention,
        remainingMargin: refreshedSnapshot.remainingMargin
      }
    };

    const conflictingActive = plans.find((item) => item.status === "active" && item.id !== plan.id) ?? null;

    if (conflictingActive) {
      setActivationConflict({ currentActive: conflictingActive, incoming: candidate });
      return;
    }

    loadPlan(candidate, "dashboard");
    finalizeActivation(candidate, false);
    setShowPlans(false);
  }

  function setPlanStatus(planId: string, status: PlanStatus) {
    setPlans((previous) =>
      previous.map((plan) =>
        plan.id === planId
          ? {
              ...plan,
              status,
              updatedAt: nowIso()
            }
          : plan
      )
    );

    if (status !== "active" && activePlanId === planId) {
      setActivePlanId(null);
      if (currentPlanId === planId && screen === "dashboard") {
        setScreen("activation");
        setCurrentPlanId(null);
        setShowInterventionModal(false);
      }
    }
  }

  function openActiveDashboard() {
    if (!activePlan) {
      return;
    }
    loadPlan(activePlan, "dashboard");
    setShowPlans(false);
  }

  function loadStoredPlanForEditing(plan: StoredPlan) {
    const destination: Screen = plan.status === "active" ? "dashboard" : "configuration";
    loadPlan(plan, destination);
    setShowPlans(false);
  }

  function resetNode() {
    stopBoundaryScannerSession();
    setScreen("activation");
    setRegime(null);
    setPlanIdentifier("");
    setPlanDomain("");
    setContractDocuments([]);
    setHardBoundary(defaultHardBoundary());
    setSoftObjective("");
    setResourceConstraint("");
    setStructuralMode("automatic");
    setCouplings(INITIAL_COUPLINGS);
    setPlannerStatus("inactive");
    setPlannerSignal(null);
    setPlannerSignalWeight(1);
    setPlannerWarning("");
    setCurrentPlanId(null);
    setEnginePowering(false);
    setFormError("");
    setCheckFeedback("");
    setCheckCount(0);
    setViolationStreak(0);
    setShowInterventionModal(false);
    setAdvancedVisible(false);
    setActivationConflict(null);
    setAssistantInput("");
    setAssistantMessages([message("assistant", ASSISTANT_INTRO)]);
    setAssistantMeta("");
    setAssistantBusy(false);
    setShowBoundaryScanner(false);
    setScannerStatus("idle");
    setScannerError("");
    setScannerPayloadInput("");
    setScanCandidate(null);
    setLastScanApplied(null);
    setStabilityHistory([]);
  }

  function toggleCoupling(key: CouplingKey) {
    if (!DEMO_COUPLINGS.includes(key)) {
      return;
    }
    setCouplings((previous) => ({ ...previous, [key]: !previous[key] }));
  }

  async function askVoiceLayer(event: FormEvent) {
    event.preventDefault();

    const trimmed = assistantInput.trim();
    if (!trimmed || !chatAvailable) {
      return;
    }

    setAssistantInput("");
    setAssistantMessages((previous) => [...previous, message("user", trimmed)]);
    setAssistantBusy(true);

    try {
      const prompt = buildAssistantPrompt({
        userInput: trimmed,
        planIdentifier,
        planDomain,
        regime: activeRegime,
        structuralMode,
        snapshot,
        stateCriteria,
        plannerStatus,
        plannerSignal,
        gpsStatus,
        weatherStatus,
        weatherSignal
      });

      const response = await requestAssistantFromCore(prompt);
      const reply = (response.reply || "").trim();
      if (!reply) {
        throw new Error("Assistant returned empty response.");
      }

      setAssistantMeta(
        `${response.provider || "core"} · ${response.model || "unknown"} · tactical · short`
      );
      setAssistantMessages((previous) => [...previous, message("assistant", reply)]);
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : "Unknown assistant error.";
      const fallbackReply = buildLocalVoiceFallback({
        userInput: trimmed,
        snapshot,
        stateCriteria,
        plannerStatus,
        plannerSignal,
        gpsStatus,
        weatherStatus,
        weatherSignal
      });
      setAssistantMessages((previous) => [
        ...previous,
        message("assistant", fallbackReply)
      ]);
      setAssistantMeta(`local fallback · ${detail}`);
    } finally {
      setAssistantBusy(false);
    }
  }

  const stageLabel = useMemo(() => {
    if (screen === "activation") {
      return "SCREEN 1 / LOCAL GOVERNANCE ACTIVATION";
    }
    if (screen === "regime") {
      return "SCREEN 2 / CONTRACT REGIME SELECTION";
    }
    if (screen === "configuration") {
      return "SCREEN 3 / ROOT CONTRACT CONFIGURATION";
    }
    if (screen === "coupling") {
      return "SCREEN 4 / ENVIRONMENTAL COUPLING";
    }
    return "MAIN EXECUTION DASHBOARD";
  }, [screen]);

  const interventionOptions = interventionChoices(activeRegime);

  const geospatialCard = COUPLING_ITEMS.find((item) => item.key === "geospatial");
  const weatherCard = COUPLING_ITEMS.find((item) => item.key === "weather");
  const plannerCard = COUPLING_ITEMS.find((item) => item.key === "planner");
  const plannerConfigReady = plannerProvider === "ical" ? Boolean(plannerIcalUrl.trim()) : Boolean(plannerToken.trim());

  return (
    <main className="nodeApp">
      <div className="gridSheen" />

      <div className="shell">
        <header className="topBar">
          <div className="brandBlock">
            <Image src="/triaia-logo.png" alt="Triaia logo" width={74} height={74} className="brandLogo" priority />
            <div>
              <p className="brandName">TRIAIA</p>
              <h1>trajectory-based hierarchical planning system</h1>
              <p className="brandSubline">planner observer mode · deterministic stability layer</p>
              <p className="stageLabel">{stageLabel}</p>
              {activePlan ? <p className="activePlanHint">Active Plan: {activePlan.planIdentifier}</p> : null}
            </div>
          </div>

          <div className="topActions">
            <button type="button" className="secondaryAction" onClick={() => setShowPlans(true)}>
              My Plans
            </button>
            <button type="button" className="secondaryAction" onClick={() => setShowInfo(true)}>
              Info
            </button>
            <a href="mailto:contact@triaia.com" className="contactAction">
              contact@triaia.com
            </a>
          </div>
        </header>

        {screen === "activation" ? (
          <section className="panel">
            <header className="panelHeader">
              <h2>TRIAIA — LOCAL NODE ACTIVE</h2>
            </header>

            <p>This instance of Triaia operates as a deterministic trajectory stabilizer.</p>
            <ul className="copyList">
              <li>All external signals are processed locally.</li>
              <li>No trajectory data is transmitted or stored remotely.</li>
              <li>Contracts remain under your control.</li>
            </ul>
            <p>Triaia does not predict outcomes.</p>
            <p>It preserves structural coherence under constraint.</p>

            <div className="activationRow">
              <button
                type="button"
                className={`primaryAction initAction ${enginePowering ? "active" : ""}`}
                onClick={initializeEngine}
                disabled={enginePowering}
              >
                {enginePowering ? "Initializing..." : "Initialize Engine"}
              </button>
            </div>

            {formError ? <p className="errorText">{formError}</p> : null}
            <footer className="localIndicator">{LOCAL_NODE_INDICATOR}</footer>
          </section>
        ) : null}

        {screen === "regime" ? (
          <section className="panel">
            <header className="panelHeader">
              <h2>Select Contract Type</h2>
            </header>

            <div className="regimeGrid" role="radiogroup" aria-label="Contract type cards">
              {(Object.keys(REGIME_DETAILS) as Regime[]).map((key) => {
                const details = REGIME_DETAILS[key];
                const selected = regime === key;
                return (
                  <button
                    key={key}
                    type="button"
                    className={`regimeCard ${selected ? "selected" : ""}`}
                    onClick={() => setRegime(key)}
                    aria-pressed={selected}
                  >
                    <h3>{details.title}</h3>
                    <p>{details.summary}</p>
                    <p className="examplesLabel">Examples:</p>
                    <ul>
                      {details.examples.map((example) => (
                        <li key={example}>{example}</li>
                      ))}
                    </ul>
                  </button>
                );
              })}
            </div>

            <p className="technicalNote">
              Selecting a regime defines threshold logic, intervention behavior, and persistence calibration. This is
              foundational.
            </p>

            <div className="actionRow">
              <button type="button" className="secondaryAction" onClick={() => setScreen("activation")}>
                Back
              </button>
              <button type="button" className="primaryAction" onClick={goToConfiguration}>
                Continue
              </button>
            </div>

            {formError ? <p className="errorText">{formError}</p> : null}
          </section>
        ) : null}

        {screen === "configuration" ? (
          <section className="panel">
            <header className="panelHeader">
              <h2>ROOT CONTRACT CONFIGURATION</h2>
            </header>

            <div className="configGrid">
              <section className="subPanel">
                <h3>Plan Identity</h3>
                <label>
                  Plan Identifier
                  <input
                    type="text"
                    value={planIdentifier}
                    onChange={(event) => setPlanIdentifier(event.target.value)}
                    placeholder="TRIAIA-CONTRACT-001"
                  />
                </label>
                <label>
                  Domain (enter if applicable)
                  <input
                    type="text"
                    value={planDomain}
                    onChange={(event) => setPlanDomain(event.target.value)}
                    placeholder="Trip to SF convention - gaming"
                  />
                </label>
                <p className="technicalNote domainPolicyNote">
                  Policy screening is active and enforced automatically. Detection is local and keyword-based; Triaia does
                  not inspect physical shipment contents or external world state by itself.
                </p>
              </section>

              <section className="subPanel">
                <h3>Primary Boundary</h3>
                <div className="boundaryImportRow">
                  <button type="button" className="secondaryAction" onClick={() => setFormError("")}>
                    Enter Manually
                  </button>
                  {canScanBoardingPass ? (
                    <button type="button" className="primaryAction" onClick={openBoundaryScanner}>
                      Scan Boarding Pass QR (Optional)
                    </button>
                  ) : null}
                </div>
                {canScanBoardingPass ? (
                  <p className="technicalNote boundaryNote">Extracts departure fields locally. No image stored.</p>
                ) : null}

                {lastScanApplied ? (
                  <div className="scanSummary">
                    <p>
                      Imported boundary ({lastScanApplied.sourceFormat.toUpperCase()}):{" "}
                      {lastScanApplied.flightNumber || "Flight unknown"}
                    </p>
                    <p>
                      {lastScanApplied.departureAirport || "---"} → {lastScanApplied.arrivalAirport || "---"} ·{" "}
                      {lastScanApplied.boundaryDateTimeLocal || "Manual time required"}
                    </p>
                    {lastScanApplied.suggestedArrivalByLocal ? (
                      <p>Suggested sub-contract: Arrive at airport by {lastScanApplied.suggestedArrivalByLocal}</p>
                    ) : null}
                  </div>
                ) : null}

                {regime === "hard" ? (
                  <label>
                    Date / Time selector
                    <input
                      type="datetime-local"
                      value={hardBoundary}
                      onChange={(event) => setHardBoundary(event.target.value)}
                    />
                  </label>
                ) : null}

                {regime === "soft" ? (
                  <label>
                    Target objective descriptor
                    <input
                      type="text"
                      value={softObjective}
                      onChange={(event) => setSoftObjective(event.target.value)}
                      placeholder="Deliver module readiness"
                    />
                  </label>
                ) : null}

                {regime === "resource" ? (
                  <label>
                    Primary resource constraint field
                    <input
                      type="text"
                      value={resourceConstraint}
                      onChange={(event) => setResourceConstraint(event.target.value)}
                      placeholder="Fuel margin threshold"
                    />
                  </label>
                ) : null}
              </section>

              <section className="subPanel">
                <h3>Structural Mode</h3>
                <div className="modeGrid">
                  <label className={`modeCard ${structuralMode === "automatic" ? "selected" : ""}`}>
                    <input
                      type="radio"
                      name="structuralMode"
                      checked={structuralMode === "automatic"}
                      onChange={() => setStructuralMode("automatic")}
                    />
                    <span className="modeTitle">Automatic</span>
                    <span>Engine executes deterministic intervention logic.</span>
                  </label>

                  <label className={`modeCard ${structuralMode === "manual" ? "selected" : ""}`}>
                    <input
                      type="radio"
                      name="structuralMode"
                      checked={structuralMode === "manual"}
                      onChange={() => setStructuralMode("manual")}
                    />
                    <span className="modeTitle">Manual</span>
                    <span>Engine signals instability; user confirms action.</span>
                  </label>
                </div>
              </section>

              <section className="subPanel">
                <h3>Contract Documents</h3>
                <p className="technicalNote">
                  Link contract-level references you have along the way (local metadata only).
                </p>
                {suggestedDocuments.length > 0 ? (
                  <section className="suggestedDocsPanel">
                    <div className="suggestedDocsHead">
                      <p className="technicalNote">
                        Proposed linked documents are inferred from the current contract context.
                      </p>
                      {pendingSuggestedDocuments.length > 1 ? (
                        <button type="button" className="secondaryAction" onClick={addAllSuggestedDocuments}>
                          + Add All Suggested
                        </button>
                      ) : null}
                    </div>
                    <div className="suggestedDocsList">
                      {suggestedDocuments.map((suggestion) => {
                        const linked = linkedDocumentTypes.has(suggestion.docType);
                        return (
                          <article
                            key={suggestion.docType}
                            className={`suggestedDocCard ${linked ? "linked" : ""}`}
                          >
                            <div>
                              <p className="suggestedDocTitle">
                                {contractDocumentTypeLabel(suggestion.docType)}
                                {suggestion.required ? <span className="suggestedDocTag">Key</span> : null}
                              </p>
                              <p className="technicalNote">{suggestion.reason}</p>
                            </div>
                            {linked ? (
                              <span className="signalChip good">Linked</span>
                            ) : (
                              <button
                                type="button"
                                className="secondaryAction"
                                onClick={() => addSuggestedDocument(suggestion)}
                              >
                                Add
                              </button>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  </section>
                ) : null}

                <p className="technicalNote">
                  Evidence readiness: {documentReadiness.label}
                  {documentReadiness.expectedCount > 0
                    ? ` (${documentReadiness.linkedExpectedCount}/${documentReadiness.expectedCount} key documents linked).`
                    : "."}
                </p>
                {documentReadiness.missingTypes.length > 0 ? (
                  <p className="technicalNote">
                    Missing key evidence:{" "}
                    {documentReadiness.missingTypes
                      .map((docType) => contractDocumentTypeLabel(docType))
                      .join(", ")}
                  </p>
                ) : null}

                {contractDocuments.length === 0 ? (
                  <p className="technicalNote">No contract documents linked yet.</p>
                ) : (
                  <div className="documentList">
                    {contractDocuments.map((document) => (
                      <article key={document.id} className="documentCard">
                        <label>
                          Document type
                          <select
                            value={document.docType}
                            onChange={(event) =>
                              updateContractDocument(document.id, {
                                docType: event.target.value as ContractDocumentType
                              })
                            }
                          >
                            {CONTRACT_DOCUMENT_TYPE_OPTIONS.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Title
                          <input
                            type="text"
                            value={document.title}
                            onChange={(event) =>
                              updateContractDocument(document.id, {
                                title: event.target.value
                              })
                            }
                            placeholder="Booked hotel near convention center"
                          />
                        </label>
                        <label>
                          Link / Source (optional)
                          <input
                            type="text"
                            value={document.sourceLink}
                            onChange={(event) =>
                              updateContractDocument(document.id, {
                                sourceLink: event.target.value
                              })
                            }
                            placeholder="https://..., email subject, or booking portal reference"
                          />
                        </label>
                        <label>
                          Reference code (optional)
                          <input
                            type="text"
                            value={document.referenceCode}
                            onChange={(event) =>
                              updateContractDocument(document.id, {
                                referenceCode: event.target.value
                              })
                            }
                            placeholder="ABC123 / meeting ID / reservation number"
                          />
                        </label>
                        <label>
                          Notes (optional)
                          <textarea
                            rows={2}
                            value={document.notes}
                            onChange={(event) =>
                              updateContractDocument(document.id, {
                                notes: event.target.value
                              })
                            }
                            placeholder="Any contract-relevant detail."
                          />
                        </label>
                        <div className="actionRow">
                          <button
                            type="button"
                            className="secondaryAction"
                            onClick={() => removeContractDocument(document.id)}
                          >
                            Remove Document
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
                <button type="button" className="secondaryAction" onClick={addContractDocument}>
                  + Add Document
                </button>
              </section>
            </div>

            <p className="technicalNote">
              Stability transitions require sustained threshold violation. Persistence gating prevents oscillatory
              intervention.
            </p>

            <div className="actionRow">
              <button type="button" className="secondaryAction" onClick={() => setScreen("regime")}>
                Back
              </button>
              <button type="button" className="primaryAction" onClick={goToCoupling}>
                Continue
              </button>
            </div>

            {formError ? <p className="errorText">{formError}</p> : null}
          </section>
        ) : null}

        {screen === "coupling" ? (
          <section className="panel">
            <header className="panelHeader">
              <div>
                <h2>EXTERNAL CONSTRAINT SIGNALS</h2>
                <p>
                  Optional signal coupling enhances stability modeling under real-world load. Signals influence alignment,
                  capacity, margin, or uncertainty. They do not modify contracts.
                </p>
              </div>
            </header>

            <section className="subPanel">
              <h3>DEMO ACTIVE COUPLINGS</h3>
              <div className="demoCouplingGrid">
                {geospatialCard ? (
                  <label className="toggleCard liveDemoCard">
                    <div className="toggleHead">
                      <input
                        type="checkbox"
                        checked={couplings.geospatial}
                        onChange={() => toggleCoupling("geospatial")}
                      />
                      <span>{geospatialCard.label}</span>
                    </div>
                    {geospatialCard.source ? <small>Source: {geospatialCard.source}</small> : null}
                    <small>Purpose: {geospatialCard.purpose}</small>
                    <small className="signalLiveStatus">Status: {gpsStatusLabel(gpsStatus)}</small>
                    {geoSignal ? (
                      <small className="signalLiveDetail">
                        Accuracy: {Math.round(geoSignal.accuracyMeters)}m · Movement: {geoSignal.movement}
                      </small>
                    ) : null}
                    <small className="localProcessing">Processed locally. Not stored remotely. Does not alter contract logic.</small>
                  </label>
                ) : null}

                {weatherCard ? (
                  <label className="toggleCard liveDemoCard">
                    <div className="toggleHead">
                      <input
                        type="checkbox"
                        checked={couplings.weather}
                        onChange={() => toggleCoupling("weather")}
                        disabled={!couplings.geospatial}
                      />
                      <span>{weatherCard.label}</span>
                    </div>
                    <small>Purpose: {weatherCard.purpose}</small>
                    <small className="signalLiveStatus">Status: {weatherStatusLabel(weatherStatus)}</small>
                    {weatherSignal ? (
                      <small className="signalLiveDetail">
                        {weatherSignal.summary} · {weatherSignal.temperatureC ?? "--"}°C · wind {weatherSignal.windKph ?? "--"}
                        km/h
                      </small>
                    ) : null}
                    <small className="localProcessing">Processed locally. Not stored remotely. Does not alter contract logic.</small>
                  </label>
                ) : null}

                {plannerCard ? (
                  <article className="toggleCard liveDemoCard plannerTelemetryCard">
                    <div className="toggleHead">
                      <input
                        type="checkbox"
                        checked={couplings.planner}
                        onChange={() => toggleCoupling("planner")}
                      />
                      <span>{plannerCard.label}</span>
                    </div>
                    <small>Supported: Todoist, Google Tasks, iCal, Notion</small>
                    <small>
                      Reads structural task telemetry only. No task creation or edits. Processed locally.
                    </small>
                    <small className="signalLiveStatus">Status: {plannerStatusLabel(plannerStatus)}</small>
                    {plannerSignal ? (
                      <small className="signalLiveDetail">
                        Total: {plannerSignal.totalTasks} · Completed: {plannerSignal.completedTasks} · Overdue:{" "}
                        {plannerSignal.overdueTasks} · Next24h: {plannerSignal.dueNext24h}
                      </small>
                    ) : null}
                    {plannerWarning ? <small className="errorText">{plannerWarning}</small> : null}

                    {couplings.planner ? (
                      <div className="plannerConfigPanel">
                        <label>
                          Provider
                          <select
                            value={plannerProvider}
                            onChange={(event) => setPlannerProvider(event.target.value as PlannerProvider)}
                          >
                            <option value="ical">iCal (local feed)</option>
                            <option value="todoist">Todoist</option>
                            <option value="google_tasks">Google Tasks</option>
                            <option value="notion">Notion</option>
                          </select>
                        </label>

                        {plannerProvider === "ical" ? (
                          <label>
                            iCal URL (read-only)
                            <input
                              type="url"
                              value={plannerIcalUrl}
                              onChange={(event) => setPlannerIcalUrl(event.target.value)}
                              placeholder="https://.../calendar.ics"
                            />
                          </label>
                        ) : (
                          <label>
                            Read-only token
                            <input
                              type="password"
                              value={plannerToken}
                              onChange={(event) => setPlannerToken(event.target.value)}
                              placeholder="Stored locally only"
                              autoComplete="off"
                            />
                          </label>
                        )}

                        <p className="technicalNote">{PLANNER_SCOPE_HINTS[plannerProvider]}</p>
                        <button
                          type="button"
                          className="secondaryAction"
                          disabled={!plannerConfigReady || plannerStatus === "loading"}
                          onClick={() => {
                            void refreshPlannerSignal();
                          }}
                        >
                          {plannerStatus === "loading" ? "Refreshing..." : "Refresh Planner Signal"}
                        </button>
                      </div>
                    ) : null}

                    <small className="localProcessing">
                      Local token only. No cloud proxy. Read-only telemetry path.
                    </small>
                  </article>
                ) : null}
              </div>
              <p className="technicalNote">
                Weather coupling requires geospatial feed in demo mode. Planner feed is observer-only and cannot edit
                external tasks.
              </p>
            </section>

            <section className="subPanel comingSoonSection">
              <h3>COUPLING ROADMAP (COMING SOON)</h3>
              <p className="technicalNote">
                All items below remain inactive in this demo build and are displayed as planned integration modules.
              </p>

              {COMING_SOON_GROUPS.map((group) => (
                <article key={group.title} className="comingSoonGroup">
                  <h4>{group.title}</h4>
                  <div className="comingSoonGrid">
                    {group.items.map((item) => (
                      <div key={item.title} className="comingSoonCard">
                        <p className="comingSoonBadge">COMING SOON</p>
                        <strong>{item.title}</strong>
                        <p>Examples: {item.examples.join(", ")}</p>
                        <p>Signal Type: {item.signalType}</p>
                        <p>Affects: {item.affects}</p>
                        <p>Best For: {item.bestFor}</p>
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </section>

            <div className="actionRow">
              <button type="button" className="secondaryAction" onClick={() => setScreen("configuration")}>
                Back
              </button>
              <button type="button" className="primaryAction" onClick={activateContract}>
                Activate Contract
              </button>
            </div>
          </section>
        ) : null}

        {screen === "dashboard" ? (
          <section className="panel dashboardPanel">
            <header className="panelHeader dashboardHeader">
              <div>
                <h2>MAIN EXECUTION DASHBOARD</h2>
                <p>
                  Contract: <strong>{planIdentifier || "UNASSIGNED"}</strong> · Regime: <strong>{snapshot.regimeClassification}</strong>{" "}
                  · Mode: <strong>{structuralMode.toUpperCase()}</strong>
                </p>
              </div>

              <div className="actionRow compact">
                <button type="button" className="primaryAction" onClick={runDeterministicCheck}>
                  Run Deterministic Check
                </button>
                <button type="button" className="secondaryAction" onClick={() => setScreen("coupling")}>
                  Edit Coupling
                </button>
                <button type="button" className="secondaryAction" onClick={resetNode}>
                  Reset Node
                </button>
              </div>
            </header>

            {checkFeedback ? <p className="technicalNote checkFeedback">{checkFeedback}</p> : null}

            {violationStreak > 0 && snapshot.intervention !== "CONTINUE" ? (
              <div className={`alertBanner ${snapshot.stability}`}>
                <strong>⚠ {activeRegime.toUpperCase()} REGIME INSTABILITY</strong>
                <span>Plan: {planIdentifier || "UNASSIGNED"}</span>
                <span>Boundary: {alertBoundaryTimestamp}</span>
              </div>
            ) : null}

            <div className="dashboardGrid">
              <article className="subPanel">
                <h3>Contract Hierarchy Tree</h3>
                <ul className="treeList">
                  {treeNodes.map((node, index) => (
                    <li key={node.id} className={`treeNode ${index === 0 ? "rootNode" : "childNode"}`}>
                      <div className="treeMain">
                        <span className={`stateDot ${node.stability}`} />
                        <strong>{node.label}</strong>
                      </div>
                      <div className="treeMeta">
                        <span>Capacity: {node.capacity}</span>
                        <span>Boundary margin: {node.margin}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </article>

              <article className="subPanel">
                <h3>Current Structural Snapshot</h3>
                <dl className="snapshotGrid">
                  <div>
                    <dt>Remaining margin</dt>
                    <dd>{snapshot.remainingMargin}</dd>
                  </div>
                  <div>
                    <dt>Capacity level</dt>
                    <dd>{snapshot.capacityLevel}</dd>
                  </div>
                  <div>
                    <dt>Uncertainty envelope</dt>
                    <dd>{snapshot.uncertaintyEnvelope}</dd>
                  </div>
                  <div>
                    <dt>Regime classification</dt>
                    <dd>{snapshot.regimeClassification}</dd>
                  </div>
                </dl>

                <section className="liveChannelsPanel">
                  <div className="liveChannelsHead">
                    <h4>Live Stability Channels</h4>
                    <span className={`signalChip ${snapshot.stability === "stable" ? "good" : snapshot.stability === "critical" ? "bad" : "neutral"}`}>
                      {Math.round(snapshot.overallIndex)} · {stabilityTrendLabel}
                    </span>
                  </div>

                  <div className="channelMetric">
                    <div className="channelMetricHead">
                      <span>Trajectory Stability</span>
                      <strong>{Math.round(snapshot.overallIndex)}</strong>
                    </div>
                    <div className="channelTrack" aria-hidden="true">
                      <div className={`channelFill ${snapshot.stability}`} style={{ width: `${Math.round(snapshot.overallIndex)}%` }} />
                    </div>
                  </div>

                  <div className="channelMetric">
                    <div className="channelMetricHead">
                      <span>Boundary Integrity</span>
                      <strong>{Math.round(snapshot.boundaryScore)}</strong>
                    </div>
                    <div className="channelTrack" aria-hidden="true">
                      <div
                        className={`channelFill ${stabilityFromScore(snapshot.boundaryScore)}`}
                        style={{ width: `${Math.round(snapshot.boundaryScore)}%` }}
                      />
                    </div>
                  </div>

                  <div className="channelMetric">
                    <div className="channelMetricHead">
                      <span>Capacity Regulation</span>
                      <strong>{Math.round(snapshot.capacityScore)}</strong>
                    </div>
                    <div className="channelTrack" aria-hidden="true">
                      <div
                        className={`channelFill ${stabilityFromScore(snapshot.capacityScore)}`}
                        style={{ width: `${Math.round(snapshot.capacityScore)}%` }}
                      />
                    </div>
                  </div>

                  <div className="channelMetric">
                    <div className="channelMetricHead">
                      <span>Uncertainty Control</span>
                      <strong>{Math.round(snapshot.uncertaintyScore)}</strong>
                    </div>
                    <div className="channelTrack" aria-hidden="true">
                      <div
                        className={`channelFill ${stabilityFromScore(snapshot.uncertaintyScore)}`}
                        style={{ width: `${Math.round(snapshot.uncertaintyScore)}%` }}
                      />
                    </div>
                  </div>

                  <div className="microTrend" role="img" aria-label="Recent stability movement">
                    {stabilityHistory.slice(-20).map((value, index, list) => (
                      <span
                        key={`${index}-${value}`}
                        className={`microTrendBar ${index === list.length - 1 ? "latest" : ""}`}
                        style={{ height: `${Math.max(14, Math.round(value))}%` }}
                        title={`Stability index ${value}`}
                      />
                    ))}
                  </div>
                  <p className="technicalNote">Bars update as signals, boundary pressure, and evidence readiness shift.</p>
                </section>

                {couplings.planner ? (
                  <section className="plannerSummaryPanel">
                    <h4>Planner Summary</h4>
                    {plannerSignal ? (
                      <p>
                        Total: <strong>{plannerSignal.totalTasks}</strong> · Completed:{" "}
                        <strong>{plannerSignal.completedTasks}</strong> · Overdue:{" "}
                        <strong>{plannerSignal.overdueTasks}</strong> · Next24h:{" "}
                        <strong>{plannerSignal.dueNext24h}</strong>
                      </p>
                    ) : (
                      <p>Planner telemetry unavailable.</p>
                    )}
                    <p className="technicalNote">
                      Observer mode only. Triaia ingests structural telemetry and does not edit external tasks.
                    </p>
                  </section>
                ) : null}

                <div className="signalRow">
                  <span className={`signalChip ${gpsStatus === "granted" ? "good" : "neutral"}`}>
                    GPS: {gpsStatusLabel(gpsStatus)}
                  </span>
                  <span
                    className={`signalChip ${weatherStatus === "ready" ? "good" : weatherStatus === "error" ? "bad" : "neutral"}`}
                  >
                    Weather: {weatherStatusLabel(weatherStatus)}
                  </span>
                  {couplings.planner ? (
                    <span
                      className={`signalChip ${
                        plannerStatus === "ready" ? "good" : plannerStatus === "error" ? "bad" : "neutral"
                      }`}
                    >
                      Planner: {plannerStatusLabel(plannerStatus)}
                    </span>
                  ) : null}
                </div>

                <div
                  className={`stabilityBar ${snapshot.stability}`}
                  onPointerDown={handleStabilityBarPointerDown}
                  onPointerUp={clearLongPressTimer}
                  onPointerLeave={clearLongPressTimer}
                  onPointerCancel={clearLongPressTimer}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setAdvancedVisible((previous) => !previous);
                    }
                  }}
                >
                  Stability channel · long-press to access advanced panel
                </div>

                {advancedVisible ? (
                  <section className="advancedPanel">
                    <h4>ADVANCED PANEL (READ-ONLY)</h4>
                    <dl className="advancedGrid">
                      <div>
                        <dt>Regime</dt>
                        <dd>{snapshot.regimeClassification}</dd>
                      </div>
                      <div>
                        <dt>Capacity level</dt>
                        <dd>{snapshot.capacityLevel}</dd>
                      </div>
                      <div>
                        <dt>Persistence duration</dt>
                        <dd>{violationStreak} cycles</dd>
                      </div>
                      <div>
                        <dt>Threshold envelope</dt>
                        <dd>{snapshot.uncertaintyEnvelope}</dd>
                      </div>
                      <div>
                        <dt>Coupled signal count</dt>
                        <dd>{couplingCount}</dd>
                      </div>
                      <div>
                        <dt>Checks executed</dt>
                        <dd>{checkCount}</dd>
                      </div>
                    </dl>
                  </section>
                ) : null}
              </article>

              <article className="subPanel">
                <h3>Intervention State</h3>
                <div className="interventionList" role="list">
                  {(["CONTINUE", "DEVIATE", "PLAN B", "PAUSE"] as InterventionState[]).map((state) => (
                    <div key={state} className={`interventionPill ${snapshot.intervention === state ? "active" : ""}`}>
                      {state}
                    </div>
                  ))}
                </div>

                <div className="voiceLayerBox">
                  <p>{articulationForState(snapshot.intervention)}</p>
                </div>

                <section className="criteriaPanel">
                  <h4>Why This State</h4>
                  <ul className="criteriaList">
                    {stateCriteria.map((criterion) => (
                      <li key={criterion}>{criterion}</li>
                    ))}
                  </ul>
                  {documentReadiness.expectedCount > 0 ? (
                    <p className="technicalNote">
                      Evidence readiness: {documentReadiness.label} ({documentReadiness.linkedExpectedCount}/
                      {documentReadiness.expectedCount} key documents linked).
                    </p>
                  ) : null}
                </section>

                <div className="llmLimits">
                  <p>LLM cannot:</p>
                  <ul>
                    <li>Change contract</li>
                    <li>Modify thresholds</li>
                    <li>Suggest goals</li>
                  </ul>
                </div>

                <section className="assistantPanel">
                  <h4>Voice Layer Assistant</h4>
                  <p className="technicalNote">Available only after contract activation.</p>
                  <div className="assistantLog">
                    {assistantMessages.slice(-6).map((entry) => (
                      <div key={entry.id} className={`assistantBubble ${entry.role}`}>
                        {entry.text}
                      </div>
                    ))}
                  </div>

                  <form className="assistantForm" onSubmit={askVoiceLayer}>
                    <textarea
                      rows={2}
                      value={assistantInput}
                      onChange={(event) => setAssistantInput(event.target.value)}
                      placeholder="Ask for deterministic state explanation"
                      disabled={!chatAvailable || assistantBusy}
                    />
                    <button
                      type="submit"
                      className="secondaryAction"
                      disabled={!chatAvailable || assistantBusy || !assistantInput.trim()}
                    >
                      {assistantBusy ? "Asking..." : "Ask Voice Layer"}
                    </button>
                  </form>
                  <p className="technicalNote">
                    {chatAvailable ? "Explanation-only channel." : "Activate a plan to enable voice layer chat."}
                    {assistantMeta ? ` ${assistantMeta}` : ""}
                  </p>
                </section>

                <div className="metaLine">
                  Hard boundary countdown:{" "}
                  {activeRegime === "hard" && hardBoundaryMinutes !== null
                    ? formatCountdown(hardBoundaryMinutes)
                    : "Not in HARD regime"}
                </div>
              </article>
            </div>
          </section>
        ) : null}

        {showPlans ? (
          <div className="modalOverlay" role="dialog" aria-modal="true" aria-label="My plans">
            <section className="modalCard plansModal">
              <header className="panelHeader">
                <h2>MY PLANS</h2>
                <button type="button" className="secondaryAction" onClick={() => setShowPlans(false)}>
                  Close
                </button>
              </header>

              <section className="plansSection">
                <h3>Active Plan</h3>
                {activePlan ? (
                  <article className="planRow active">
                    <div>
                      <strong>{activePlan.planIdentifier}</strong>
                      <p>Domain: {activePlan.planDomain || "Unspecified"}</p>
                      <p>Regime: {activePlan.regime.toUpperCase()}</p>
                      <p>Stability: {activePlan.lastSnapshot.stability.toUpperCase()}</p>
                      <p>Boundary: {describeBoundary(activePlan)}</p>
                    </div>
                    <div className="actionRow compact">
                      <button type="button" className="primaryAction" onClick={openActiveDashboard}>
                        Open Dashboard
                      </button>
                      <button type="button" className="secondaryAction" onClick={() => setPlanStatus(activePlan.id, "paused")}>
                        Pause
                      </button>
                    </div>
                  </article>
                ) : (
                  <p className="technicalNote">No active trajectory. Activate a stored or newly configured plan.</p>
                )}
              </section>

              <section className="plansSection">
                <h3>Stored Plans</h3>
                <div className="plansList">
                  {sortedPlans.length === 0 ? (
                    <p className="technicalNote">No local plans stored yet.</p>
                  ) : (
                    sortedPlans.map((plan) => (
                      <article key={plan.id} className="planRow">
                        <div>
                          <strong>{plan.planIdentifier}</strong>
                          <p>Domain: {plan.planDomain || "Unspecified"}</p>
                          <p>Regime: {plan.regime.toUpperCase()}</p>
                          <p>Status: {plan.status.toUpperCase()}</p>
                          <p>
                            Last snapshot: {plan.lastSnapshot.stability.toUpperCase()} · {plan.lastSnapshot.intervention}
                          </p>
                          <p>Boundary: {describeBoundary(plan)}</p>
                        </div>
                        <div className="planActions">
                          <button type="button" className="secondaryAction" onClick={() => loadStoredPlanForEditing(plan)}>
                            Load
                          </button>
                          {plan.status !== "active" ? (
                            <button type="button" className="primaryAction" onClick={() => activateStoredPlan(plan)}>
                              Activate
                            </button>
                          ) : null}
                          {plan.status !== "completed" ? (
                            <button type="button" className="secondaryAction" onClick={() => setPlanStatus(plan.id, "completed")}>
                              Complete
                            </button>
                          ) : null}
                          {plan.status !== "archived" ? (
                            <button type="button" className="secondaryAction" onClick={() => setPlanStatus(plan.id, "archived")}>
                              Archive
                            </button>
                          ) : null}
                        </div>
                      </article>
                    ))
                  )}
                </div>
              </section>
            </section>
          </div>
        ) : null}

        {activationConflict ? (
          <div className="modalOverlay" role="dialog" aria-modal="true" aria-label="Active plan detected">
            <section className="modalCard">
              <header className="panelHeader">
                <h2>Active Plan Detected</h2>
              </header>
              <p>Only one trajectory may run in active mode at a time. Activate new plan?</p>
              <p>
                Current active: <strong>{activationConflict.currentActive.planIdentifier}</strong>
              </p>
              <p>
                Incoming plan: <strong>{activationConflict.incoming.planIdentifier}</strong>
              </p>
              <div className="actionRow">
                <button
                  type="button"
                  className="primaryAction"
                  onClick={() => {
                    loadPlan(activationConflict.incoming, "dashboard");
                    finalizeActivation(activationConflict.incoming, true);
                    setActivationConflict(null);
                    setShowPlans(false);
                  }}
                >
                  Pause Current Plan and Activate New
                </button>
                <button type="button" className="secondaryAction" onClick={() => setActivationConflict(null)}>
                  Cancel
                </button>
              </div>
            </section>
          </div>
        ) : null}

        {showBoundaryScanner ? (
          <div className="modalOverlay" role="dialog" aria-modal="true" aria-label="Scan boarding pass">
            <section className="modalCard scannerModal">
              <header className="panelHeader">
                <div>
                  <h2>SCAN BOARDING PASS (OPTIONAL)</h2>
                  <p>Boundary import for HARD regime. Decoding runs locally. No image stored.</p>
                </div>
                <button type="button" className="secondaryAction" onClick={closeBoundaryScanner}>
                  Close
                </button>
              </header>

              <section className="scannerViewport">
                {!scanCandidate ? (
                  <>
                    <video ref={scannerVideoRef} className="scannerVideo" autoPlay playsInline muted />
                    <div className="scannerStatusRow">
                      <span className="signalChip neutral">Status: {scannerStatusLabel(scannerStatus)}</span>
                    </div>
                    <p className="technicalNote">
                      Position boarding pass QR or barcode inside frame. If camera decode is unavailable, use manual payload
                      fallback below.
                    </p>
                    {scannerError ? <p className="errorText">{scannerError}</p> : null}
                  </>
                ) : (
                  <article className="scannerCandidate">
                    <h3>Detected Boundary Candidate</h3>
                    <dl className="snapshotGrid scanSnapshot">
                      <div>
                        <dt>Flight</dt>
                        <dd>{scanCandidate.flightNumber || "Unknown"}</dd>
                      </div>
                      <div>
                        <dt>Route</dt>
                        <dd>
                          {(scanCandidate.departureAirport || "---") + " → " + (scanCandidate.arrivalAirport || "---")}
                        </dd>
                      </div>
                      <div>
                        <dt>Boundary</dt>
                        <dd>{scanCandidate.boundaryDateTimeLocal || "Manual date/time needed"}</dd>
                      </div>
                      <div>
                        <dt>Arrival Suggestion</dt>
                        <dd>{scanCandidate.suggestedArrivalByLocal || "Unavailable"}</dd>
                      </div>
                      <div>
                        <dt>Booking Reference</dt>
                        <dd>{scanCandidate.bookingReference || "Unavailable"}</dd>
                      </div>
                      <div>
                        <dt>Format</dt>
                        <dd>{scanCandidate.sourceFormat.toUpperCase()}</dd>
                      </div>
                    </dl>
                    <p className="technicalNote">Raw preview: {scanCandidate.rawPreview}</p>
                    {scanCandidate.notes.length ? (
                      <ul className="copyList">
                        {scanCandidate.notes.map((note) => (
                          <li key={note}>{note}</li>
                        ))}
                      </ul>
                    ) : null}
                  </article>
                )}
              </section>

              <section className="scannerFallback">
                <label>
                  Manual payload fallback
                  <textarea
                    value={scannerPayloadInput}
                    onChange={(event) => setScannerPayloadInput(event.target.value)}
                    placeholder="Paste boarding pass payload text for local parsing."
                    rows={4}
                  />
                </label>
                <div className="actionRow">
                  <button type="button" className="secondaryAction" onClick={parseManualBoardingPayload}>
                    Parse Payload
                  </button>
                  {scanCandidate ? (
                    <button
                      type="button"
                      className="secondaryAction"
                      onClick={() => {
                        setScanCandidate(null);
                        setScannerError("");
                        setScannerStatus("starting");
                      }}
                    >
                      Rescan
                    </button>
                  ) : null}
                </div>
              </section>

              <div className="actionRow">
                <button type="button" className="primaryAction" disabled={!scanCandidate} onClick={applyScannedBoundary}>
                  Confirm Import to Contract
                </button>
                <button type="button" className="secondaryAction" onClick={closeBoundaryScanner}>
                  Keep Manual Boundary
                </button>
              </div>
            </section>
          </div>
        ) : null}

        {showInfo ? (
          <div className="modalOverlay" role="dialog" aria-modal="true" aria-label="Triaia information">
            <section className="modalCard">
              <header className="panelHeader">
                <h2>Triaia — Local Structural Control Layer</h2>
                <button type="button" className="secondaryAction" onClick={() => setShowInfo(false)}>
                  Close
                </button>
              </header>

              <p>
                Triaia is a structural control interface for deterministic trajectory stabilization under irreversible
                time constraints. It can observe planner telemetry but does not act as a planner.
              </p>
              <ul className="copyList">
                <li>Contracts, boundaries, and intervention logic are explicit.</li>
                <li>State transitions are local-node events.</li>
                <li>Signal coupling is optional and processed locally.</li>
                <li>Planner integrations are read-only telemetry only (no task create/edit/delete).</li>
                <li>No trajectory data is stored remotely through this interface.</li>
              </ul>

              <p>
                Contact: <a href="mailto:contact@triaia.com">contact@triaia.com</a>
              </p>
            </section>
          </div>
        ) : null}

        {showInterventionModal ? (
          <div className="modalOverlay" role="dialog" aria-modal="true" aria-label="Structural instability detected">
            <section className="modalCard dangerModal">
              <header className="panelHeader">
                <h2>STRUCTURAL INSTABILITY DETECTED</h2>
              </header>

              <div className="alertContext">
                <p>⚠ {activeRegime.toUpperCase()} REGIME INSTABILITY</p>
                <p>Plan: {planIdentifier || "UNASSIGNED"}</p>
                <p>Boundary: {alertBoundaryTimestamp}</p>
              </div>

              <p>Threshold violation persistence detected. Select regime-aware intervention.</p>

              <div className="modalChoices">
                {interventionOptions.map((choice) => (
                  <button key={choice} type="button" className="secondaryAction" onClick={applyInterventionChoice}>
                    {choice}
                  </button>
                ))}
              </div>

              <p className="technicalNote">Time never freezes. Pause restores capacity only.</p>
            </section>
          </div>
        ) : null}

        {!consentAccepted ? (
          <div className="modalOverlay" role="dialog" aria-modal="true" aria-label="Local processing agreement">
            <section className="modalCard consentModal">
              <header className="panelHeader">
                <h2>LOCAL PROCESSING AGREEMENT</h2>
              </header>

              <p>This node runs in local governance mode.</p>
              <ul className="copyList">
                <li>No trajectory data is transmitted or stored remotely.</li>
                <li>Demo external couplings are limited to GPS and weather.</li>
                <li>My Plans stores contract metadata locally in this browser only.</li>
                <li>You can revoke GPS permission at any time in browser/device settings.</li>
              </ul>

              <label className="consentCheck">
                <input
                  ref={consentCheckboxRef}
                  type="checkbox"
                  checked={consentTicked}
                  onChange={(event) => setConsentTicked(event.target.checked)}
                />
                <span>I understand and agree to local processing terms.</span>
              </label>

              <div className="actionRow">
                <button
                  type="button"
                  className="primaryAction"
                  onClick={() => {
                    const acknowledged = consentTicked || Boolean(consentCheckboxRef.current?.checked);
                    if (!acknowledged) {
                      setFormError("Please acknowledge local processing terms to continue.");
                      return;
                    }
                    setConsentTicked(true);
                    setConsentAccepted(true);
                    setFormError("");
                  }}
                >
                  Continue
                </button>
              </div>
            </section>
          </div>
        ) : null}
      </div>

      <footer className="statusStrip">{STATUS_STRIP}</footer>
    </main>
  );
}
