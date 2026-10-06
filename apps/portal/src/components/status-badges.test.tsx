import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CAMPAIGN_DISPLAY_STATUSES, AD_STATUSES } from '@lookup/contracts';
import { describeAttentionReason, describeCampaignStatus, describeFileStatus } from '../plain-words/ad-status-words';
import { CampaignStatusBadge, FileStatusBadge, OnAirBadge } from './status-badges';

describe('status badges', () => {
  it('ON AIR says "On air now" to a screen reader, and its pulsing dot stops for reduced motion', () => {
    const { container } = render(<OnAirBadge />);
    expect(screen.getByText('On air now')).toHaveClass('sr-only');
    const dot = container.querySelector('[aria-hidden="true"]');
    expect(dot).toHaveClass('animate-on-air', 'motion-reduce:animate-none');
  });

  it('a campaign that is live is the ON AIR badge; every other state is written out', () => {
    const { rerender } = render(<CampaignStatusBadge status="LIVE_NOW" />);
    expect(screen.getByText('On air now')).toBeInTheDocument();
    for (const [status, label] of [
      ['SCHEDULED', 'Scheduled'],
      ['PAUSED', 'Paused'],
      ['ENDED', 'Ended'],
      ['DRAFT', 'Draft'],
      [null, 'Not scheduled yet'],
    ] as const) {
      rerender(<CampaignStatusBadge status={status} />);
      expect(screen.getByText(label), String(status)).toBeInTheDocument();
    }
  });

  it('shows the audio file\'s state in words, with the upload percentage while uploading', () => {
    const { rerender } = render(<FileStatusBadge status="AWAITING_UPLOAD" uploadPercent={45} />);
    expect(screen.getByText('Uploading 45%')).toBeInTheDocument();
    rerender(<FileStatusBadge status="AWAITING_UPLOAD" />);
    expect(screen.getByText('Waiting for the audio')).toBeInTheDocument();
    rerender(<FileStatusBadge status="PROCESSING" />);
    expect(screen.getByText('Audio checked')).toBeInTheDocument();
    rerender(<FileStatusBadge status="FAILED" />);
    expect(screen.getByText('Upload refused')).toBeInTheDocument();
  });
});

describe('plain words for statuses', () => {
  it('has words for every campaign and file state, each with a hint', () => {
    for (const status of CAMPAIGN_DISPLAY_STATUSES) {
      const words = describeCampaignStatus(status);
      expect(words.label.length, status).toBeGreaterThan(0);
      expect(words.hint.length, status).toBeGreaterThan(0);
    }
    for (const status of AD_STATUSES) {
      const words = describeFileStatus(status);
      expect(words.label.length, status).toBeGreaterThan(0);
      expect(words.hint.length, status).toBeGreaterThan(0);
    }
  });

  it('never promises that a checked upload is already recognised (that starts when recognition is switched on)', () => {
    expect(describeFileStatus('PROCESSING').hint).toContain('once recognition is switched on');
    expect(describeFileStatus('PROCESSING').label).not.toMatch(/ready/i);
  });

  it('says what to do about each reason an ad needs attention', () => {
    expect(describeAttentionReason('upload_refused', 'Brand A', null)).toMatchObject({ title: 'Brand A · upload refused', action: 'Upload again' });
    expect(describeAttentionReason('start_date_passed', 'Brand A', null).action).toBe('Review and publish');
    expect(describeAttentionReason('ending_soon', 'Brand A', '7 Oct').detail).toContain('7 Oct');
  });
});
