import type { ActionCard } from '@lookup/contracts';

export interface ActionCardFieldChange {
  /** Where the change is: a card field ("layout") or a button field ("actions.<action id>.phone_number_e164"). */
  path: string;
  change: 'added' | 'removed' | 'changed';
}

/**
 * What changed between two versions of an ad's buttons, by field, never by value, so the audit trail
 * can say "the WhatsApp number of this button changed" without copying the number into it. Buttons
 * are matched by their id, which stays the same across versions.
 */
export function describeActionCardChanges(previous: ActionCard | null, next: ActionCard): ActionCardFieldChange[] {
  const changes: ActionCardFieldChange[] = [];
  compareFields(cardFields(previous), cardFields(next), '', changes);

  const previousActions = new Map((previous?.actions ?? []).map((action, position) => [action.id, { action, position }]));
  const nextActions = new Map(next.actions.map((action, position) => [action.id, { action, position }]));
  for (const [actionId, { action, position }] of nextActions) {
    const before = previousActions.get(actionId);
    if (!before) {
      changes.push({ path: `actions.${actionId}`, change: 'added' });
      continue;
    }
    compareFields(actionFields(before.action), actionFields(action), `actions.${actionId}.`, changes);
    if (before.position !== position) changes.push({ path: `actions.${actionId}.position`, change: 'changed' });
  }
  for (const actionId of previousActions.keys()) {
    if (!nextActions.has(actionId)) changes.push({ path: `actions.${actionId}`, change: 'removed' });
  }
  return changes;
}

/** Each field of the card except its buttons, as comparable text. */
function cardFields(card: ActionCard | null): Map<string, string> {
  if (!card) return new Map();
  return new Map(Object.entries(card).filter(([name]) => name !== 'actions').map(([name, value]) => [name, JSON.stringify(value)]));
}

/** Each field of one button except its id, as comparable text. */
function actionFields(action: ActionCard['actions'][number]): Map<string, string> {
  return new Map(Object.entries(action).filter(([name]) => name !== 'id').map(([name, value]) => [name, JSON.stringify(value)]));
}

function compareFields(before: Map<string, string>, after: Map<string, string>, pathPrefix: string, changes: ActionCardFieldChange[]): void {
  for (const [name, value] of after) {
    if (!before.has(name)) changes.push({ path: `${pathPrefix}${name}`, change: 'added' });
    else if (before.get(name) !== value) changes.push({ path: `${pathPrefix}${name}`, change: 'changed' });
  }
  for (const name of before.keys()) {
    if (!after.has(name)) changes.push({ path: `${pathPrefix}${name}`, change: 'removed' });
  }
}
