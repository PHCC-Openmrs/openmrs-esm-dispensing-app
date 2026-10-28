import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { showModal, showSnackbar, useConfig, userHasAccess, useSession } from '@openmrs/esm-framework';
import { OPENMRS_FHIR_EXT_REQUEST_FULFILLER_STATUS } from '../constants';
import {
  type MedicationDispense,
  MedicationDispenseStatus,
  type MedicationRequest,
  type MedicationRequestBundle,
  MedicationRequestFulfillerStatus,
  MedicationRequestStatus,
} from '../types';
import { usePrescriptionDetails } from '../medication-request/medication-request.resource';
import { deleteDispense } from '../medication-dispense/medication-dispense.resource';
import HistoryAndComments from './history-and-comments.component';

vi.mock('../medication-request/medication-request.resource', () => ({
  usePrescriptionDetails: vi.fn(),
}));

vi.mock('../medication-dispense/medication-dispense.resource', () => ({
  deleteDispense: vi.fn(),
}));

vi.mock('../components/medication-event.component', () => ({
  default: ({ children }) => <div>{children}</div>,
}));

const mockDeleteDispense = vi.mocked(deleteDispense);
const mockShowModal = vi.mocked(showModal);

const dispense = {
  resourceType: 'MedicationDispense',
  id: 'dispense-uuid',
  status: MedicationDispenseStatus.completed,
  authorizingPrescription: [{ reference: 'MedicationRequest/request-uuid', type: 'MedicationRequest' }],
  quantity: { value: 30, code: 'tablet-code' },
  whenHandedOver: '2026-10-28T09:00:00+00:00',
  performer: [{ actor: { reference: 'Practitioner/provider-uuid', display: 'Pharmacist' } }],
} as MedicationDispense;

// fully dispensed and so completed; deleting its only dispense has to re-open it
const bundle: MedicationRequestBundle = {
  request: {
    resourceType: 'MedicationRequest',
    id: 'request-uuid',
    status: MedicationRequestStatus.active,
    requester: { display: 'Doctor' },
    dispenseRequest: { numberOfRepeatsAllowed: 0, quantity: { value: 30, code: 'tablet-code' } },
    extension: [
      { url: OPENMRS_FHIR_EXT_REQUEST_FULFILLER_STATUS, valueCode: MedicationRequestFulfillerStatus.completed },
    ],
  } as unknown as MedicationRequest,
  dispenses: [dispense],
};

beforeEach(() => {
  vi.mocked(useConfig).mockReturnValue({
    refreshInterval: 0,
    dispenseBehavior: { allowModifyingPrescription: false, restrictTotalQuantityDispensed: true },
  });
  vi.mocked(useSession).mockReturnValue({ user: { uuid: 'user-uuid' } } as any);
  vi.mocked(userHasAccess).mockReturnValue(true);
  vi.mocked(usePrescriptionDetails).mockReturnValue({
    medicationRequestBundles: [bundle],
    prescriptionDate: new Date('2026-10-28T08:00:00Z'),
    error: null,
    isLoading: false,
  } as any);
  mockShowModal.mockReturnValue(vi.fn());
});

const deleteTheDispense = async () => {
  const user = userEvent.setup();
  render(<HistoryAndComments encounterUuid="encounter-uuid" patientUuid="patient-uuid" />);
  // the dispense's action menu is the only button; Carbon names it from its tooltip, not aria-label
  await user.click(screen.getByRole('button'));
  // the floating menu counts as hidden in jsdom, so its items are found by text
  await user.click(screen.getByText('Delete'));
  // confirm in the delete modal
  const [, modalProps] = mockShowModal.mock.calls[0] as [string, { onDelete: () => void }];
  modalProps.onDelete();
};

describe('HistoryAndComments - deleting a dispense', () => {
  test('deletes the dispense and re-opens the prescription in one request', async () => {
    mockDeleteDispense.mockResolvedValue({ ok: true } as any);

    await deleteTheDispense();

    expect(mockDeleteDispense).toHaveBeenCalledTimes(1);
    expect(mockDeleteDispense).toHaveBeenCalledWith('dispense-uuid', { fulfillerStatus: null });
  });

  test('shows why a delete was rejected', async () => {
    mockDeleteDispense.mockRejectedValue({
      message: 'Server responded with 400 (Bad Request)',
      responseBody: { error: { message: 'This dispense was recorded before stock was linked to dispenses' } },
    });

    await deleteTheDispense();

    await waitFor(() =>
      expect(vi.mocked(showSnackbar)).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'error',
          subtitle: 'This dispense was recorded before stock was linked to dispenses',
        }),
      ),
    );
  });
});
