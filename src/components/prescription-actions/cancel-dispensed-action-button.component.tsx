import React from 'react';
import { Button } from '@carbon/react';
import { useTranslation } from 'react-i18next';
import { showModal } from '@openmrs/esm-framework';
import { type MedicationRequestBundle } from '../../types';

type CancelDispensedActionButtonProps = {
  encounterUuid: string;
  medicationRequestBundle: MedicationRequestBundle;
  cancellable: boolean;
  disabled: boolean;
};

/**
 * Administrators only: cancels a completed prescription, voiding its dispenses and putting their
 * stock back. Shown only when the state table grants the cancelDispensed action.
 */
const CancelDispensedActionButton: React.FC<CancelDispensedActionButtonProps> = ({
  encounterUuid,
  medicationRequestBundle,
  cancellable,
  disabled,
}) => {
  const { t } = useTranslation();

  if (!cancellable) {
    return null;
  }

  const handleClick = () => {
    const dispose = showModal('cancel-dispensed-prescription-modal', {
      encounterUuid,
      medicationRequestBundle,
      onClose: () => dispose(),
    });
  };

  return (
    <Button kind="danger--tertiary" onClick={handleClick} disabled={disabled}>
      {t('cancelPrescription', 'Cancel prescription')}
    </Button>
  );
};

export default CancelDispensedActionButton;
