import React from 'react';
import { Button, ModalBody, ModalFooter, ModalHeader } from '@carbon/react';
import { Trans, useTranslation } from 'react-i18next';
import { getPatientName } from '@openmrs/esm-framework';
import { usePrescriptionDetails } from '../medication-request/medication-request.resource';
import MedicationEvent from '../components/medication-event.component';
import styles from './on-prescription-filled.scss';

interface OnPrescriptionFilledModalProps {
  patient: fhir.Patient;

  /**
   * The encounter with which the user just placed the fill prescription order.
   */
  encounterUuid: string;

  /**
   * closes the modal
   */
  close(): void;
}

/**
 * This modal appears after the user submits the order basket opened via the
 * "Fill Prescription" button in the dispensing app. It lists the prescriptions
 * that were just ordered; dispensing is done separately from the prescription.
 */
const OnPrescriptionFilledModal: React.FC<OnPrescriptionFilledModalProps> = ({ patient, encounterUuid, close }) => {
  const { medicationRequestBundles } = usePrescriptionDetails(encounterUuid);
  const { t } = useTranslation();

  const patientName = getPatientName(patient);

  return (
    <>
      <ModalHeader>{t('dispenseAllPrescriptions', 'Dispense prescriptions')}</ModalHeader>
      <ModalBody>
        <p className={styles.modalDescription}>
          <Trans i18nKey="dispenseAllPrescriptionsConfirmation">
            Would you like to mark prescriptions ordered for <strong>{{ patientName } as any}</strong> as dispensed?
            Orders with no refills will be marked as completed.
          </Trans>
        </p>
        {medicationRequestBundles.map((bundle) => (
          <MedicationEvent key={bundle.request.id} medicationEvent={bundle.request} />
        ))}
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" onClick={close}>
          {t('createOrderWithoutDispensing', 'Create order without dispensing')}
        </Button>
      </ModalFooter>
    </>
  );
};

export default OnPrescriptionFilledModal;
