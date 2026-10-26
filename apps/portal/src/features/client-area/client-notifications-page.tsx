import { AIR_TIME_REMINDER_LEAD_MINUTES, type AirTimeReminderLeadMinutes, type ClientNotificationSettings, type ClientNotificationSettingsInput } from '@lookup/contracts';
import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { ApiError } from '../../api/api-client';
import { Button } from '../../components/button';
import { ErrorNotice } from '../../components/error-notice';
import { SkeletonRows } from '../../components/skeleton';
import { describeStation } from '../../plain-words/client-words';
import {
  currentSubscription,
  hasInstallOffer,
  install,
  isAppleMobile,
  isInstalled,
  notificationPermission,
  onInstallOfferChange,
  pushSupport,
  reportDeviceFailure,
  turnOffThisDevice,
  turnOnThisDevice,
} from './this-device';
import { NoAdvertsToView } from './client-parts';
import { useClientNotificationSettings, useSaveNotificationSettings, useSendTestNotification } from './use-client-area';

/** A yes-or-no setting, saved as soon as it changes, like a phone's settings: a 48 px row with its own words. */
function SwitchRow({ label, hint, checked, disabled, onChange }: { label: string; hint?: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  const labelId = useId();
  const hintId = useId();
  return (
    <label className="flex min-h-12 items-center justify-between gap-4 rounded-md border border-line-soft bg-surface px-4 py-2">
      <span className="flex min-w-0 flex-col">
        <span id={labelId} className="text-label">
          {label}
        </span>
        {hint ? (
          <span id={hintId} className="text-caption text-muted">
            {hint}
          </span>
        ) : null}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-labelledby={labelId}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.checked)}
        className="size-6 shrink-0 accent-[var(--color-accent)]"
      />
    </label>
  );
}

/** The iPhone and iPad steps: notifications there work only from the Home Screen. */
function HomeScreenSteps() {
  return (
    <ol className="flex list-decimal flex-col gap-1 pl-5 text-body">
      <li>Tap the Share button (the square with an arrow) at the bottom of Safari.</li>
      <li>Choose Add to Home Screen, then Add.</li>
      <li>Open Look Up from your Home Screen and come back to this page.</li>
    </ol>
  );
}

type DeviceState = { kind: 'CHECKING' } | { kind: 'ON' } | { kind: 'OFF' } | { kind: 'BLOCKED' };

/**
 * Notifications on this device (P5C-NOTIFY-02): the browser asks permission only when the person taps "Turn on
 * notifications"; a refusal, a browser without push, an iPhone not yet on the Home Screen and a server without push are
 * each explained in plain words, with what to do instead.
 */
function ThisDevice({ settings, onTurnedOn }: { settings: ClientNotificationSettings; onTurnedOn: () => void }) {
  const support = pushSupport();
  const [state, setState] = useState<DeviceState>({ kind: 'CHECKING' });
  const [isWorking, setIsWorking] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);

  useEffect(() => {
    let isCurrent = true;
    if (support !== 'SUPPORTED') return;
    if (notificationPermission() === 'denied') {
      setState({ kind: 'BLOCKED' });
      return;
    }
    currentSubscription()
      .then((subscription) => isCurrent && setState({ kind: subscription && notificationPermission() === 'granted' ? 'ON' : 'OFF' }))
      .catch(() => isCurrent && setState({ kind: 'OFF' }));
    return () => {
      isCurrent = false;
    };
  }, [support]);

  const turnOn = async () => {
    if (!settings.pushPublicKey) return;
    setIsWorking(true);
    setProblem(null);
    try {
      const outcome = await turnOnThisDevice(settings.pushPublicKey);
      setState({ kind: outcome });
      if (outcome === 'ON') onTurnedOn();
    } catch (caught) {
      reportDeviceFailure(caught);
      setProblem(caught);
    } finally {
      setIsWorking(false);
    }
  };
  const turnOff = async () => {
    setIsWorking(true);
    setProblem(null);
    try {
      await turnOffThisDevice();
      setState({ kind: 'OFF' });
    } catch (caught) {
      reportDeviceFailure(caught);
      setProblem(caught);
    } finally {
      setIsWorking(false);
    }
  };

  let body;
  if (!settings.isPushAvailable) {
    body = <p className="text-body text-muted">Notifications on this device aren't available yet. Reminders can come by email: turn on email reminders below.</p>;
  } else if (support === 'NEEDS_HOME_SCREEN') {
    body = (
      <>
        <p className="text-body">On iPhone and iPad, notifications work once Look Up is on your Home Screen:</p>
        <HomeScreenSteps />
      </>
    );
  } else if (support === 'NOT_SUPPORTED') {
    body = <p className="text-body text-muted">This browser can't show notifications. Open Look Up in Chrome, or turn on email reminders below.</p>;
  } else if (state.kind === 'CHECKING') {
    body = <p className="text-body text-muted">Checking this device…</p>;
  } else if (state.kind === 'BLOCKED') {
    body = (
      <p className="text-body">
        Notifications are blocked for Look Up in this browser. To allow them, open the site's settings (the icon to the left of the address), set Notifications to Allow, then come back
        here. Until then, email reminders still work.
      </p>
    );
  } else if (state.kind === 'ON') {
    body = (
      <>
        <p role="status" className="text-body">
          Notifications are on for this device.
        </p>
        <Button variant="secondary" className="min-h-12 self-start" onClick={() => void turnOff()} isBusy={isWorking} busyLabel="Turning off…">
          Turn off on this device
        </Button>
      </>
    );
  } else {
    body = (
      <>
        <p className="text-body text-muted">Your browser will ask you to allow notifications from Look Up.</p>
        <Button className="min-h-12 self-start" onClick={() => void turnOn()} isBusy={isWorking} busyLabel="Turning on…">
          Turn on notifications
        </Button>
      </>
    );
  }

  return (
    <section aria-labelledby="client-this-device" className="flex flex-col gap-3 rounded-lg border border-line-soft bg-surface p-5">
      <h2 id="client-this-device" className="text-heading">
        On this device
      </h2>
      {body}
      {problem ? <ErrorNotice error={problem} title="We couldn't change notifications on this device" /> : null}
    </section>
  );
}

/** "Install the app" where the browser offers it; on an iPhone or iPad, the Home Screen steps (P5C-INSTALL-02). */
export function InstallOffer() {
  const canInstall = useSyncExternalStore(onInstallOfferChange, hasInstallOffer, () => false);
  if (isInstalled()) return null;
  // On an iPhone that needs the Home Screen for notifications, "On this device" already shows the same steps.
  if (!canInstall && (!isAppleMobile() || pushSupport() === 'NEEDS_HOME_SCREEN')) return null;
  return (
    <section aria-labelledby="client-install" className="flex flex-col gap-3 rounded-lg border border-line-soft bg-surface p-5">
      <h2 id="client-install" className="text-heading">
        Install the app
      </h2>
      <p className="text-body text-muted">Open Look Up like any app, straight from your home screen.</p>
      {canInstall ? (
        <Button className="min-h-12 self-start" onClick={() => void install()}>
          Install the app
        </Button>
      ) : (
        <HomeScreenSteps />
      )}
    </section>
  );
}

function describeTestResult(devices: number, isEmailSent: boolean): string {
  const deviceWords = devices === 1 ? '1 device' : `${devices} devices`;
  if (devices > 0 && isEmailSent) return `Sent to ${deviceWords} and your email.`;
  if (devices > 0) return `Sent to ${deviceWords}.`;
  if (isEmailSent) return 'Sent to your email.';
  return 'Nothing to send to yet: turn on notifications on this device, or email reminders.';
}

/**
 * Notifications (ADR-006 decision 6; P5C-NOTIFY-01): a reminder before each slot of the person's adverts, on this device
 * and by email, how early (5, 15 or 30 minutes), and which adverts. Every change is saved at once.
 */
export function ClientNotificationsPage() {
  const settings = useClientNotificationSettings();
  const save = useSaveNotificationSettings();
  const test = useSendTestNotification();
  const [draft, setDraft] = useState<ClientNotificationSettingsInput | null>(null);
  const howEarlyId = useId();

  useEffect(() => {
    if (settings.data) setDraft({ isPushOn: settings.data.isPushOn, isEmailOn: settings.data.isEmailOn, leadMinutes: settings.data.leadMinutes, mutedAds: settings.data.mutedAds });
  }, [settings.data]);

  if (settings.isPending) return <SkeletonRows count={4} rowClassName="h-16" />;
  // Someone whose last access was taken away has no reminders to set: the same explanation as the client home.
  if (settings.error instanceof ApiError && settings.error.code === 'NOT_FOUND') {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-display">Notifications</h1>
        <NoAdvertsToView />
      </div>
    );
  }
  if (settings.isError || !draft) {
    return (
      <div className="flex flex-col items-start gap-3">
        <h1 className="text-display">Notifications</h1>
        {settings.isError ? <ErrorNotice error={settings.error} title="We couldn't load your notifications" /> : null}
        <Button variant="secondary" onClick={() => void settings.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  const change = (next: Partial<ClientNotificationSettingsInput>) => {
    const changed = { ...draft, ...next };
    setDraft(changed);
    save.mutate(changed);
  };
  const isMuted = (stationId: string, adId: string) => draft.mutedAds.some((muted) => muted.stationId === stationId && muted.adId === adId);
  const stations = [...new Map(settings.data.ads.map((ad) => [ad.stationId, ad.stationName])).entries()];

  return (
    <div className="flex max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-display">Notifications</h1>
        <p className="text-body text-muted">A reminder before each time slot of your adverts, so you can listen in and check they air. Changes are saved as you make them.</p>
      </div>

      <ThisDevice settings={settings.data} onTurnedOn={() => (draft.isPushOn ? undefined : change({ isPushOn: true }))} />

      <section aria-labelledby="client-email-reminders" className="flex flex-col gap-2">
        <h2 id="client-email-reminders" className="text-heading">
          Email
        </h2>
        <SwitchRow label="Email me a reminder too" hint="To the email you sign in with." checked={draft.isEmailOn} onChange={(checked) => change({ isEmailOn: checked })} />
      </section>

      <fieldset aria-describedby={howEarlyId} className="flex flex-col gap-2">
        <legend className="text-heading">How early</legend>
        <span id={howEarlyId} className="text-caption text-muted">
          Before the slot starts, in the station's time.
        </span>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {AIR_TIME_REMINDER_LEAD_MINUTES.map((minutes) => (
            <label key={minutes} className="flex min-h-12 items-center gap-3 rounded-md border border-line-soft bg-surface px-4">
              <input type="radio" name="reminder-lead-minutes" value={minutes} checked={draft.leadMinutes === minutes} onChange={() => change({ leadMinutes: minutes as AirTimeReminderLeadMinutes })} className="size-5" />
              <span className="text-label">{`${minutes} minutes`}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <section aria-labelledby="client-which-adverts" className="flex flex-col gap-3">
        <h2 id="client-which-adverts" className="text-heading">
          Which adverts
        </h2>
        {settings.data.ads.length === 0 ? <p className="text-body text-muted">Your adverts appear here once a station publishes them.</p> : null}
        {stations.map(([stationId, stationName]) => (
          <div key={stationId} className="flex flex-col gap-2">
            <h3 className="text-label text-muted">{describeStation(stationName, null)}</h3>
            {settings.data.ads
              .filter((ad) => ad.stationId === stationId)
              .map((ad) => (
                <SwitchRow
                  key={ad.adId}
                  label={ad.title}
                  checked={!isMuted(ad.stationId, ad.adId)}
                  onChange={(checked) =>
                    change({
                      mutedAds: checked
                        ? draft.mutedAds.filter((muted) => !(muted.stationId === ad.stationId && muted.adId === ad.adId))
                        : [...draft.mutedAds, { stationId: ad.stationId, adId: ad.adId }],
                    })
                  }
                />
              ))}
          </div>
        ))}
      </section>

      {save.isError ? <ErrorNotice error={save.error} title="We couldn't save that change" /> : null}
      {save.isSuccess && !save.isPending ? (
        <p role="status" className="text-caption text-muted">
          Saved.
        </p>
      ) : null}

      <section aria-labelledby="client-test-notification" className="flex flex-col items-start gap-3">
        <h2 id="client-test-notification" className="text-heading">
          Check it works
        </h2>
        <Button variant="secondary" className="min-h-12" onClick={() => test.mutate()} isBusy={test.isPending} busyLabel="Sending…">
          Send a test notification
        </Button>
        {test.isSuccess ? (
          <p role="status" className="text-body">
            {describeTestResult(test.data.devices, test.data.isEmailSent)}
          </p>
        ) : null}
        {test.isError ? <ErrorNotice error={test.error} title="We couldn't send a test notification" /> : null}
      </section>

      <InstallOffer />
    </div>
  );
}
