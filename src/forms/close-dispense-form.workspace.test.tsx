import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { showSnackbar, useConfig, usePatient } from '@openmrs/esm-framework';
import { type MedicationDispense, MedicationDispenseStatus, MedicationRequestFulfillerStatus } from '../types';
import { saveDispenses, useReasonForCloseValueSet } from '../medication-dispense/medication-dispense.resource';
import CloseDispenseForm from './close-dispense-form.workspace';

vi.mock('../medication-dispense/medication-dispense.resource', () => ({
  saveDispenses: vi.fn(),
  useReasonForCloseValueSet: vi.fn(),
}));

vi.mock('../pharmacy-queue-notification', () => ({
  notifyIfPrescriptionFulfillmentComplete: vi.fn(),
}));

const mockSaveDispenses = vi.mocked(saveDispenses);
const mockCloseWorkspace = vi.fn();

const workspaceProps = {
  launchChildWorkspace: vi.fn(),
  windowProps: {},
  groupProps: {},
  workspaceName: 'close-dispense-workspace',
  windowName: 'close-dispense-window',
  isRootWorkspace: true,
  promptBeforeClosing: vi.fn(),
  setTitle: vi.fn(),
  showActionMenu: true,
};

const medicationDispense = {
  resourceType: 'MedicationDispense',
  status: null,
  authorizingPrescription: [{ reference: 'MedicationRequest/request-uuid', type: 'MedicationRequest' }],
  whenHandedOver: '2026-10-28T09:00:00+00:00',
} as MedicationDispense;

const renderCloseForm = () =>
  render(
    <CloseDispenseForm
      {...workspaceProps}
      workspaceProps={{ medicationDispense, mode: 'enter', encounterUuid: 'encounter-uuid' }}
      closeWorkspace={mockCloseWorkspace}
    />,
  );

beforeEach(() => {
  vi.mocked(useConfig).mockReturnValue({
    valueSets: { reasonForClose: { uuid: 'reason-value-set' } },
    medicationRequestExpirationPeriodInDays: 90,
  });
  vi.mocked(usePatient).mockReturnValue({ patient: null, isLoading: false } as any);
  vi.mocked(useReasonForCloseValueSet).mockReturnValue({
    reasonForCloseValueSet: {
      compose: { include: [{ concept: [{ code: 'reason-uuid', display: 'Out of stock' }] }] },
    } as any,
  });
  mockSaveDispenses.mockResolvedValue({ ok: true, data: { dispenses: [] } } as any);
});

const closeWithReason = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', { name: /reason for close/i }));
  await user.click(screen.getByRole('option', { name: 'Out of stock' }));
  await user.click(screen.getByRole('button', { name: 'Close' }));
};

describe('CloseDispenseForm', () => {
  test('saves a new close and the prescription being declined in one request, taking no stock', async () => {
    renderCloseForm();

    await closeWithReason();

    expect(mockSaveDispenses.mock.calls[0][0]).toEqual([
      {
        medicationDispense: expect.objectContaining({
          id: expect.any(String),
          status: MedicationDispenseStatus.declined,
        }),
        fulfillerStatus: MedicationRequestFulfillerStatus.declined,
      },
    ]);
    expect(mockCloseWorkspace).toHaveBeenCalledWith({ discardUnsavedChanges: true });
  });

  test('shows the server error and stays open when the close is rejected', async () => {
    mockSaveDispenses.mockRejectedValueOnce({
      message: 'Server responded with 403 (Forbidden)',
      responseBody: { error: { message: 'Privileges required: Task: stockmanagement.stockItems.dispense' } },
    });
    renderCloseForm();

    await closeWithReason();

    expect(vi.mocked(showSnackbar)).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'error',
        subtitle: 'Privileges required: Task: stockmanagement.stockItems.dispense',
      }),
    );
    expect(mockCloseWorkspace).not.toHaveBeenCalled();
  });
});
