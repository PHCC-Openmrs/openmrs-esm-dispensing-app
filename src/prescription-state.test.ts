import dayjs from 'dayjs';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  MedicationDispenseStatus,
  type MedicationDispense,
  type MedicationRequest,
  type MedicationRequestBundle,
  MedicationRequestFulfillerStatus,
  MedicationRequestStatus,
} from './types';
import { OPENMRS_FHIR_EXT_REQUEST_FULFILLER_STATUS } from './constants';
import {
  computePrescriptionState,
  getAvailableActions,
  isExpired,
  PrescriptionAction,
  PrescriptionState,
  summarizePrescriptionStates,
  TERMINAL_STATES,
} from './prescription-state';

const allButtonsEnabled = { pauseButtonEnabled: true, closeButtonEnabled: true };
const options = { medicationRequestExpirationPeriodInDays: 90 };

function buildRequest(overrides: Partial<MedicationRequest> = {}): MedicationRequest {
  return {
    resourceType: 'MedicationRequest',
    id: 'request-1',
    status: MedicationRequestStatus.active,
    dispenseRequest: {
      numberOfRepeatsAllowed: 0,
      quantity: { value: 30, code: 'tablet' },
      validityPeriod: { start: dayjs().subtract(2, 'day').toISOString() },
    },
    ...overrides,
  } as MedicationRequest;
}

function withFulfillerStatus(request: MedicationRequest, status: MedicationRequestFulfillerStatus): MedicationRequest {
  return {
    ...request,
    extension: [{ url: OPENMRS_FHIR_EXT_REQUEST_FULFILLER_STATUS, valueCode: status }],
  } as MedicationRequest;
}

function buildDispense(status: MedicationDispenseStatus, whenHandedOver = dayjs().toISOString()): MedicationDispense {
  return { resourceType: 'MedicationDispense', id: `dispense-${status}`, status, whenHandedOver } as MedicationDispense;
}

function bundle(request: MedicationRequest, dispenses: Array<MedicationDispense> = []): MedicationRequestBundle {
  return { request, dispenses };
}

describe('computePrescriptionState', () => {
  it('reports a fresh request within its validity period as active', () => {
    expect(computePrescriptionState(bundle(buildRequest()), options)).toBe(PrescriptionState.active);
  });

  it('reports a request the prescriber cancelled as cancelled, whatever pharmacy did with it', () => {
    const request = withFulfillerStatus(
      buildRequest({ status: MedicationRequestStatus.cancelled }),
      MedicationRequestFulfillerStatus.on_hold,
    );
    expect(computePrescriptionState(bundle(request), options)).toBe(PrescriptionState.cancelled);
  });

  it('reports a declined request as closed', () => {
    const request = withFulfillerStatus(buildRequest(), MedicationRequestFulfillerStatus.declined);
    expect(computePrescriptionState(bundle(request, [buildDispense(MedicationDispenseStatus.declined)]), options)).toBe(
      PrescriptionState.closed,
    );
  });

  it('reports an on-hold request as paused', () => {
    const request = withFulfillerStatus(buildRequest(), MedicationRequestFulfillerStatus.on_hold);
    expect(computePrescriptionState(bundle(request, [buildDispense(MedicationDispenseStatus.on_hold)]), options)).toBe(
      PrescriptionState.paused,
    );
  });

  it('reports a request completed by an actual dispense as completed', () => {
    const request = withFulfillerStatus(
      buildRequest({ status: MedicationRequestStatus.completed }),
      MedicationRequestFulfillerStatus.completed,
    );
    expect(
      computePrescriptionState(bundle(request, [buildDispense(MedicationDispenseStatus.completed)]), options),
    ).toBe(PrescriptionState.completed);
  });

  // this is the order-381 case: the order lapsed at its auto expire date and the backend
  // reports it as completed even though nothing was ever handed over, which used to strip
  // every button from it while the worklist still called it "Active"
  it('reports a lapsed request marked completed with no dispense behind it as expired', () => {
    const request = buildRequest({
      status: MedicationRequestStatus.completed,
      dispenseRequest: {
        numberOfRepeatsAllowed: 1,
        quantity: { value: 33, code: 'bag' },
        validityPeriod: {
          start: dayjs().subtract(13, 'day').toISOString(),
          end: dayjs().subtract(11, 'day').toISOString(),
        },
      },
    } as Partial<MedicationRequest>);
    expect(computePrescriptionState(bundle(request), options)).toBe(PrescriptionState.expired);
  });

  // a bundle can legitimately arrive without the dispenses behind it, so a completed
  // request still inside its validity period must not be demoted to expired
  it('keeps an unexpired request reported as completed as completed, even with no dispenses in the bundle', () => {
    const request = buildRequest({ status: MedicationRequestStatus.completed });
    expect(computePrescriptionState(bundle(request), options)).toBe(PrescriptionState.completed);
  });

  it('keeps a request carrying no dispense request at all as completed when the backend says so', () => {
    const request = { resourceType: 'MedicationRequest', id: 'request-1', status: MedicationRequestStatus.completed };
    expect(computePrescriptionState(bundle(request as MedicationRequest), options)).toBe(PrescriptionState.completed);
  });

  // the configured window governs how long a request stays in the worklist; it is not
  // evidence about what happened to the order, so it must never demote a completed one
  it('does not demote a completed request on the configured window alone', () => {
    const request = buildRequest({
      status: MedicationRequestStatus.completed,
      dispenseRequest: {
        numberOfRepeatsAllowed: 8,
        quantity: { value: 30, code: 'tablet' },
        // long past the 90 day window, but the prescriber set no expiry date
        validityPeriod: { start: dayjs().subtract(3, 'year').toISOString() },
      },
    } as Partial<MedicationRequest>);
    expect(computePrescriptionState(bundle(request), options)).toBe(PrescriptionState.completed);
  });

  it('prefers the prescriber-supplied expiry date over the configured window', () => {
    const request = buildRequest({
      dispenseRequest: {
        numberOfRepeatsAllowed: 0,
        quantity: { value: 30, code: 'tablet' },
        validityPeriod: {
          // well inside the 90 day configured window, but past its own expiry date
          start: dayjs().subtract(13, 'day').toISOString(),
          end: dayjs().subtract(11, 'day').toISOString(),
        },
      },
    } as Partial<MedicationRequest>);
    expect(computePrescriptionState(bundle(request), options)).toBe(PrescriptionState.expired);
  });

  it('does not expire a request whose expiry date is still in the future', () => {
    const request = buildRequest({
      dispenseRequest: {
        numberOfRepeatsAllowed: 0,
        quantity: { value: 30, code: 'tablet' },
        validityPeriod: {
          start: dayjs().subtract(13, 'day').toISOString(),
          end: dayjs().add(25, 'day').toISOString(),
        },
      },
    } as Partial<MedicationRequest>);
    expect(computePrescriptionState(bundle(request), options)).toBe(PrescriptionState.active);
  });

  it('falls back to the configured window when no expiry date is supplied', () => {
    const request = buildRequest({
      dispenseRequest: {
        numberOfRepeatsAllowed: 0,
        quantity: { value: 30, code: 'tablet' },
        validityPeriod: { start: dayjs().subtract(91, 'day').toISOString() },
      },
    } as Partial<MedicationRequest>);
    expect(computePrescriptionState(bundle(request), options)).toBe(PrescriptionState.expired);
  });

  it('expiry outranks a pause, so a lapsed request stops offering dispense', () => {
    const request = withFulfillerStatus(
      buildRequest({
        dispenseRequest: {
          numberOfRepeatsAllowed: 0,
          quantity: { value: 30, code: 'tablet' },
          validityPeriod: {
            start: dayjs().subtract(13, 'day').toISOString(),
            end: dayjs().subtract(1, 'day').toISOString(),
          },
        },
      } as Partial<MedicationRequest>),
      MedicationRequestFulfillerStatus.on_hold,
    );
    expect(computePrescriptionState(bundle(request, [buildDispense(MedicationDispenseStatus.on_hold)]), options)).toBe(
      PrescriptionState.expired,
    );
  });

  describe('when the fulfiller status extension disagrees with the dispense records', () => {
    let warn: MockInstance;

    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
      warn.mockRestore();
    });

    it('trusts the dispense records and logs the mismatch', () => {
      // the backend never propagated the decline onto the request
      const request = buildRequest();
      const state = computePrescriptionState(
        bundle(request, [buildDispense(MedicationDispenseStatus.declined)]),
        options,
      );

      expect(state).toBe(PrescriptionState.closed);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('fulfiller status mismatch'));
    });

    it('stays quiet when there are no dispenses to disagree with', () => {
      computePrescriptionState(bundle(buildRequest()), options);
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

describe('isExpired', () => {
  it('treats a request with no validity period as unexpired', () => {
    expect(isExpired({ id: 'request-1' } as MedicationRequest, 90)).toBe(false);
  });
});

describe('getAvailableActions', () => {
  it('offers everything on an active request', () => {
    expect(getAvailableActions(PrescriptionState.active, allButtonsEnabled)).toEqual([
      PrescriptionAction.dispense,
      PrescriptionAction.pause,
      PrescriptionAction.close,
    ]);
  });

  it('keeps an expired request closable so it cannot be stranded', () => {
    expect(getAvailableActions(PrescriptionState.expired, allButtonsEnabled)).toEqual([PrescriptionAction.close]);
  });

  it('lets a paused request be dispensed, which is how it is resumed', () => {
    expect(getAvailableActions(PrescriptionState.paused, allButtonsEnabled)).toContain(PrescriptionAction.dispense);
  });

  it('does not offer pause twice on an already paused request', () => {
    expect(getAvailableActions(PrescriptionState.paused, allButtonsEnabled)).not.toContain(PrescriptionAction.pause);
  });

  it('respects the site disabling the pause and close buttons', () => {
    expect(
      getAvailableActions(PrescriptionState.active, { pauseButtonEnabled: false, closeButtonEnabled: false }),
    ).toEqual([PrescriptionAction.dispense]);
  });

  // the invariant that makes the reported bug structurally impossible: a request the
  // pharmacist can still resolve must always expose a way to resolve it
  it.each(Object.values(PrescriptionState).filter((state) => !TERMINAL_STATES.includes(state as PrescriptionState)))(
    'leaves at least one action available in the non-terminal state "%s"',
    (state) => {
      expect(getAvailableActions(state as PrescriptionState, allButtonsEnabled).length).toBeGreaterThan(0);
    },
  );

  it.each(TERMINAL_STATES)('offers no actions in the terminal state "%s"', (state) => {
    expect(getAvailableActions(state, allButtonsEnabled)).toEqual([]);
  });
});

describe('summarizePrescriptionStates', () => {
  it('returns null for a prescription with no requests', () => {
    expect(summarizePrescriptionStates([], allButtonsEnabled)).toBeNull();
  });

  it('counts only the requests that still have an action available', () => {
    expect(
      summarizePrescriptionStates(
        [PrescriptionState.active, PrescriptionState.expired, PrescriptionState.completed],
        allButtonsEnabled,
      ),
    ).toEqual({ dominantState: PrescriptionState.active, total: 3, actionableCount: 2 });
  });

  it('surfaces the state that most demands attention', () => {
    expect(
      summarizePrescriptionStates([PrescriptionState.completed, PrescriptionState.paused], allButtonsEnabled)
        .dominantState,
    ).toBe(PrescriptionState.paused);
  });

  it('does not advertise an actionable state for a fully resolved prescription', () => {
    const summary = summarizePrescriptionStates(
      [PrescriptionState.completed, PrescriptionState.closed],
      allButtonsEnabled,
    );
    expect(summary.actionableCount).toBe(0);
    expect(TERMINAL_STATES).toContain(summary.dominantState);
  });
});
