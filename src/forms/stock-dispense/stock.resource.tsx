import useSWR from 'swr';
import { openmrsFetch, useSession } from '@openmrs/esm-framework';
import { type DispenseStockLine, type InventoryItem, type MedicationDispense } from '../../types';

//TODO: Add configuration to retrieve the stock dispense endpoint
// For stock dispense to work, stock management module should be installed and configured
const getDispenseStockUrl = (drugUuid: string, locationUuid: string) =>
  `/ws/rest/v1/stockmanagement/stockiteminventory?v=default&totalCount=true&drugUuid=${drugUuid}&includeBatchNo=true&groupBy=LocationStockItemBatchNo&dispenseLocationUuid=${locationUuid}&includeStrength=1&includeConceptRefIds=1&emptyBatch=1&emptyBatchLocationUuid=${locationUuid}&dispenseAtLocation=1`;

/**
 * Fetches the inventory items for a given drug UUID.
 *
 * @param {string} drugUuid - The UUID of the drug.
 * @returns {Array} - The inventory items.
 */
export const useDispenseStock = (drugUuid: string) => {
  const session = useSession();
  const url = getDispenseStockUrl(drugUuid, session?.sessionLocation?.uuid);
  const { data, error, isLoading } = useSWR<{ data: { results: Array<InventoryItem> } }>(url, openmrsFetch);
  return { inventoryItems: data?.data?.results ?? [], error, isLoading };
};

/**
 * Fetches the inventory items for several drugs at once, keyed by drug UUID. Used where every
 * medication on a prescription has to be checked together, e.g. "Dispense all".
 */
export const useDispenseStockForDrugs = (drugUuids: Array<string>) => {
  const session = useSession();
  const locationUuid = session?.sessionLocation?.uuid;
  const uniqueDrugUuids = [...new Set(drugUuids.filter(Boolean))].sort();
  const { data, error, isLoading } = useSWR<Record<string, Array<InventoryItem>>>(
    locationUuid && uniqueDrugUuids.length ? ['dispenseStockForDrugs', locationUuid, ...uniqueDrugUuids] : null,
    async () => {
      const entries = await Promise.all(
        uniqueDrugUuids.map(async (drugUuid) => {
          const response = await openmrsFetch<{ results: Array<InventoryItem> }>(
            getDispenseStockUrl(drugUuid, locationUuid),
          );
          return [drugUuid, response.data?.results ?? []] as const;
        }),
      );
      return Object.fromEntries(entries);
    },
  );
  return { inventoryItemsByDrug: data ?? {}, error, isLoading };
};

// Applies a FHIR duration unit to a date, so a course length can be projected forward.
const durationUnitAppliers: Record<string, (date: Date, value: number) => void> = {
  s: (date, value) => date.setSeconds(date.getSeconds() + value),
  min: (date, value) => date.setMinutes(date.getMinutes() + value),
  h: (date, value) => date.setHours(date.getHours() + value),
  d: (date, value) => date.setDate(date.getDate() + value),
  wk: (date, value) => date.setDate(date.getDate() + value * 7),
  mo: (date, value) => date.setMonth(date.getMonth() + value),
  y: (date, value) => date.setFullYear(date.getFullYear() + value),
};

/**
 * The date the patient is expected to take their last dose: the furthest end date across
 * every dosage instruction that actually carries a duration. Uses the furthest rather than
 * any one of them, because a batch has to outlast the whole course, not just the shortest
 * leg of it.
 *
 * Returns null when no instruction carries a duration. "Course length unknown" is a
 * different thing from "course ends today" and must not be collapsed into it.
 */
function getLastMedicationDate(medicationToDispense: MedicationDispense): Date | null {
  const endDates = (medicationToDispense?.dosageInstruction ?? [])
    .map((instruction) => {
      const duration = instruction.timing?.repeat?.duration;
      const applyDuration = durationUnitAppliers[instruction.timing?.repeat?.durationUnit];
      if (!duration || !applyDuration) {
        return null;
      }
      const endDate = new Date();
      applyDuration(endDate, duration);
      return endDate.getTime();
    })
    .filter((time) => typeof time === 'number' && !Number.isNaN(time));

  return endDates.length ? new Date(Math.max(...endDates)) : null;
}

/**
 * Is this batch eligible to dispense against this prescription?
 *
 * The rule being enforced is "the batch must not expire before the patient finishes the
 * course". Where the course length is unknown there is nothing to enforce it against, so
 * the batch falls back to the weaker "not already expired" test instead of being rejected.
 *
 * Rejecting it was the previous behaviour, and it stranded prescriptions: an order entered
 * without a duration filtered out *every* batch, which left the batch selector empty and
 * the Dispense button disabled for good (see `dispense-form.workspace.tsx`). The prescription
 * then sat in the worklist as Active with no way for pharmacy to dispense it and no error
 * explaining why.
 */
function isValidBatch(
  medicationToDispense: MedicationDispense,
  inventoryItem: InventoryItem,
  validateBatch: boolean | undefined,
) {
  if (validateBatch === false) {
    return true;
  }

  // nothing to hand over from an empty batch, whatever its expiry says
  if (!(inventoryItem?.quantity > 0)) {
    return false;
  }

  const expiryDate = inventoryItem.expiration ? new Date(inventoryItem.expiration) : null;
  if (!expiryDate || Number.isNaN(expiryDate.getTime())) {
    // no usable expiry recorded on the batch, so there is no expiry claim to check
    return true;
  }

  const lastMedicationDate = getLastMedicationDate(medicationToDispense);

  return expiryDate > (lastMedicationDate ?? new Date());
}

/**
 * The batches this prescription may be dispensed from, first-expiry-first-out. Batches with
 * no usable expiry are dispensable but cannot be ordered against the rest, so they sort last
 * rather than comparing as NaN.
 */
export function getDispensableBatches(
  medicationDispense: MedicationDispense,
  inventoryItems: Array<InventoryItem>,
  validateBatch: boolean | undefined,
): Array<InventoryItem> {
  const expiryRank = (item: InventoryItem) => {
    const time = item.expiration ? new Date(item.expiration).getTime() : NaN;
    return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
  };
  return inventoryItems
    .filter((item) => isValidBatch(medicationDispense, item, validateBatch))
    .sort((a, b) => expiryRank(a) - expiryRank(b));
}

export type BatchAllocation = {
  inventoryItem: InventoryItem;
  quantity: number;
};

/**
 * Splits the quantity being dispensed across the batches the pharmacist picked, draining
 * them in the order given (callers pass them first-expiry-first-out). A batch on its own
 * may hold less than the prescription needs; the backend rejects any single line that would
 * take a batch below zero, so each batch is only ever asked for what it actually holds.
 *
 * Only whole units of a batch count, the same as the batch list shows them. A fraction left
 * behind by an earlier rounding (a batch holding 0.01, shown as "Quantity: 0") is never
 * allocated, since a line for it is rejected and with it the whole dispense.
 *
 * `shortfall` is what is left over once every selected batch is used up. Anything above zero
 * means the selection cannot cover the dispense and it must not be submitted.
 */
export function allocateQuantityAcrossBatches(
  batches: Array<InventoryItem>,
  quantityToDispense: number,
): { allocations: Array<BatchAllocation>; shortfall: number } {
  let remaining = quantityToDispense > 0 ? quantityToDispense : 0;
  const allocations: Array<BatchAllocation> = [];
  for (const inventoryItem of batches) {
    if (remaining <= 0) {
      break;
    }
    const available = inventoryItem.quantity > 0 ? Math.floor(inventoryItem.quantity) : 0;
    const quantity = Math.min(available, remaining);
    if (quantity > 0) {
      allocations.push({ inventoryItem, quantity });
      remaining -= quantity;
    }
  }
  return { allocations, shortfall: remaining };
}

/**
 * The stock lines of a dispense: one per batch the quantity was allocated to. They travel with
 * the dispense itself, and the backend saves both in one transaction, so a multi-batch dispense
 * either reduces every batch and is recorded, or does neither. The patient, prescription and
 * encounter the stock is issued against are taken from the dispense on the server.
 */
export const createDispenseStockLines = (allocations: Array<BatchAllocation>): Array<DispenseStockLine> =>
  allocations.map(({ inventoryItem, quantity }) => ({
    dispenseLocation: inventoryItem.locationUuid,
    stockItem: inventoryItem.stockItemUuid,
    stockBatch: inventoryItem.stockBatchUuid,
    stockItemPackagingUOM: inventoryItem.quantityUoMUuid,
    quantity,
  }));
