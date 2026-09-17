import React from 'react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { useConfig, useSession } from '@openmrs/esm-framework';
import { usePrescriptionsTable } from '../medication-request/medication-request.resource';
import PrescriptionTabPanel from './prescription-tab-panel.component';
import { type SimpleLocation } from '../types';

vi.mock('../medication-request/medication-request.resource');

const mockUseConfig = vi.mocked(useConfig);
const mockUseSession = vi.mocked(useSession);
const mockUsePrescriptionsTable = vi.mocked(usePrescriptionsTable);

const descendantLocations: SimpleLocation[] = [
  { id: 'loc-mch', name: 'KGH MCH', associatedPharmacyLocation: null },
  { id: 'loc-triage', name: 'KGH Triage', associatedPharmacyLocation: null },
];

beforeEach(() => {
  mockUsePrescriptionsTable.mockReturnValue({
    prescriptionsTableRows: [],
    error: undefined,
    isLoading: false,
    totalOrders: 0,
  });
  mockUseSession.mockReturnValue({ sessionLocation: { uuid: 'session-uuid' } } as any);
});

describe('PrescriptionTabPanel', () => {
  it('restricts the data fetch to visit location descendants when restrictToVisitLocationDescendants is true and no filter location is selected', () => {
    mockUseConfig.mockReturnValue({
      locationBehavior: {
        locationColumn: { enabled: false },
        locationFilter: { enabled: false },
        restrictToVisitLocationDescendants: true,
      },
      medicationRequestExpirationPeriodInDays: 90,
      refreshInterval: 10000,
      actionButtons: {
        pauseButton: { enabled: true },
        closeButton: { enabled: true },
      },
    });

    render(<PrescriptionTabPanel isTabActive={true} locations={descendantLocations} isLocationsLoading={false} />);

    const [, , , , , , locationsPassedToFetch] = mockUsePrescriptionsTable.mock.lastCall;
    expect(locationsPassedToFetch).toEqual(descendantLocations);
  });

  it('fetches without a location restriction when restrictToVisitLocationDescendants is false and no filter is selected', () => {
    mockUseConfig.mockReturnValue({
      locationBehavior: {
        locationColumn: { enabled: false },
        locationFilter: { enabled: false },
        restrictToVisitLocationDescendants: false,
      },
      medicationRequestExpirationPeriodInDays: 90,
      refreshInterval: 10000,
      actionButtons: {
        pauseButton: { enabled: true },
        closeButton: { enabled: true },
      },
    });

    render(<PrescriptionTabPanel isTabActive={true} locations={descendantLocations} isLocationsLoading={false} />);

    const [, , , , , , locationsPassedToFetch] = mockUsePrescriptionsTable.mock.lastCall;
    expect(locationsPassedToFetch).toEqual([]);
  });

  describe('when restrictToSessionLocation is true', () => {
    const sessionLocation: SimpleLocation[] = [
      { id: 'session-uuid', name: 'KGH Pharmacy', associatedPharmacyLocation: null },
    ];

    beforeEach(() => {
      mockUseConfig.mockReturnValue({
        locationBehavior: {
          locationColumn: { enabled: false },
          locationFilter: { enabled: true, tag: 'Login Location' },
          restrictToVisitLocationDescendants: false,
          restrictToSessionLocation: true,
        },
        medicationRequestExpirationPeriodInDays: 90,
        refreshInterval: 10000,
        actionButtons: {
          pauseButton: { enabled: true },
          closeButton: { enabled: true },
        },
      });
    });

    it('restricts the data fetch to the login location and hides the location filter', () => {
      const { queryByLabelText } = render(
        <PrescriptionTabPanel isTabActive={true} locations={sessionLocation} isLocationsLoading={false} />,
      );

      const [loadData, , , , , , locationsPassedToFetch] = mockUsePrescriptionsTable.mock.lastCall;
      expect(loadData).toBe(true);
      expect(locationsPassedToFetch).toEqual(sessionLocation);
      expect(queryByLabelText('Filter by locations')).not.toBeInTheDocument();
    });

    it('does not fetch until the login location is known', () => {
      render(<PrescriptionTabPanel isTabActive={true} locations={[]} isLocationsLoading={true} />);

      const [loadData] = mockUsePrescriptionsTable.mock.lastCall;
      expect(loadData).toBe(false);
    });
  });
});
