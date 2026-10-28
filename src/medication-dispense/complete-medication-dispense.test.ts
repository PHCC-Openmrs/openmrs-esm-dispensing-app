import { describe, expect, test } from 'vitest';
import { type PharmacyConfig } from '../config-schema';
import { OPENMRS_FHIR_EXT_REQUEST_FULFILLER_STATUS } from '../constants';
import {
  type DispenseStockLine,
  type MedicationDispense,
  MedicationDispenseStatus,
  type MedicationRequest,
  type MedicationRequestBundle,
  MedicationRequestFulfillerStatus,
  MedicationRequestStatus,
} from '../types';
import { buildCompletedDispenseItem, buildPausedOrClosedDispenseItem } from './complete-medication-dispense';

const buildConfig = ({ completeOrderWithThisDispense = false, restrictTotalQuantityDispensed = true } = {}) =>
  ({
    completeOrderWithThisDispense,
    dispenseBehavior: { allowModifyingPrescription: false, restrictTotalQuantityDispensed },
  }) as unknown as PharmacyConfig;

const stock: Array<DispenseStockLine> = [
  {
    dispenseLocation: 'location-uuid',
    stockItem: 'stock-item-uuid',
    stockBatch: 'stock-batch-uuid',
    stockItemPackagingUOM: 'uom-uuid',
    quantity: 30,
  },
];

/** A prescription for 30 tablets with no refills, and optionally a fulfiller status already set. */
const buildBundle = (
  dispenses: Array<MedicationDispense> = [],
  fulfillerStatus?: MedicationRequestFulfillerStatus,
): MedicationRequestBundle => ({
  request: {
    resourceType: 'MedicationRequest',
    id: 'request-uuid',
    status: MedicationRequestStatus.active,
    dispenseRequest: {
      numberOfRepeatsAllowed: 0,
      quantity: { value: 30, code: 'tablet-code' },
      validityPeriod: { start: '2026-10-01' },
    },
    extension: fulfillerStatus
      ? [{ url: OPENMRS_FHIR_EXT_REQUEST_FULFILLER_STATUS, valueCode: fulfillerStatus }]
      : undefined,
  } as unknown as MedicationRequest,
  dispenses,
});

const buildDispense = (overrides: Partial<MedicationDispense> = {}): MedicationDispense =>
  ({
    resourceType: 'MedicationDispense',
    status: null,
    authorizingPrescription: [{ reference: 'MedicationRequest/request-uuid', type: 'MedicationRequest' }],
    quantity: { value: 30, code: 'tablet-code' },
    whenHandedOver: '2026-10-28T09:00:00+00:00',
    ...overrides,
  }) as MedicationDispense;

describe('buildCompletedDispenseItem', () => {
  test('sends a new dispense as completed, under the id generated for it, with its stock', () => {
    const item = buildCompletedDispenseItem(buildDispense(), buildBundle(), buildConfig(), 'new-dispense-uuid', stock);

    expect(item.medicationDispense).toMatchObject({
      id: 'new-dispense-uuid',
      status: MedicationDispenseStatus.completed,
      whenPrepared: '2026-10-28T09:00:00+00:00',
    });
    expect(item.update).toBeUndefined();
    expect(item.stock).toBe(stock);
    expect(item.restrictTotalQuantityDispensed).toBe(true);
  });

  test('counts a new dispense towards the prescription, completing it once the full quantity is out', () => {
    // the generated id must not make the new dispense look like an edit of one already in the
    // bundle, or its 30 tablets would not be counted and the prescription would stay open
    const item = buildCompletedDispenseItem(buildDispense(), buildBundle(), buildConfig(), 'new-dispense-uuid', stock);

    expect(item.fulfillerStatus).toBe(MedicationRequestFulfillerStatus.completed);
  });

  test('leaves the fulfiller status out when it does not change', () => {
    const existing = buildDispense({
      id: 'existing-dispense-uuid',
      status: MedicationDispenseStatus.completed,
    });
    const item = buildCompletedDispenseItem(
      { ...existing, whenHandedOver: '2026-10-28T10:00:00+00:00' },
      buildBundle([existing], MedicationRequestFulfillerStatus.completed),
      buildConfig(),
      'unused-new-dispense-uuid',
      stock,
    );

    expect('fulfillerStatus' in item).toBe(false);
  });

  test('completes the prescription straight away when completeOrderWithThisDispense is set', () => {
    const item = buildCompletedDispenseItem(
      buildDispense({ quantity: { value: 10, code: 'tablet-code' } }),
      buildBundle(),
      buildConfig({ completeOrderWithThisDispense: true }),
      'new-dispense-uuid',
      stock,
    );

    expect(item.fulfillerStatus).toBe(MedicationRequestFulfillerStatus.completed);
  });

  test('sends an edit as an update of the existing dispense, keeping its id', () => {
    const existing = buildDispense({
      id: 'existing-dispense-uuid',
      status: MedicationDispenseStatus.completed,
      quantity: { value: 10, code: 'tablet-code' },
    });

    const item = buildCompletedDispenseItem(
      { ...existing, quantity: { value: 30, code: 'tablet-code' } },
      buildBundle([existing]),
      buildConfig(),
      'unused-new-dispense-uuid',
      stock,
    );

    expect(item.update).toBe(true);
    expect(item.medicationDispense.id).toBe('existing-dispense-uuid');
    // the edited 30 replaces the original 10 rather than adding to it
    expect(item.fulfillerStatus).toBe(MedicationRequestFulfillerStatus.completed);
  });
});

describe('buildPausedOrClosedDispenseItem', () => {
  test('a new pause puts the prescription on hold and takes no stock', () => {
    const item = buildPausedOrClosedDispenseItem(
      buildDispense(),
      MedicationDispenseStatus.on_hold,
      MedicationRequestFulfillerStatus.on_hold,
      'new-dispense-uuid',
    );

    expect(item).toEqual({
      medicationDispense: expect.objectContaining({
        id: 'new-dispense-uuid',
        status: MedicationDispenseStatus.on_hold,
      }),
      fulfillerStatus: MedicationRequestFulfillerStatus.on_hold,
    });
  });

  test('editing a close record updates it without touching the prescription status', () => {
    const item = buildPausedOrClosedDispenseItem(
      buildDispense({ id: 'existing-dispense-uuid', status: MedicationDispenseStatus.declined }),
      MedicationDispenseStatus.declined,
      MedicationRequestFulfillerStatus.declined,
      'unused-new-dispense-uuid',
    );

    expect(item).toEqual({
      medicationDispense: expect.objectContaining({
        id: 'existing-dispense-uuid',
        status: MedicationDispenseStatus.declined,
      }),
      update: true,
    });
  });
});
