import React from 'react';
import { SkeletonText, Tag, Tile } from '@carbon/react';
import { WarningFilled } from '@carbon/react/icons';
import { useTranslation } from 'react-i18next';
import { type PatientUuid, useConfig, UserHasAccess } from '@openmrs/esm-framework';
import {
  computeTotalQuantityDispensed,
  computeTotalQuantityOrdered,
  getConceptCodingDisplay,
  getQuantityUnitsMatch,
  useStaleEncounterUuids,
  getMostRecentMedicationDispenseStatus,
} from '../utils';
import { computePrescriptionState, PrescriptionState } from '../prescription-state';
import { PRIVILEGE_CREATE_DISPENSE } from '../constants';
import { type AllergyIntolerance, type MedicationRequestBundle, MedicationDispenseStatus } from '../types';
import { type PharmacyConfig } from '../config-schema';
import { usePatientAllergies, usePrescriptionDetails } from '../medication-request/medication-request.resource';
import ActionButtons from '../components/action-buttons.component';
import MedicationEvent from '../components/medication-event.component';
import PrescriptionsActionsFooter from './prescription-actions.component';
import styles from './prescription-details.scss';

const PrescriptionDetails: React.FC<{
  encounterUuid: string;
  patientUuid: PatientUuid;
}> = ({ encounterUuid, patientUuid }) => {
  const { t } = useTranslation();
  const config = useConfig<PharmacyConfig>();
  const {
    allergies,
    totalAllergies,
    isLoading: isLoadingAllergies,
    error: allergiesError,
  } = usePatientAllergies(patientUuid, config.refreshInterval);
  const { medicationRequestBundles, error, isLoading } = usePrescriptionDetails(encounterUuid, config.refreshInterval);
  const { staleEncounterUuids } = useStaleEncounterUuids();

  // the tag and the action buttons below it derive from the same state, so the tag can
  // never describe a request as something its buttons disagree with
  const generateStatusTag = (medicationRequestBundle: MedicationRequestBundle): React.ReactNode => {
    const state = computePrescriptionState(medicationRequestBundle, {
      medicationRequestExpirationPeriodInDays: config.medicationRequestExpirationPeriodInDays,
    });

    switch (state) {
      case PrescriptionState.cancelled:
        return <Tag type="red">{t('cancelled', 'Cancelled')}</Tag>;
      case PrescriptionState.completed:
        return <Tag type="green">{t('completed', 'Completed')}</Tag>;
      case PrescriptionState.expired:
        return <Tag type="red">{t('expired', 'Expired')}</Tag>;
      case PrescriptionState.closed:
        return <Tag type="red">{t('closed', 'Closed')}</Tag>;
      case PrescriptionState.paused:
        return <Tag type="red">{t('paused', 'Paused')}</Tag>;
    }

    // an active request that has already had medication handed over against it
    const mostRecentDispenseStatus = getMostRecentMedicationDispenseStatus(medicationRequestBundle.dispenses);
    if (mostRecentDispenseStatus === MedicationDispenseStatus.completed) {
      return <Tag type="gray">{t('dispensed', 'Dispensed')}</Tag>;
    }

    return <Tag type="blue">{t('active', 'Active')}</Tag>;
  };

  const getDispensedProgress = (medicationRequestBundle: MedicationRequestBundle) => {
    if (
      !medicationRequestBundle.dispenses?.length ||
      !getQuantityUnitsMatch([medicationRequestBundle.request, ...medicationRequestBundle.dispenses])
    ) {
      return { quantityDispensed: undefined, totalQuantityOrdered: undefined };
    }
    return {
      quantityDispensed: computeTotalQuantityDispensed(medicationRequestBundle.dispenses),
      totalQuantityOrdered: computeTotalQuantityOrdered(medicationRequestBundle.request),
    };
  };

  const displayAllergies = (allergies: Array<AllergyIntolerance>): string => {
    const fallbackLabel = t('unknownAllergy', 'Unknown allergy');
    return allergies
      .map((allergy) => {
        // Prefer code.text as it contains the human-readable allergen name
        // (especially important for "Other" type allergies where coding display is generic)
        if (allergy.code?.text) {
          return allergy.code.text;
        }
        if (allergy.code?.coding?.length) {
          return getConceptCodingDisplay(allergy.code.coding) ?? allergy.code.coding[0]?.display;
        }
        return fallbackLabel;
      })
      .filter(Boolean)
      .join(', ');
  };

  return (
    <div className={styles.prescriptionContainer}>
      {isLoadingAllergies && (
        <Tile className={styles.skeletonTile}>
          <SkeletonText />
        </Tile>
      )}
      {!isLoadingAllergies && (
        <Tile className={styles.allergiesTile}>
          <div className={styles.allergiesContent}>
            <div>
              <WarningFilled size={24} className={styles.allergiesIcon} />
              <p>
                {allergiesError && (
                  <span className={styles.error}>
                    {t('errorLoadingAllergies', 'Error loading allergies')}: {allergiesError.message}
                  </span>
                )}
                {!allergiesError && totalAllergies > 0 && (
                  <span>
                    <span className={styles.allergiesCount}>
                      {t('allergiesCount', '{{ count }} allergies', {
                        count: totalAllergies,
                      })}
                    </span>{' '}
                    {displayAllergies(allergies)}
                  </span>
                )}
                {!allergiesError &&
                  typeof totalAllergies === 'number' &&
                  totalAllergies === 0 &&
                  t('noAllergyDetailsFound', 'No allergy details found')}
              </p>
            </div>
          </div>
        </Tile>
      )}
      <h5 className={styles.prescribedHeader}>{t('prescribed', 'Prescribed')}</h5>
      {isLoading && (
        <Tile className={styles.skeletonTile}>
          <SkeletonText paragraph lineCount={2} />
        </Tile>
      )}
      {error && (
        <p className={styles.error}>
          {t('errorLoadingPrescriptionDetails', 'Error loading prescription details')}: {error.message}
        </p>
      )}
      {medicationRequestBundles &&
        (medicationRequestBundles.length > 0 ? (
          medicationRequestBundles.map((bundle) => (
            <MedicationEvent
              key={bundle.request.id}
              medicationEvent={bundle.request}
              status={generateStatusTag(bundle)}
              {...getDispensedProgress(bundle)}>
              <UserHasAccess privilege={PRIVILEGE_CREATE_DISPENSE}>
                <ActionButtons
                  patientUuid={patientUuid}
                  encounterUuid={encounterUuid}
                  medicationRequestBundle={bundle}
                  disabled={staleEncounterUuids.includes(encounterUuid)}
                />
              </UserHasAccess>
            </MedicationEvent>
          ))
        ) : (
          <p className={styles.emptyState}>{t('noPrescriptionsFound', 'No prescriptions found')}</p>
        ))}
      {medicationRequestBundles?.length > 0 && (
        <PrescriptionsActionsFooter encounterUuid={encounterUuid} patientUuid={patientUuid} />
      )}
    </div>
  );
};

export default PrescriptionDetails;
