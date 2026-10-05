import { PASSWORD_MAXIMUM_LENGTH, PASSWORD_MINIMUM_LENGTH } from '@lookup/contracts';
import { useMutation } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { ApiError } from '../../api/api-client';
import { portalApi } from '../../app/portal-api';
import { ErrorNotice } from '../../components/error-notice';

/** Plain words for each reason the API gives for refusing a password change. */
const FIELD_PROBLEM_MESSAGES: Record<string, string> = {
  incorrect: 'Your current password is not correct.',
  too_short: `Use at least ${PASSWORD_MINIMUM_LENGTH} characters. A few unrelated words work well.`,
  too_small: `Use at least ${PASSWORD_MINIMUM_LENGTH} characters. A few unrelated words work well.`,
  too_long: `Use at most ${PASSWORD_MAXIMUM_LENGTH} characters.`,
  too_big: `Use at most ${PASSWORD_MAXIMUM_LENGTH} characters.`,
  too_common: 'That password is too common or too easy to guess. Choose something less predictable.',
  contains_personal_details: "Don't use your name, email or station name in your password.",
};

function fieldProblemsFrom(error: unknown): Record<string, string> {
  if (!(error instanceof ApiError) || error.code !== 'VALIDATION_FAILED') return {};
  const problems: Record<string, string> = {};
  for (const field of error.fields) {
    problems[field.path] = FIELD_PROBLEM_MESSAGES[field.code] ?? 'Check this field and try again.';
  }
  return problems;
}

export function ChangePasswordPage() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [arePasswordsVisible, setArePasswordsVisible] = useState(false);
  const currentPasswordFieldId = useId();
  const newPasswordFieldId = useId();
  const newPasswordHintId = useId();

  const changePassword = useMutation({
    mutationFn: () => portalApi.post<void>('/auth/change-password', { currentPassword, newPassword }),
    onSuccess: () => {
      setCurrentPassword('');
      setNewPassword('');
    },
  });

  const fieldProblems = fieldProblemsFrom(changePassword.error);
  const hasOnlyFieldProblems = Object.keys(fieldProblems).length > 0;
  const newPasswordLength = [...newPassword.normalize('NFC')].length;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    changePassword.mutate();
  };

  return (
    <div className="flex max-w-lg flex-col gap-6">
      <h1 className="text-display">Your account</h1>

      <form onSubmit={submit} noValidate className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5">
        <h2 className="text-heading">Change your password</h2>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={currentPasswordFieldId} className="text-label">
            Current password
          </label>
          <input
            id={currentPasswordFieldId}
            type={arePasswordsVisible ? 'text' : 'password'}
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
            aria-invalid={Boolean(fieldProblems.currentPassword)}
            className="min-h-11 rounded-md border border-line bg-surface px-3 text-body"
          />
          {fieldProblems.currentPassword ? <span className="text-caption text-danger">{fieldProblems.currentPassword}</span> : null}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={newPasswordFieldId} className="text-label">
            New password
          </label>
          <input
            id={newPasswordFieldId}
            type={arePasswordsVisible ? 'text' : 'password'}
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
            aria-invalid={Boolean(fieldProblems.newPassword)}
            aria-describedby={newPasswordHintId}
            className="min-h-11 rounded-md border border-line bg-surface px-3 text-body"
          />
          <span id={newPasswordHintId} className="text-caption text-muted">
            At least {PASSWORD_MINIMUM_LENGTH} characters ({newPasswordLength} so far). Spaces are fine.
          </span>
          {fieldProblems.newPassword ? <span className="text-caption text-danger">{fieldProblems.newPassword}</span> : null}
        </div>

        <label className="flex min-h-11 items-center gap-2 text-body">
          <input type="checkbox" checked={arePasswordsVisible} onChange={(event) => setArePasswordsVisible(event.target.checked)} className="size-5" />
          Show passwords
        </label>

        {changePassword.isError && !hasOnlyFieldProblems ? <ErrorNotice error={changePassword.error} /> : null}
        {changePassword.isSuccess ? (
          <p role="status" className="rounded-md bg-success-soft px-4 py-3 text-body text-success">
            Your password has been changed. You've been signed out everywhere else.
          </p>
        ) : null}

        <button
          type="submit"
          disabled={changePassword.isPending || !currentPassword || !newPassword}
          className="min-h-12 rounded-md bg-accent px-5 text-label text-on-accent hover:bg-accent-hover disabled:opacity-60 sm:self-start"
        >
          {changePassword.isPending ? 'Changing…' : 'Change password'}
        </button>
      </form>
    </div>
  );
}
