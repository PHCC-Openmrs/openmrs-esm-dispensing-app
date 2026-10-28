import { useMemo } from 'react';
import dayjs from 'dayjs';
import useSWR from 'swr';
import { fhirBaseUrl, openmrsFetch, parseDate } from '@openmrs/esm-framework';
import {
  type AllergyIntoleranceResponse,
  type EncounterResponse,
  type MedicationRequest,
  type MedicationRequestResponse,
  type PrescriptionsTableRow,
  type MedicationDispense,
  type Encounter,
  type MedicationRequestBundle,
  type SimpleLocation,
} from '../types';
import {
  getPatientNameMatchRank,
  getPrescriptionDetailsEndpoint,
  getMedicationDisplay,
  getMedicationReferenceOrCodeableConcept,
  getPrescriptionTableEndpoint,
  sortMedicationDispensesByWhenHandedOver,
  getAssociatedMedicationDispenses,
} from '../utils';
import {
  type ActionAvailabilityOptions,
  computePrescriptionState,
  summarizePrescriptionStates,
} from '../prescription-state';

// A patient name search is ranked by how well each name matches, which the server cannot do: it only sorts
// by date and pages. So a search fetches up to this many matches at once and ranks and pages them here. A
// search with more matches than this is not ranked, but shown in date order, page by page, as without it.
const SEARCH_FETCH_LIMIT = 100;

function mergeSearchResponses(responses: Array<{ data: EncounterResponse }>): { data: EncounterResponse } {
  const entries = new Map<string, EncounterResponse['entry'][number]>();
  responses.forEach((response) =>
    response.data.entry?.forEach((entry) => entries.set(`${entry.resource.resourceType}/${entry.resource.id}`, entry)),
  );
  return {
    data: { ...responses[0].data, entry: [...entries.values()] },
  };
}

export function usePrescriptionsTable(
  loadData: boolean,
  customPrescriptionsTableEndpoint: string = '',
  status: string = '',
  pageSize: number = 10,
  pageOffset: number = 0,
  patientSearchTerm: string = '',
  locations: SimpleLocation[] = [],
  medicationRequestExpirationPeriodInDays: number,
  refreshInterval: number,
  actionOptions: ActionAvailabilityOptions,
) {
  const expiryDate = dayjs(new Date())
    .startOf('day')
    .subtract(medicationRequestExpirationPeriodInDays, 'day')
    .toISOString();
  const locationIds = locations?.map((location) => location.id).join(',');

  // a search for "kumar karan" also looks for "kumar" and "karan" alone: the server only returns patients
  // with every word in their name, and the ones with just one of them come after those in the ranking
  const searchTerm = patientSearchTerm.trim();
  const searchWords = searchTerm.split(/\s+/).filter(Boolean);
  const searchTerms = searchTerm ? [...new Set([searchTerm, ...(searchWords.length > 1 ? searchWords : [])])] : [];
  const { data: searchResponses, error: searchError } = useSWR<Array<{ data: EncounterResponse }>, Error>(
    loadData && searchTerms.length
      ? [
          'prescriptions-name-search',
          ...searchTerms.map((term) =>
            getPrescriptionTableEndpoint(
              customPrescriptionsTableEndpoint,
              status,
              0,
              SEARCH_FETCH_LIMIT,
              expiryDate,
              term,
              locationIds,
            ),
          ),
        ]
      : null,
    ([, ...urls]: Array<string>) => Promise.all(urls.map((url) => openmrsFetch(url))),
    { refreshInterval: refreshInterval },
  );
  const tooManyMatchesToRank = searchResponses?.some((response) => response.data.total > SEARCH_FETCH_LIMIT);
  const isRanking = searchTerms.length > 0 && searchResponses !== undefined && !tooManyMatchesToRank;

  const { data: pagedData, error: pagedError } = useSWR<{ data: EncounterResponse }, Error>(
    loadData && (!searchTerms.length || tooManyMatchesToRank)
      ? getPrescriptionTableEndpoint(
          customPrescriptionsTableEndpoint,
          status,
          pageOffset,
          pageSize,
          expiryDate,
          patientSearchTerm,
          locationIds,
        )
      : null,
    openmrsFetch,
    { refreshInterval: refreshInterval },
  );
  const data = isRanking ? mergeSearchResponses(searchResponses) : pagedData;
  const error = pagedError ?? searchError;

  let prescriptionsTableRows: PrescriptionsTableRow[];
  let rankedMatchCount: number;
  if (data) {
    const entries = data?.data.entry;
    if (entries) {
      const encounters = entries
        .filter((entry) => entry?.resource?.resourceType == 'Encounter')
        .map((entry) => entry.resource as Encounter);
      const medicationRequests = entries
        .filter((entry) => entry?.resource?.resourceType == 'MedicationRequest')
        .map((entry) => entry.resource as MedicationRequest);
      const medicationDispenses = entries
        .filter((entry) => entry?.resource?.resourceType == 'MedicationDispense')
        .map((entry) => entry.resource as MedicationDispense)
        .sort(sortMedicationDispensesByWhenHandedOver);
      prescriptionsTableRows = encounters.map((encounter) => {
        const medicationRequestsForEncounter = medicationRequests.filter(
          (medicationRequest) => medicationRequest.encounter.reference == 'Encounter/' + encounter.id,
        );

        const medicationRequestReferences = medicationRequestsForEncounter.map(
          (medicationRequest) => 'MedicationRequest/' + medicationRequest.id,
        );
        const medicationDispensesForMedicationRequests = medicationDispenses.filter((medicationDispense) =>
          medicationRequestReferences.includes(medicationDispense.authorizingPrescription[0]?.reference),
        );
        return buildPrescriptionsTableRow(
          encounter,
          medicationRequestsForEncounter,
          medicationDispensesForMedicationRequests,
          medicationRequestExpirationPeriodInDays,
          actionOptions,
        );
      });
      prescriptionsTableRows.sort((a, b) => (a.created < b.created ? 1 : -1));
      if (isRanking) {
        // best name match first, the newest prescription first among equal matches, then this page of them
        const ranks = new Map(
          prescriptionsTableRows.map((row) => [row.id, getPatientNameMatchRank(row.patient.name, searchTerm)]),
        );
        prescriptionsTableRows.sort((a, b) => ranks.get(a.id) - ranks.get(b.id));
        rankedMatchCount = prescriptionsTableRows.length;
        prescriptionsTableRows = prescriptionsTableRows.slice(pageOffset, pageOffset + pageSize);
      }
    } else {
      prescriptionsTableRows = [];
    }
  }

  return {
    prescriptionsTableRows,
    error: error,
    isLoading: !prescriptionsTableRows && !error,
    totalOrders: isRanking ? rankedMatchCount : data?.data.total,
  };
}

function buildPrescriptionsTableRow(
  encounter: Encounter,
  medicationRequests: Array<MedicationRequest>,
  medicationDispense: Array<MedicationDispense>,
  medicationRequestExpirationPeriodInDays: number,
  actionOptions: ActionAvailabilityOptions,
): PrescriptionsTableRow {
  // each request is paired with its own dispenses so the row summary sees the same
  // evidence the expanded rows do; previously the dispenses fetched here were dropped
  // and the summary relied solely on the request's fulfiller status extension
  const states = medicationRequests.map((medicationRequest) =>
    computePrescriptionState(
      {
        request: medicationRequest,
        dispenses: getAssociatedMedicationDispenses(medicationRequest, medicationDispense) ?? [],
      },
      { medicationRequestExpirationPeriodInDays },
    ),
  );

  return {
    id: encounter?.id,
    created: encounter?.period?.start,
    patient: {
      name: encounter?.subject?.display,
      uuid: encounter?.subject?.reference?.split('/')[1],
    },
    drugs: [
      ...new Set(
        medicationRequests
          .map((medicationRequest) => getMedicationDisplay(getMedicationReferenceOrCodeableConcept(medicationRequest)))
          .sort((a, b) => {
            return a.localeCompare(b);
          }),
      ),
    ].join('; '),
    lastDispenser:
      medicationDispense && medicationDispense[0]?.performer && medicationDispense[0]?.performer[0]?.actor.display,
    prescriber: [...new Set(medicationRequests.map((o) => o.requester.display))].join(', '),
    status: summarizePrescriptionStates(states, actionOptions),
    location: encounter?.location ? encounter?.location[0]?.location.display : null,
  };
}

export function usePrescriptionDetails(encounterUuid: string, refreshInterval = null) {
  const { data, ...rest } = useSWR<{ data: MedicationRequestResponse }, Error>(
    getPrescriptionDetailsEndpoint(encounterUuid),
    openmrsFetch,
    { refreshInterval: refreshInterval },
  );

  const { medicationRequestBundles, prescriptionDate } = useMemo(() => {
    if (data) {
      return medicationRequestResponseToPrescriptionDetails(data.data.entry);
    } else {
      return { medicationRequestBundles: [], prescriptionDate: null };
    }
  }, [data]);

  return {
    medicationRequestBundles,
    prescriptionDate,
    ...rest,
  };
}

/**
 * fetches prescription details of a given encounter directly via openmrsFetch (instead of useSWR)
 * @param encounterUuid
 * @returns
 */
export async function getPrescriptionDetails(encounterUuid: string) {
  const result = await openmrsFetch<MedicationRequestResponse>(getPrescriptionDetailsEndpoint(encounterUuid));
  const {
    data: { entry },
  } = result;
  return medicationRequestResponseToPrescriptionDetails(entry);
}

function medicationRequestResponseToPrescriptionDetails(
  results: { resource: MedicationRequest | MedicationDispense }[],
) {
  const medicationRequestBundles: Array<MedicationRequestBundle> = [];
  let prescriptionDate: Date;

  const encounter = results
    ?.filter((entry) => entry?.resource?.resourceType == 'Encounter')
    .map((entry) => entry.resource as Encounter);

  if (encounter) {
    // by definition of the request (search by encounter) there should be one and only one encounter
    prescriptionDate = parseDate(encounter[0]?.period.start);

    const medicationRequests = results
      ?.filter((entry) => entry?.resource?.resourceType == 'MedicationRequest')
      .map((entry) => entry.resource as MedicationRequest);

    const medicationDispenses = results
      ?.filter((entry) => entry?.resource?.resourceType == 'MedicationDispense')
      .map((entry) => entry.resource as MedicationDispense)
      .sort(sortMedicationDispensesByWhenHandedOver);

    medicationRequests.every((medicationRequest) =>
      medicationRequestBundles.push({
        request: medicationRequest,
        dispenses: getAssociatedMedicationDispenses(medicationRequest, medicationDispenses).sort(
          sortMedicationDispensesByWhenHandedOver,
        ),
      }),
    );
  }

  return { medicationRequestBundles, prescriptionDate };
}

export function usePatientAllergies(patientUuid: string, refreshInterval) {
  const { data, error, isLoading } = useSWR<{ data: AllergyIntoleranceResponse }, Error>(
    `${fhirBaseUrl}/AllergyIntolerance?patient=${patientUuid}`,
    openmrsFetch,
    { refreshInterval: refreshInterval },
  );

  const allergies = data?.data.entry?.map((allergy) => allergy.resource) ?? [];

  return {
    allergies,
    totalAllergies: data?.data.total,
    error,
    isLoading,
  };
}

// supports passing just the uuid/code or the entire reference, ie either: "MedicationReference/123-abc" or "123-abc"
export function useMedicationRequest(reference: string, refreshInterval) {
  reference = reference
    ? reference.startsWith('MedicationRequest')
      ? reference
      : `MedicationRequest/${reference}`
    : null;

  const { data, isLoading } = useSWR<{ data: MedicationRequest }, Error>(
    reference ? `${fhirBaseUrl}/${reference}` : null,
    openmrsFetch,
    { refreshInterval: refreshInterval },
  );
  return {
    medicationRequest: data ? data.data : null,
    isLoading,
  };
}
