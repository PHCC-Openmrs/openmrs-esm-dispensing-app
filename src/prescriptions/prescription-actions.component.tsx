import React from 'react';
import { Layer } from '@carbon/react';
import PrescriptionPrintAction from '../print-prescription/prescription-print-action.component';
import styles from './prescription-actions.scss';
import { useConfig, UserHasAccess } from '@openmrs/esm-framework';
import type { PharmacyConfig } from '../config-schema';
import { type MedicationRequestBundle } from '../types';
import { PRIVILEGE_CREATE_DISPENSE } from '../constants';
import DispenseAllAction from './dispense-all-action.component';

type PrescriptionsActionsFooterProps = {
  encounterUuid: string;
  patientUuid: string;
  medicationRequestBundles: Array<MedicationRequestBundle>;
  disabled: boolean;
};

const PrescriptionsActionsFooter: React.FC<PrescriptionsActionsFooterProps> = ({
  encounterUuid,
  patientUuid,
  medicationRequestBundles,
  disabled,
}) => {
  const config = useConfig<PharmacyConfig>();

  return (
    <Layer className={styles.actionsContainer}>
      <div className={styles.actionCluster}>
        {/* Left buttons */}
        {config.actionButtons.printPrescriptionsButton.enabled && (
          <PrescriptionPrintAction encounterUuid={encounterUuid} patientUuid={patientUuid} />
        )}
      </div>

      <div className={styles.actionCluster}>
        {/* Right buttons */}
        <UserHasAccess privilege={PRIVILEGE_CREATE_DISPENSE}>
          <DispenseAllAction
            encounterUuid={encounterUuid}
            patientUuid={patientUuid}
            medicationRequestBundles={medicationRequestBundles}
            disabled={disabled}
          />
        </UserHasAccess>
      </div>
    </Layer>
  );
};

export default PrescriptionsActionsFooter;
