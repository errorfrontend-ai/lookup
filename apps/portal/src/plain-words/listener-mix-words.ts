import type { ListenerMixAgeBandGroup, ListenerMixGenderGroup } from '@lookup/contracts';

/** What each group of "Who is listening" is called on screen (ADR-005; LA-STATS-07). */
const GENDER_WORDS: Record<ListenerMixGenderGroup['group'], string> = {
  FEMALE: 'Women',
  MALE: 'Men',
  ANOTHER: 'Another gender',
  PREFER_NOT_TO_SAY: 'Preferred not to say',
  OTHER_GROUPS: 'Other groups',
};

const AGE_BAND_WORDS: Record<ListenerMixAgeBandGroup['group'], string> = {
  UNDER_18: 'Under 18',
  AGE_18_TO_24: '18–24',
  AGE_25_TO_34: '25–34',
  AGE_35_TO_44: '35–44',
  AGE_45_TO_54: '45–54',
  AGE_55_AND_OVER: '55 and over',
  OTHER_GROUPS: 'Other groups',
};

export const describeGenderGroup = (group: ListenerMixGenderGroup['group']) => GENDER_WORDS[group];
export const describeAgeBandGroup = (group: ListenerMixAgeBandGroup['group']) => AGE_BAND_WORDS[group];
