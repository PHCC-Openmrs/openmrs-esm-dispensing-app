import React from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useConfig, usePatient } from '@openmrs/esm-framework';
import { type MedicationDispense, MedicationDispenseStatus, MedicationRequestFulfillerStatus } from '../types';
import { saveDispenses, useReasonForPauseValueSet } from '../medication-dispense/medication-dispense.resource';
import PauseDispenseForm from './pause-dispense-form.workspace';

vi.mock('../medication-dispense/medication-dispense.resource', () => ({
  saveDispenses: vi.fn(),
  useReasonForPauseValueSet: vi.fn(),
}));

const mockSaveDispenses = vi.mocked(saveDispenses);
const mockCloseWorkspace = vi.fn();

const workspaceProps = {
  launchChildWorkspace: vi.fn(),
  windowProps: {},
  groupProps: {},
  workspaceName: 'pause-dispense-workspace',
  windowName: 'pause-dispense-window',
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

const renderPauseForm = (dispense: MedicationDispense, mode: 'enter' | 'edit') =>
  render(
    <PauseDispenseForm
      {...workspaceProps}
      workspaceProps={{ medicationDispense: dispense, mode, encounterUuid: 'encounter-uuid' }}
      closeWorkspace={mockCloseWorkspace}
    />,
  );

beforeEach(() => {
  vi.mocked(useConfig).mockReturnValue({ valueSets: { reasonForPause: { uuid: 'reason-value-set' } } });
  vi.mocked(usePatient).mockReturnValue({ patient: null, isLoading: false } as any);
  vi.mocked(useReasonForPauseValueSet).mockReturnValue({
    reasonForPauseValueSet: {
      compose: { include: [{ concept: [{ code: 'reason-uuid', display: 'Patient request' }] }] },
    } as any,
  });
  mockSaveDispenses.mockResolvedValue({ ok: true, data: { dispenses: [] } } as any);
});

describe('PauseDispenseForm', () => {
  test('saves a new pause and the prescription going on hold in one request, taking no stock', async () => {
    const user = userEvent.setup();
    renderPauseForm(medicationDispense, 'enter');

    await user.click(screen.getByRole('combobox', { name: /reason for pause/i }));
    await user.click(screen.getByRole('option', { name: 'Patient request' }));
    await user.click(screen.getByRole('button', { name: 'Pause' }));

    expect(mockSaveDispenses).toHaveBeenCalledTimes(1);
    expect(mockSaveDispenses.mock.calls[0][0]).toEqual([
      {
        medicationDispense: expect.objectContaining({
          id: expect.any(String),
          status: MedicationDispenseStatus.on_hold,
          statusReasonCodeableConcept: { coding: [{ code: 'reason-uuid' }] },
        }),
        fulfillerStatus: MedicationRequestFulfillerStatus.on_hold,
      },
    ]);
    expect(mockCloseWorkspace).toHaveBeenCalledWith({ discardUnsavedChanges: true });
  });

  test('saves an edited pause record as an update, leaving the prescription status alone', async () => {
    const user = userEvent.setup();
    renderPauseForm(
      {
        ...medicationDispense,
        id: 'paused-dispense-uuid',
        status: MedicationDispenseStatus.on_hold,
        statusReasonCodeableConcept: { coding: [{ code: 'reason-uuid' }] },
      } as MedicationDispense,
      'edit',
    );

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(mockSaveDispenses.mock.calls[0][0]).toEqual([
      {
        medicationDispense: expect.objectContaining({ id: 'paused-dispense-uuid' }),
        update: true,
      },
    ]);
  });
});
