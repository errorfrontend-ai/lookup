import { describe, expect, it } from 'vitest';
import { CLIENT_DEFAULT_CARD_REASONS, SetClientDefaultActionCardInput } from '../src/stations/station-schemas.js';
import { reasonCodeForIssue, VALIDATION_REASON_CODES } from '../src/validation-reason-codes.js';

/** PUT /stations/{stationId}/clients/{clientId}/default-action-card (P4 design §5.10): a client's usual card, or none. */
describe('SetClientDefaultActionCardInput', () => {
  const reasons = (input: unknown) => {
    const result = SetClientDefaultActionCardInput.safeParse(input);
    return result.success ? [] : result.error.issues.map((issue) => ({ path: issue.path.join('.'), code: reasonCodeForIssue(issue) }));
  };

  it('takes one card id, or null to take the usual card away', () => {
    expect(SetClientDefaultActionCardInput.parse({ actionCardId: '0192a6c4-0000-4000-8000-0000000000c1' })).toEqual({ actionCardId: '0192a6c4-0000-4000-8000-0000000000c1' });
    expect(SetClientDefaultActionCardInput.parse({ actionCardId: null })).toEqual({ actionCardId: null });
  });

  it('refuses a missing or malformed id and anything else in the body, naming the field', () => {
    expect(reasons({})).toEqual([{ path: 'actionCardId', code: 'invalid_type' }]);
    expect(reasons({ actionCardId: 'card-1' })).toEqual([{ path: 'actionCardId', code: 'invalid_format' }]);
    expect(reasons({ actionCardId: null, clientId: '0192a6c4-0000-4000-8000-0000000000c1' })).toEqual([{ path: '', code: 'unrecognized_keys' }]);
  });

  it('the refusal of a card that is not the client’s own is a fixed reason the API may relay', () => {
    expect(CLIENT_DEFAULT_CARD_REASONS).toEqual(['card_not_of_this_client']);
    expect(VALIDATION_REASON_CODES.has('card_not_of_this_client')).toBe(true);
  });
});
