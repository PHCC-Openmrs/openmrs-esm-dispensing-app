import React, { useMemo, useState } from 'react';
import { useSWRConfig } from 'swr';
import { useTranslation } from 'react-i18next';
import { Button, InlineNotification, Modal } from '@carbon/react';
import { formatDate, type Session, showSnackbar, useConfig, useSession } from '@openmrs/esm-framework';
import { type InventoryItem, type MedicationDispense, type MedicationRequestBundle, type Provider } from '../types';
import { type PharmacyConfig } from '../config-schema';
import {
  calculateIsFreeTextDosage,
  getDosageInstruction,
  getMedicationDisplay,
  getMedicationReferenceOrCodeableConcept,
  getUuidFromReference,
  markEncounterAsStale,
  revalidate,
} from '../utils';
import { computePrescriptionState, PrescriptionState } from '../prescription-state';
import { initiateMedicationDispenseBody, useProviders } from '../medication-dispense/medication-dispense.resource';
import {
  completeMedicationDispense,
  findDuplicateDispense,
  isMedicationDispenseValid,
} from '../medication-dispense/complete-medication-dispense';
import {
  createStockDispenseRequestPayload,
  getDispensableBatches,
  sendStockDispenseRequest,
  useDispenseStockForDrugs,
} from '../forms/stock-dispense/stock.resource';
import { notifyIfPrescriptionFulfillmentComplete } from '../pharmacy-queue-notification';

export type DispenseAllItem = {
  medicationRequestBundle: MedicationRequestBundle;
  medicationDispense: MedicationDispense;
  drugUuid: string | undefined;
  /** The earliest-expiring dispensable batch; only set when stock dispensing is enabled. */
  batch?: InventoryItem;
};

/**
 * Works out what "Dispense all" would do for these prescriptions, or why it cannot.
 *
 * Every active prescription is included, each with exactly the
 * dispense the Dispense button would pre-fill. "Dispense all" is only offered when none of
 * them needs a human decision:
 *  - each pre-filled dispense is already valid (dispenser, quantity, dosage), and
 *  - with stock dispensing on, the earliest-expiring eligible batch of each drug holds enough
 *    for everything being dispensed of that drug. A prescription that would need a second
 *    batch, or has no stock, goes through the normal Dispense form instead.
 */
export function planDispenseAll(
  medicationRequestBundles: Array<MedicationRequestBundle>,
  inventoryItemsByDrug: Record<string, Array<InventoryItem>>,
  session: Session,
  providers: Array<Provider>,
  config: PharmacyConfig,
): { items: Array<DispenseAllItem>; canDispenseAll: boolean } {
  const items: Array<DispenseAllItem> = (medicationRequestBundles ?? [])
    // Only active prescriptions. A paused one can still be dispensed on its own (that is how
    // it is resumed), but someone paused it on purpose, so a bulk action must not sweep it up.
    .filter(
      (bundle) =>
        computePrescriptionState(bundle, {
          medicationRequestExpirationPeriodInDays: config.medicationRequestExpirationPeriodInDays,
        }) === PrescriptionState.active,
    )
    .map((medicationRequestBundle) => {
      const medicationDispense = initiateMedicationDispenseBody(
        medicationRequestBundle.request,
        session,
        providers,
        true,
      );
      const drugUuid = medicationDispense.medicationReference?.reference
        ? getUuidFromReference(medicationDispense.medicationReference.reference)
        : undefined;
      const batch =
        config.enableStockDispense && drugUuid
          ? getDispensableBatches(medicationDispense, inventoryItemsByDrug[drugUuid] ?? [], config.validateBatch)[0]
          : undefined;
      return { medicationRequestBundle, medicationDispense, drugUuid, batch };
    });

  const allValid = items.every(({ medicationDispense }) => {
    const dosageInstruction = getDosageInstruction(medicationDispense.dosageInstruction);
    const isFreeTextDosage = dosageInstruction ? calculateIsFreeTextDosage(dosageInstruction) : false;
    return isMedicationDispenseValid(medicationDispense, isFreeTextDosage);
  });

  // Two prescriptions for the same drug draw on the same earliest batch, so it has to cover
  // their combined quantity, not each one separately.
  const neededByBatch = new Map<string, number>();
  items.forEach(({ batch, medicationDispense }) => {
    if (batch) {
      neededByBatch.set(
        batch.stockBatchUuid,
        (neededByBatch.get(batch.stockBatchUuid) ?? 0) + (medicationDispense.quantity?.value ?? 0),
      );
    }
  });
  const stockCovered =
    !config.enableStockDispense ||
    items.every(({ batch }) => batch && batch.quantity >= neededByBatch.get(batch.stockBatchUuid));

  return { items, canDispenseAll: items.length > 1 && allValid && stockCovered };
}

type DispenseAllActionProps = {
  encounterUuid: string;
  patientUuid: string;
  medicationRequestBundles: Array<MedicationRequestBundle>;
  disabled: boolean;
};

const DispenseAllAction: React.FC<DispenseAllActionProps> = ({
  encounterUuid,
  patientUuid,
  medicationRequestBundles,
  disabled,
}) => {
  const { t } = useTranslation();
  const { mutate } = useSWRConfig();
  const config = useConfig<PharmacyConfig>();
  const session = useSession();
  const providers = useProviders(config.dispenserProviderRoles);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const drugUuids = useMemo(
    () =>
      (medicationRequestBundles ?? [])
        .map((bundle) => bundle.request.medicationReference?.reference)
        .filter(Boolean)
        .map(getUuidFromReference),
    [medicationRequestBundles],
  );
  const {
    inventoryItemsByDrug,
    isLoading: isLoadingStock,
    error: stockError,
  } = useDispenseStockForDrugs(config.enableStockDispense ? drugUuids : []);

  const { items, canDispenseAll } = planDispenseAll(
    medicationRequestBundles,
    inventoryItemsByDrug,
    session,
    providers,
    config,
  );

  // while stock is still loading (or failed to load) its availability is unknown, so the
  // button stays hidden rather than appearing and then vanishing
  if (!canDispenseAll || (config.enableStockDispense && (isLoadingStock || stockError))) {
    return null;
  }

  const duplicates = config.enableDuplicateDispenseCheck
    ? items.filter(({ medicationDispense, medicationRequestBundle }) =>
        findDuplicateDispense(medicationDispense, medicationRequestBundle.dispenses, config.duplicateCheckWindowDays),
      )
    : [];

  const handleDispenseAll = async () => {
    setIsSubmitting(true);
    const abortController = new AbortController();
    markEncounterAsStale(encounterUuid);

    // Rebuilt at submit time so the handed-over time is when the pharmacist confirmed, not
    // when the page rendered.
    const toDispense = items.map((item) => ({
      ...item,
      medicationDispense: initiateMedicationDispenseBody(
        item.medicationRequestBundle.request,
        session,
        providers,
        true,
      ),
    }));

    // One at a time, so a failure part way through leaves a clear record of what was saved.
    const saved: Array<DispenseAllItem> = [];
    const failed: Array<string> = [];
    for (const item of toDispense) {
      const name = getMedicationDisplay(getMedicationReferenceOrCodeableConcept(item.medicationDispense));
      try {
        const response = await completeMedicationDispense(
          item.medicationDispense,
          item.medicationRequestBundle,
          config,
          abortController,
        );
        if (response.ok) {
          saved.push(item);
        } else {
          failed.push(name);
        }
      } catch {
        failed.push(name);
      }
    }

    // Stock for every saved dispense goes in a single request, which the backend applies in
    // one transaction.
    if (config.enableStockDispense && saved.length > 0) {
      const stockDispenseRequests = saved.flatMap(({ batch, medicationDispense }) =>
        createStockDispenseRequestPayload(
          [{ inventoryItem: batch, quantity: medicationDispense.quantity.value }],
          patientUuid,
          encounterUuid,
          medicationDispense,
        ),
      );
      try {
        await sendStockDispenseRequest(stockDispenseRequests, abortController);
        showSnackbar({
          title: t('stockDispensed', 'Stock dispensed'),
          kind: 'success',
          subtitle: t('stockDispensedSuccessfully', 'Stock dispensed successfully and batch level updated.'),
        });
      } catch (error) {
        showSnackbar({
          title: t('stockDispenseError', 'Stock dispense error'),
          kind: 'error',
          subtitle: error?.message,
        });
      }
    }

    revalidate(mutate, encounterUuid);
    if (saved.length > 0) {
      notifyIfPrescriptionFulfillmentComplete(
        encounterUuid,
        patientUuid,
        config.medicationRequestExpirationPeriodInDays,
      );
      showSnackbar({
        kind: 'success',
        title: t('medicationsDispensed', '{{count}} medications dispensed', { count: saved.length }),
        subtitle: t('medicationListUpdated', 'Medication dispense list has been updated.'),
      });
    }
    if (failed.length > 0) {
      showSnackbar({
        kind: 'error',
        title: t('dispenseAllPartialError', 'Some medications could not be dispensed'),
        subtitle: failed.join(', '),
      });
    }
    setIsSubmitting(false);
    setIsConfirmOpen(false);
  };

  const formatExpiry = (batch: InventoryItem) => {
    const expiryDate = batch.expiration ? new Date(batch.expiration) : null;
    return expiryDate && !Number.isNaN(expiryDate.getTime())
      ? formatDate(expiryDate)
      : t('noExpiryRecorded', 'not recorded');
  };

  return (
    <>
      <Button kind="primary" disabled={disabled || isSubmitting} onClick={() => setIsConfirmOpen(true)}>
        {t('dispenseAll', 'Dispense all')}
      </Button>
      <Modal
        open={isConfirmOpen}
        modalHeading={t('dispenseAllHeading', 'Dispense all medications')}
        primaryButtonText={
          isSubmitting
            ? t('dispensing', 'Dispensing...')
            : t('dispenseAllConfirm', 'Dispense {{count}} medications', {
                count: items.length,
              })
        }
        secondaryButtonText={t('cancel', 'Cancel')}
        primaryButtonDisabled={isSubmitting}
        onRequestClose={() => !isSubmitting && setIsConfirmOpen(false)}
        onRequestSubmit={() => void handleDispenseAll()}>
        <ul>
          {items.map(({ medicationRequestBundle, medicationDispense, batch }) => (
            <li key={medicationRequestBundle.request.id}>
              <strong>{getMedicationDisplay(getMedicationReferenceOrCodeableConcept(medicationDispense))}</strong>
              {' — '}
              {medicationDispense.quantity?.value} {medicationDispense.quantity?.unit}
              {batch &&
                ` · ${t('dispenseAllBatch', 'Batch {{batchNumber}} (expiry {{expiration}})', {
                  batchNumber: batch.batchNumber,
                  expiration: formatExpiry(batch),
                })}`}
            </li>
          ))}
        </ul>
        {duplicates.length > 0 && (
          <InlineNotification
            kind="warning"
            lowContrast
            hideCloseButton
            title={t('dispenseAllDuplicateWarning', 'Recently dispensed')}
            subtitle={t(
              'dispenseAllDuplicateWarningDetails',
              'These were already dispensed with the same quantity and dose in the last {{days}} days: {{medications}}',
              {
                days: config.duplicateCheckWindowDays,
                medications: duplicates
                  .map(({ medicationDispense }) =>
                    getMedicationDisplay(getMedicationReferenceOrCodeableConcept(medicationDispense)),
                  )
                  .join(', '),
              },
            )}
          />
        )}
      </Modal>
    </>
  );
};

export default DispenseAllAction;
