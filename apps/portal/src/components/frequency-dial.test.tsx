import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FrequencyDial } from './frequency-dial';

describe('FrequencyDial', () => {
  it('shows an FM station\'s name, its number large and the band, with a decorative scale', () => {
    const { container } = render(<FrequencyDial stationName="Radio Phoenix" frequencyLabel="89.5 FM" />);
    expect(screen.getByText('Radio Phoenix')).toBeInTheDocument();
    expect(screen.getByText('89.5')).toBeInTheDocument();
    expect(screen.getByText('FM')).toBeInTheDocument();
    const scale = container.querySelector('svg');
    expect(scale).toHaveAttribute('aria-hidden', 'true');
    // One tick for every whole MHz from 88 to 108, plus the needle.
    expect(scale?.querySelectorAll('line')).toHaveLength(22);
  });

  it('puts the needle further right for a higher frequency', () => {
    const needleX = (label: string) => {
      const { container, unmount } = render(<FrequencyDial stationName="S" frequencyLabel={label} />);
      const needle = [...(container.querySelectorAll('line') as NodeListOf<SVGLineElement>)].at(-1) as SVGLineElement;
      const position = Number(needle.getAttribute('x1'));
      unmount();
      return position;
    };
    expect(needleX('88.0 FM')).toBeLessThan(needleX('98.1 FM'));
    expect(needleX('98.1 FM')).toBeLessThan(needleX('107.5 FM'));
  });

  it('shows a label it cannot read as written, with no scale', () => {
    const { container } = render(<FrequencyDial stationName="Radio One" frequencyLabel="Lusaka's number one" />);
    expect(screen.getByText("Lusaka's number one")).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeNull();
  });
});
