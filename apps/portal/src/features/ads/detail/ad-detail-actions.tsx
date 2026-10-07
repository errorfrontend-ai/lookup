import { MAXIMUM_AD_TITLE_LENGTH } from '@lookup/contracts';
import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError } from '../../../api/api-client';
import { Button } from '../../../components/button';
import { ErrorNotice } from '../../../components/error-notice';
import { ConfirmDialog, ModalDialog } from '../../../components/modal-dialog';
import { TextField } from '../../../components/text-field';
import { useToast } from '../../../components/toast-region';
import { useArchiveAd, useRenameAd } from '../use-ad-detail';
import { browserMaxLength } from '../../../formatting/text-length';

/** The words for a refused title: ours for a bad one, and the general explanation for anything else. */
function titleProblem(error: unknown): string | null {
  if (error instanceof ApiError && error.code === 'VALIDATION_FAILED') return `Enter a title of 1 to ${MAXIMUM_AD_TITLE_LENGTH} characters.`;
  return null;
}

export function RenameAdDialog({ stationId, adId, currentTitle, onClose }: { stationId: string; adId: string; currentTitle: string; onClose: () => void }) {
  const [title, setTitle] = useState(currentTitle);
  const rename = useRenameAd(stationId, adId);
  const showToast = useToast();
  const problem = titleProblem(rename.error);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    if (trimmed === currentTitle) {
      onClose();
      return;
    }
    rename.mutate(
      { title: trimmed },
      {
        onSuccess: () => {
          showToast('Ad renamed');
          onClose();
        },
      },
    );
  };

  return (
    <ModalDialog title="Rename this ad" onClose={onClose}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <TextField
          label="Ad title"
          hint="Listeners see this above the buttons."
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={browserMaxLength(MAXIMUM_AD_TITLE_LENGTH)}
          counter={`${[...title].length} / ${MAXIMUM_AD_TITLE_LENGTH}`}
          error={problem}
          autoComplete="off"
        />
        {rename.isError && !problem ? <ErrorNotice error={rename.error} /> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" isBusy={rename.isPending} busyLabel="Saving…" disabled={!title.trim()}>
            Save title
          </Button>
        </div>
      </form>
    </ModalDialog>
  );
}

export function RemoveAdDialog({ stationId, adId, adTitle, onClose }: { stationId: string; adId: string; adTitle: string; onClose: () => void }) {
  const archive = useArchiveAd(stationId, adId);
  const showToast = useToast();
  const navigate = useNavigate();

  const remove = () =>
    archive.mutate(undefined, {
      onSuccess: () => {
        showToast(`“${adTitle}” removed`);
        void navigate(`/stations/${stationId}/ads`, { replace: true });
      },
    });

  return (
    <ConfirmDialog title="Remove this ad?" confirmLabel="Remove ad" cancelLabel="Keep the ad" isBusy={archive.isPending} onConfirm={remove} onClose={onClose}>
      <p>“{adTitle}” will disappear from your lists. Its history is kept.</p>
      {archive.isError ? (
        <div className="mt-3">
          <ErrorNotice error={archive.error} title="We couldn't remove it" />
        </div>
      ) : null}
    </ConfirmDialog>
  );
}
