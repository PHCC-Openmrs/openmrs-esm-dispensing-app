import React, { useEffect, useMemo, useState } from 'react';
import { useSWRConfig } from 'swr';
import { useTranslation } from 'react-i18next';
import { Button, ComboBox, Form, InlineLoading } from '@carbon/react';
import {
  ExtensionSlot,
  getCoreTranslation,
  ResponsiveWrapper,
  showSnackbar,
  useConfig,
  usePatient,
  Workspace2,
  type Workspace2DefinitionProps,
} from '@openmrs/esm-framework';
import { saveDispenses, useReasonForCloseValueSet } from '../medication-dispense/medication-dispense.resource';
import { buildPausedOrClosedDispenseItem } from '../medication-dispense/complete-medication-dispense';
import { type MedicationDispense, MedicationDispenseStatus, MedicationRequestFulfillerStatus } from '../types';
import { type PharmacyConfig } from '../config-schema';
import { generateUuid, getErrorMessage, markEncounterAsStale, revalidate } from '../utils';
import { notifyIfPrescriptionFulfillmentComplete } from '../pharmacy-queue-notification';
import styles from './forms.scss';

type CloseDispenseFormProps = {
  medicationDispense: MedicationDispense;
  mode: 'enter' | 'edit';
  patientUuid?: string;
  encounterUuid: string;
  customWorkspaceTitle?: string;
};

const CloseDispenseForm: React.FC<Workspace2DefinitionProps<CloseDispenseFormProps, {}, {}>> = ({
  workspaceProps: { medicationDispense, mode, patientUuid, encounterUuid, customWorkspaceTitle },
  closeWorkspace,
}) => {
  const { t } = useTranslation();
  const { mutate } = useSWRConfig();
  const config = useConfig<PharmacyConfig>();
  const { patient, isLoading } = usePatient(patientUuid);

  // Keep track of medication dispense payload
  const [medicationDispensePayload, setMedicationDispensePayload] = useState<MedicationDispense>();

  // whether or not the form is valid and ready to submit
  const [isValid, setIsValid] = useState(false);

  // to prevent duplicate submits
  const [isSubmitting, setIsSubmitting] = useState(false);
  // a new close is saved under this id for as long as the form is open, so a resubmit after a
  // lost response is recognised instead of saved twice
  const [newDispenseId] = useState(generateUuid);
  const [reasonsForClose, setReasonsForClose] = useState([]);
  const { reasonForCloseValueSet } = useReasonForCloseValueSet(config.valueSets.reasonForClose.uuid);

  useEffect(() => {
    const reasonForCloseOptions = [];

    if (reasonForCloseValueSet?.compose?.include) {
      const uuidValueSet = reasonForCloseValueSet.compose.include.find((include) => !include.system);
      if (uuidValueSet) {
        uuidValueSet.concept?.forEach((concept) =>
          reasonForCloseOptions.push({
            id: concept.code,
            text: concept.display,
          }),
        );
        reasonForCloseOptions.sort((a, b) => a.text.localeCompare(b.text));
      }
    }
    setReasonsForClose(reasonForCloseOptions);
  }, [reasonForCloseValueSet]);

  const handleSubmit = () => {
    if (!isSubmitting) {
      setIsSubmitting(true);
      const abortController = new AbortController();
      markEncounterAsStale(encounterUuid);
      // the close and, for a new one, the prescription's declined status are saved together
      saveDispenses(
        [
          buildPausedOrClosedDispenseItem(
            medicationDispensePayload,
            MedicationDispenseStatus.declined,
            MedicationRequestFulfillerStatus.declined,
            newDispenseId,
          ),
        ],
        abortController,
      )
        .then(() => {
          revalidate(mutate, encounterUuid);
          notifyIfPrescriptionFulfillmentComplete(
            encounterUuid,
            patientUuid,
            config.medicationRequestExpirationPeriodInDays,
          );
          showSnackbar({
            kind: 'success',
            title: t(
              mode === 'enter' ? 'medicationDispenseClosed' : 'medicationDispenseUpdated',
              mode === 'enter' ? 'Medication dispense closed.' : 'Dispense record successfully updated.',
            ),
          });
          closeWorkspace({ discardUnsavedChanges: true });
        })
        .catch((error) => {
          showSnackbar({
            title: t(
              mode === 'enter' ? 'medicationDispenseCloseError' : 'medicationDispenseUpdatedError',
              mode === 'enter' ? 'Error closing medication dispense.' : 'Error updating dispense record',
            ),
            kind: 'error',
            subtitle: getErrorMessage(error),
          });
          setIsSubmitting(false);
        });
    }
  };

  const checkIsValid = () => {
    if (medicationDispensePayload && medicationDispensePayload.statusReasonCodeableConcept?.coding[0].code) {
      setIsValid(true);
    } else {
      setIsValid(false);
    }
  };

  // initialize the internal dispense payload with the dispenses passed in as props
  useEffect(() => setMedicationDispensePayload(medicationDispense), [medicationDispense]);

  // check is valid on any changes
  useEffect(checkIsValid, [medicationDispensePayload]);

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
    <Workspace2 title={customWorkspaceTitle ?? t('closePrescription', 'Close prescription')}>
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
            <ResponsiveWrapper>
              <ComboBox
                id="reasonForPause"
                items={reasonsForClose}
                titleText={t('reasonForClose', 'Reason for close')}
                itemToString={(item) => item?.text}
                initialSelectedItem={{
                  id: medicationDispense.statusReasonCodeableConcept?.coding[0]?.code,
                  text: medicationDispense.statusReasonCodeableConcept?.text,
                }}
                onChange={({ selectedItem }) => {
                  setMedicationDispensePayload({
                    ...medicationDispensePayload,
                    statusReasonCodeableConcept: {
                      coding: [
                        {
                          code: selectedItem?.id,
                        },
                      ],
                    },
                  });
                }}
              />
            </ResponsiveWrapper>
          </section>
        </div>
        <section className={styles.buttonGroup}>
          <Button
            disabled={isSubmitting}
            onClick={() => {
              closeWorkspace();
            }}
            kind="secondary">
            {getCoreTranslation('cancel', 'Cancel')}
          </Button>
          <Button disabled={!isValid || isSubmitting} onClick={handleSubmit}>
            {t(mode === 'enter' ? 'close' : 'saveChanges', mode === 'enter' ? 'Close' : 'Save changes')}
          </Button>
        </section>
      </Form>
    </Workspace2>
  );
};

export default CloseDispenseForm;
