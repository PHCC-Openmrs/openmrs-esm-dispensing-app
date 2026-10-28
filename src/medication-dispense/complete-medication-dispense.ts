import {
  type DispenseRequestItem,
  type DispenseStockLine,
  type MedicationDispense,
  MedicationDispenseStatus,
  type MedicationRequestBundle,
  MedicationRequestFulfillerStatus,
} from '../types';
import { type PharmacyConfig } from '../config-schema';
import { computeNewFulfillerStatusAfterDispenseEvent, getFulfillerStatus } from '../utils';

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
 * The dispense as the backend stores it: with its status, the prepared time set to the
 * handed-over time (the two are not captured separately yet), and an id. A new dispense gets
 * the id generated for it when its form opened, so resubmitting after a lost response is
 * recognised as the same dispense rather than saved, and stock taken, a second time.
 */
export function prepareMedicationDispense(
  medicationDispense: MedicationDispense,
  status: MedicationDispenseStatus,
  newDispenseId: string,
): MedicationDispense {
  return {
    ...medicationDispense,
    id: medicationDispense.id || newDispenseId,
    status,
    whenPrepared: medicationDispense.whenHandedOver,
  };
}

/**
 * Builds the request item for a completed dispense: the dispense, the batches it is taken from,
 * and the prescription's new fulfiller status, which goes straight to completed when
 * `completeOrderWithThisDispense` is set and is otherwise whatever the dispensed total now
 * implies, sent only when it changes.
 */
export function buildCompletedDispenseItem(
  medicationDispense: MedicationDispense,
  medicationRequestBundle: MedicationRequestBundle,
  config: PharmacyConfig,
  newDispenseId: string,
  stock: Array<DispenseStockLine>,
): DispenseRequestItem {
  const item: DispenseRequestItem = {
    medicationDispense: prepareMedicationDispense(
      medicationDispense,
      MedicationDispenseStatus.completed,
      newDispenseId,
    ),
    restrictTotalQuantityDispensed: config.dispenseBehavior.restrictTotalQuantityDispensed,
    stock,
  };
  if (medicationDispense.id) {
    item.update = true;
  }

  if (config.completeOrderWithThisDispense) {
    item.fulfillerStatus = MedicationRequestFulfillerStatus.completed;
  } else {
    // computed before the new id is added: a dispense without an id is what tells this a new
    // dispense is joining the bundle rather than replacing one already in it
    const newFulfillerStatus = computeNewFulfillerStatusAfterDispenseEvent(
      { ...medicationDispense, status: MedicationDispenseStatus.completed },
      medicationRequestBundle,
      config.dispenseBehavior.restrictTotalQuantityDispensed,
    );
    if (getFulfillerStatus(medicationRequestBundle.request) !== newFulfillerStatus) {
      item.fulfillerStatus = newFulfillerStatus;
    }
  }
  return item;
}

/**
 * Builds the request item for a paused or closed dispense. Only a new one moves the
 * prescription's fulfiller status; editing an existing pause or close record leaves it alone.
 */
export function buildPausedOrClosedDispenseItem(
  medicationDispense: MedicationDispense,
  status: MedicationDispenseStatus.on_hold | MedicationDispenseStatus.declined,
  fulfillerStatus: MedicationRequestFulfillerStatus,
  newDispenseId: string,
): DispenseRequestItem {
  const prepared = prepareMedicationDispense(medicationDispense, status, newDispenseId);
  return medicationDispense.id
    ? { medicationDispense: prepared, update: true }
    : { medicationDispense: prepared, fulfillerStatus };
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
