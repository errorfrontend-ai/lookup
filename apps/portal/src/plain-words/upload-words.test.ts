import { UPLOAD_REFUSAL_REASONS } from '@lookup/contracts';
import { describe, expect, it } from 'vitest';
import { describeUploadRefusal } from './upload-words';

describe('why an upload was refused, in words', () => {
  it('has its own sentence for every reason the API can give', () => {
    const generic = describeUploadRefusal(null);
    for (const reason of UPLOAD_REFUSAL_REASONS) {
      expect(describeUploadRefusal(reason), reason).not.toBe(generic);
      expect(describeUploadRefusal(reason), reason).not.toContain(reason);
    }
  });

  it('says something plain for a reason it does not know, never the code itself', () => {
    expect(describeUploadRefusal('codec_probe_timeout')).toBe("This file couldn't be used. Choose a different file.");
    expect(describeUploadRefusal(null)).toBe("This file couldn't be used. Choose a different file.");
  });
});
