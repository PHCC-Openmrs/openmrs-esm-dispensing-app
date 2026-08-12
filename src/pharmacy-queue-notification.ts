import { getPrescriptionDetails } from './medication-request/medication-request.resource';
import { computePrescriptionStatus } from './utils';
import { MedicationRequestCombinedStatus } from './types';

// Consumed by esm-service-queues-app (if installed) to auto-end a patient's pharmacy queue
// entry. There is no shared event bus between these independently-versioned apps - this is
// the same plain window-CustomEvent convention esm-patient-chart-app already uses for
// 'visit-started'/'visit-ended', which esm-service-queues-app also listens for.
export const PHARMACY_FULFILLMENT_COMPLETED_EVENT = 'pharmacy-fulfillment-completed';

/**
 * Checks whether every medication request tied to the given prescription encounter has reached
 * a terminal state (completed, declined, cancelled, or expired - i.e. nothing active or on_hold
 * remains), and if so, dispatches `pharmacy-fulfillment-completed` so other apps can react to
 * "this patient's pharmacy visit is done."
 *
 * Call after a dispense/decline is saved - but not after pausing one (`on_hold` must not be
 * treated as complete).
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
    const medicationRequests = medicationRequestBundles.map((bundle) => bundle.request);
    const status = computePrescriptionStatus(medicationRequests, medicationRequestExpirationPeriodInDays);

    const isTerminal =
      status != null &&
      status !== MedicationRequestCombinedStatus.active &&
      status !== MedicationRequestCombinedStatus.on_hold;

    if (isTerminal) {
      window.dispatchEvent(
        new CustomEvent(PHARMACY_FULFILLMENT_COMPLETED_EVENT, { detail: { patientUuid, encounterUuid } }),
      );
    }
  } catch (error) {
    console.error('Failed to check prescription fulfillment status for pharmacy queue notification', error);
  }
}
