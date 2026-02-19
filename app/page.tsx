"use client";

import Image from "next/image";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type UncertaintyLevel = "low" | "medium" | "high";
type OutcomeAnswer = "yes" | "no" | null;
type ChatRole = "user" | "assistant";

interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
}

interface PlanStep {
  id: string;
  name: string;
  estimatedMinutes: number;
  uncertainty: UncertaintyLevel;
  importance: number;
  expanded: boolean;
  completed: boolean;
  completedAt: string | null;
}

interface PlanState {
  goalName: string;
  deadlineLocal: string;
  createdAtIso: string;
  steps: PlanStep[];
}

interface RiskPoint {
  timestampMs: number;
  probability: number;
}

interface RiskResult {
  probability: number;
  estimatedCompletionMinutes: number;
  ciLowMinutes: number;
  ciHighMinutes: number;
  remainingBudgetMinutes: number;
  simulations: number;
  driftDelta: number | null;
  acceleratingNegativeDrift: boolean;
  evaluatedAtIso: string;
}

interface CalibrationRecord {
  record_id: string;
  created_at: string;
  goal_name: string;
  deadline_local: string;
  predicted_probability_initial: number;
  predicted_probability_final: number;
  actual_success: boolean;
  predicted_total_minutes: number;
  actual_total_minutes: number | null;
  completed_steps: number;
  total_steps: number;
}

interface CoreAssistantResponse {
  reply?: string;
  provider?: string;
  model?: string;
  response_style?: string;
  response_length?: string;
  error?: string;
}

const CALIBRATION_STORAGE_KEY = "triaia_calibration_records_v1";

const ASSISTANT_INTRO =
  "I support structure and interpretation only. I can suggest steps, uncertainty labels, and explain risk numbers. I cannot update plan state.";

const INFO_DETAILS = {
  title: "Triaia — Trajectory Risk Estimator",
  subtitle: "Estimate probability of completing a time-constrained goal.",
  description:
    "Triaia is state-driven. Plan structure and progress are explicit in the UI. Chat is explanation-only and does not update state.",
  rules: [
    "State updates happen only through step checkboxes.",
    "Chat can suggest structure, but cannot mark steps done.",
    "Probability is recalculated from explicit state transitions."
  ]
};

const UNCERTAINTY_OPTIONS: Array<{ value: UncertaintyLevel; label: string }> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" }
];

function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function message(role: ChatRole, text: string): ChatMessage {
  return { id: uid(), role, text };
}

function nowIso(): string {
  return new Date().toISOString();
}

function formatDateTimeLocal(date: Date): string {
  const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return adjusted.toISOString().slice(0, 16);
}

function parseDeadline(deadlineLocal: string): Date | null {
  const parsed = new Date(deadlineLocal);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function formatRemainingTime(minutes: number): string {
  const safeMinutes = Math.max(0, Math.floor(minutes));
  const hours = Math.floor(safeMinutes / 60);
  const mins = safeMinutes % 60;
  return `${hours}h ${mins}m`;
}

function createStep(index: number): PlanStep {
  return {
    id: uid(),
    name: `Step ${index}`,
    estimatedMinutes: 20,
    uncertainty: "medium",
    importance: 3,
    expanded: true,
    completed: false,
    completedAt: null
  };
}

function createEmptyPlan(): PlanState {
  const deadline = new Date(Date.now() + 4 * 60 * 60 * 1000);
  return {
    goalName: "",
    deadlineLocal: formatDateTimeLocal(deadline),
    createdAtIso: nowIso(),
    steps: [createStep(1), createStep(2), createStep(3)]
  };
}

function clonePlan(plan: PlanState): PlanState {
  return {
    goalName: plan.goalName,
    deadlineLocal: plan.deadlineLocal,
    createdAtIso: nowIso(),
    steps: plan.steps.map((step, index) => ({
      ...step,
      id: uid(),
      name: step.name || `Step ${index + 1}`,
      completed: false,
      completedAt: null,
      expanded: true
    }))
  };
}

function validatePlan(plan: PlanState): string | null {
  if (!plan.goalName.trim()) {
    return "Goal name is required.";
  }

  const deadline = parseDeadline(plan.deadlineLocal);
  if (deadline === null) {
    return "Deadline is required and must be valid.";
  }
  if (deadline.getTime() <= Date.now()) {
    return "Deadline must be in the future.";
  }

  if (plan.steps.length === 0) {
    return "Add at least one step.";
  }

  for (const [index, step] of plan.steps.entries()) {
    if (!step.name.trim()) {
      return `Step ${index + 1}: name is required.`;
    }
    if (!Number.isFinite(step.estimatedMinutes) || step.estimatedMinutes <= 0) {
      return `Step ${index + 1}: estimated duration must be > 0.`;
    }
    if (!Number.isFinite(step.importance) || step.importance < 1 || step.importance > 5) {
      return `Step ${index + 1}: importance must be between 1 and 5.`;
    }
  }

  return null;
}

function sampleNormal(mean: number, stdDev: number): number {
  const u1 = Math.max(1e-9, Math.random());
  const u2 = Math.max(1e-9, Math.random());
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mean + z0 * stdDev;
}

function quantile(sortedValues: number[], q: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.floor((sortedValues.length - 1) * q)));
  return sortedValues[index];
}

function uncertaintySpread(level: UncertaintyLevel): number {
  if (level === "low") {
    return 0.12;
  }
  if (level === "medium") {
    return 0.28;
  }
  return 0.45;
}

function driftMetrics(points: RiskPoint[]): { delta: number | null; acceleratingNegative: boolean } {
  if (points.length < 2) {
    return { delta: null, acceleratingNegative: false };
  }
  const last = points[points.length - 1];
  const prev = points[points.length - 2];
  const delta = last.probability - prev.probability;

  if (points.length < 3) {
    return { delta, acceleratingNegative: false };
  }

  const beforePrev = points[points.length - 3];
  const prevDelta = prev.probability - beforePrev.probability;
  const acceleratingNegative = delta < 0 && prevDelta < 0 && Math.abs(delta) > Math.abs(prevDelta) + 1e-6;
  return { delta, acceleratingNegative };
}

function runSimulation(plan: PlanState, priorPoints: RiskPoint[], simulations = 1200): RiskResult {
  const deadline = parseDeadline(plan.deadlineLocal);
  const deadlineMs = deadline === null ? Date.now() : deadline.getTime();
  const remainingBudgetMinutes = Math.max(0, (deadlineMs - Date.now()) / 60000);

  const remainingSteps = plan.steps.filter((step) => !step.completed);
  if (remainingSteps.length === 0) {
    const finalPoint: RiskPoint = { timestampMs: Date.now(), probability: 1 };
    const drift = driftMetrics([...priorPoints, finalPoint]);
    return {
      probability: 1,
      estimatedCompletionMinutes: 0,
      ciLowMinutes: 0,
      ciHighMinutes: 0,
      remainingBudgetMinutes,
      simulations,
      driftDelta: drift.delta,
      acceleratingNegativeDrift: drift.acceleratingNegative,
      evaluatedAtIso: nowIso()
    };
  }

  let successCount = 0;
  const sampledTotals: number[] = [];

  for (let trial = 0; trial < simulations; trial += 1) {
    let totalMinutes = 0;
    for (const step of remainingSteps) {
      const spread = uncertaintySpread(step.uncertainty);
      const stdDev = Math.max(0.8, step.estimatedMinutes * spread);
      const importanceFactor = 1 + (step.importance - 3) * 0.06;
      const centered = step.estimatedMinutes * importanceFactor;
      const sample = sampleNormal(centered, stdDev);
      totalMinutes += Math.max(1, sample);
    }

    sampledTotals.push(totalMinutes);
    if (totalMinutes <= remainingBudgetMinutes) {
      successCount += 1;
    }
  }

  sampledTotals.sort((a, b) => a - b);
  const sum = sampledTotals.reduce((acc, value) => acc + value, 0);
  const estimatedCompletionMinutes = sampledTotals.length > 0 ? sum / sampledTotals.length : 0;
  const probability = simulations > 0 ? successCount / simulations : 0;

  const nextPoint: RiskPoint = { timestampMs: Date.now(), probability };
  const drift = driftMetrics([...priorPoints, nextPoint]);

  return {
    probability,
    estimatedCompletionMinutes,
    ciLowMinutes: quantile(sampledTotals, 0.05),
    ciHighMinutes: quantile(sampledTotals, 0.95),
    remainingBudgetMinutes,
    simulations,
    driftDelta: drift.delta,
    acceleratingNegativeDrift: drift.acceleratingNegative,
    evaluatedAtIso: nowIso()
  };
}

function riskBand(probability: number): "green" | "orange" | "red" {
  if (probability >= 0.8) {
    return "green";
  }
  if (probability >= 0.6) {
    return "orange";
  }
  return "red";
}

function driftLabel(result: RiskResult | null): string {
  if (!result || result.driftDelta === null) {
    return "No drift baseline yet.";
  }
  const points = (result.driftDelta * 100).toFixed(1);
  if (result.acceleratingNegativeDrift) {
    return `Negative drift accelerating (${points} pts since last estimate).`;
  }
  if (result.driftDelta < 0) {
    return `Negative drift (${points} pts since last estimate).`;
  }
  if (result.driftDelta > 0) {
    return `Positive drift (${points} pts since last estimate).`;
  }
  return "Drift unchanged.";
}

function buildAssistantMessage(userPrompt: string, plan: PlanState, risk: RiskResult | null): string {
  const stepSummary = plan.steps
    .slice(0, 10)
    .map((step, index) => {
      const status = step.completed ? "done" : "pending";
      return `${index + 1}:${step.name}|${step.estimatedMinutes}m|${step.uncertainty}|${status}`;
    })
    .join("; ");

  const riskSummary = risk
    ? `probability=${risk.probability.toFixed(3)}, drift_delta=${
        risk.driftDelta === null ? "n/a" : risk.driftDelta.toFixed(3)
      }, remaining_budget_minutes=${risk.remainingBudgetMinutes.toFixed(1)}`
    : "probability=n/a, drift_delta=n/a, remaining_budget_minutes=n/a";

  return [
    `User request: ${userPrompt}`,
    "Plan context:",
    `goal_name=${plan.goalName || "(unset)"}`,
    `deadline_local=${plan.deadlineLocal}`,
    `steps=${stepSummary || "none"}`,
    riskSummary,
    "Respond with one neutral clarification question or one optional non-directive suggestion.",
    "Do not use urgency language and do not issue commands."
  ].join("\n");
}

async function requestAssistantFromCore(messageText: string): Promise<CoreAssistantResponse> {
  const response = await fetch("/api/core/assistant_chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message: messageText,
      response_style: "detailed",
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
  const [plan, setPlan] = useState<PlanState>(createEmptyPlan);
  const [risk, setRisk] = useState<RiskResult | null>(null);
  const [riskHistory, setRiskHistory] = useState<RiskPoint[]>([]);
  const [initialProbability, setInitialProbability] = useState<number | null>(null);

  const [completionAnswer, setCompletionAnswer] = useState<OutcomeAnswer>(null);
  const [actualCompletionLocal, setActualCompletionLocal] = useState("");
  const [completionFeedback, setCompletionFeedback] = useState("");

  const [planError, setPlanError] = useState("");
  const [showInfo, setShowInfo] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([message("assistant", ASSISTANT_INTRO)]);
  const [isAskingAssistant, setIsAskingAssistant] = useState(false);
  const [assistantMeta, setAssistantMeta] = useState("");

  const [draggingStepId, setDraggingStepId] = useState<string | null>(null);
  const [focusProgress, setFocusProgress] = useState(false);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const progressSectionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  const completedCount = useMemo(() => plan.steps.filter((step) => step.completed).length, [plan.steps]);
  const pendingCount = useMemo(() => Math.max(0, plan.steps.length - completedCount), [completedCount, plan.steps.length]);
  const progressPercent = useMemo(() => {
    if (plan.steps.length === 0) {
      return 0;
    }
    return Math.round((completedCount / plan.steps.length) * 100);
  }, [completedCount, plan.steps.length]);

  const deadline = useMemo(() => parseDeadline(plan.deadlineLocal), [plan.deadlineLocal]);
  const deadlineMs = deadline?.getTime() ?? nowMs;
  const timeRemainingMinutes = useMemo(() => Math.max(0, (deadlineMs - nowMs) / 60000), [deadlineMs, nowMs]);
  const deadlinePassed = deadline !== null && deadlineMs <= nowMs;
  const allStepsDone = plan.steps.length > 0 && plan.steps.every((step) => step.completed);
  const shouldShowCompletion = deadlinePassed || allStepsDone;

  const currentBand = risk ? riskBand(risk.probability) : "orange";
  const nextPendingStep = useMemo(
    () => plan.steps.find((step) => !step.completed) ?? null,
    [plan.steps]
  );
  const trajectoryPhase = useMemo(() => {
    if (allStepsDone) {
      return "completed";
    }
    if (deadlinePassed) {
      return "deadline passed";
    }
    if (completedCount > 0) {
      return "in progress";
    }
    return "planned";
  }, [allStepsDone, completedCount, deadlinePassed]);
  const probabilitySeries = useMemo(() => {
    const values = riskHistory.map((point) => point.probability);
    if (risk && (values.length === 0 || Math.abs(values[values.length - 1] - risk.probability) > 1e-6)) {
      values.push(risk.probability);
    }
    return values.slice(-18);
  }, [risk, riskHistory]);
  const probabilitySparklinePoints = useMemo(() => {
    if (probabilitySeries.length === 0) {
      return "";
    }
    const width = 260;
    const height = 72;
    const padding = 6;
    return probabilitySeries
      .map((value, index) => {
        const x =
          probabilitySeries.length === 1
            ? width / 2
            : padding + (index * (width - padding * 2)) / (probabilitySeries.length - 1);
        const y = padding + (1 - value) * (height - padding * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  }, [probabilitySeries]);
  const trajectoryTrend = useMemo(() => {
    if (!risk || risk.driftDelta === null) {
      return { symbol: "→", label: "stable" };
    }
    if (risk.driftDelta > 0.001) {
      return { symbol: "↑", label: "improving" };
    }
    if (risk.driftDelta < -0.001) {
      return { symbol: "↓", label: "declining" };
    }
    return { symbol: "→", label: "stable" };
  }, [risk]);
  const trajectoryConfidencePercent = risk ? Math.max(0, Math.min(100, risk.probability * 100)) : 0;

  function resetAll() {
    setPlan(createEmptyPlan());
    setRisk(null);
    setRiskHistory([]);
    setInitialProbability(null);
    setCompletionAnswer(null);
    setActualCompletionLocal("");
    setCompletionFeedback("");
    setPlanError("");
    setShowDetails(false);
    setChatMessages([message("assistant", ASSISTANT_INTRO)]);
    setChatInput("");
    setIsAskingAssistant(false);
    setAssistantMeta("");
    setFocusProgress(false);
  }

  function replaceStep(stepId: string, patch: Partial<PlanStep>) {
    setPlan((previous) => ({
      ...previous,
      steps: previous.steps.map((step) => (step.id === stepId ? { ...step, ...patch } : step))
    }));
  }

  function addStep() {
    setPlan((previous) => ({
      ...previous,
      steps: [...previous.steps, createStep(previous.steps.length + 1)]
    }));
  }

  function removeStep(stepId: string) {
    setPlan((previous) => ({
      ...previous,
      steps: previous.steps.filter((step) => step.id !== stepId)
    }));
  }

  function clearAllSteps() {
    setPlan((previous) => ({
      ...previous,
      steps: []
    }));
    setFocusProgress(false);
  }

  function duplicatePlan() {
    const copy = clonePlan(plan);
    setPlan(copy);
    setRisk(null);
    setRiskHistory([]);
    setInitialProbability(null);
    setPlanError("");
    setCompletionAnswer(null);
    setCompletionFeedback("");
  }

  function reorderSteps(fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) {
      return;
    }

    setPlan((previous) => {
      if (fromIndex >= previous.steps.length || toIndex >= previous.steps.length) {
        return previous;
      }
      const next = [...previous.steps];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return { ...previous, steps: next };
    });
  }

  function moveStep(stepId: string, direction: "up" | "down") {
    const index = plan.steps.findIndex((step) => step.id === stepId);
    if (index === -1) {
      return;
    }
    const target = direction === "up" ? index - 1 : index + 1;
    reorderSteps(index, target);
  }

  function evaluatePlan(nextPlan: PlanState = plan): boolean {
    const validationError = validatePlan(nextPlan);
    if (validationError) {
      setPlanError(validationError);
      return false;
    }

    const result = runSimulation(nextPlan, riskHistory);
    const nextPoint: RiskPoint = {
      timestampMs: Date.now(),
      probability: result.probability
    };

    setPlan(nextPlan);
    setRisk(result);
    setRiskHistory((previous) => [...previous.slice(-18), nextPoint]);
    setPlanError("");

    if (initialProbability === null) {
      setInitialProbability(result.probability);
    }

    return true;
  }

  function handleEvaluatePlanSubmit(event: FormEvent) {
    event.preventDefault();
    evaluatePlan(plan);
  }

  function focusProgressPanel() {
    setFocusProgress(true);
    progressSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function toggleStepCompletion(stepId: string, completed: boolean) {
    const timestamp = completed ? nowIso() : null;
    const updatedPlan: PlanState = {
      ...plan,
      steps: plan.steps.map((step) =>
        step.id === stepId
          ? {
              ...step,
              completed,
              completedAt: timestamp
            }
          : step
      )
    };

    evaluatePlan(updatedPlan);
  }

  function resetProgress() {
    const updatedPlan: PlanState = {
      ...plan,
      steps: plan.steps.map((step) => ({
        ...step,
        completed: false,
        completedAt: null
      }))
    };
    setCompletionAnswer(null);
    setCompletionFeedback("");
    evaluatePlan(updatedPlan);
  }

  async function handleAssistantAsk(event: FormEvent) {
    event.preventDefault();
    const prompt = chatInput.trim();
    if (!prompt) {
      return;
    }

    setChatInput("");
    setChatMessages((previous) => [...previous, message("user", prompt)]);
    setIsAskingAssistant(true);

    try {
      const coreMessage = buildAssistantMessage(prompt, plan, risk);
      const response = await requestAssistantFromCore(coreMessage);
      const reply = (response.reply || "").trim();
      if (!reply) {
        throw new Error("Assistant returned empty response.");
      }
      setAssistantMeta(
        `${response.provider || "core"} · ${response.model || "unknown"} · detailed · short`
      );
      setChatMessages((previous) => [...previous, message("assistant", reply)]);
    } catch (caught) {
      const detail = caught instanceof Error ? caught.message : "Unknown assistant error.";
      setChatMessages((previous) => [
        ...previous,
        message("assistant", `Core assistant unavailable: ${detail}`)
      ]);
      setAssistantMeta("core assistant error");
    } finally {
      setIsAskingAssistant(false);
    }
  }

  function submitCompletionOutcome() {
    if (completionAnswer === null) {
      setCompletionFeedback("Select Yes or No before submitting outcome.");
      return;
    }

    const finalProbability = risk?.probability ?? 0;
    const initial = initialProbability ?? finalProbability;

    let actualTotalMinutes: number | null = null;
    if (actualCompletionLocal.trim()) {
      const actual = parseDeadline(actualCompletionLocal);
      const created = new Date(plan.createdAtIso);
      if (actual && !Number.isNaN(created.getTime())) {
        actualTotalMinutes = Math.max(0, (actual.getTime() - created.getTime()) / 60000);
      }
    }

    const record: CalibrationRecord = {
      record_id: uid(),
      created_at: nowIso(),
      goal_name: plan.goalName,
      deadline_local: plan.deadlineLocal,
      predicted_probability_initial: Number(initial.toFixed(6)),
      predicted_probability_final: Number(finalProbability.toFixed(6)),
      actual_success: completionAnswer === "yes",
      predicted_total_minutes: Number((risk?.estimatedCompletionMinutes ?? 0).toFixed(2)),
      actual_total_minutes: actualTotalMinutes === null ? null : Number(actualTotalMinutes.toFixed(2)),
      completed_steps: completedCount,
      total_steps: plan.steps.length
    };

    try {
      const raw = window.localStorage.getItem(CALIBRATION_STORAGE_KEY);
      const existing = raw ? (JSON.parse(raw) as CalibrationRecord[]) : [];
      const next = [...existing, record];
      window.localStorage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(next));
      setCompletionFeedback("Outcome submitted and calibration record logged locally.");
    } catch {
      setCompletionFeedback("Outcome captured, but local calibration log write failed.");
    }
  }

  return (
    <main className="appShell">
      <div className="backdropGrid" />
      <div className="page">
        <header className="topRow">
          <div>
            <h1>Triaia</h1>
            <p>State-driven trajectory evaluation</p>
          </div>
          <div className="topButtons">
            <button type="button" className="ghostButton" onClick={() => setShowInfo(true)}>
              Info
            </button>
            <a href="mailto:contact@triaia.com" className="contactButton">
              contact@triaia.com
            </a>
          </div>
        </header>

        <section className="card zoneCard">
          <header className="sectionHeader">
            <div>
              <h2>Goal (Contract) + Deadline</h2>
              <p>Define objective and deadline as the contract anchor.</p>
            </div>
          </header>

          <form className="goalGrid" onSubmit={handleEvaluatePlanSubmit}>
            <label>
              Goal Name
              <input
                value={plan.goalName}
                onChange={(event) => setPlan((previous) => ({ ...previous, goalName: event.target.value }))}
                placeholder="Arrive at conference"
                required
              />
            </label>

            <label>
              Deadline
              <input
                type="datetime-local"
                value={plan.deadlineLocal}
                onChange={(event) => setPlan((previous) => ({ ...previous, deadlineLocal: event.target.value }))}
                required
              />
            </label>

            <div className="inlineMetaRow">
              <span>Time Remaining: {formatRemainingTime(timeRemainingMinutes)}</span>
              <span>Created: {new Date(plan.createdAtIso).toLocaleString()}</span>
            </div>
          </form>
        </section>

        <section className="card signatureCard">
          <header className="sectionHeader">
            <div>
              <h2>Trajectory / Hierarchy / Probability</h2>
              <p>Always-visible system state.</p>
            </div>
          </header>

          <div className="signatureGrid">
            <article className="signatureBlock">
              <h3>Trajectory</h3>
              <dl className="signatureList">
                <div>
                  <dt>Phase</dt>
                  <dd>{trajectoryPhase}</dd>
                </div>
                <div>
                  <dt>Progress</dt>
                  <dd>
                    {completedCount}/{plan.steps.length} ({progressPercent}%)
                  </dd>
                </div>
                <div>
                  <dt>Time Remaining</dt>
                  <dd>{formatRemainingTime(timeRemainingMinutes)}</dd>
                </div>
                <div>
                  <dt>Remaining Step</dt>
                  <dd>{nextPendingStep ? nextPendingStep.name : "None (complete)"}</dd>
                </div>
              </dl>
            </article>

            <article className="signatureBlock">
              <h3>Hierarchy</h3>
              <div className="hierarchyRoot">Goal: {plan.goalName || "(unset)"}</div>
              <ul className="hierarchyList">
                {plan.steps.map((step, index) => (
                  <li key={step.id}>
                    <span className={`hierarchyState ${step.completed ? "done" : "pending"}`}>
                      {step.completed ? "✓" : "○"}
                    </span>
                    <span className="hierarchyLabel">
                      {index + 1}. {step.name || `Step ${index + 1}`}
                    </span>
                  </li>
                ))}
              </ul>
            </article>

            <article className="signatureBlock">
              <h3>Probability Over Time</h3>
              <div className="probabilitySummary">
                Current: {risk ? `${(risk.probability * 100).toFixed(1)}%` : "n/a"} · Samples:{" "}
                {probabilitySeries.length}
              </div>
              <div className="trajectoryConfidenceRow">
                <span>Trajectory Confidence</span>
                <strong>{risk ? `${trajectoryConfidencePercent.toFixed(1)}%` : "n/a"}</strong>
              </div>
              <div className="confidenceMeter">
                <div
                  className={`confidenceFill ${currentBand}`}
                  style={{ width: `${trajectoryConfidencePercent.toFixed(1)}%` }}
                />
              </div>
              <div className={`trendLine ${trajectoryTrend.label}`}>
                Trend {trajectoryTrend.symbol} {trajectoryTrend.label}
              </div>
              <div className="sparklineWrap">
                {probabilitySparklinePoints ? (
                  <svg viewBox="0 0 260 72" className="sparkline" role="img" aria-label="Probability history">
                    <polyline points={probabilitySparklinePoints} />
                  </svg>
                ) : (
                  <div className="sparklinePlaceholder">Evaluate plan to start probability timeline.</div>
                )}
              </div>
            </article>
          </div>
        </section>

        <section className="middleGrid">
          <div ref={progressSectionRef} className={`card zoneCard ${focusProgress ? "focusedZone" : ""}`}>
            <header className="sectionHeader">
              <div>
                <h2>Plan Structure + Current Progress</h2>
                <p>State updates are explicit: only these checkboxes change progress.</p>
              </div>
              <button type="button" className="primaryButton compact" onClick={addStep}>
                + Add Step
              </button>
            </header>

            <div className="stepList">
              {plan.steps.map((step, index) => (
                <article
                  key={step.id}
                  className={`stepCard ${step.completed ? "completed" : ""}`}
                  draggable
                  onDragStart={() => setDraggingStepId(step.id)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (!draggingStepId || draggingStepId === step.id) {
                      return;
                    }
                    const fromIndex = plan.steps.findIndex((item) => item.id === draggingStepId);
                    const toIndex = plan.steps.findIndex((item) => item.id === step.id);
                    reorderSteps(fromIndex, toIndex);
                    setDraggingStepId(null);
                  }}
                  onDragEnd={() => setDraggingStepId(null)}
                >
                  <div className="stepHeaderRow">
                    <label className="checkLabel">
                      <input
                        type="checkbox"
                        checked={step.completed}
                        onChange={(event) => toggleStepCompletion(step.id, event.target.checked)}
                      />
                      <span className="stepMainText">
                        <strong>
                          Step {index + 1} {step.name ? `- ${step.name}` : ""}
                        </strong>
                        <small>
                          {step.completedAt
                            ? `Recorded at ${new Date(step.completedAt).toLocaleTimeString()}`
                            : "Pending"}
                        </small>
                      </span>
                    </label>

                    <div className="stepActions">
                      <button type="button" className="tinyButton" onClick={() => moveStep(step.id, "up")}>↑</button>
                      <button type="button" className="tinyButton" onClick={() => moveStep(step.id, "down")}>↓</button>
                      <button
                        type="button"
                        className="tinyButton"
                        onClick={() => replaceStep(step.id, { expanded: !step.expanded })}
                      >
                        {step.expanded ? "Collapse" : "Expand"}
                      </button>
                      <button type="button" className="tinyButton danger" onClick={() => removeStep(step.id)}>
                        Remove
                      </button>
                    </div>
                  </div>

                  {step.expanded ? (
                    <div className="stepDetailGrid">
                      <label>
                        Step Name
                        <input
                          value={step.name}
                          onChange={(event) => replaceStep(step.id, { name: event.target.value })}
                          placeholder={`Step ${index + 1}`}
                        />
                      </label>

                      <label>
                        Estimated Duration (minutes)
                        <input
                          type="number"
                          min={1}
                          value={step.estimatedMinutes}
                          onChange={(event) =>
                            replaceStep(step.id, { estimatedMinutes: Math.max(1, Number(event.target.value) || 1) })
                          }
                        />
                      </label>

                      <label>
                        Uncertainty
                        <select
                          value={step.uncertainty}
                          onChange={(event) => replaceStep(step.id, { uncertainty: event.target.value as UncertaintyLevel })}
                        >
                          {UNCERTAINTY_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label>
                        Importance ({step.importance})
                        <input
                          type="range"
                          min={1}
                          max={5}
                          step={1}
                          value={step.importance}
                          onChange={(event) => replaceStep(step.id, { importance: Number(event.target.value) || 3 })}
                        />
                      </label>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>

            {plan.steps.length === 0 ? <p className="hintText">No steps yet. Add step to define trajectory.</p> : null}
          </div>

          <div className="card zoneCard">
            <header className="sectionHeader">
              <div>
                <h2>Current State</h2>
                <p>This is where you are now.</p>
              </div>
              <span className={`riskPill ${currentBand}`}>{currentBand.toUpperCase()}</span>
            </header>

            <div className={`probabilityBlock ${currentBand}`}>
              <span>Current Probability</span>
              <strong>{risk ? risk.probability.toFixed(2) : "--"}</strong>
            </div>

            {risk && risk.probability < 0.6 ? <p className="alertLine">Trajectory risk elevated.</p> : null}
            {risk?.acceleratingNegativeDrift ? <p className="subtleAlert">Risk increasing.</p> : null}

            <dl className="stateGrid">
              <div>
                <dt>Goal</dt>
                <dd>{plan.goalName || "Unset"}</dd>
              </div>
              <div>
                <dt>Deadline</dt>
                <dd>{deadline ? deadline.toLocaleString() : "Invalid"}</dd>
              </div>
              <div>
                <dt>Completed</dt>
                <dd>{completedCount}</dd>
              </div>
              <div>
                <dt>Pending</dt>
                <dd>{pendingCount}</dd>
              </div>
              <div>
                <dt>Time Remaining</dt>
                <dd>{formatRemainingTime(timeRemainingMinutes)}</dd>
              </div>
              <div>
                <dt>Drift</dt>
                <dd>{driftLabel(risk)}</dd>
              </div>
            </dl>

            <button type="button" className="ghostButton" onClick={() => setShowDetails((value) => !value)}>
              {showDetails ? "Hide Details" : "Show Details"}
            </button>

            {showDetails && risk ? (
              <dl className="detailGrid">
                <div>
                  <dt>Estimated Completion Time</dt>
                  <dd>{risk.estimatedCompletionMinutes.toFixed(1)} min</dd>
                </div>
                <div>
                  <dt>Confidence Interval</dt>
                  <dd>
                    {risk.ciLowMinutes.toFixed(1)} - {risk.ciHighMinutes.toFixed(1)} min
                  </dd>
                </div>
                <div>
                  <dt>Simulations</dt>
                  <dd>{risk.simulations}</dd>
                </div>
                <div>
                  <dt>Evaluated At</dt>
                  <dd>{new Date(risk.evaluatedAtIso).toLocaleTimeString()}</dd>
                </div>
              </dl>
            ) : null}
          </div>
        </section>

        <section className="card zoneCard">
          <header className="sectionHeader">
            <div>
              <h2>Action Panel</h2>
              <p>Explicit controls. No hidden state transitions through chat.</p>
            </div>
          </header>

          <div className="buttonRow wrap">
            <button type="button" className="primaryButton" onClick={() => evaluatePlan(plan)}>
              Evaluate Plan
            </button>
            <button type="button" className="ghostButton" onClick={focusProgressPanel}>
              Update Progress
            </button>
            <button type="button" className="ghostButton" onClick={() => evaluatePlan(plan)}>
              Recalculate
            </button>
            <button type="button" className="ghostButton" onClick={duplicatePlan}>
              Duplicate Plan
            </button>
            <button type="button" className="ghostButton" onClick={clearAllSteps}>
              Clear All Steps
            </button>
            <button type="button" className="ghostButton" onClick={resetProgress}>
              Reset Progress
            </button>
            <button type="button" className="ghostButton" onClick={resetAll}>
              Start New Plan
            </button>
          </div>

          {planError ? <p className="errorText">{planError}</p> : null}
          <p className="metaText">Progress: {progressPercent}% complete.</p>
        </section>

        {shouldShowCompletion ? (
          <section className="card zoneCard">
            <header className="sectionHeader">
              <div>
                <h2>Completion</h2>
                <p>Was the goal completed before deadline?</p>
              </div>
            </header>

            <div className="buttonRow">
              <button
                type="button"
                className={completionAnswer === "yes" ? "primaryButton" : "ghostButton"}
                onClick={() => setCompletionAnswer("yes")}
              >
                Yes
              </button>
              <button
                type="button"
                className={completionAnswer === "no" ? "primaryButton" : "ghostButton"}
                onClick={() => setCompletionAnswer("no")}
              >
                No
              </button>
            </div>

            <label>
              Actual completion time (optional)
              <input
                type="datetime-local"
                value={actualCompletionLocal}
                onChange={(event) => setActualCompletionLocal(event.target.value)}
              />
            </label>

            <div className="buttonRow">
              <button type="button" className="primaryButton" onClick={submitCompletionOutcome}>
                Submit Outcome
              </button>
            </div>

            {completionFeedback ? <p className="metaText">{completionFeedback}</p> : null}
          </section>
        ) : null}

        <section className="card zoneCard chatZone">
          <header className="sectionHeader">
            <div>
              <h2>Chat (Guidance Layer)</h2>
              <p>Chat is secondary. It cannot update state.</p>
            </div>
            <button type="button" className="ghostButton" onClick={() => setChatOpen((value) => !value)}>
              {chatOpen ? "Collapse" : "Expand"}
            </button>
          </header>

          {chatOpen ? (
            <>
              <div className="chatLog">
                {chatMessages.slice(-14).map((entry) => (
                  <div key={entry.id} className={`chatBubble ${entry.role}`}>
                    {entry.text}
                  </div>
                ))}
              </div>

              <form className="chatForm" onSubmit={handleAssistantAsk}>
                <textarea
                  rows={3}
                  value={chatInput}
                  onChange={(event) => setChatInput(event.target.value)}
                  placeholder="Ask for structure, uncertainty, or probability interpretation"
                />
                <button type="submit" className="primaryButton" disabled={isAskingAssistant || !chatInput.trim()}>
                  {isAskingAssistant ? "Asking Core..." : "Ask Assistant"}
                </button>
              </form>

              <p className="metaText">
                Assistant cannot submit forms, mark completion, or alter probabilities.
                {assistantMeta ? ` ${assistantMeta}` : ""}
              </p>
            </>
          ) : null}
        </section>
      </div>

      {showInfo ? (
        <div className="modalOverlay" role="dialog" aria-modal="true" aria-label="About Triaia">
          <section className="modalCard">
            <header className="sectionHeader">
              <div>
                <h2>{INFO_DETAILS.title}</h2>
                <p>{INFO_DETAILS.subtitle}</p>
              </div>
              <button type="button" className="ghostButton" onClick={() => setShowInfo(false)}>
                Close
              </button>
            </header>

            <p>{INFO_DETAILS.description}</p>

            <ul>
              {INFO_DETAILS.rules.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>

            <p>
              Contact: <a href="mailto:contact@triaia.com">contact@triaia.com</a>
            </p>
          </section>
        </div>
      ) : null}
    </main>
  );
}
