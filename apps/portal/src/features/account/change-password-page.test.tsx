import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../app/portal-api';
import { errorResponse, installFakeApi, jsonResponse, signedInUserWith } from '../../test/fake-api';
import { renderPortalAt } from '../../test/render-portal';

const user = signedInUserWith();
const accountPath = `/stations/${user.stations[0]?.id}/account`;

/** A simulated person; no pause between key presses keeps long passwords fast on slow machines. */
const person = userEvent.setup({ delay: null });

afterEach(() => {
  queryClient.clear();
  vi.unstubAllGlobals();
});

async function submitPasswordChange(currentPassword: string, newPassword: string) {
  await person.type(await screen.findByLabelText('Current password'), currentPassword);
  await person.type(screen.getByLabelText('New password'), newPassword);
  await person.click(screen.getByRole('button', { name: 'Change password' }));
}

describe('changing a password', () => {
  it('confirms the change and clears both fields', async () => {
    const fakeApi = installFakeApi({
      'GET /auth/me': () => jsonResponse(200, user),
      'POST /auth/change-password': () => jsonResponse(204, null),
    });
    renderPortalAt(accountPath);

    await submitPasswordChange('amber kettle rainy harbour', 'copper lantern quiet meadow');

    expect(await screen.findByRole('status')).toHaveTextContent('Your password has been changed.');
    expect(screen.getByLabelText('Current password')).toHaveValue('');
    expect(screen.getByLabelText('New password')).toHaveValue('');
    expect(fakeApi.calls.find((call) => call.path === '/auth/change-password')?.body).toEqual({
      currentPassword: 'amber kettle rainy harbour',
      newPassword: 'copper lantern quiet meadow',
    });
  });

  it.each([
    ['currentPassword', 'incorrect', 'Your current password is not correct.'],
    ['newPassword', 'too_common', 'That password is too common or too easy to guess.'],
    ['newPassword', 'contains_personal_details', "Don't use your name, email or station name in your password."],
    ['newPassword', 'too_short', 'Use at least 15 characters.'],
    ['newPassword', 'something_new', 'Check this field and try again.'],
  ])('explains a refused %s (%s) next to the field', async (path, code, expectedMessage) => {
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, user),
      'POST /auth/change-password': () =>
        errorResponse(400, 'VALIDATION_FAILED', 'Some details are missing or not valid.', 'abc123', [{ path, code }]),
    });
    renderPortalAt(accountPath);

    await submitPasswordChange('amber kettle rainy harbour', 'password password password');

    expect(await screen.findByText(new RegExp(expectedMessage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))).toBeInTheDocument();
    const field = screen.getByLabelText(path === 'currentPassword' ? 'Current password' : 'New password');
    expect(field).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows other failures with their reference code', async () => {
    installFakeApi({
      'GET /auth/me': () => jsonResponse(200, user),
      'POST /auth/change-password': () => errorResponse(429, 'RATE_LIMITED', 'Too many attempts. Please wait and try again.', 'beefbeef'),
    });
    renderPortalAt(accountPath);

    await submitPasswordChange('amber kettle rainy harbour', 'copper lantern quiet meadow');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too many attempts.');
    expect(alert).toHaveTextContent('Reference: beefbeef');
  });

  it('counts characters the way the API does (one emoji is one character)', async () => {
    installFakeApi({ 'GET /auth/me': () => jsonResponse(200, user) });
    renderPortalAt(accountPath);
    await person.type(await screen.findByLabelText('New password'), 'ab🎵');
    expect(screen.getByText(/\(3 so far\)/)).toBeInTheDocument();
  });
});
