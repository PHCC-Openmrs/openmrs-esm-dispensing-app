import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Layer, StructuredListBody, StructuredListCell, StructuredListRow, StructuredListWrapper } from '@carbon/react';
import { age, formatDate, parseDate, useSession, type NullablePatient } from '@openmrs/esm-framework';
import { type DosageInstruction, type MedicationRequestBundle, type Quantity } from '../types';
import {
  getDosageInstruction,
  getMedicationDisplay,
  getMedicationReferenceOrCodeableConcept,
  getQuantity,
  getRefillsAllowed,
} from '../utils';
import careLogo from '../assets/care-logo.png';
import styles from './print-prescription.scss';

type PrescriptionsPrintoutProps = {
  excludedPrescription: Array<string>;
  medicationRequests: Array<MedicationRequestBundle>;
  patient?: NullablePatient;
};

const PrescriptionsPrintout: React.FC<PrescriptionsPrintoutProps> = ({
  excludedPrescription,
  medicationRequests,
  patient,
}) => {
  const { t } = useTranslation();
  const {
    sessionLocation: { display: facilityName },
  } = useSession();
  const subject = medicationRequests[0]?.request?.subject;

  const extractPatientName = (display: string) => (display.includes('(') ? display.split('(')[0] : display);

  const nationalId = patient?.identifier?.find(
    (identifier) =>
      identifier.type?.text === 'National ID' ||
      identifier.type?.coding?.some((coding) => coding.display === 'National ID'),
  )?.value;

  const phoneNumber = patient?.telecom?.find((contact) => contact.system === 'phone')?.value;

  const patientGender = patient?.gender ? patient.gender.charAt(0).toUpperCase() + patient.gender.slice(1) : null;

  const patientAge = patient?.birthDate ? age(patient.birthDate) : null;

  const requesters = useMemo(() => {
    const uniqueRequesters = new Set<string>();
    medicationRequests
      ?.filter((req) => !excludedPrescription.includes(req.request.id))
      ?.forEach((request) => {
        const display = request.request?.requester?.display;
        if (display) uniqueRequesters.add(display);
      });
    return uniqueRequesters;
  }, [medicationRequests, excludedPrescription]);

  const filteredRequests = useMemo(
    () => medicationRequests?.filter((req) => !excludedPrescription.includes(req.request.id)) || [],
    [medicationRequests, excludedPrescription],
  );

  return (
    <Layer className={styles.printOutContainer}>
      <StructuredListWrapper>
        <StructuredListBody>
          <StructuredListRow head>
            <StructuredListCell head>
              <img src={careLogo} alt="CARE logo" className={styles.careLogo} />
              <p className={styles.printoutTitle}>{t('prescriptionInstructions', 'Prescription instructions')}</p>
              {(subject || patientGender || patientAge || nationalId || phoneNumber) && (
                <div className={styles.patientInfoGrid}>
                  <div className={styles.patientInfoRow}>
                    {subject && (
                      <p>
                        <span className={styles.infoLabel}>{t('patientName', 'Patient Name')}</span>
                        {': '}
                        {extractPatientName(subject.display)}
                      </p>
                    )}
                    {nationalId && (
                      <p>
                        <span className={styles.infoLabel}>{t('nationalId', 'National ID')}</span>
                        {': '}
                        {nationalId}
                      </p>
                    )}
                  </div>
                  {(patientGender || patientAge || phoneNumber) && (
                    <div className={styles.patientInfoRow}>
                      <div>
                        {patientGender && (
                          <p>
                            <span className={styles.infoLabel}>{t('gender', 'Gender')}</span>
                            {': '}
                            {patientGender}
                          </p>
                        )}
                        {patientAge && (
                          <p>
                            <span className={styles.infoLabel}>{t('age', 'Age')}</span>
                            {': '}
                            {patientAge}
                          </p>
                        )}
                      </div>
                      {phoneNumber && (
                        <p>
                          <span className={styles.infoLabel}>{t('phoneNumber', 'Phone number')}</span>
                          {': '}
                          {phoneNumber}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </StructuredListCell>
          </StructuredListRow>
          {filteredRequests.map((request) => {
            const medicationEvent = request.request;
            const dosageInstruction: DosageInstruction = getDosageInstruction(medicationEvent.dosageInstruction);
            const quantity: Quantity = getQuantity(medicationEvent);
            const numberOfRefillsAllowed: number = getRefillsAllowed(medicationEvent);

            return (
              <div key={request.request.id}>
                {dosageInstruction && (
                  <StructuredListRow>
                    <StructuredListCell>
                      <p className={styles.medicationName}>
                        <strong>
                          {getMedicationDisplay(getMedicationReferenceOrCodeableConcept(medicationEvent))}
                        </strong>
                      </p>
                      <br />
                      <p>
                        <span className={styles.faintText}>{t('dose', 'Dose')}</span>
                        {': '}
                        <span className={styles.prescriptionInfo}>
                          {dosageInstruction?.doseAndRate?.map((doseAndRate, index) => {
                            return (
                              <span className={styles.prescriptionInfo} key={`dose-${request.request.id}-${index}`}>
                                {doseAndRate?.doseQuantity?.value} {doseAndRate?.doseQuantity?.unit}
                              </span>
                            );
                          })}
                        </span>{' '}
                        &mdash;{' '}
                        <span className={styles.prescriptionInfo}>
                          {dosageInstruction?.route?.text} &mdash; {dosageInstruction?.timing?.code?.text}
                          {dosageInstruction?.timing?.repeat?.duration
                            ? ` ${t('for', 'for')} ${dosageInstruction?.timing?.repeat?.duration} ${dosageInstruction?.timing?.repeat?.durationUnit}`
                            : ''}
                        </span>
                        {quantity && (
                          <div>
                            <span className={styles.faintText}>{t('quantity', 'Quantity')}</span>
                            {': '}
                            <span className={styles.prescriptionInfo}>
                              {quantity.value} {quantity.unit}
                            </span>
                          </div>
                        )}
                      </p>
                      <p>
                        <span className={styles.faintText}>{t('datePrescribed', 'Date prescribed')}</span>
                        {': '}{' '}
                        <span className={styles.prescriptionInfo}>
                          {formatDate(parseDate(request.request.authoredOn), { noToday: true })}
                        </span>
                      </p>
                      <p>
                        <span className={styles.faintText}>{t('refills', 'Refills')}</span>
                        {': '}{' '}
                        <span className={styles.prescriptionInfo}>
                          {numberOfRefillsAllowed || numberOfRefillsAllowed === 0
                            ? numberOfRefillsAllowed
                            : t('noRefills', 'No refills')}
                        </span>
                      </p>

                      {dosageInstruction?.text && <p>{dosageInstruction.text}</p>}
                      {dosageInstruction?.additionalInstruction?.length > 0 && (
                        <p>
                          {dosageInstruction?.additionalInstruction.map((instruction) => instruction.text).join(', ')}
                        </p>
                      )}
                    </StructuredListCell>
                  </StructuredListRow>
                )}
              </div>
            );
          })}
          {requesters.size > 0 && (
            <p className={styles.prescriber}>
              {t('prescribedBy', 'Prescribed By')}:{' '}
              {Array.from(requesters.values())
                .map((name) => name?.split('(')?.at(0))
                ?.join(', ')}
            </p>
          )}
          <p className={styles.facilityName}>{facilityName}</p>
        </StructuredListBody>
      </StructuredListWrapper>
    </Layer>
  );
};

export default PrescriptionsPrintout;
