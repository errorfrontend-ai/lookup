import { LISTENER_MIX_MINIMUM_GROUP_SIZE, OTHER_LISTENER_GROUPS } from '@lookup/contracts';

export interface ListenerGroupCount<Name extends string> {
  group: Name;
  listeners: number;
}

/**
 * The groups a station may see (LA-D10, docs/design/listener-accounts.md §7; LA-STATS-03). Given one breakdown of the
 * known listeners, in the order it is to be shown, and how many known listeners there are in all:
 *
 *  1. Below 10 known listeners there is no breakdown at all (null): every group would be small.
 *  2. A group of 1 to 9 listeners is small. A group of 0 is shown as 0, since it names no one, and a group of 10 or more
 *     is shown as it is.
 *  3. All small groups are folded into one "other groups" line, shown last. If that line stands for exactly one group, or
 *     adds up to under 10, the smallest group still shown with anyone in it joins it, and again, until it stands for two
 *     groups or more and adds up to 10 or more. So the line never names a single small group, and the total minus the
 *     groups shown never gives a number under 10.
 *
 * Nothing the function returns is below 10 except a zero, and no line stands for fewer than two groups with someone in
 * them. If the counts do not add up (so a line cannot be made safe), nothing is shown rather than something unsafe.
 */
export function suppressSmallGroups<Name extends string>(
  groups: ReadonlyArray<ListenerGroupCount<Name>>,
  knownListeners: number,
): Array<ListenerGroupCount<Name | typeof OTHER_LISTENER_GROUPS>> | null {
  if (knownListeners < LISTENER_MIX_MINIMUM_GROUP_SIZE) return null;
  const small = groups.filter((group) => group.listeners >= 1 && group.listeners < LISTENER_MIX_MINIMUM_GROUP_SIZE);
  if (small.length === 0) return groups.map((group) => ({ ...group }));

  const folded = new Set<Name>(small.map((group) => group.group));
  let otherListeners = small.reduce((total, group) => total + group.listeners, 0);
  let foldedGroupCount = small.length;
  while (foldedGroupCount < 2 || otherListeners < LISTENER_MIX_MINIMUM_GROUP_SIZE) {
    let smallestShown: ListenerGroupCount<Name> | undefined;
    for (const group of groups) {
      if (folded.has(group.group) || group.listeners <= 0) continue;
      if (smallestShown === undefined || group.listeners < smallestShown.listeners) smallestShown = group;
    }
    if (smallestShown === undefined) return null;
    folded.add(smallestShown.group);
    otherListeners += smallestShown.listeners;
    foldedGroupCount += 1;
  }
  return [...groups.filter((group) => !folded.has(group.group)).map((group) => ({ ...group })), { group: OTHER_LISTENER_GROUPS, listeners: otherListeners }];
}
