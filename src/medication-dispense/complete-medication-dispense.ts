import { type FetchResponse } from '@openmrs/esm-framework';
import {
  type MedicationDispense,
  MedicationDispenseStatus,
  type MedicationRequestBundle,
  MedicationRequestFulfillerStatus,
} from '../types';
import { type PharmacyConfig } from '../config-schema';
import { computeNewFulfillerStatusAfterDispenseEvent, getFulfillerStatus, getUuidFromReference } from '../utils';
import { updateMedicationRequestFulfillerStatus } from '../medication-request/medication-request.resource';
import { saveMedicationDispense } from './medication-dispense.resource';

/**
 * Whether a dispense carries everything needed to be saved: a dispenser, a quantity with a
 * unit, either a fully coded or a free-text dosage (never a half-coded one), and a reason and
 * type for any substitution.
 */
export function isMedicationDispenseValid(medicationDispense: MedicationDispense, isFreeTextDosage: boolean): boolean {
  if (!medicationDispense) {
    return false;
  }
  const dosageInstruction = medicationDispense.dosageInstruction?.[0];
  const anyCodedDosage =
    dosageInstruction?.doseAndRate?.[0]?.doseQuantity?.value ||
    dosageInstruction?.doseAndRate?.[0]?.doseQuantity?.code ||
    dosageInstruction?.route?.coding?.[0]?.code ||
    dosageInstruction?.timing?.code?.coding?.[0]?.code;

  const allCodedDosage =
    dosageInstruction?.doseAndRate?.[0]?.doseQuantity?.value &&
    dosageInstruction?.doseAndRate?.[0]?.doseQuantity?.code &&
    dosageInstruction?.route?.coding?.[0]?.code &&
    dosageInstruction?.timing?.code?.coding?.[0]?.code;

  return Boolean(
    medicationDispense.performer &&
      medicationDispense.performer[0]?.actor.reference &&
      medicationDispense.quantity?.value &&
      medicationDispense.quantity?.code &&
      ((allCodedDosage && !isFreeTextDosage) || (!anyCodedDosage && isFreeTextDosage && dosageInstruction?.text)) &&
      (!medicationDispense.substitution?.wasSubstituted ||
        (medicationDispense.substitution.reason[0]?.coding[0].code &&
          medicationDispense.substitution.type?.coding[0].code)),
  );
}

/**
 * Saves a dispense as completed and moves the prescription's fulfiller status on to match:
 * straight to completed when `completeOrderWithThisDispense` is set, otherwise to whatever the
 * dispensed total now implies. Stock is not touched here; callers send the stock dispense
 * request once this has succeeded.
 */
export function completeMedicationDispense(
  medicationDispense: MedicationDispense,
  medicationRequestBundle: MedicationRequestBundle,
  config: PharmacyConfig,
  abortController?: AbortController,
): Promise<FetchResponse> {
  return saveMedicationDispense(medicationDispense, MedicationDispenseStatus.completed, abortController).then(
    (response) => {
      if (!response.ok) {
        return response;
      }
      // assumes the authorizing prescription exists
      const medicationRequestUuid = getUuidFromReference(medicationDispense.authorizingPrescription[0].reference);
      if (config.completeOrderWithThisDispense) {
        return updateMedicationRequestFulfillerStatus(
          medicationRequestUuid,
          MedicationRequestFulfillerStatus.completed,
        ).then(() => response);
      }
      const newFulfillerStatus = computeNewFulfillerStatusAfterDispenseEvent(
        medicationDispense,
        medicationRequestBundle,
        config.dispenseBehavior.restrictTotalQuantityDispensed,
      );
      if (getFulfillerStatus(medicationRequestBundle.request) !== newFulfillerStatus) {
        return updateMedicationRequestFulfillerStatus(medicationRequestUuid, newFulfillerStatus).then(() => response);
      }
      return response;
    },
  );
}

/**
 * The most recent completed dispense of the same medication, quantity and dose within
 * `duplicateCheckWindowDays` before this one, if there is one. `dispense` itself is never
 * reported as its own duplicate when it is being edited.
 */
export function findDuplicateDispense(
  dispense: MedicationDispense,
  existingDispenses: Array<MedicationDispense>,
  duplicateCheckWindowDays: number,
): MedicationDispense | undefined {
  const getDispenseDate = (d: MedicationDispense) => d.whenHandedOver ?? d.whenPrepared;
  const getTime = (date?: string) => {
    if (!date) {
      return null;
    }

    const parsedTime = new Date(date).getTime();
    return Number.isNaN(parsedTime) ? null : parsedTime;
  };
  const windowMs = duplicateCheckWindowDays * 24 * 60 * 60 * 1000;
  const currentDispenseTime = getTime(getDispenseDate(dispense)) ?? Date.now();

  return (existingDispenses ?? [])
    .filter((d) => d.status === MedicationDispenseStatus.completed)
    .filter((d) => {
      const dispenseTime = getTime(getDispenseDate(d));
      if (dispenseTime === null) {
        return false;
      }

      // Duplicate checks are relative to the dispense date being submitted, not "now".
      return dispenseTime <= currentDispenseTime && currentDispenseTime - dispenseTime <= windowMs;
    })
    .sort((a, b) => {
      return getTime(getDispenseDate(b)) - getTime(getDispenseDate(a));
    })
    .find((existingDispense) => {
      if (existingDispense.id && dispense.id && existingDispense.id === dispense.id) {
        return false;
      }
      const sameMedication =
        existingDispense.medicationCodeableConcept?.coding?.[0]?.code ===
        dispense.medicationCodeableConcept?.coding?.[0]?.code;
      const sameQuantity =
        existingDispense.quantity?.value === dispense.quantity?.value &&
        existingDispense.quantity?.code === dispense.quantity?.code;
      const sameDose =
        existingDispense.dosageInstruction?.[0]?.doseAndRate?.[0]?.doseQuantity?.value ===
          dispense.dosageInstruction?.[0]?.doseAndRate?.[0]?.doseQuantity?.value &&
        existingDispense.dosageInstruction?.[0]?.doseAndRate?.[0]?.doseQuantity?.code ===
          dispense.dosageInstruction?.[0]?.doseAndRate?.[0]?.doseQuantity?.code;
      return sameMedication && sameQuantity && sameDose;
    });
}
