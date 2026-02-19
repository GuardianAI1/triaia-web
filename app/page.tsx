"use client";

import Image from "next/image";
import { FormEvent, useEffect, useMemo, useState } from "react";

type Screen = "landing" | "setup" | "risk" | "progress" | "completion";
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

const INFO_DETAILS = {
  title: "Triaia — Trajectory Risk Estimator",
  subtitle: "Estimate probability of completing a time-constrained goal.",
  description:
    "Triaia models a goal as a sequential trajectory with uncertainty. It estimates whether the full sequence can be completed before the deadline and recalculates risk as progress updates arrive.",
  whatItTracks: [
    "Trajectory modeling over time",
    "Constraint-aware decision layers",
    "Hierarchical decomposition via ordered steps",
    "Revision under external feedback",
    "Drift monitoring between expected and observed progress"
  ],
  boundaries: [
    "Assistant is guidance-only: it helps define steps and explain risk.",
    "Assistant cannot submit forms, override probabilities, or inject hidden parameters.",
    "Manual progress updates are the source of ground-truth state in this Phase A UI."
  ]
};

const UNCERTAINTY_OPTIONS: Array<{ value: UncertaintyLevel; label: string }> = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" }
];

const ASSISTANT_INTRO =
  "I can help break goals into steps, explain uncertainty, and interpret the current risk estimate. I cannot modify your plan directly or submit forms.";

function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function message(role: ChatRole, text: string): ChatMessage {
  return { id: uid(), role, text };
}

function formatDateTimeLocal(date: Date): string {
  const adjusted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return adjusted.toISOString().slice(0, 16);
}

function nowIso(): string {
  return new Date().toISOString();
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

function parseDeadline(deadlineLocal: string): Date | null {
  const parsed = new Date(deadlineLocal);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
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

function shouldEnterCompletion(plan: PlanState): boolean {
  const deadline = parseDeadline(plan.deadlineLocal);
  const deadlinePassed = deadline !== null && deadline.getTime() <= Date.now();
  const allDone = plan.steps.length > 0 && plan.steps.every((step) => step.completed);
  return deadlinePassed || allDone;
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
    `created_at=${plan.createdAtIso}`,
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
  const [screen, setScreen] = useState<Screen>("landing");
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

  const [chatOpen, setChatOpen] = useState(true);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([message("assistant", ASSISTANT_INTRO)]);
  const [isAskingAssistant, setIsAskingAssistant] = useState(false);
  const [assistantMeta, setAssistantMeta] = useState("");

  const [draggingStepId, setDraggingStepId] = useState<string | null>(null);

  const completedCount = useMemo(() => plan.steps.filter((step) => step.completed).length, [plan.steps]);
  const progressPercent = useMemo(() => {
    if (plan.steps.length === 0) {
      return 0;
    }
    return Math.round((completedCount / plan.steps.length) * 100);
  }, [completedCount, plan.steps.length]);

  const currentBand = risk ? riskBand(risk.probability) : "orange";

  useEffect(() => {
    if (screen !== "risk" && screen !== "progress") {
      return;
    }

    const timer = window.setInterval(() => {
      if (shouldEnterCompletion(plan)) {
        setScreen("completion");
      }
    }, 30000);

    return () => {
      window.clearInterval(timer);
    };
  }, [plan, screen]);

  function resetForNewPlan() {
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
  }

  function startNewPlanFlow() {
    resetForNewPlan();
    setScreen("setup");
  }

  function handleCancelSetup() {
    resetForNewPlan();
    setScreen("landing");
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

  function clearAllSteps() {
    setPlan((previous) => ({
      ...previous,
      steps: []
    }));
  }

  function duplicateCurrentPlan() {
    const copy = clonePlan(plan);
    setPlan(copy);
    setRisk(null);
    setRiskHistory([]);
    setInitialProbability(null);
    setPlanError("");
    setScreen("setup");
  }

  function resetProgress() {
    const updated: PlanState = {
      ...plan,
      steps: plan.steps.map((step) => ({
        ...step,
        completed: false,
        completedAt: null
      }))
    };
    setPlan(updated);
    if (risk) {
      evaluatePlan(updated, "risk");
    }
  }

  function removeStep(stepId: string) {
    setPlan((previous) => ({
      ...previous,
      steps: previous.steps.filter((step) => step.id !== stepId)
    }));
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

  function evaluatePlan(nextPlan: PlanState, targetScreen: Screen = "risk"): boolean {
    const validationError = validatePlan(nextPlan);
    if (validationError) {
      setPlanError(validationError);
      setScreen("setup");
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
    setCompletionFeedback("");

    if (initialProbability === null) {
      setInitialProbability(result.probability);
    }

    if (shouldEnterCompletion(nextPlan)) {
      setScreen("completion");
      return true;
    }

    setScreen(targetScreen);
    return true;
  }

  function handleEvaluatePlanSubmit(event: FormEvent) {
    event.preventDefault();
    evaluatePlan(plan, "risk");
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

    evaluatePlan(updatedPlan, "risk");
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

  function renderLanding() {
    return (
      <section className="card landingCard">
        <Image src="/triaia-logo.png" alt="Triaia logo" width={152} height={152} priority />
        <h1>Triaia — Trajectory Risk Estimator</h1>
        <p>Estimate probability of completing a time-constrained goal.</p>
        <div className="landingActions">
          <button type="button" className="primaryButton" onClick={startNewPlanFlow}>
            Create New Plan
          </button>
          <button type="button" className="ghostButton" onClick={() => setShowInfo(true)}>
            What is this?
          </button>
        </div>
      </section>
    );
  }

  function renderSetup() {
    return (
      <section className="card">
        <header className="sectionHeader">
          <div>
            <h2>Plan Setup</h2>
            <p>Define the goal, deadline, then add sequential steps.</p>
          </div>
          <div className="headerButtons">
            <button type="button" className="ghostButton" onClick={duplicateCurrentPlan}>
              Duplicate Plan
            </button>
            <button type="button" className="ghostButton" onClick={clearAllSteps}>
              Clear All Steps
            </button>
          </div>
        </header>

        <form className="setupForm" onSubmit={handleEvaluatePlanSubmit}>
          <div className="fieldGroup">
            <h3>Goal Definition</h3>
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
          </div>

          <div className="fieldGroup">
            <div className="stepHeaderRow">
              <h3>Step Definition</h3>
              <button type="button" className="primaryButton compact" onClick={addStep}>
                + Add Step
              </button>
            </div>

            <div className="stepsList">
              {plan.steps.map((step, index) => (
                <article
                  key={step.id}
                  className="stepCard"
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
                  <header>
                    <strong>
                      Step {index + 1} {step.completed ? "• Completed" : ""}
                    </strong>
                    <div className="stepButtons">
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
                  </header>

                  {step.expanded ? (
                    <div className="stepBody">
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
                        Uncertainty Level
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
                        Importance Weight ({step.importance})
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
          </div>

          {planError ? <p className="errorText">{planError}</p> : null}

          <div className="buttonRow">
            <button type="submit" className="primaryButton">
              Evaluate Plan
            </button>
            <button type="button" className="ghostButton" onClick={handleCancelSetup}>
              Cancel
            </button>
          </div>
        </form>
      </section>
    );
  }

  function renderRisk() {
    return (
      <section className="card">
        <header className="sectionHeader">
          <div>
            <h2>Risk Result</h2>
            <p>{plan.goalName || "Unnamed goal"}</p>
          </div>
          <span className={`riskPill ${currentBand}`}>{currentBand.toUpperCase()}</span>
        </header>

        <div className={`bigProbability ${currentBand}`}>
          <span>P(Goal Achieved Before Deadline)</span>
          <strong>{risk ? risk.probability.toFixed(2) : "0.00"}</strong>
        </div>

        {risk && risk.probability < 0.6 ? <p className="alertLine">Trajectory risk elevated.</p> : null}
        {risk?.acceleratingNegativeDrift ? <p className="subtleAlert">Risk increasing.</p> : null}

        <button type="button" className="ghostButton" onClick={() => setShowDetails((value) => !value)}>
          {showDetails ? "Hide Details" : "Show Details"}
        </button>

        {showDetails && risk ? (
          <dl className="metricGrid">
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
              <dt>Drift Indicator</dt>
              <dd>{driftLabel(risk)}</dd>
            </div>
            <div>
              <dt>Number of Simulations</dt>
              <dd>{risk.simulations}</dd>
            </div>
            <div>
              <dt>Remaining Deadline Budget</dt>
              <dd>{risk.remainingBudgetMinutes.toFixed(1)} min</dd>
            </div>
            <div>
              <dt>Progress</dt>
              <dd>
                {completedCount}/{plan.steps.length} steps ({progressPercent}%)
              </dd>
            </div>
          </dl>
        ) : null}

        <div className="buttonRow wrap">
          <button type="button" className="primaryButton" onClick={() => setScreen("progress")}>
            Update Progress
          </button>
          <button type="button" className="ghostButton" onClick={() => setScreen("setup")}>
            Adjust Plan
          </button>
          <button type="button" className="ghostButton" onClick={() => evaluatePlan(plan, "risk")}>
            Recalculate
          </button>
          <button type="button" className="ghostButton" onClick={resetProgress}>
            Reset Progress
          </button>
          <button type="button" className="ghostButton" onClick={startNewPlanFlow}>
            Start New Plan
          </button>
        </div>
      </section>
    );
  }

  function renderProgress() {
    return (
      <section className="card">
        <header className="sectionHeader">
          <div>
            <h2>Update Progress</h2>
            <p>Check completed steps. Timestamp is recorded automatically.</p>
          </div>
          <span className="progressBadge">{progressPercent}% complete</span>
        </header>

        <div className="checklist">
          {plan.steps.map((step, index) => (
            <label key={step.id} className="checkRow">
              <input
                type="checkbox"
                checked={step.completed}
                onChange={(event) => toggleStepCompletion(step.id, event.target.checked)}
              />
              <span>
                Step {index + 1} — {step.name}
                {step.completedAt ? <small>Completed at {new Date(step.completedAt).toLocaleString()}</small> : null}
              </span>
            </label>
          ))}
        </div>

        <div className="buttonRow">
          <button type="button" className="ghostButton" onClick={() => setScreen("risk")}>
            Back to Risk
          </button>
        </div>
      </section>
    );
  }

  function renderCompletion() {
    return (
      <section className="card">
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
          <button type="button" className="ghostButton" onClick={startNewPlanFlow}>
            Start New Plan
          </button>
        </div>

        {completionFeedback ? <p className="metaText">{completionFeedback}</p> : null}
      </section>
    );
  }

  function renderScreen() {
    if (screen === "landing") {
      return renderLanding();
    }
    if (screen === "setup") {
      return renderSetup();
    }
    if (screen === "risk") {
      return renderRisk();
    }
    if (screen === "progress") {
      return renderProgress();
    }
    return renderCompletion();
  }

  return (
    <main className="appShell">
      <div className="backdropGrid" />
      <div className="page">
        <header className="topRow">
          <div>
            <h1>Triaia</h1>
            <p>General Planning UI - Phase A</p>
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

        {renderScreen()}

        <section className="card chatCard">
          <header className="sectionHeader">
            <div>
              <h2>Chatbot Panel</h2>
              <p>Assistance-only: step suggestions, uncertainty guidance, risk explanations.</p>
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
                  placeholder="Ask for step structure, uncertainty guidance, or risk interpretation"
                />
                <button type="submit" className="primaryButton" disabled={isAskingAssistant || !chatInput.trim()}>
                  {isAskingAssistant ? "Asking Core..." : "Ask Assistant"}
                </button>
              </form>

              <p className="metaText">
                Assistant cannot submit forms, override structure, or alter probabilities.
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

            <h3>What it tracks</h3>
            <ul>
              {INFO_DETAILS.whatItTracks.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>

            <h3>Boundaries</h3>
            <ul>
              {INFO_DETAILS.boundaries.map((item) => (
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
