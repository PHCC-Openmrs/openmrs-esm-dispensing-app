import React, { useCallback, useMemo, useState } from 'react';
import { useSWRConfig } from 'swr';
import { useTranslation } from 'react-i18next';
import { Button, Form, FormLabel, InlineLoading } from '@carbon/react';
import {
  ExtensionSlot,
  getCoreTranslation,
  showModal,
  showSnackbar,
  useConfig,
  usePatient,
  Workspace2,
  type Workspace2DefinitionProps,
} from '@openmrs/esm-framework';
import {
  type MedicationDispense,
  MedicationDispenseStatus,
  type MedicationRequestBundle,
  type InventoryItem,
} from '../types';
import {
  calculateIsFreeTextDosage,
  generateUuid,
  getDosageInstruction,
  getErrorMessage,
  markEncounterAsStale,
  revalidate,
} from '../utils';
import { type PharmacyConfig } from '../config-schema';
import { notifyIfPrescriptionFulfillmentComplete } from '../pharmacy-queue-notification';
import { allocateQuantityAcrossBatches, createDispenseStockLines } from './stock-dispense/stock.resource';
import {
  buildCompletedDispenseItem,
  findDuplicateDispense,
  isMedicationDispenseValid,
} from '../medication-dispense/complete-medication-dispense';
import { saveDispenses } from '../medication-dispense/medication-dispense.resource';
import MedicationDispenseReview from './medication-dispense-review.component';
import StockDispense from './stock-dispense/stock-dispense.component';
import styles from './forms.scss';

type DispenseFormProps = {
  medicationDispense: MedicationDispense;
  medicationRequestBundle: MedicationRequestBundle;
  mode: 'enter' | 'edit';
  patientUuid?: string;
  encounterUuid: string;
  quantityRemaining: number;
  quantityDispensed: number;
  customWorkspaceTitle?: string;
  onWorkspaceClosed?(): void;
};

const DispenseForm: React.FC<Workspace2DefinitionProps<DispenseFormProps, {}, {}>> = ({
  workspaceProps: {
    medicationDispense,
    medicationRequestBundle,
    mode,
    patientUuid,
    encounterUuid,
    quantityRemaining,
    quantityDispensed,
    customWorkspaceTitle,
    onWorkspaceClosed,
  },
  closeWorkspace,
}) => {
  const { t } = useTranslation();
  const { mutate } = useSWRConfig();
  const { patient, isLoading } = usePatient(patientUuid);
  const config = useConfig<PharmacyConfig>();

  // Batches selected to dispense from, in first-expiry-first-out order
  const [inventoryItems, setInventoryItems] = useState<Array<InventoryItem>>([]);

  // Keep track of medication dispense payload
  const [medicationDispensePayload, setMedicationDispensePayload] = useState(medicationDispense);

  // to prevent duplicate submits
  const [isSubmitting, setIsSubmitting] = useState(false);

  // The id a new dispense is saved under, fixed for as long as this form is open. If the
  // connection drops after the server saved the dispense, pressing Dispense again sends the
  // same id, and the server answers with the dispense it already has instead of saving it, and
  // taking its stock, twice.
  const [newDispenseId] = useState(generateUuid);

  const [isFreeTextDosage, setIsFreeTextDosage] = useState(() => {
    const dosageInstruction = getDosageInstruction(medicationDispense?.dosageInstruction);
    return dosageInstruction ? calculateIsFreeTextDosage(dosageInstruction) : false;
  });

  const getDuplicateDispense = (dispense: MedicationDispense): MedicationDispense =>
    findDuplicateDispense(dispense, medicationRequestBundle?.dispenses, config.duplicateCheckWindowDays);

  const handleDuplicateMedication = (previousDispense: MedicationDispense) => {
    const dispose = showModal('duplicate-dispense-modal', {
      onClose: () => dispose(),
      medicationName: medicationDispensePayload?.medicationCodeableConcept?.text || '',
      previousDispense: previousDispense,
      previousDispenseDate: previousDispense?.whenHandedOver ?? previousDispense?.whenPrepared ?? undefined,
      previousSchedule:
        previousDispense?.dosageInstruction?.[0]?.timing?.code?.text ??
        medicationDispensePayload?.dosageInstruction?.[0]?.timing?.code?.text,
      previousQuantity: previousDispense?.quantity?.value ?? medicationDispensePayload?.quantity?.value,
      previousQuantityUnit:
        previousDispense?.quantity?.unit ??
        previousDispense?.quantity?.code ??
        medicationDispensePayload?.quantity?.code,
      previousPerformer:
        previousDispense?.performer?.[0]?.actor?.display ?? medicationDispensePayload?.performer?.[0]?.actor?.display,
      onConfirm: () => handleSubmit(),
    });
  };

  // Submit medication dispense form. The dispense, its stock and the prescription's status are
  // saved by one request in one transaction, so on any error nothing has been saved and the
  // form stays open to try again.
  const handleSubmit = () => {
    if (isSubmitting) {
      return Promise.resolve();
    }
    setIsSubmitting(true);
    const abortController = new AbortController();
    markEncounterAsStale(encounterUuid);
    return Promise.resolve()
      .then(() =>
        saveDispenses(
          [
            buildCompletedDispenseItem(
              medicationDispensePayload,
              medicationRequestBundle,
              config,
              newDispenseId,
              createDispenseStockLines(batchAllocation.allocations),
            ),
          ],
          abortController,
        ),
      )
      .then(
        (response) => {
          const [savedDispense] = response.data?.dispenses ?? [];
          if (config.completeOrderWithThisDispense && savedDispense?.status === MedicationDispenseStatus.completed) {
            showSnackbar({
              title: t('prescriptionCompleted', 'Prescription completed'),
              kind: 'success',
              subtitle: t(
                'prescriptionCompletedSuccessfully',
                'Medication dispensed and prescription marked as completed',
              ),
            });
          }
          revalidate(mutate, encounterUuid);
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
            subtitle: t('medicationListUpdated', 'Medication dispense list has been updated.'),
            title: t(
              mode === 'enter' ? 'medicationDispensed' : 'medicationDispenseUpdated',
              mode === 'enter'
                ? 'Medication successfully dispensed.'
                : 'Medication dispense record successfully updated.',
            ),
          });
          closeWorkspace({ discardUnsavedChanges: true });
          setIsSubmitting(false);
          onWorkspaceClosed?.();
        },
        (error) => {
          showSnackbar({
            kind: 'error',
            title: t(
              mode === 'enter' ? 'medicationDispenseError' : 'medicationDispenseUpdatedError',
              mode === 'enter' ? 'Error dispensing medication.' : 'Error updating dispense record',
            ),
            subtitle: getErrorMessage(error),
          });
          setIsSubmitting(false);
        },
      );
  };

  const updateMedicationDispense = useCallback((medicationDispenseUpdate: Partial<MedicationDispense>) => {
    setMedicationDispensePayload((prevState) => ({
      ...prevState,
      ...medicationDispenseUpdate,
    }));
  }, []);

  // whether or not the form is valid and ready to submit
  const isValid = useMemo(
    () => isMedicationDispenseValid(medicationDispensePayload, isFreeTextDosage),
    [isFreeTextDosage, medicationDispensePayload],
  );

  // How the dispense quantity splits across the selected batches. Every dispense takes its
  // stock, so it is blocked until the selection holds enough; the server would reject it
  // otherwise.
  const batchAllocation = useMemo(
    () => allocateQuantityAcrossBatches(inventoryItems, medicationDispensePayload?.quantity?.value),
    [inventoryItems, medicationDispensePayload?.quantity?.value],
  );
  const isStockSelectionValid = batchAllocation.allocations.length > 0 && batchAllocation.shortfall <= 0;

  const isButtonDisabled = !isStockSelectionValid || !isValid || isSubmitting;

  const handleSubmitOrDuplicateCheck = () => {
    const duplicateDispense = medicationDispensePayload ? getDuplicateDispense(medicationDispensePayload) : null;
    if (config.enableDuplicateDispenseCheck && duplicateDispense) {
      handleDuplicateMedication(duplicateDispense);
    } else {
      handleSubmit();
    }
  };

  const bannerState = useMemo(() => {
    if (patient) {
      return {
        patient,
        patientUuid,
        hideActionsOverflow: true,
      };
    }
  }, [patient, patientUuid]);

  return (
    <Workspace2 title={customWorkspaceTitle ?? t('dispensePrescription', 'Dispense prescription')}>
      <Form className={styles.formWrapper}>
        <div>
          {isLoading && (
            <InlineLoading
              className={styles.bannerLoading}
              iconDescription="Loading"
              description="Loading banner"
              status="active"
            />
          )}
          {patient && <ExtensionSlot name="patient-header-slot" state={bannerState} />}
          <section className={styles.formGroup}>
            <FormLabel>
              {config.dispenseBehavior.allowModifyingPrescription
                ? t('drugHelpText', 'You may edit the formulation and quantity dispensed here')
                : t('drugHelpTextNoEdit', 'You may edit quantity dispensed here')}
            </FormLabel>
            {medicationDispensePayload ? (
              <div>
                <MedicationDispenseReview
                  medicationDispense={medicationDispensePayload}
                  updateMedicationDispense={updateMedicationDispense}
                  isFreeTextDosage={isFreeTextDosage}
                  setIsFreeTextDosage={setIsFreeTextDosage}
                  quantityRemaining={quantityRemaining}
                  quantityDispensed={quantityDispensed}
                />
                <StockDispense
                  inventoryItems={inventoryItems}
                  medicationDispense={medicationDispense}
                  quantityToDispense={medicationDispensePayload.quantity?.value}
                  updateInventoryItems={setInventoryItems}
                />
              </div>
            ) : null}
          </section>
        </div>
        <section className={styles.buttonGroup}>
          <Button
            disabled={isSubmitting}
            onClick={() => {
              closeWorkspace();
              onWorkspaceClosed?.();
            }}
            kind="secondary">
            {getCoreTranslation('cancel', 'Cancel')}
          </Button>
          <Button disabled={isButtonDisabled} onClick={handleSubmitOrDuplicateCheck}>
            {t(
              mode === 'enter' ? 'dispensePrescription' : 'saveChanges',
              mode === 'enter' ? 'Dispense prescription' : 'Save changes',
            )}
          </Button>
        </section>
      </Form>
    </Workspace2>
  );
};

export default DispenseForm;
