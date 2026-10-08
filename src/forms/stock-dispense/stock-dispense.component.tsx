import React from 'react';
import { useTranslation } from 'react-i18next';
import { InlineLoading, InlineNotification, Layer, MultiSelect } from '@carbon/react';
import { formatDate, useConfig } from '@openmrs/esm-framework';
import { type MedicationDispense, type InventoryItem } from '../../types';
import { type PharmacyConfig } from '../../config-schema';
import { allocateQuantityAcrossBatches, getDispensableBatches, useDispenseStock } from './stock.resource';

type StockDispenseProps = {
  medicationDispense: MedicationDispense;
  /** The quantity on the dispense form, which the selected batches have to cover between them. */
  quantityToDispense: number;
  /** Selected batches, always reported in first-expiry-first-out order. */
  updateInventoryItems: (inventoryItems: Array<InventoryItem>) => void;
  inventoryItems: Array<InventoryItem>;
};

const StockDispense: React.FC<StockDispenseProps> = ({
  medicationDispense,
  quantityToDispense,
  inventoryItems: selectedInventoryItems,
  updateInventoryItems,
}) => {
  const { t } = useTranslation();
  const config = useConfig<PharmacyConfig>();

  const drugUuid = medicationDispense?.medicationReference?.reference?.split('/')[1];
  const { inventoryItems, error, isLoading } = useDispenseStock(drugUuid);
  const validInventoryItems = getDispensableBatches(medicationDispense, inventoryItems, config?.validateBatch);

  // Total physical stock at this location, across all batches - independent of the
  // expiry-vs-duration filtering above, since a pharmacist checking "how much is left"
  // wants the real on-hand amount, not just what happens to be eligible to dispense.
  const totalQuantity = inventoryItems.reduce((sum, item) => sum + (item.quantity ?? 0), 0);
  const quantityUoM = inventoryItems[0]?.quantityUoM ?? '';
  const locationName = inventoryItems[0]?.partyName ?? '';

  const { allocations, shortfall } = allocateQuantityAcrossBatches(selectedInventoryItems, quantityToDispense);
  const selectedQuantity = selectedInventoryItems.reduce((sum, item) => sum + (item.quantity ?? 0), 0);

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
      <MultiSelect
        id="stockDispense"
        // Batches are passed by uuid rather than as objects: Carbon's MultiSelect silently drops
        // any item with an undefined property, which would hide e.g. a batch with no expiry.
        items={validInventoryItems.map((item) => item.stockBatchUuid)}
        selectedItems={selectedInventoryItems.map((item) => item.stockBatchUuid)}
        // keep the list in first-expiry-first-out order rather than Carbon's alphabetical default
        sortItems={(items) => [...items]}
        selectionFeedback="fixed"
        onChange={({ selectedItems }) => {
          // report in FEFO order whatever order they were clicked in, so allocation drains the
          // earliest-expiring batch first
          updateInventoryItems(validInventoryItems.filter((item) => selectedItems.includes(item.stockBatchUuid)));
        }}
        itemToString={(stockBatchUuid) => {
          const item = validInventoryItems.find((i) => i.stockBatchUuid === stockBatchUuid);
          return item ? toStockDispense(item) : '';
        }}
        titleText={t('stockDispense', 'Stock Dispense')}
        label={t('selectStockDispense', 'Select stock to dispense from')}
        helperText={t(
          'selectMultipleBatchesHelper',
          'Select more than one batch if a single batch does not hold enough to dispense.',
        )}
      />
      {allocations.length > 0 && (
        <ul aria-label={t('batchAllocation', 'Batch allocation')}>
          {allocations.map(({ inventoryItem, quantity }) => (
            <li key={inventoryItem.stockBatchUuid}>
              {t('batchAllocationDetails', 'Batch {{batchNumber}}: {{quantity}} {{quantityUoM}}', {
                batchNumber: inventoryItem.batchNumber,
                quantity,
                quantityUoM: inventoryItem.quantityUoM,
              })}
            </li>
          ))}
        </ul>
      )}
      {selectedInventoryItems.length > 0 && shortfall > 0 && (
        <InlineNotification
          aria-label="closes notification"
          kind="error"
          lowContrast={true}
          hideCloseButton={true}
          statusIconDescription="notification"
          title={t('insufficientBatchQuantity', 'Selected batches do not cover the quantity')}
          subtitle={t(
            'insufficientBatchQuantityDetails',
            'The selected batches hold {{selectedQuantity}} {{quantityUoM}} but {{quantityToDispense}} are being dispensed. Select another batch or reduce the quantity.',
            {
              selectedQuantity: Math.floor(selectedQuantity),
              quantityUoM,
              quantityToDispense,
            },
          )}
        />
      )}
    </Layer>
  );
};

export default StockDispense;
