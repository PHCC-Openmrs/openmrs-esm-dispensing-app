import dayjs from 'dayjs';
import {
  MedicationDispenseStatus,
  type MedicationRequest,
  type MedicationRequestBundle,
  MedicationRequestFulfillerStatus,
  MedicationRequestStatus,
} from './types';
import { getFulfillerStatus, getMostRecentMedicationDispenseStatus } from './utils';

/**
 * The single state a medication request can be in, from the pharmacist's point of view.
 *
 * This replaces the three overlapping status calculations this app used to carry
 * (request status, "combined" status and prescription status), all of which could
 * disagree with one another and with the buttons rendered alongside them.
 */
export enum PrescriptionState {
  active = 'active',
  paused = 'paused',
  closed = 'closed',
  completed = 'completed',
  expired = 'expired',
  cancelled = 'cancelled',
}

/**
 * The actions a pharmacist can take against a request. These map 1:1 onto the buttons
 * contributed to the `prescription-action-button-slot`.
 */
export enum PrescriptionAction {
  dispense = 'dispense',
  pause = 'pause',
  close = 'close',
}

/**
 * States from which no further pharmacy action is possible. Every *other* state must
 * offer at least one action, otherwise a request becomes stranded in the worklist with
 * no way to resolve it (see `prescription-state.test.ts`).
 */
export const TERMINAL_STATES: ReadonlyArray<PrescriptionState> = [
  PrescriptionState.closed,
  PrescriptionState.completed,
  PrescriptionState.cancelled,
];

/**
 * The state -> action table. This is the single source of truth for button visibility.
 *
 * Note that `expired` deliberately retains `close`: an expired request that pharmacy
 * never formally closed is exactly the one that needs closing, and gating every action
 * on `active` (as this app previously did) removed the only button that could resolve it.
 *
 * `paused` retains `dispense` because dispensing against a paused request is how a
 * pharmacist resumes it; there is no separate "resume" action.
 */
const ACTIONS_BY_STATE: Record<PrescriptionState, ReadonlyArray<PrescriptionAction>> = {
  [PrescriptionState.active]: [PrescriptionAction.dispense, PrescriptionAction.pause, PrescriptionAction.close],
  [PrescriptionState.paused]: [PrescriptionAction.dispense, PrescriptionAction.close],
  [PrescriptionState.expired]: [PrescriptionAction.close],
  [PrescriptionState.closed]: [],
  [PrescriptionState.completed]: [],
  [PrescriptionState.cancelled]: [],
};

/**
 * Display precedence when rolling several requests up into one prescription (encounter).
 * Ordered by how much pharmacy attention the state demands, so a row never advertises a
 * calmer state than the work it actually contains.
 */
const STATE_PRECEDENCE: ReadonlyArray<PrescriptionState> = [
  PrescriptionState.active,
  PrescriptionState.paused,
  PrescriptionState.expired,
  PrescriptionState.completed,
  PrescriptionState.closed,
  PrescriptionState.cancelled,
];

export interface PrescriptionStateOptions {
  /**
   * Fallback expiration window, used only for requests whose `validityPeriod.end` is
   * absent. When the backend supplies an expiry date (from the order's auto expire date)
   * that date is authoritative and this value is ignored.
   */
  medicationRequestExpirationPeriodInDays: number;
}

export interface ActionAvailabilityOptions {
  pauseButtonEnabled: boolean;
  closeButtonEnabled: boolean;
}

export interface PrescriptionStatusSummary {
  /** The state shown on the collapsed row. */
  dominantState: PrescriptionState;
  /** How many medication requests this prescription contains. */
  total: number;
  /** How many of them still have at least one action available. */
  actionableCount: number;
}

/**
 * Has this request passed its validity period?
 *
 * Prefers `validityPeriod.end` (the prescriber's own auto expire date) and falls back to
 * the configured window measured from `validityPeriod.start` only when no end date exists.
 * The configured window is a worklist convention, not a clinical fact, so it must never
 * override a real expiry date.
 */
export function isExpired(medicationRequest: MedicationRequest, medicationRequestExpirationPeriodInDays: number) {
  const validityPeriod = medicationRequest?.dispenseRequest?.validityPeriod;

  if (validityPeriod?.end) {
    return dayjs(validityPeriod.end).isBefore(dayjs());
  }

  if (validityPeriod?.start) {
    return dayjs(validityPeriod.start).isBefore(
      dayjs().startOf('day').subtract(medicationRequestExpirationPeriodInDays, 'day'),
    );
  }

  return false;
}

/**
 * Has this request passed an expiry date the prescriber actually set?
 *
 * Unlike `isExpired` this ignores the configured fallback window entirely, so it is hard
 * evidence that the request lapsed rather than a worklist convention. Only used where a
 * wrong answer would change a request's state, never merely how long it stays listed.
 */
function hasLapsed(medicationRequest: MedicationRequest): boolean {
  const end = medicationRequest?.dispenseRequest?.validityPeriod?.end;
  return Boolean(end) && dayjs(end).isBefore(dayjs());
}

/**
 * Did anything actually get handed over against this request?
 *
 * Used to tell genuine completion apart from a request the backend reports as `completed`
 * purely because its auto expire date passed. A request that completed without a single
 * dispense did not complete, it lapsed, and treating it as terminal is what strands it.
 */
function hasDispenseEvidence(medicationRequestBundle: MedicationRequestBundle): boolean {
  return (
    medicationRequestBundle.dispenses?.some((dispense) => dispense.status === MedicationDispenseStatus.completed) ??
    false
  );
}

/**
 * Reconciles the two places this app can learn that a request was paused or closed: the
 * `fulfillerStatus` extension the backend maintains on the request, and the status of the
 * most recent dispense recorded against it.
 *
 * These are supposed to agree. When they do not, the dispense records win (they are the
 * events; the extension is a denormalised cache of them) and the disagreement is logged,
 * because it means the backend did not propagate a dispense event and the request would
 * otherwise present the wrong state and the wrong buttons.
 */
function reconcileFulfillerStatus(medicationRequestBundle: MedicationRequestBundle): MedicationRequestFulfillerStatus {
  const { request, dispenses } = medicationRequestBundle;
  const extensionStatus = getFulfillerStatus(request);
  const mostRecentDispenseStatus = getMostRecentMedicationDispenseStatus(dispenses);

  let dispenseDerivedStatus: MedicationRequestFulfillerStatus = null;
  if (mostRecentDispenseStatus === MedicationDispenseStatus.declined) {
    dispenseDerivedStatus = MedicationRequestFulfillerStatus.declined;
  } else if (mostRecentDispenseStatus === MedicationDispenseStatus.on_hold) {
    dispenseDerivedStatus = MedicationRequestFulfillerStatus.on_hold;
  }

  // only a meaningful comparison when we actually have dispenses to derive a status from
  if (dispenses?.length && dispenseDerivedStatus !== extensionStatus) {
    console.warn(
      `Dispensing: fulfiller status mismatch on MedicationRequest/${request?.id}. ` +
        `Extension reports "${extensionStatus ?? 'none'}" but the most recent dispense implies ` +
        `"${dispenseDerivedStatus ?? 'none'}". Using the dispense records. This usually means the ` +
        `backend did not propagate the most recent dispense event onto the request.`,
    );
    return dispenseDerivedStatus;
  }

  return dispenseDerivedStatus ?? extensionStatus;
}

/**
 * Computes the one state for a medication request. Everything the pharmacist sees for
 * that request - its tag, its buttons, its contribution to the row summary - derives
 * from this function and nothing else.
 */
export function computePrescriptionState(
  medicationRequestBundle: MedicationRequestBundle,
  { medicationRequestExpirationPeriodInDays }: PrescriptionStateOptions,
): PrescriptionState {
  const request = medicationRequestBundle?.request;

  if (!request) {
    return PrescriptionState.cancelled;
  }

  // the prescriber revoking the order outranks anything pharmacy did with it
  if (request.status === MedicationRequestStatus.cancelled) {
    return PrescriptionState.cancelled;
  }

  const fulfillerStatus = reconcileFulfillerStatus(medicationRequestBundle);

  if (fulfillerStatus === MedicationRequestFulfillerStatus.declined) {
    return PrescriptionState.closed;
  }

  const expired = isExpired(request, medicationRequestExpirationPeriodInDays);
  const reportedComplete =
    fulfillerStatus === MedicationRequestFulfillerStatus.completed ||
    request.status === MedicationRequestStatus.completed;

  if (reportedComplete) {
    // A request reported as complete that is also past its expiry date with nothing ever
    // handed over did not complete, it lapsed - so treat it as expired and keep it
    // closable rather than stranding it in a terminal state with no way out.
    //
    // Both conditions are required deliberately. A bundle can legitimately arrive without
    // the dispenses behind a completed request, so absent dispenses alone must not demote
    // it; and the demotion keys off a real expiry date rather than the configured window,
    // because that window is a worklist convention and says nothing about what happened
    // to the order.
    if (hasLapsed(request) && !hasDispenseEvidence(medicationRequestBundle)) {
      return PrescriptionState.expired;
    }
    return PrescriptionState.completed;
  }

  // expiry outranks a pause: dispensing against a lapsed request is not appropriate,
  // so it must not keep offering the dispense action a paused request would
  if (expired || request.status === MedicationRequestStatus.expired) {
    return PrescriptionState.expired;
  }

  if (fulfillerStatus === MedicationRequestFulfillerStatus.on_hold) {
    return PrescriptionState.paused;
  }

  return PrescriptionState.active;
}

/**
 * The actions available from a given state, after applying the site's button configuration.
 */
export function getAvailableActions(
  state: PrescriptionState,
  { pauseButtonEnabled, closeButtonEnabled }: ActionAvailabilityOptions,
): ReadonlyArray<PrescriptionAction> {
  return (ACTIONS_BY_STATE[state] ?? []).filter((action) => {
    if (action === PrescriptionAction.pause) {
      return pauseButtonEnabled;
    }
    if (action === PrescriptionAction.close) {
      return closeButtonEnabled;
    }
    return true;
  });
}

/**
 * Rolls the states of every request in a prescription (encounter) up into the summary
 * shown on the collapsed table row.
 *
 * Unlike the "any request is active means the whole row is Active" rule this replaces,
 * the summary also reports how many requests still need attention, so a row can never
 * claim a state that none of its contents can act on.
 */
export function summarizePrescriptionStates(
  states: ReadonlyArray<PrescriptionState>,
  actionOptions: ActionAvailabilityOptions,
): PrescriptionStatusSummary {
  if (!states?.length) {
    return null;
  }

  const dominantState = STATE_PRECEDENCE.find((state) => states.includes(state)) ?? PrescriptionState.active;

  return {
    dominantState,
    total: states.length,
    actionableCount: states.filter((state) => getAvailableActions(state, actionOptions).length > 0).length,
  };
}
