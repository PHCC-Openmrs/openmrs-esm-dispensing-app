import React from 'react';
import dayjs from 'dayjs';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type Session, showSnackbar, useConfig, useSession } from '@openmrs/esm-framework';
import {
  type InventoryItem,
  type MedicationDispense,
  MedicationDispenseStatus,
  type MedicationRequest,
  type MedicationRequestBundle,
  MedicationRequestFulfillerStatus,
  MedicationRequestStatus,
} from '../types';
import { OPENMRS_FHIR_EXT_REQUEST_FULFILLER_STATUS } from '../constants';
import { type PharmacyConfig } from '../config-schema';
import DispenseAllAction, { planDispenseAll } from './dispense-all-action.component';
import { saveDispenses, useProviders } from '../medication-dispense/medication-dispense.resource';
import { useDispenseStockForDrugs } from '../forms/stock-dispense/stock.resource';
import type * as medicationDispenseResource from '../medication-dispense/medication-dispense.resource';
import type * as stockResource from '../forms/stock-dispense/stock.resource';

vi.mock('../medication-dispense/medication-dispense.resource', async (importOriginal) => ({
  ...(await importOriginal<typeof medicationDispenseResource>()),
  saveDispenses: vi.fn(),
  useProviders: vi.fn(),
}));

vi.mock('../forms/stock-dispense/stock.resource', async (importOriginal) => ({
  ...(await importOriginal<typeof stockResource>()),
  useDispenseStockForDrugs: vi.fn(),
}));

vi.mock('../pharmacy-queue-notification', () => ({
  notifyIfPrescriptionFulfillmentComplete: vi.fn(),
}));

const mockSaveDispenses = vi.mocked(saveDispenses);
const mockUseProviders = vi.mocked(useProviders);
const mockUseDispenseStockForDrugs = vi.mocked(useDispenseStockForDrugs);
const mockUseConfig = vi.mocked(useConfig);
const mockUseSession = vi.mocked(useSession);
const mockShowSnackbar = vi.mocked(showSnackbar);

const session = {
  currentProvider: { uuid: 'provider-uuid' },
  sessionLocation: { uuid: 'location-uuid' },
} as unknown as Session;

const config = {
  validateBatch: true,
  dispenseBehavior: { allowModifyingPrescription: false, restrictTotalQuantityDispensed: true },
  completeOrderWithThisDispense: false,
  enableDuplicateDispenseCheck: false,
  medicationRequestExpirationPeriodInDays: 90,
  actionButtons: { pauseButton: { enabled: true }, closeButton: { enabled: true } },
} as unknown as PharmacyConfig;

/** An active request with a fully coded dosage, so its pre-filled dispense is valid. */
function buildBundle(id: string, drugUuid: string, quantity: number, overrides: Partial<MedicationRequest> = {}) {
  return {
    request: {
      resourceType: 'MedicationRequest',
      id,
      status: MedicationRequestStatus.active,
      medicationReference: { reference: `Medication/${drugUuid}`, display: drugUuid },
      dispenseRequest: {
        numberOfRepeatsAllowed: 0,
        quantity: { value: quantity, code: 'tablet-code', unit: 'Tablet' },
        validityPeriod: { start: dayjs().subtract(1, 'day').toISOString() },
      },
      dosageInstruction: [
        {
          text: '',
          timing: { code: { coding: [{ code: 'once-daily' }] } },
          route: { coding: [{ code: 'oral' }] },
          doseAndRate: [{ doseQuantity: { value: 1, code: 'tablet-code' } }],
        },
      ],
      ...overrides,
    },
    dispenses: [],
  } as unknown as MedicationRequestBundle;
}

function batch(stockBatchUuid: string, quantity: number, expiresInDays: number): InventoryItem {
  return {
    stockBatchUuid,
    batchNumber: stockBatchUuid.toUpperCase(),
    stockItemUuid: 'stock-item',
    locationUuid: 'location-uuid',
    quantity,
    quantityUoM: 'Tablet',
    quantityUoMUuid: 'uom',
    expiration: dayjs().add(expiresInDays, 'day').toISOString(),
  } as InventoryItem;
}

const plan = (bundles: Array<MedicationRequestBundle>, stock: Record<string, Array<InventoryItem>>, cfg = config) =>
  planDispenseAll(bundles, stock, session, [], cfg);

describe('planDispenseAll', () => {
  test('offers dispense all when the earliest batch of every drug covers its quantity', () => {
    const result = plan([buildBundle('r1', 'drug-a', 30), buildBundle('r2', 'drug-b', 10)], {
      'drug-a': [batch('a-late', 500, 300), batch('a-early', 30, 100)],
      'drug-b': [batch('b1', 10, 100)],
    });

    expect(result.canDispenseAll).toBe(true);
    // the earliest-expiring batch is the one used, not the biggest
    expect(result.items.map((item) => item.batch.stockBatchUuid)).toEqual(['a-early', 'b1']);
  });

  test('hides dispense all when the earliest batch of one drug is short, even if the total is enough', () => {
    const result = plan([buildBundle('r1', 'drug-a', 50), buildBundle('r2', 'drug-b', 10)], {
      'drug-a': [batch('a1', 20, 100), batch('a2', 20, 200), batch('a3', 20, 300)],
      'drug-b': [batch('b1', 10, 100)],
    });

    expect(result.canDispenseAll).toBe(false);
  });

  test('hides dispense all when a drug has no stock', () => {
    expect(
      plan([buildBundle('r1', 'drug-a', 10), buildBundle('r2', 'drug-b', 10)], { 'drug-a': [batch('a1', 10, 100)] })
        .canDispenseAll,
    ).toBe(false);
  });

  test('requires one batch to cover two prescriptions of the same drug together', () => {
    const bundles = [buildBundle('r1', 'drug-a', 20), buildBundle('r2', 'drug-a', 20)];

    expect(plan(bundles, { 'drug-a': [batch('a1', 30, 100)] }).canDispenseAll).toBe(false);
    expect(plan(bundles, { 'drug-a': [batch('a1', 40, 100)] }).canDispenseAll).toBe(true);
  });

  test('leaves out paused prescriptions, which were held on purpose', () => {
    const paused = buildBundle('r3', 'drug-c', 10, {
      extension: [
        { url: OPENMRS_FHIR_EXT_REQUEST_FULFILLER_STATUS, valueCode: MedicationRequestFulfillerStatus.on_hold },
      ],
    } as Partial<MedicationRequest>);

    paused.dispenses = [
      {
        resourceType: 'MedicationDispense',
        id: 'paused-dispense',
        status: MedicationDispenseStatus.on_hold,
        whenHandedOver: dayjs().toISOString(),
      } as MedicationDispense,
    ];

    const result = plan([buildBundle('r1', 'drug-a', 10), buildBundle('r2', 'drug-b', 10), paused], {
      'drug-a': [batch('a1', 10, 100)],
      'drug-b': [batch('b1', 10, 100)],
    });

    expect(result.items.map((item) => item.medicationRequestBundle.request.id)).toEqual(['r1', 'r2']);
    expect(result.canDispenseAll).toBe(true);
  });

  test('is not offered for a single dispensable prescription', () => {
    expect(plan([buildBundle('r1', 'drug-a', 10)], { 'drug-a': [batch('a1', 10, 100)] }).canDispenseAll).toBe(false);
  });

  test('hides dispense all when a pre-filled dispense is incomplete', () => {
    const noRoute = buildBundle('r2', 'drug-b', 10);
    noRoute.request.dosageInstruction[0].route = undefined;

    expect(
      plan([buildBundle('r1', 'drug-a', 10), noRoute], {
        'drug-a': [batch('a1', 10, 100)],
        'drug-b': [batch('b1', 10, 100)],
      }).canDispenseAll,
    ).toBe(false);
  });

  test('does not count a fraction of a unit left in the earliest batch', () => {
    const bundles = [buildBundle('r1', 'drug-a', 10.5), buildBundle('r2', 'drug-b', 10)];
    const stock = { 'drug-a': [batch('a1', 10.9, 100)], 'drug-b': [batch('b1', 10, 100)] };

    expect(plan(bundles, stock).canDispenseAll).toBe(false);
  });
});

describe('DispenseAllAction', () => {
  const bundles = [buildBundle('r1', 'drug-a', 30), buildBundle('r2', 'drug-b', 10)];

  beforeEach(() => {
    mockUseConfig.mockReturnValue(config);
    mockUseSession.mockReturnValue(session);
    mockUseProviders.mockReturnValue([]);
    mockUseDispenseStockForDrugs.mockReturnValue({
      inventoryItemsByDrug: { 'drug-a': [batch('a1', 100, 100)], 'drug-b': [batch('b1', 50, 100)] },
      isLoading: false,
      error: null,
    });
    mockSaveDispenses.mockResolvedValue({ ok: true, data: { dispenses: [] } } as any);
  });

  const confirmDispenseAll = async () => {
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Dispense all' }));
    await user.click(screen.getByRole('button', { name: 'Dispense {{count}} medications' }));
  };

  test('saves every medication, each with its batch, in a single request', async () => {
    render(
      <DispenseAllAction
        encounterUuid="encounter-uuid"
        patientUuid="patient-uuid"
        medicationRequestBundles={bundles}
        disabled={false}
      />,
    );

    await confirmDispenseAll();

    expect(mockSaveDispenses).toHaveBeenCalledTimes(1);
    const [items] = mockSaveDispenses.mock.calls[0];
    expect(items.map((item) => [item.medicationDispense.status, item.stock])).toEqual([
      [
        MedicationDispenseStatus.completed,
        [
          {
            dispenseLocation: 'location-uuid',
            stockItem: 'stock-item',
            stockBatch: 'a1',
            stockItemPackagingUOM: 'uom',
            quantity: 30,
          },
        ],
      ],
      [
        MedicationDispenseStatus.completed,
        [
          {
            dispenseLocation: 'location-uuid',
            stockItem: 'stock-item',
            stockBatch: 'b1',
            stockItemPackagingUOM: 'uom',
            quantity: 10,
          },
        ],
      ],
    ]);
    expect(mockShowSnackbar).toHaveBeenCalledWith(
      expect.objectContaining({ title: '{{count}} medications dispensed' }),
    );
  });

  test('reports that nothing was dispensed when the request fails, and retries under the same ids', async () => {
    mockSaveDispenses.mockRejectedValueOnce({
      message: 'Server responded with 400 (Bad Request)',
      responseBody: { error: { message: 'Not enough stock in batch B1' } },
    });
    render(
      <DispenseAllAction
        encounterUuid="encounter-uuid"
        patientUuid="patient-uuid"
        medicationRequestBundles={bundles}
        disabled={false}
      />,
    );

    await confirmDispenseAll();

    expect(mockShowSnackbar).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'error',
        title: 'Nothing was dispensed',
        subtitle: 'Not enough stock in batch B1',
      }),
    );
    expect(mockShowSnackbar).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: '{{count}} medications dispensed' }),
    );

    await confirmDispenseAll();

    const idsOf = (call: number) => mockSaveDispenses.mock.calls[call][0].map((item) => item.medicationDispense.id);
    expect(idsOf(1)).toEqual(idsOf(0));
    expect(new Set(idsOf(0)).size).toBe(2);
  });
});
