import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ActionCard } from '../src/action-card/action-card-schema.js';
import { reasonCodeForIssue, VALIDATION_REASON_CODES } from '../src/validation-reason-codes.js';

describe('reasonCodeForIssue', () => {
  it('uses the library code for an ordinary problem', () => {
    const result = z.object({ name: z.string() }).safeParse({ name: 4 });
    expect(result.success ? [] : result.error.issues.map(reasonCodeForIssue)).toEqual(['invalid_type']);
  });

  it('uses our own reason for a rule of ours that is on the list', () => {
    const result = ActionCard.safeParse({
      schema_version: 1,
      layout: 'VERTICAL_STACK',
      actions: [{ type: 'LINK', id: '0192a6c4-0000-4000-8000-000000000004', label: 'Menu', style: 'OUTLINE', url: 'https://bit.ly/abc123' }],
    });
    const codes = result.success ? [] : result.error.issues.map(reasonCodeForIssue);
    expect(codes).toEqual(['link_uses_url_shortener']);
    expect(VALIDATION_REASON_CODES.has('link_uses_url_shortener')).toBe(true);
  });

  it('reports only "custom" for a reason that is not on the list, so free text never reaches a person', () => {
    const result = z.string().superRefine((_value, context) => {
      context.addIssue({ code: 'custom', params: { reason: 'something we typed with the value 0977123456' }, message: 'x' });
    }).safeParse('anything');
    expect(result.success ? [] : result.error.issues.map(reasonCodeForIssue)).toEqual(['custom']);
  });
});
