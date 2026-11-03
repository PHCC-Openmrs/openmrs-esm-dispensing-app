import React, { useState } from 'react';
import { useSWRConfig } from 'swr';
import { Button, InlineLoading, ModalBody, ModalFooter, ModalHeader, TextArea } from '@carbon/react';
import { useTranslation } from 'react-i18next';
import { showSnackbar } from '@openmrs/esm-framework';
import { cancelDispensedOrder } from '../../medication-dispense/medication-dispense.resource';
import { type MedicationRequestBundle } from '../../types';
import {
  getErrorMessage,
  getMedicationDisplay,
  getMedicationReferenceOrCodeableConcept,
  markEncounterAsStale,
  revalidate,
} from '../../utils';

type CancelDispensedPrescriptionModalProps = {
  encounterUuid: string;
  medicationRequestBundle: MedicationRequestBundle;
  onClose: () => void;
};

const CancelDispensedPrescriptionModal: React.FC<CancelDispensedPrescriptionModalProps> = ({
  encounterUuid,
  medicationRequestBundle,
  onClose,
}) => {
  const { t } = useTranslation();
  const { mutate } = useSWRConfig();
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleConfirm = () => {
    setSubmitting(true);
    markEncounterAsStale(encounterUuid);
    // the dispenses are voided, their stock returned and the prescription closed in one transaction
    cancelDispensedOrder(medicationRequestBundle.request.id, reason.trim())
      .then(() => {
        showSnackbar({
          kind: 'success',
          title: t('success', 'Success'),
          subtitle: t('prescriptionCancelledStockReturned', 'Prescription cancelled and its dispensed stock returned'),
        });
        revalidate(mutate, encounterUuid);
        onClose();
      })
      .catch((error) => {
        setSubmitting(false);
        showSnackbar({
          kind: 'error',
          title: t('cancelPrescriptionFailed', 'Could not cancel the prescription'),
          subtitle: getErrorMessage(error, t('somethingWentWrong', 'Something went wrong')),
        });
      });
  };

  return (
    <React.Fragment>
      <ModalHeader closeModal={onClose} title={t('cancelPrescription', 'Cancel prescription')} />
      <ModalBody>
        <p>
          {t(
            'cancelPrescriptionMessage',
            'Every dispense of {{medication}} on this prescription will be deleted and the dispensed quantity returned to stock. The prescription will be closed.',
            {
              medication: getMedicationDisplay(
                getMedicationReferenceOrCodeableConcept(medicationRequestBundle.request),
              ),
            },
          )}
        </p>
        <br />
        <TextArea
          id="cancelPrescriptionReason"
          labelText={t('reason', 'Reason')}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          maxCount={255}
          enableCounter
        />
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" onClick={onClose}>
          {t('goBack', 'Go back')}
        </Button>
        <Button kind="danger" onClick={handleConfirm} disabled={submitting || !reason.trim()}>
          {submitting ? (
            <InlineLoading description={t('cancelling', 'Cancelling') + '...'} />
          ) : (
            t('cancelPrescription', 'Cancel prescription')
          )}
        </Button>
      </ModalFooter>
    </React.Fragment>
  );
};

export default CancelDispensedPrescriptionModal;
