import React from 'react';
import { vi, describe, expect, test, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useConfig } from '@openmrs/esm-framework';
import { type InventoryItem, type MedicationDispense, MedicationDispenseStatus } from '../../types';
import StockDispense from './stock-dispense.component';
import { useDispenseStock } from './stock.resource';

const mockUseConfig = vi.mocked(useConfig);
const mockUseDispenseStock = vi.mocked(useDispenseStock);

vi.mock('./stock.resource', () => ({
  __esModule: true,
  useDispenseStock: vi.fn(),
}));

// Expiries are expressed relative to "now" so the suite does not rot as real time passes.
const daysFromNow = (days: number) => new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

const createInventoryItem = (overrides: Partial<InventoryItem> = {}): InventoryItem =>
  ({
    partyName: 'Outpatient Pharmacy',
    stockItemUuid: 'stock-item-uuid',
    stockBatchUuid: 'stock-batch-uuid',
    batchNumber: 'BATCH-A',
    quantity: 200,
    quantityUoM: 'Tablet',
    quantityUoMUuid: 'uom-uuid',
    locationUuid: 'location-uuid',
    expiration: daysFromNow(365),
    ...overrides,
  }) as InventoryItem;

/**
 * A dispense whose dosage instruction carries a duration, i.e. the course length is known.
 * Passing `null` builds the case that stranded prescriptions in production: an order entered
 * with no duration at all.
 */
const createMedicationDispense = (duration: number | null, durationUnit = 'd'): MedicationDispense =>
  ({
    resourceType: 'MedicationDispense',
    status: MedicationDispenseStatus.completed,
    medicationReference: { reference: 'Medication/drug-uuid' },
    dosageInstruction: [
      {
        timing: {
          code: { coding: [] },
          repeat: duration === null ? undefined : { duration, durationUnit },
        },
      },
    ],
  }) as unknown as MedicationDispense;

const renderStockDispense = (medicationDispense: MedicationDispense) =>
  render(
    <StockDispense medicationDispense={medicationDispense} inventoryItem={undefined} updateInventoryItem={vi.fn()} />,
  );

/**
 * Opens the batch selector. `getAllByRole('option')` afterwards is the assertion that
 * matters: an option per eligible batch is exactly what enables the Dispense button.
 */
const openBatchSelector = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox', { name: /stock dispense/i }));
};

beforeEach(() => {
  mockUseConfig.mockReturnValue({ validateBatch: true } as never);
  mockUseDispenseStock.mockReturnValue({
    inventoryItems: [createInventoryItem()],
    error: null,
    isLoading: false,
  });
});

describe('StockDispense batch eligibility', () => {
  test('offers the batch when the prescription carries no duration', async () => {
    // Regression: an order with no duration used to filter out every batch, which left the
    // selector empty and the Dispense button permanently disabled, stranding the
    // prescription in the worklist as Active with no error explaining why.
    renderStockDispense(createMedicationDispense(null));

    await openBatchSelector();

    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(screen.queryByText(/No batch can be dispensed/i)).not.toBeInTheDocument();
  });

  test('offers a batch that outlasts a known course', async () => {
    renderStockDispense(createMedicationDispense(10));

    await openBatchSelector();

    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  test('excludes a batch that expires before a known course ends', async () => {
    mockUseDispenseStock.mockReturnValue({
      inventoryItems: [createInventoryItem({ expiration: daysFromNow(3) })],
      error: null,
      isLoading: false,
    });

    renderStockDispense(createMedicationDispense(30));

    await openBatchSelector();

    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText(/No batch can be dispensed/i)).toBeInTheDocument();
  });

  test('excludes a batch that has already expired, even with no duration to check against', async () => {
    mockUseDispenseStock.mockReturnValue({
      inventoryItems: [createInventoryItem({ expiration: daysFromNow(-30) })],
      error: null,
      isLoading: false,
    });

    renderStockDispense(createMedicationDispense(null));

    await openBatchSelector();

    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  test('excludes an empty batch', async () => {
    mockUseDispenseStock.mockReturnValue({
      inventoryItems: [createInventoryItem({ quantity: 0 })],
      error: null,
      isLoading: false,
    });

    renderStockDispense(createMedicationDispense(null));

    await openBatchSelector();

    expect(screen.queryAllByRole('option')).toHaveLength(0);
    // no stock at all, so the existing "No item in inventory" notice covers it
    expect(screen.getByText(/There is no stock of this medicine/i)).toBeInTheDocument();
    expect(screen.queryByText(/No batch can be dispensed/i)).not.toBeInTheDocument();
  });

  test('offers a batch with no recorded expiry', async () => {
    mockUseDispenseStock.mockReturnValue({
      inventoryItems: [createInventoryItem({ expiration: undefined })],
      error: null,
      isLoading: false,
    });

    renderStockDispense(createMedicationDispense(30));

    await openBatchSelector();

    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  test('skips eligibility checks entirely when validateBatch is disabled', async () => {
    mockUseConfig.mockReturnValue({ validateBatch: false } as never);
    mockUseDispenseStock.mockReturnValue({
      inventoryItems: [createInventoryItem({ expiration: daysFromNow(-30) })],
      error: null,
      isLoading: false,
    });

    renderStockDispense(createMedicationDispense(30));

    await openBatchSelector();

    expect(screen.getAllByRole('option')).toHaveLength(1);
  });
});
