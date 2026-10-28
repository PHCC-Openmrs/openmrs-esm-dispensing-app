import React, { useMemo, useRef, useState } from 'react';
import { useSWRConfig } from 'swr';
import { useTranslation } from 'react-i18next';
import { Button, InlineNotification, Modal } from '@carbon/react';
import { formatDate, type Session, showSnackbar, useConfig, useSession } from '@openmrs/esm-framework';
import { type InventoryItem, type MedicationDispense, type MedicationRequestBundle, type Provider } from '../types';
import { type PharmacyConfig } from '../config-schema';
import {
  calculateIsFreeTextDosage,
  generateUuid,
  getDosageInstruction,
  getErrorMessage,
  getMedicationDisplay,
  getMedicationReferenceOrCodeableConcept,
  getUuidFromReference,
  markEncounterAsStale,
  revalidate,
} from '../utils';
import { computePrescriptionState, PrescriptionState } from '../prescription-state';
import {
  initiateMedicationDispenseBody,
  saveDispenses,
  useProviders,
} from '../medication-dispense/medication-dispense.resource';
import {
  buildCompletedDispenseItem,
  findDuplicateDispense,
  isMedicationDispenseValid,
} from '../medication-dispense/complete-medication-dispense';
import {
  createDispenseStockLines,
  getDispensableBatches,
  useDispenseStockForDrugs,
} from '../forms/stock-dispense/stock.resource';
import { notifyIfPrescriptionFulfillmentComplete } from '../pharmacy-queue-notification';

export type DispenseAllItem = {
  medicationRequestBundle: MedicationRequestBundle;
  medicationDispense: MedicationDispense;
  drugUuid: string | undefined;
  /** The earliest-expiring dispensable batch, if the drug has one. */
  batch?: InventoryItem;
};

/**
 * Works out what "Dispense all" would do for these prescriptions, or why it cannot.
 *
 * Every active prescription is included, each with exactly the
 * dispense the Dispense button would pre-fill. "Dispense all" is only offered when none of
 * them needs a human decision:
 *  - each pre-filled dispense is already valid (dispenser, quantity, dosage), and
 *  - the earliest-expiring eligible batch of each drug holds enough for everything being
 *    dispensed of that drug, counting whole units only. A prescription that would need a
 *    second batch, or has no stock, goes through the normal Dispense form instead.
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
      const batch = drugUuid
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
  const stockCovered = items.every(
    ({ batch }) => batch && Math.floor(batch.quantity) >= neededByBatch.get(batch.stockBatchUuid),
  );

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

  // The id each prescription's dispense is saved under, kept until "Dispense all" succeeds. If
  // the connection drops after the server saved them, confirming again sends the same ids and
  // the server answers with the dispenses it already has instead of saving them twice.
  const dispenseIds = useRef(new Map<string, string>());
  const getDispenseId = (medicationRequestBundle: MedicationRequestBundle) => {
    const requestId = medicationRequestBundle.request.id;
    if (!dispenseIds.current.has(requestId)) {
      dispenseIds.current.set(requestId, generateUuid());
    }
    return dispenseIds.current.get(requestId);
  };

  const drugUuids = useMemo(
    () =>
      (medicationRequestBundles ?? [])
        .map((bundle) => bundle.request.medicationReference?.reference)
        .filter(Boolean)
        .map(getUuidFromReference),
    [medicationRequestBundles],
  );
  const { inventoryItemsByDrug, isLoading: isLoadingStock, error: stockError } = useDispenseStockForDrugs(drugUuids);

  const { items, canDispenseAll } = planDispenseAll(
    medicationRequestBundles,
    inventoryItemsByDrug,
    session,
    providers,
    config,
  );

  // while stock is still loading (or failed to load) its availability is unknown, so the
  // button stays hidden rather than appearing and then vanishing
  if (!canDispenseAll || isLoadingStock || stockError) {
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

    try {
      // Every medication goes in one request, which the backend saves in one transaction:
      // either all of them are dispensed with their stock taken, or none is. The dispenses are
      // rebuilt here so the handed-over time is when the pharmacist confirmed, not when the
      // page rendered.
      const dispenses = items.map((item) => {
        const medicationDispense = initiateMedicationDispenseBody(
          item.medicationRequestBundle.request,
          session,
          providers,
          true,
        );
        return buildCompletedDispenseItem(
          medicationDispense,
          item.medicationRequestBundle,
          config,
          getDispenseId(item.medicationRequestBundle),
          createDispenseStockLines([{ inventoryItem: item.batch, quantity: medicationDispense.quantity.value }]),
        );
      });
      await saveDispenses(dispenses, abortController);

      dispenseIds.current.clear();
      notifyIfPrescriptionFulfillmentComplete(
        encounterUuid,
        patientUuid,
        config.medicationRequestExpirationPeriodInDays,
      );
      showSnackbar({
        title: t('stockDispensed', 'Stock dispensed'),
        kind: 'success',
        subtitle: t('stockDispensedSuccessfully', 'Stock dispensed successfully and batch level updated.'),
      });
      showSnackbar({
        kind: 'success',
        title: t('medicationsDispensed', '{{count}} medications dispensed', { count: dispenses.length }),
        subtitle: t('medicationListUpdated', 'Medication dispense list has been updated.'),
      });
    } catch (error) {
      showSnackbar({
        kind: 'error',
        title: t('dispenseAllError', 'Nothing was dispensed'),
        subtitle: getErrorMessage(error),
      });
    }
    // reloaded either way: after a failure the stock shown may be what made it fail
    revalidate(mutate, encounterUuid);
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
