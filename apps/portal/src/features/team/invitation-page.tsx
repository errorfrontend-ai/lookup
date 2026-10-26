import type { AcceptedInvitation, InvitationDescription } from '@lookup/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { portalApi, SIGNED_IN_USER_QUERY_KEY } from '../../app/portal-api';
import { Button } from '../../components/button';
import { ErrorNotice } from '../../components/error-notice';
import { LoadingScreen } from '../../components/plain-pages';
import { TextField } from '../../components/text-field';
import { useSignOut } from '../session/use-sign-out';
import { useSignedInUser } from '../session/use-signed-in-user';
import { fieldErrorsFrom } from '../../plain-words/sign-up-words';
import { linkTokenFrom } from '../sign-up/verify-email-page';
import { ROLE_CHOICES } from './team-page';

/** Where the token waits while the person signs in: this tab only, gone when it closes. */
const TOKEN_STORAGE_KEY = 'lookup-invitation-token';

/** The invitation's token: from the link's fragment (then kept for this tab), or kept from before signing in. */
export function readInvitationToken(): string | null {
  const fromLink = linkTokenFrom(window.location.hash);
  try {
    if (fromLink) window.sessionStorage.setItem(TOKEN_STORAGE_KEY, fromLink);
    return fromLink ?? window.sessionStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return fromLink;
  }
}

function forgetInvitationToken(): void {
  try {
    window.sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Nothing kept, nothing to forget.
  }
}

const UNUSABLE_WORDS: Record<Exclude<InvitationDescription['state'], 'OPEN'>, string> = {
  EXPIRED: "This invitation has expired. Ask the station's owner for a new one.",
  REVOKED: "This invitation was cancelled. Ask the station's owner for a new one.",
  ACCEPTED: 'This invitation has already been used. Sign in to see the station.',
};

/** What the invitation offers, in the words the page shows: joining the team, or viewing a client's adverts. */
function invitationWords(invitation: InvitationDescription): { heading: string; explanation: string; accept: string; busy: string } {
  const station = [invitation.stationName, invitation.frequencyLabel].filter(Boolean).join(' · ');
  if (invitation.kind === 'CLIENT_VIEWER') {
    return {
      heading: `${station} invites you to view ${invitation.clientName}'s adverts`,
      explanation: `See when ${invitation.clientName}'s adverts air, how listeners respond, and get a reminder before each one airs. You can view everything; only the station can change it.`,
      accept: 'Accept',
      busy: 'Accepting…',
    };
  }
  const role = ROLE_CHOICES[invitation.role ?? 'ANALYST'];
  return {
    heading: `You're invited to join ${station} as ${/^[AEIOU]/.test(role.name) ? 'an' : 'a'} ${role.name}`,
    explanation: `${role.explanation}.`,
    accept: `Join ${invitation.stationName ?? 'the station'}`,
    busy: 'Joining…',
  };
}

/**
 * An invitation opened from its email (P5A design §4.5; journey F): who invites, to which role; then "Join" with a
 * new account, or "Sign in to accept" for an email that has one, coming back here after signing in. A client's
 * invitation (ADR-006) uses the same page and steps, and lands on the client's own pages.
 */
export function InvitationPage() {
  const [token] = useState(readInvitationToken);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const signedInUser = useSignedInUser();
  const signOut = useSignOut();
  const [fullName, setFullName] = useState('');
  const [mobileNumber, setMobileNumber] = useState('');
  const [password, setPassword] = useState('');
  // The token leaves the address bar once read (it is kept for this tab only).
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  const description = useQuery({
    queryKey: ['invitation', token],
    queryFn: () => portalApi.post<InvitationDescription>('/invitations/description', { token }),
    enabled: Boolean(token),
    retry: false,
  });
  const joined = async (accepted: AcceptedInvitation) => {
    forgetInvitationToken();
    await queryClient.invalidateQueries({ queryKey: SIGNED_IN_USER_QUERY_KEY });
    void navigate(accepted.kind === 'CLIENT_VIEWER' ? '/client' : `/stations/${accepted.stationId}/overview`, { replace: true });
  };
  const joinWithNewAccount = useMutation({
    mutationFn: () =>
      portalApi.post<AcceptedInvitation>('/invitations/acceptance-with-new-account', { token, fullName, mobileNumber: mobileNumber.trim() || null, password }),
    onSuccess: joined,
  });
  const joinSignedIn = useMutation({ mutationFn: () => portalApi.post<AcceptedInvitation>('/invitations/acceptance', { token }), onSuccess: joined });

  if (!token) return <InvitationMessage heading="This invitation link doesn't work" words="Open the link from the email again, or ask the station's owner for a new one." />;
  if (description.isPending || signedInUser.isPending) return <LoadingScreen label="Opening the invitation…" />;
  if (description.isError) return <InvitationMessage heading="This invitation link doesn't work" words={description.error.message} />;
  const invitation = description.data;
  if (invitation.state !== 'OPEN') return <InvitationMessage heading="This invitation can't be used" words={UNUSABLE_WORDS[invitation.state]} />;
  const words = invitationWords(invitation);
  const signedInEmail = signedInUser.data?.user.email;
  const fieldErrors = fieldErrorsFrom(joinWithNewAccount.error);

  const submitNewAccount = (event: FormEvent) => {
    event.preventDefault();
    if (fullName.trim() && password) joinWithNewAccount.mutate();
  };

  return (
    <main id="main-content" className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-5 px-4 py-10">
      <span className="font-display text-title">Look Up</span>
      <h1 className="text-display">{words.heading}</h1>
      <p className="text-body text-muted">{words.explanation}</p>
      {invitation.hasAccount ? (
        signedInEmail && signedInEmail.toLowerCase() === invitation.invitedEmail.toLowerCase() ? (
          <div className="flex flex-col gap-3">
            {joinSignedIn.isError ? <ErrorNotice error={joinSignedIn.error} /> : null}
            <Button onClick={() => joinSignedIn.mutate()} isBusy={joinSignedIn.isPending} busyLabel={words.busy}>
              {words.accept}
            </Button>
          </div>
        ) : signedInEmail ? (
          <div className="flex flex-col gap-3">
            <p className="text-body">This invitation was sent to {invitation.invitedEmail}. Sign out, then sign in with that email to accept.</p>
            <Button variant="secondary" onClick={() => void signOut({ returnTo: '/invitations/accept', forEmail: invitation.invitedEmail })}>
              Sign out
            </Button>
            <Link to="/" className="flex min-h-11 items-center self-start text-label text-accent underline underline-offset-4">
              Continue as {signedInUser.data?.user.fullName}
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-body">{invitation.invitedEmail} already has an account.</p>
            <Button onClick={() => void navigate('/sign-in', { state: { from: '/invitations/accept', forEmail: invitation.invitedEmail } })}>Sign in to accept</Button>
          </div>
        )
      ) : (
        <form onSubmit={submitNewAccount} noValidate className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5">
          <p className="text-body">Your account will use {invitation.invitedEmail}.</p>
          <TextField label="Your full name" autoComplete="name" required value={fullName} onChange={(event) => setFullName(event.target.value)} error={fieldErrors.fullName} />
          <TextField label="Mobile number (optional)" type="tel" autoComplete="tel-national" placeholder="97 123 4567" value={mobileNumber} onChange={(event) => setMobileNumber(event.target.value)} error={fieldErrors.mobileNumber} />
          <TextField label="Password" type="password" autoComplete="new-password" required hint="At least 15 characters." value={password} onChange={(event) => setPassword(event.target.value)} error={fieldErrors.password} />
          {joinWithNewAccount.isError && Object.keys(fieldErrors).length === 0 ? <ErrorNotice error={joinWithNewAccount.error} /> : null}
          <Button type="submit" disabled={!fullName.trim() || !password} isBusy={joinWithNewAccount.isPending} busyLabel={words.busy}>
            {invitation.kind === 'CLIENT_VIEWER' ? 'Create account and accept' : 'Join'}
          </Button>
        </form>
      )}
    </main>
  );
}

/** An invitation that can't be used, in plain words; someone already signed in can go on to their own pages. */
function InvitationMessage({ heading, words }: { heading: string; words: string }) {
  const signedInUser = useSignedInUser();
  return (
    <main id="main-content" className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-4 px-4">
      <span className="font-display text-title">Look Up</span>
      <h1 className="text-display">{heading}</h1>
      <p className="text-body text-muted">{words}</p>
      {signedInUser.data ? (
        <Link to="/" className="flex min-h-11 items-center self-start text-label text-accent underline underline-offset-4">
          Go to your pages
        </Link>
      ) : null}
    </main>
  );
}
