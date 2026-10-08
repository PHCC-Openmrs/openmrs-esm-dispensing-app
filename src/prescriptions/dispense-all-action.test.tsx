import dayjs from 'dayjs';
import { describe, expect, test } from 'vitest';
import { type Session } from '@openmrs/esm-framework';
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
import { planDispenseAll } from './dispense-all-action.component';

const session = {
  currentProvider: { uuid: 'provider-uuid' },
  sessionLocation: { uuid: 'location-uuid' },
} as unknown as Session;

const config = {
  enableStockDispense: true,
  validateBatch: true,
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

  test('ignores stock entirely when stock dispensing is disabled', () => {
    const result = plan(
      [buildBundle('r1', 'drug-a', 10), buildBundle('r2', 'drug-b', 10)],
      {},
      {
        ...config,
        enableStockDispense: false,
      },
    );

    expect(result.canDispenseAll).toBe(true);
  });
});
