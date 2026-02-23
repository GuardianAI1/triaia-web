import { PlannerSignal } from "@/app/lib/core-boundary";

type Regime = "hard" | "soft" | "resource";

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

export interface ContractDocumentInput {
  docType: ContractDocumentType;
  title: string;
  sourceLink: string;
  referenceCode: string;
  notes: string;
}

interface ActorPayload {
  id: string;
  budget_total: number;
  budget_remaining: number;
  deadline: number;
}

interface ResourcePayload {
  id: string;
  quantity_total: number;
  quantity_allocated: number;
}

interface ActionPayload {
  id: string;
  owner_actor_id: string;
  cost: number;
  duration: number;
  start_time: number;
  dependencies: string[];
  required_resources: Record<string, number>;
}

export interface ValidatePlanPayload {
  plan: {
    actors: Record<string, ActorPayload>;
    resources: Record<string, ResourcePayload>;
    actions: Record<string, ActionPayload>;
  };
}

function hasDocumentSignal(document: ContractDocumentInput): boolean {
  return [document.title, document.sourceLink, document.referenceCode, document.notes].some(
    (value) => value.trim().length > 0
  );
}

function ensurePositiveInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.max(1, Math.floor(value));
}

function nextTime(cursor: number, duration: number): number {
  return cursor + ensurePositiveInteger(duration, 10);
}

export function buildValidatePlanPayload(params: {
  regime: Regime;
  hardBoundaryMinutes: number | null;
  plannerSignal: PlannerSignal | null;
  documents: ContractDocumentInput[];
}): ValidatePlanPayload {
  const { regime, hardBoundaryMinutes, plannerSignal, documents } = params;

  const linkedDocuments = documents.filter(hasDocumentSignal);
  const planningHorizon = ensurePositiveInteger(hardBoundaryMinutes ?? 24 * 60, 24 * 60);
  const deadline = Math.max(90, planningHorizon);

  const actions: Record<string, ActionPayload> = {};
  let cursor = 0;

  actions.action_contract_open = {
    id: "action_contract_open",
    owner_actor_id: "actor_primary",
    cost: 6,
    duration: 15,
    start_time: cursor,
    dependencies: [],
    required_resources: {
      resource_focus_primary: 1
    }
  };
  cursor = nextTime(cursor + 5, 15);

  actions.action_support_sync = {
    id: "action_support_sync",
    owner_actor_id: "actor_support",
    cost: 4,
    duration: 12,
    start_time: 5,
    dependencies: [],
    required_resources: {
      resource_focus_support: 1
    }
  };

  let previousActionId = "action_contract_open";
  const boundedDocs = linkedDocuments.slice(0, 10);
  for (const [index, document] of boundedDocs.entries()) {
    const actionId = `action_doc_${index + 1}`;
    actions[actionId] = {
      id: actionId,
      owner_actor_id: "actor_primary",
      cost: 5,
      duration: 10,
      start_time: cursor,
      dependencies: [previousActionId, "action_support_sync"],
      required_resources: {
        resource_shared_channel: 1
      }
    };
    previousActionId = actionId;
    cursor = nextTime(cursor + 4, 10);

    if (document.docType === "boarding_pass" || document.docType === "flight_itinerary") {
      actions.action_boundary_lock = {
        id: "action_boundary_lock",
        owner_actor_id: "actor_support",
        cost: 4,
        duration: 8,
        start_time: cursor,
        dependencies: [previousActionId],
        required_resources: {
          resource_shared_channel: 1
        }
      };
      previousActionId = "action_boundary_lock";
      cursor = nextTime(cursor + 3, 8);
    }
  }

  if (!actions.action_boundary_commit) {
    actions.action_boundary_commit = {
      id: "action_boundary_commit",
      owner_actor_id: "actor_primary",
      cost: 6,
      duration: 14,
      start_time: cursor,
      dependencies: [previousActionId, "action_support_sync"],
      required_resources: {
        resource_shared_channel: 1
      }
    };
    previousActionId = "action_boundary_commit";
    cursor = nextTime(cursor + 6, 14);
  }

  if ((plannerSignal?.totalTasks ?? 0) > 0) {
    actions.action_load_stabilization = {
      id: "action_load_stabilization",
      owner_actor_id: "actor_support",
      cost: 6,
      duration: 12,
      start_time: cursor,
      dependencies: [previousActionId],
      required_resources: {
        resource_focus_support: 1
      }
    };
    previousActionId = "action_load_stabilization";
    cursor = nextTime(cursor + 2, 12);
  }

  const regimeFinalActionId =
    regime === "hard"
      ? "action_hard_boundary"
      : regime === "resource"
        ? "action_resource_margin"
        : "action_soft_objective";

  actions[regimeFinalActionId] = {
    id: regimeFinalActionId,
    owner_actor_id: "actor_primary",
    cost: 8,
    duration: 16,
    start_time: cursor,
    dependencies: [previousActionId],
    required_resources: {
      resource_focus_primary: 1
    }
  };

  const spendByActor = {
    actor_primary: 0,
    actor_support: 0
  };

  for (const actionId of Object.keys(actions)) {
    const action = actions[actionId];
    if (action.owner_actor_id === "actor_primary") {
      spendByActor.actor_primary += action.cost;
    } else if (action.owner_actor_id === "actor_support") {
      spendByActor.actor_support += action.cost;
    }
  }

  const actors: Record<string, ActorPayload> = {
    actor_primary: {
      id: "actor_primary",
      budget_total: spendByActor.actor_primary + 30,
      budget_remaining: 30,
      deadline
    },
    actor_support: {
      id: "actor_support",
      budget_total: spendByActor.actor_support + 20,
      budget_remaining: 20,
      deadline
    }
  };

  const resources: Record<string, ResourcePayload> = {
    resource_focus_primary: {
      id: "resource_focus_primary",
      quantity_total: 1,
      quantity_allocated: 0
    },
    resource_focus_support: {
      id: "resource_focus_support",
      quantity_total: 1,
      quantity_allocated: 0
    },
    resource_shared_channel: {
      id: "resource_shared_channel",
      quantity_total: 1,
      quantity_allocated: 0
    }
  };

  return {
    plan: {
      actors,
      resources,
      actions
    }
  };
}
