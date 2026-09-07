import { getPrescriptionDetails } from './medication-request/medication-request.resource';
import { computePrescriptionState, summarizePrescriptionStates } from './prescription-state';

// Consumed by esm-service-queues-app (if installed) to auto-end a patient's pharmacy queue
// entry. There is no shared event bus between these independently-versioned apps - this is
// the same plain window-CustomEvent convention esm-patient-chart-app already uses for
// 'visit-started'/'visit-ended', which esm-service-queues-app also listens for.
export const PHARMACY_FULFILLMENT_COMPLETED_EVENT = 'pharmacy-fulfillment-completed';

/**
 * Checks whether every medication request tied to the given prescription encounter is finished
 * with pharmacy - meaning none of them has an action left for a pharmacist to take - and if so,
 * dispatches `pharmacy-fulfillment-completed` so other apps can react to "this patient's
 * pharmacy visit is done."
 *
 * "Finished" is deliberately the same state -> action table the buttons use, so the queue entry
 * cannot be ended while a request in the prescription still shows a button. Note that this keeps
 * the entry open for an expired request nobody has closed yet, which is outstanding pharmacy work
 * even though nothing more can be dispensed against it.
 *
 * Call after a dispense/decline is saved - but not after pausing one (a paused request can still
 * be dispensed, so it is not finished).
 */
export async function notifyIfPrescriptionFulfillmentComplete(
  encounterUuid: string,
  patientUuid: string,
  medicationRequestExpirationPeriodInDays: number,
): Promise<void> {
  if (!encounterUuid || !patientUuid) {
    return;
  }

  try {
    const { medicationRequestBundles } = await getPrescriptionDetails(encounterUuid);
    const states = medicationRequestBundles.map((bundle) =>
      computePrescriptionState(bundle, { medicationRequestExpirationPeriodInDays }),
    );
    // asks whether any pharmacy action remains at all, rather than whether this particular
    // site happens to show the button for it
    const summary = summarizePrescriptionStates(states, { pauseButtonEnabled: true, closeButtonEnabled: true });

    if (summary != null && summary.actionableCount === 0) {
      window.dispatchEvent(
        new CustomEvent(PHARMACY_FULFILLMENT_COMPLETED_EVENT, { detail: { patientUuid, encounterUuid } }),
      );
    }
  } catch (error) {
    console.error('Failed to check prescription fulfillment status for pharmacy queue notification', error);
  }
}
