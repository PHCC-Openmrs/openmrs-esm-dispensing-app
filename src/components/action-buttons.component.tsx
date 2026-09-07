import React from 'react';
import { ExtensionSlot, useConfig, useSession } from '@openmrs/esm-framework';
import { type MedicationRequestBundle } from '../types';
import { computeQuantityRemaining, computeTotalQuantityDispensed } from '../utils';
import { computePrescriptionState, getAvailableActions, PrescriptionAction } from '../prescription-state';
import { type PharmacyConfig } from '../config-schema';
import { useProviders } from '../medication-dispense/medication-dispense.resource';
import styles from './action-buttons.scss';

interface ActionButtonsProps {
  medicationRequestBundle: MedicationRequestBundle;
  patientUuid: string;
  encounterUuid: string;
  disabled: boolean;
}

const ActionButtons: React.FC<ActionButtonsProps> = ({
  medicationRequestBundle,
  patientUuid,
  encounterUuid,
  disabled,
}) => {
  const config = useConfig<PharmacyConfig>();
  const session = useSession();
  const providers = useProviders(config.dispenserProviderRoles);
  // button visibility comes entirely from the state -> action table in prescription-state.ts,
  // so it can never disagree with the state tag rendered next to these buttons
  const state = computePrescriptionState(medicationRequestBundle, {
    medicationRequestExpirationPeriodInDays: config.medicationRequestExpirationPeriodInDays,
  });
  const availableActions = getAvailableActions(state, {
    pauseButtonEnabled: config.actionButtons.pauseButton.enabled,
    closeButtonEnabled: config.actionButtons.closeButton.enabled,
  });

  const dispensable = availableActions.includes(PrescriptionAction.dispense);
  const pauseable = availableActions.includes(PrescriptionAction.pause);
  const closeable = availableActions.includes(PrescriptionAction.close);

  let quantityRemaining = null;
  if (config.dispenseBehavior.restrictTotalQuantityDispensed) {
    quantityRemaining = computeQuantityRemaining(medicationRequestBundle);
  }

  let quantityDispensed = 0;
  if (config.dispenseBehavior.restrictTotalQuantityDispensed && medicationRequestBundle.dispenses) {
    quantityDispensed = computeTotalQuantityDispensed(medicationRequestBundle.dispenses);
  }

  const prescriptionActionsState = {
    state,
    availableActions,
    dispensable,
    pauseable,
    closeable,
    quantityRemaining,
    quantityDispensed,
    patientUuid,
    encounterUuid,
    medicationRequestBundle,
    session,
    providers,
    disabled,
  };

  return (
    <div className={styles.actionBtns}>
      <ExtensionSlot
        className={styles.extensionSlot}
        name="prescription-action-button-slot"
        state={prescriptionActionsState}
      />
    </div>
  );
};

export default ActionButtons;
