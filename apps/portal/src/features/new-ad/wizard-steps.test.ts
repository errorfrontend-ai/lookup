import { describe, expect, it } from 'vitest';
import { actionCardFixture, adDetail, scheduleFixture } from '../../test/ad-fixtures';
import { firstIncompleteStep, isWizardStepId } from './wizard-steps';

describe('where setup resumes', () => {
  it('starts at the client when there is no ad yet', () => {
    expect(firstIncompleteStep(null, undefined)).toBe('client');
  });

  it('goes to the audio while the file has not arrived, or was refused', () => {
    expect(firstIncompleteStep(adDetail({ status: 'AWAITING_UPLOAD', actionCard: null, schedule: null }), undefined)).toBe('audio');
    expect(firstIncompleteStep(adDetail({ status: 'FAILED', actionCard: null, schedule: null }), undefined)).toBe('audio');
    // Even a failed upload that has since been tried again and failed again.
    expect(firstIncompleteStep(adDetail({ status: 'AWAITING_UPLOAD' }), { phase: 'failed' })).toBe('audio');
  });

  it('lets the person carry on while the audio is still going up or being checked', () => {
    for (const phase of ['uploading', 'checking', 'checked'] as const) {
      expect(firstIncompleteStep(adDetail({ status: 'AWAITING_UPLOAD', actionCard: null, schedule: null }), { phase })).toBe('buttons');
    }
  });

  it('then asks for the buttons, then the schedule, then the review', () => {
    expect(firstIncompleteStep(adDetail({ status: 'PROCESSING', actionCard: null, schedule: null }), undefined)).toBe('buttons');
    expect(firstIncompleteStep(adDetail({ status: 'PROCESSING', actionCard: actionCardFixture(), schedule: null }), undefined)).toBe('schedule');
    expect(firstIncompleteStep(adDetail({ status: 'PROCESSING', actionCard: actionCardFixture(), schedule: scheduleFixture() }), undefined)).toBe('review');
  });

  it('knows which words in an address are steps', () => {
    expect(isWizardStepId('audio')).toBe(true);
    expect(isWizardStepId('publish')).toBe(false);
    expect(isWizardStepId(null)).toBe(false);
  });
});
