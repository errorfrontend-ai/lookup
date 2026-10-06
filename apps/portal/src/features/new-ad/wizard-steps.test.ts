import { describe, expect, it } from 'vitest';
import { actionCardFixture, adDetail, adSummary, campaignSummary, scheduleFixture } from '../../test/ad-fixtures';
import { BUILT_WIZARD_STEPS, firstIncompleteStep, isWizardStepId, setupStepForSummary } from './wizard-steps';

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

describe('where an unfinished ad in the list resumes', () => {
  it('goes to the audio while the file has not arrived or was refused', () => {
    expect(setupStepForSummary(adSummary({ status: 'AWAITING_UPLOAD', hasActionCard: false, campaign: null }))).toBe('audio');
    expect(setupStepForSummary(adSummary({ status: 'FAILED', hasActionCard: true, campaign: campaignSummary() }))).toBe('audio');
  });

  it('then the buttons, then the schedule, then the review', () => {
    expect(setupStepForSummary(adSummary({ status: 'PROCESSING', hasActionCard: false, campaign: null }))).toBe('buttons');
    expect(setupStepForSummary(adSummary({ status: 'PROCESSING', hasActionCard: true, campaign: null }))).toBe('schedule');
    expect(setupStepForSummary(adSummary({ status: 'PROCESSING', hasActionCard: true, campaign: campaignSummary({ displayStatus: 'DRAFT' }) }))).toBe('review');
  });

  it('says there is nothing left to set up once the ad is published', () => {
    for (const displayStatus of ['SCHEDULED', 'LIVE_NOW', 'PAUSED', 'ENDED'] as const) {
      expect(setupStepForSummary(adSummary({ status: 'PROCESSING', hasActionCard: true, campaign: campaignSummary({ displayStatus }) }))).toBeNull();
    }
  });
});

describe('the steps that exist so far', () => {
  it('are the client, audio and buttons, so nothing links to a step that is not built', () => {
    expect([...BUILT_WIZARD_STEPS]).toEqual(['client', 'audio', 'buttons']);
  });
});
