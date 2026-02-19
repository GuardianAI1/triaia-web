"use client";

import Image from "next/image";
import { FormEvent, useEffect, useMemo, useState } from "react";
import {
  assistantChat,
  assistantConstructMission,
  type AssistantResponseLength,
  type AssistantResponseStyle,
  type ChatMessage,
  checkCoreHealth,
  createMission,
  fetchMissionStatus,
  type HealthResponse,
  type MissionStatus,
  sendStructuredUpdate,
  startGrounding,
  stopGrounding
} from "@/lib/core";

const CORE_URL_STORAGE_KEY = "triaia-core-url";
const DEFAULT_CORE_URL = "http://127.0.0.1:8081";
const COPILOT_INTRO =
  "I can construct your mission step-by-step. I ask only for missing fields (mission, departure time, airport, gate), then create it in the sealed Core.";

const CAPABILITIES = [
  "Trajectory modeling over time",
  "Constraint-aware decision layers",
  "Hierarchical decomposition",
  "Revision under external feedback",
  "Drift monitoring"
];

const STYLE_OPTIONS: Array<{ value: AssistantResponseStyle; label: string }> = [
  { value: "tactical", label: "Tactical" },
  { value: "detailed", label: "Detailed" }
];

const LENGTH_OPTIONS: Array<{ value: AssistantResponseLength; label: string }> = [
  { value: "short", label: "Short" },
  { value: "medium", label: "Medium" },
  { value: "long", label: "Long" }
];

const INFO_DETAILS = {
  overview:
    "Triaia is a trajectory-based hierarchical planning system. You define a mission, the sealed Core decomposes it into layered subgoals, simulates uncertainty forward in time, and returns only operational guidance.",
  tracks: [
    "Mission progress probability over time",
    "Constraint pressure at each stage of the mission",
    "Hierarchy-level contribution to risk",
    "Drift between expected and observed reality",
    "Policy recommendation updates when conditions change"
  ],
  flow: [
    "You define mission intent and constraints.",
    "Copilot can construct missing mission fields (mission, departure time, airport, gate).",
    "Core computes status, confidence, and recommendations.",
    "Grounding updates (OCR/GPS structured signals) revise belief state.",
    "Core re-evaluates trajectory and returns updated guidance."
  ],
  boundaries: [
    "UI handles display, chat, and sensor-side structured updates.",
    "Core remains the only decision authority.",
    "UI cannot submit planning outputs like risk level or recommendation.",
    "Raw video and private Core internals are not exposed through this UI."
  ]
};

function messageId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function chatMessage(role: ChatMessage["role"], text: string): ChatMessage {
  return {
    id: messageId(),
    role,
    text
  };
}

function toTitleCase(value: string | undefined): string {
  if (!value) {
    return "";
  }
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function trimMessage(text: string): string {
  return text.trim();
}

function parseConfidence(value: string): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return Math.min(1, Math.max(0, parsed));
}

export default function HomePage() {
  const [coreUrl, setCoreUrl] = useState(DEFAULT_CORE_URL);
  const [coreHealth, setCoreHealth] = useState<HealthResponse | null>(null);
  const [healthError, setHealthError] = useState<string>("");

  const [missionName, setMissionName] = useState("Catch AF83 at 08:20");
  const [departureTime, setDepartureTime] = useState("08:20");
  const [airport, setAirport] = useState("JFK");
  const [gate, setGate] = useState("B42");

  const [missionStatus, setMissionStatus] = useState<MissionStatus | null>(null);

  const [timestamp, setTimestamp] = useState("07:52");
  const [location, setLocation] = useState("Terminal 4");
  const [gateDetected, setGateDetected] = useState("B42");
  const [signalConfidence, setSignalConfidence] = useState("0.91");

  const [assistantPrompt, setAssistantPrompt] = useState("");
  const [assistantResponseStyle, setAssistantResponseStyle] = useState<AssistantResponseStyle>("tactical");
  const [assistantResponseLength, setAssistantResponseLength] = useState<AssistantResponseLength>("short");
  const [assistantMeta, setAssistantMeta] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([chatMessage("assistant", COPILOT_INTRO)]);
  const [constructionSessionId, setConstructionSessionId] = useState<string | undefined>();
  const [isInfoOpen, setIsInfoOpen] = useState(false);

  const [isBusy, setIsBusy] = useState(false);
  const [activeAction, setActiveAction] = useState<string>("");
  const [error, setError] = useState<string>("");

  const hasMission = missionStatus !== null;
  const missionId = missionStatus?.mission_id;

  const websiteLink = process.env.NEXT_PUBLIC_TRIAIA_WEBSITE_URL ?? "https://triaia.com";
  const githubLink = process.env.NEXT_PUBLIC_GITHUB_REPO_URL ?? "";

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const stored = window.localStorage.getItem(CORE_URL_STORAGE_KEY);
    if (stored) {
      setCoreUrl(stored);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    window.localStorage.setItem(CORE_URL_STORAGE_KEY, coreUrl);
  }, [coreUrl]);

  const healthLabel = useMemo(() => {
    if (healthError) {
      return "unreachable";
    }
    if (coreHealth?.status === "ok") {
      return "healthy";
    }
    return "unknown";
  }, [coreHealth, healthError]);

  async function runAction(action: string, work: () => Promise<void>) {
    setIsBusy(true);
    setActiveAction(action);
    setError("");
    try {
      await work();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "Request failed.";
      setError(message);
    } finally {
      setIsBusy(false);
      setActiveAction("");
    }
  }

  async function handleHealthCheck() {
    await runAction("health", async () => {
      const health = await checkCoreHealth(coreUrl);
      setCoreHealth(health);
      setHealthError("");
    });
  }

  async function handleCreateMission(event: FormEvent) {
    event.preventDefault();
    await runAction("create", async () => {
      const created = await createMission(coreUrl, {
        mission: missionName,
        departure_time: departureTime,
        airport,
        gate
      });
      setMissionStatus(created);
      setConstructionSessionId(undefined);
      setAssistantMeta("mission created in sealed core");
      setChatMessages((previous) => [...previous, chatMessage("system", `Mission created: ${created.mission_id}`)]);
    });
  }

  async function handleRefreshStatus() {
    if (!missionId) {
      return;
    }
    await runAction("refresh", async () => {
      const refreshed = await fetchMissionStatus(coreUrl, missionId);
      setMissionStatus(refreshed);
    });
  }

  async function handleStartGrounding() {
    if (!missionId) {
      return;
    }
    await runAction("start-grounding", async () => {
      await startGrounding(coreUrl, { mission_id: missionId });
      const refreshed = await fetchMissionStatus(coreUrl, missionId);
      setMissionStatus(refreshed);
    });
  }

  async function handleStopGrounding() {
    if (!missionId) {
      return;
    }
    await runAction("stop-grounding", async () => {
      await stopGrounding(coreUrl, { mission_id: missionId });
      const refreshed = await fetchMissionStatus(coreUrl, missionId);
      setMissionStatus(refreshed);
    });
  }

  async function handleStructuredUpdate(event: FormEvent) {
    event.preventDefault();
    if (!missionId) {
      return;
    }
    await runAction("update", async () => {
      const confidence = parseConfidence(signalConfidence);
      const updated = await sendStructuredUpdate(coreUrl, {
        mission_id: missionId,
        schema_version: "1.0",
        source: "ui_scan",
        timestamp,
        location,
        gate_detected: gateDetected,
        confidence
      });
      setMissionStatus(updated);
    });
  }

  async function handleAskCopilot(event: FormEvent) {
    event.preventDefault();
    const prompt = trimMessage(assistantPrompt);
    if (!prompt) {
      return;
    }

    setAssistantPrompt("");
    setChatMessages((previous) => [...previous, chatMessage("user", prompt)]);

    await runAction("assistant", async () => {
      if (!missionId) {
        const response = await assistantConstructMission(coreUrl, {
          session_id: constructionSessionId,
          message: prompt
        });

        setConstructionSessionId(response.session_id);
        if (response.captured_fields?.mission) {
          setMissionName(response.captured_fields.mission);
        }
        if (response.captured_fields?.departure_time) {
          setDepartureTime(response.captured_fields.departure_time);
        }
        if (response.captured_fields?.airport) {
          setAirport(response.captured_fields.airport);
        }
        if (response.captured_fields?.gate) {
          setGate(response.captured_fields.gate);
        }

        if (response.mission) {
          setMissionStatus(response.mission);
          setConstructionSessionId(undefined);
        }

        const missing = response.missing_fields?.length ? response.missing_fields.join(", ") : "none";
        setAssistantMeta(`sealed-core · mission-constructor · missing: ${missing}`);
        setChatMessages((previous) => [...previous, chatMessage("assistant", response.reply)]);
        return;
      }

      const response = await assistantChat(coreUrl, {
        mission_id: missionId,
        message: prompt,
        response_style: assistantResponseStyle,
        response_length: assistantResponseLength
      });

      const responseStyle = toTitleCase(response.response_style ?? assistantResponseStyle);
      const responseLength = toTitleCase(response.response_length ?? assistantResponseLength);
      setAssistantMeta(`${response.provider} · ${response.model} · ${responseStyle} · ${responseLength}`);
      setChatMessages((previous) => [...previous, chatMessage("assistant", response.reply)]);
    });
  }

  function clearChat() {
    setAssistantPrompt("");
    setAssistantMeta("");
    setConstructionSessionId(undefined);
    setChatMessages([chatMessage("assistant", COPILOT_INTRO)]);
  }

  return (
    <main className="pageShell">
      <div className="backdrop" />
      <div className="layout">
        <header className="topBar">
          <div>
            <h1>Triaia</h1>
            <p>A trajectory-based hierarchical planning system</p>
          </div>
          <div className="topActions">
            <button type="button" className="topLinkButton" onClick={() => setIsInfoOpen(true)}>
              Info
            </button>
            <a href={websiteLink} target="_blank" rel="noreferrer">
              triaia.com
            </a>
            {githubLink ? (
              <a href={githubLink} target="_blank" rel="noreferrer">
                GitHub
              </a>
            ) : null}
          </div>
        </header>

        <section className="panel aboutPanel">
          <div className="brandMark">
            <Image src="/triaia-logo.png" alt="Triaia logo" width={180} height={180} priority />
          </div>
          <div className="aboutCopy">
            <h2>What Triaia does</h2>
            <ul>
              {CAPABILITIES.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <p className="strongLine">Not just a planning app.</p>
          </div>
        </section>

        <section className="panel">
          <div className="sectionHeaderRow">
            <h3>Core Connection</h3>
            <span className={`healthBadge ${healthLabel}`}>{healthLabel}</span>
          </div>
          <p className="muted">UI and Core are separated. Planning stays server-side in sealed Core.</p>
          <div className="inlineRow">
            <input
              value={coreUrl}
              onChange={(event) => setCoreUrl(event.target.value)}
              placeholder="http://127.0.0.1:8081"
              aria-label="Core URL"
            />
            <button type="button" onClick={handleHealthCheck} disabled={isBusy}>
              {activeAction === "health" ? "Checking..." : "Check /health"}
            </button>
          </div>
          {coreHealth ? (
            <p className="metaLine">
              {coreHealth.service ?? "htp_core"} · assistant {coreHealth.assistant_enabled ? "on" : "off"} ·
              model {coreHealth.assistant_model ?? "n/a"}
            </p>
          ) : null}
          {healthError ? <p className="errorLine">{healthError}</p> : null}
        </section>

        <section className="panel">
          <h3>Create Mission</h3>
          <form onSubmit={handleCreateMission} className="stackForm">
            <input
              value={missionName}
              onChange={(event) => setMissionName(event.target.value)}
              placeholder="Mission"
              required
            />
            <input
              value={departureTime}
              onChange={(event) => setDepartureTime(event.target.value)}
              placeholder="Departure time (HH:MM)"
              required
            />
            <div className="inlineRow twoCol">
              <input
                value={airport}
                onChange={(event) => setAirport(event.target.value.toUpperCase())}
                placeholder="Airport"
                maxLength={3}
                required
              />
              <input
                value={gate}
                onChange={(event) => setGate(event.target.value.toUpperCase())}
                placeholder="Gate"
                required
              />
            </div>
            <button type="submit" disabled={isBusy}>
              {activeAction === "create" ? "Creating..." : "Create Mission"}
            </button>
          </form>
        </section>

        <section className="panel">
          <div className="sectionHeaderRow">
            <h3>Copilot Assistant</h3>
            <span className="metaTag">translator only</span>
          </div>
          <p className="muted">
            Copilot is guidance + mission construction. It does not compute planning outputs; Core remains authoritative.
          </p>

          {!hasMission ? (
            <p className="helperLine">
              Mission constructor mode is active. Describe your trip and Copilot will request only missing fields.
            </p>
          ) : null}

          <div className="chatWindow" role="log" aria-live="polite">
            {chatMessages.slice(-14).map((message) => (
              <div key={message.id} className={`bubble ${message.role}`}>
                <span>{message.text}</span>
              </div>
            ))}
          </div>

          <form onSubmit={handleAskCopilot} className="stackForm">
            <textarea
              value={assistantPrompt}
              onChange={(event) => setAssistantPrompt(event.target.value)}
              placeholder="Ask Copilot"
              rows={3}
            />

            {hasMission ? (
              <>
                <div className="segmentRow">
                  {STYLE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={assistantResponseStyle === option.value ? "active" : ""}
                      onClick={() => setAssistantResponseStyle(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>

                <div className="segmentRow lengthRow">
                  {LENGTH_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={assistantResponseLength === option.value ? "active" : ""}
                      onClick={() => setAssistantResponseLength(option.value)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </>
            ) : null}

            <div className="inlineRow">
              <button type="submit" disabled={isBusy || trimMessage(assistantPrompt).length === 0}>
                {activeAction === "assistant" ? "Thinking..." : "Ask Copilot"}
              </button>
              <button type="button" onClick={clearChat} className="secondary" disabled={isBusy}>
                Clear Chat
              </button>
            </div>
          </form>

          {assistantMeta ? <p className="metaLine">{assistantMeta}</p> : null}
        </section>

        <section className="panel">
          <div className="sectionHeaderRow">
            <h3>Mission Status</h3>
            <button type="button" onClick={handleRefreshStatus} disabled={!missionId || isBusy}>
              {activeAction === "refresh" ? "Refreshing..." : "Refresh"}
            </button>
          </div>

          {missionStatus ? (
            <dl className="statusGrid">
              <div>
                <dt>Mission ID</dt>
                <dd className="smallMono">{missionStatus.mission_id}</dd>
              </div>
              <div>
                <dt>Risk</dt>
                <dd>{missionStatus.risk_level}</dd>
              </div>
              <div>
                <dt>Stability</dt>
                <dd>{missionStatus.status}</dd>
              </div>
              <div>
                <dt>Confidence</dt>
                <dd>{missionStatus.confidence.toFixed(3)}</dd>
              </div>
              <div className="fullRow">
                <dt>Recommendation</dt>
                <dd>{missionStatus.recommendation}</dd>
              </div>
              <div className="fullRow">
                <dt>Timestamp</dt>
                <dd>{missionStatus.timestamp}</dd>
              </div>
            </dl>
          ) : (
            <p className="muted">No mission yet.</p>
          )}

          <div className="inlineRow topGap">
            <button type="button" onClick={handleStartGrounding} disabled={!missionId || isBusy}>
              {activeAction === "start-grounding" ? "Starting..." : "Start Mission Mode"}
            </button>
            <button
              type="button"
              onClick={handleStopGrounding}
              disabled={!missionId || isBusy}
              className="secondary"
            >
              {activeAction === "stop-grounding" ? "Stopping..." : "Stop Mission Mode"}
            </button>
          </div>
        </section>

        <section className="panel">
          <h3>Structured Update (Grounding)</h3>
          <p className="muted">Send structured state only. No raw media goes to Core.</p>
          <form onSubmit={handleStructuredUpdate} className="stackForm">
            <input
              value={timestamp}
              onChange={(event) => setTimestamp(event.target.value)}
              placeholder="Timestamp (HH:MM)"
              required
            />
            <input
              value={location}
              onChange={(event) => setLocation(event.target.value)}
              placeholder="Location"
            />
            <div className="inlineRow twoCol">
              <input
                value={gateDetected}
                onChange={(event) => setGateDetected(event.target.value.toUpperCase())}
                placeholder="Gate detected"
              />
              <input
                value={signalConfidence}
                onChange={(event) => setSignalConfidence(event.target.value)}
                placeholder="Confidence 0-1"
              />
            </div>
            <button type="submit" disabled={!missionId || isBusy}>
              {activeAction === "update" ? "Sending..." : "Send Structured State"}
            </button>
          </form>
        </section>

        {error ? <p className="errorBanner">{error}</p> : null}
      </div>

      {isInfoOpen ? (
        <div className="modalOverlay" role="dialog" aria-modal="true" aria-label="About Triaia">
          <div className="modalCard">
            <div className="modalHeader">
              <h2>About Triaia</h2>
              <button type="button" className="secondary" onClick={() => setIsInfoOpen(false)}>
                Close
              </button>
            </div>

            <p>{INFO_DETAILS.overview}</p>

            <h3>What the app tracks</h3>
            <ul>
              {INFO_DETAILS.tracks.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>

            <h3>How a mission runs</h3>
            <ol>
              {INFO_DETAILS.flow.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ol>

            <h3>System boundaries</h3>
            <ul>
              {INFO_DETAILS.boundaries.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>

            <h3>Contact</h3>
            <p>
              For product and deployment support:{" "}
              <a href="mailto:contact@triaia.com" className="contactLink">
                contact@triaia.com
              </a>
            </p>
          </div>
        </div>
      ) : null}
    </main>
  );
}
