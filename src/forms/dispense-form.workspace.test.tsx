import React from 'react';
import { vi, describe, expect, test, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { showModal, showSnackbar, useConfig, usePatient } from '@openmrs/esm-framework';
import {
  type InventoryItem,
  type MedicationDispense,
  type MedicationRequestBundle,
  MedicationDispenseStatus,
} from '../types';
import DispenseForm from './dispense-form.workspace';
import { saveDispenses } from '../medication-dispense/medication-dispense.resource';

const mockUseConfig = vi.mocked(useConfig);
const mockUsePatient = vi.mocked(usePatient);
const mockShowModal = vi.mocked(showModal);
const mockShowSnackbar = vi.mocked(showSnackbar);
const mockCloseWorkspace = vi.fn();
const mockLaunchChildWorkspace = vi.fn();
const mockSaveDispenses = vi.mocked(saveDispenses);

vi.mock('../medication-dispense/medication-dispense.resource', () => ({
  __esModule: true,
  saveDispenses: vi.fn(),
}));

const { mockBatch } = vi.hoisted(() => ({
  mockBatch: {
    stockBatchUuid: 'stock-batch-uuid',
    stockItemUuid: 'stock-item-uuid',
    quantityUoMUuid: 'uom-uuid',
    locationUuid: 'location-uuid',
    batchNumber: 'BATCH-A',
    quantity: 100,
  } as InventoryItem,
}));

// Mock workspace props required by Workspace2DefinitionProps
const mockWorkspaceProps = {
  launchChildWorkspace: mockLaunchChildWorkspace,
  windowProps: {},
  groupProps: {},
  workspaceName: 'dispense-form',
  windowName: 'dispense-form-window',
  isRootWorkspace: true,
  promptBeforeClosing: vi.fn(),
  setTitle: vi.fn(),
  showActionMenu: true,
};

// Mock the child components
vi.mock('./medication-dispense-review.component', () => ({
  __esModule: true,
  default: () => <div>Medication Dispense Review</div>,
}));

// stands in for the batch selector: picking a batch is what lets a dispense be submitted
vi.mock('./stock-dispense/stock-dispense.component', () => ({
  __esModule: true,
  default: ({ updateInventoryItems }) => (
    <button type="button" onClick={() => updateInventoryItems([mockBatch])}>
      Select batch
    </button>
  ),
}));

const mockPatient = {
  uuid: 'patient-uuid',
  display: 'Test Patient',
  identifiers: [],
  person: {
    age: 30,
    attributes: [],
    birthDate: '1990-01-01',
    gender: 'M',
    display: 'Test Patient',
    preferredAddress: {},
    uuid: 'patient-uuid',
  },
};

const createMockMedicationDispense = (): MedicationDispense => ({
  resourceType: 'MedicationDispense',
  status: MedicationDispenseStatus.completed,
  medicationCodeableConcept: {
    text: 'Test Medication',
    coding: [
      {
        code: 'medication-code',
      },
    ],
  },
  medicationReference: {
    reference: 'Medication/med-uuid',
    display: 'Test Medication',
  },
  subject: {
    reference: 'Patient/patient-uuid',
    display: 'Test Patient',
  },
  performer: [
    {
      actor: {
        reference: 'Practitioner/prac-uuid',
        display: 'Test Practitioner',
      },
    },
  ],
  location: {
    reference: 'Location/loc-uuid',
    display: 'Test Location',
  },
  quantity: {
    value: 30,
    code: '385055001',
  },
  dosageInstruction: [
    {
      timing: {
        code: {
          coding: [
            {
              code: 'timing-code',
              display: 'Once daily',
            },
          ],
        },
      },
      asNeededBoolean: false,
      route: {
        coding: [
          {
            code: 'route-code',
            display: 'Oral',
          },
        ],
      },
      doseAndRate: [
        {
          doseQuantity: {
            value: 1,
            code: '385055001',
          },
        },
      ],
    },
  ],
  substitution: {
    wasSubstituted: false,
  },
});

const createMockMedicationRequestBundle = (numberOfRepeatsAllowed: number | null): MedicationRequestBundle => ({
  request: {
    resourceType: 'MedicationRequest',
    id: 'request-uuid',
    meta: {
      lastUpdated: '2023-01-01T00:00:00.000Z',
    },
    status: 'active' as any,
    intent: 'order',
    priority: 'routine',
    medicationReference: {
      reference: 'Medication/med-uuid',
      display: 'Test Medication',
    },
    subject: {
      reference: 'Patient/patient-uuid',
      display: 'Test Patient',
    },
    encounter: {
      reference: 'Encounter/enc-uuid',
      type: 'Encounter',
    },
    requester: {
      reference: 'Practitioner/prac-uuid',
      type: 'Practitioner',
      identifier: {
        value: 'PRAC123',
      },
      display: 'Test Practitioner',
    },
    dosageInstruction: [
      {
        timing: {
          code: {
            coding: [
              {
                code: 'timing-code',
                display: 'Once daily',
              },
            ],
          },
        },
        asNeededBoolean: false,
        route: {
          coding: [
            {
              code: 'route-code',
              display: 'Oral',
            },
          ],
        },
        doseAndRate: [
          {
            doseQuantity: {
              value: 1,
              code: '385055001',
            },
          },
        ],
      },
    ],
    dispenseRequest: {
      numberOfRepeatsAllowed: numberOfRepeatsAllowed,
      quantity: {
        value: 30,
        code: '385055001',
      },
      validityPeriod: {
        start: '2023-01-01',
      },
    },
  },
  dispenses: [],
});

beforeEach(() => {
  mockShowModal.mockReturnValue(vi.fn());
  mockSaveDispenses.mockResolvedValue({ ok: true, status: 200, data: { dispenses: [{ status: 'completed' }] } } as any);
  mockUseConfig.mockReturnValue({
    dispenseBehavior: {
      allowModifyingPrescription: false,
      restrictTotalQuantityDispensed: false,
    },
    completeOrderWithThisDispense: true,
  });
  mockUsePatient.mockReturnValue({
    patient: mockPatient,
    isLoading: false,
    error: null,
    patientUuid: 'patient-uuid',
  } as any);
});

describe('DispenseForm - duplicate dispense check', () => {
  test('should not show duplicate warning for retrospective dispense when only later dispenses are in the lookback window', async () => {
    const user = userEvent.setup();

    const medicationDispense = {
      ...createMockMedicationDispense(),
      whenHandedOver: '2026-03-12T10:00:00.000Z',
    };
    const recentDispense = {
      ...createMockMedicationDispense(),
      id: 'existing-dispense-id',
      whenHandedOver: '2026-03-26T10:00:00.000Z',
    };

    const medicationRequestBundle = {
      ...createMockMedicationRequestBundle(0),
      dispenses: [recentDispense],
    };

    mockUseConfig.mockReturnValue({
      dispenseBehavior: {
        allowModifyingPrescription: false,
        restrictTotalQuantityDispensed: false,
      },
      completeOrderWithThisDispense: true,
      enableDuplicateDispenseCheck: true,
      duplicateCheckWindowDays: 7,
    } as any);

    render(
      <DispenseForm
        {...mockWorkspaceProps}
        workspaceProps={{
          medicationDispense,
          medicationRequestBundle,
          mode: 'enter',
          patientUuid: 'patient-uuid',
          encounterUuid: 'encounter-uuid',
          quantityRemaining: 30,
          quantityDispensed: 0,
        }}
        closeWorkspace={mockCloseWorkspace}
      />,
    );

    await user.click(screen.getByRole('button', { name: /select batch/i }));
    await user.click(screen.getByRole('button', { name: /dispense prescription/i }));

    expect(mockShowModal).not.toHaveBeenCalled();
    expect(mockSaveDispenses).toHaveBeenCalled();
  });
});

const renderDispenseForm = (
  medicationDispense: MedicationDispense = createMockMedicationDispense(),
  mode: 'enter' | 'edit' = 'enter',
) =>
  render(
    <DispenseForm
      {...mockWorkspaceProps}
      workspaceProps={{
        medicationDispense,
        medicationRequestBundle: createMockMedicationRequestBundle(0),
        mode,
        patientUuid: 'patient-uuid',
        encounterUuid: 'encounter-uuid',
        quantityRemaining: 30,
        quantityDispensed: 0,
      }}
      closeWorkspace={mockCloseWorkspace}
    />,
  );

describe('DispenseForm - saving with stock', () => {
  test('always asks for batches, and only allows dispensing once they cover the quantity', async () => {
    const user = userEvent.setup();
    renderDispenseForm();

    expect(screen.getByRole('button', { name: /dispense prescription/i })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /select batch/i }));

    expect(screen.getByRole('button', { name: /dispense prescription/i })).toBeEnabled();
  });

  test('saves the dispense, its stock and the prescription status in one request', async () => {
    const user = userEvent.setup();
    renderDispenseForm({ ...createMockMedicationDispense(), whenHandedOver: '2026-10-28T09:00:00+00:00' });

    await user.click(screen.getByRole('button', { name: /select batch/i }));
    await user.click(screen.getByRole('button', { name: /dispense prescription/i }));

    expect(mockSaveDispenses).toHaveBeenCalledTimes(1);
    const [items] = mockSaveDispenses.mock.calls[0];
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      medicationDispense: expect.objectContaining({
        id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
        status: MedicationDispenseStatus.completed,
        whenPrepared: '2026-10-28T09:00:00+00:00',
      }),
      fulfillerStatus: 'COMPLETED',
      restrictTotalQuantityDispensed: false,
      stock: [
        {
          dispenseLocation: 'location-uuid',
          stockItem: 'stock-item-uuid',
          stockBatch: 'stock-batch-uuid',
          stockItemPackagingUOM: 'uom-uuid',
          quantity: 30,
        },
      ],
    });
    expect(mockCloseWorkspace).toHaveBeenCalledWith({ discardUnsavedChanges: true });
  });

  test('keeps the form open on an error, and resends the same dispense id', async () => {
    const user = userEvent.setup();
    mockSaveDispenses.mockRejectedValueOnce({
      message: 'Server responded with 400 (Bad Request)',
      responseBody: { error: { message: 'Not enough stock in batch BATCH-A' } },
    });
    renderDispenseForm();

    await user.click(screen.getByRole('button', { name: /select batch/i }));
    await user.click(screen.getByRole('button', { name: /dispense prescription/i }));

    expect(mockShowSnackbar).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error', subtitle: 'Not enough stock in batch BATCH-A' }),
    );
    expect(mockCloseWorkspace).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /dispense prescription/i }));

    expect(mockSaveDispenses).toHaveBeenCalledTimes(2);
    const firstId = mockSaveDispenses.mock.calls[0][0][0].medicationDispense.id;
    expect(mockSaveDispenses.mock.calls[1][0][0].medicationDispense.id).toBe(firstId);
    expect(mockCloseWorkspace).toHaveBeenCalledWith({ discardUnsavedChanges: true });
  });

  test('sends an edit as an update of the existing dispense, with the newly selected batches', async () => {
    const user = userEvent.setup();
    renderDispenseForm({ ...createMockMedicationDispense(), id: 'existing-dispense-uuid' }, 'edit');

    await user.click(screen.getByRole('button', { name: /select batch/i }));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    const [[item]] = mockSaveDispenses.mock.calls[0];
    expect(item.update).toBe(true);
    expect(item.medicationDispense.id).toBe('existing-dispense-uuid');
    expect(item.stock).toEqual([expect.objectContaining({ stockBatch: 'stock-batch-uuid', quantity: 30 })]);
  });
});
