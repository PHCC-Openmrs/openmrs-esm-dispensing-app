import React from 'react';
import { useTranslation } from 'react-i18next';
import { ComboBox, InlineLoading, InlineNotification, Layer } from '@carbon/react';
import { formatDate, useConfig } from '@openmrs/esm-framework';
import { type MedicationDispense, type InventoryItem } from '../../types';
import { type PharmacyConfig } from '../../config-schema';
import { useDispenseStock } from './stock.resource';

type StockDispenseProps = {
  medicationDispense: MedicationDispense;
  updateInventoryItem: (inventoryItem: InventoryItem) => void;
  inventoryItem: InventoryItem;
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

const StockDispense: React.FC<StockDispenseProps> = ({ medicationDispense, updateInventoryItem }) => {
  const { t } = useTranslation();
  const config = useConfig<PharmacyConfig>();

  const drugUuid = medicationDispense?.medicationReference?.reference?.split('/')[1];
  const { inventoryItems, error, isLoading } = useDispenseStock(drugUuid);
  // First-expiry-first-out. Batches with no usable expiry are dispensable but cannot be
  // ordered against the rest, so they sort last rather than comparing as NaN.
  const expiryRank = (item: InventoryItem) => {
    const time = item.expiration ? new Date(item.expiration).getTime() : NaN;
    return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
  };
  const validInventoryItems = inventoryItems
    .filter((item) => isValidBatch(medicationDispense, item))
    .sort((a, b) => expiryRank(a) - expiryRank(b));

  // Total physical stock at this location, across all batches - independent of the
  // expiry-vs-duration filtering above, since a pharmacist checking "how much is left"
  // wants the real on-hand amount, not just what happens to be eligible to dispense.
  const totalQuantity = inventoryItems.reduce((sum, item) => sum + (item.quantity ?? 0), 0);
  const quantityUoM = inventoryItems[0]?.quantityUoM ?? '';
  const locationName = inventoryItems[0]?.partyName ?? '';

  /**
   * Is this batch eligible to dispense against this prescription?
   *
   * The rule being enforced is "the batch must not expire before the patient finishes the
   * course". Where the course length is unknown there is nothing to enforce it against, so
   * the batch falls back to the weaker "not already expired" test instead of being rejected.
   *
   * Rejecting it was the previous behaviour, and it stranded prescriptions: an order entered
   * without a duration filtered out *every* batch, which left the batch selector empty, and
   * an empty selector leaves `inventoryItem` undefined, which keeps the Dispense button
   * disabled for good (see `dispense-form.workspace.tsx`). The prescription then sits in the
   * worklist as Active with no way for pharmacy to dispense it and no error explaining why.
   */
  function isValidBatch(medicationToDispense: MedicationDispense, inventoryItem: InventoryItem) {
    if (typeof config !== 'undefined' && !config.validateBatch) {
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

  const toStockDispense = (inventoryItem: InventoryItem) => {
    // A batch with no usable expiry is now dispensable (there is no expiry claim to fail),
    // so its label has to render without one - `formatDate` throws on an invalid date.
    const expiryDate = inventoryItem.expiration ? new Date(inventoryItem.expiration) : null;
    const expiration =
      expiryDate && !Number.isNaN(expiryDate.getTime())
        ? formatDate(expiryDate)
        : t('noExpiryRecorded', 'not recorded');

    return t(
      'stockDispenseDetails',
      'Batch: {{batchNumber}} - Quantity: {{quantity}} ({{quantityUoM}}) - Expiry: {{expiration}}',
      {
        batchNumber: inventoryItem.batchNumber,
        quantity: Math.floor(inventoryItem.quantity),
        quantityUoM: inventoryItem.quantityUoM,
        expiration,
      },
    );
  };

  if (error) {
    return (
      <InlineNotification
        aria-label="closes notification"
        kind="error"
        lowContrast={true}
        statusIconDescription="notification"
        subtitle={t('errorLoadingInventoryItems', 'Error fetching inventory items')}
        title={t('error', 'Error')}
      />
    );
  }

  if (isLoading) {
    return <InlineLoading description={t('loadingInventoryItems', 'Loading inventory items...')} />;
  }

  return (
    <Layer>
      {totalQuantity > 0 ? (
        <InlineNotification
          aria-label="closes notification"
          kind="info"
          lowContrast={true}
          hideCloseButton={true}
          statusIconDescription="notification"
          title={t('stockAvailable', 'Available in stock')}
          subtitle={t('stockAvailableDetails', '{{quantity}} {{quantityUoM}} left at {{location}}', {
            quantity: Math.floor(totalQuantity),
            quantityUoM,
            location: locationName,
          })}
        />
      ) : (
        <InlineNotification
          aria-label="closes notification"
          kind="warning"
          lowContrast={true}
          hideCloseButton={true}
          statusIconDescription="notification"
          title={t('noStockAvailable', 'No item in inventory')}
          subtitle={t('noStockAvailableDetails', 'There is no stock of this medicine at {{location}}', {
            location: locationName,
          })}
        />
      )}
      {totalQuantity > 0 && validInventoryItems.length === 0 && (
        <InlineNotification
          aria-label="closes notification"
          kind="warning"
          lowContrast={true}
          hideCloseButton={true}
          statusIconDescription="notification"
          title={t('noDispensableBatch', 'No batch can be dispensed')}
          subtitle={t(
            'noDispensableBatchDetails',
            'This medicine is in stock, but no batch expires late enough to cover this prescription. Check the batch expiry dates, or the duration on the prescription.',
          )}
        />
      )}
      <ComboBox
        id="stockDispense"
        items={validInventoryItems}
        onChange={({ selectedItem }) => {
          updateInventoryItem(selectedItem);
        }}
        itemToString={(item) => (item ? toStockDispense(item) : '')}
        titleText={t('stockDispense', 'Stock Dispense')}
        placeholder={t('selectStockDispense', 'Select stock to dispense from')}
      />
    </Layer>
  );
};

export default StockDispense;
