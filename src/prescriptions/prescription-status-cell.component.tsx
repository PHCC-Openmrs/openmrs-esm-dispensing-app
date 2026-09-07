import React from 'react';
import { useTranslation } from 'react-i18next';
import { type PrescriptionStatusSummary } from '../prescription-state';
import styles from './prescriptions.scss';

/**
 * Renders the rolled up state of a prescription on the collapsed table row.
 *
 * A prescription can hold several medication requests in different states, so as well as
 * the state that most demands attention it reports how many of those requests still have
 * an action available. That count comes from the same state -> action table the buttons in
 * the expanded row use, so the row cannot advertise work that has no button behind it.
 */
const PrescriptionStatusCell: React.FC<{ summary: PrescriptionStatusSummary }> = ({ summary }) => {
  const { t } = useTranslation();

  if (!summary) {
    return null;
  }

  const { dominantState, total, actionableCount } = summary;
  // dynamic state keys, kept here so they are picked up for translation:
  // t('active', 'Active')
  // t('paused', 'Paused')
  // t('closed', 'Closed')
  // t('completed', 'Completed')
  // t('expired', 'Expired')
  // t('cancelled', 'Cancelled')
  const stateLabel = t(dominantState);

  if (total === 1) {
    return <span>{stateLabel}</span>;
  }

  return (
    <span>
      {stateLabel}
      <span className={styles.statusDetail}>
        {actionableCount > 0
          ? t('countNeedAction', '{{actionableCount}} of {{total}} need action', { actionableCount, total })
          : t('countItems', '{{total}} items', { total })}
      </span>
    </span>
  );
};

export default PrescriptionStatusCell;
