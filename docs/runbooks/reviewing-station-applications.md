# Reviewing station applications

For the Look Up super admin: how to decide a station's application, a change to an approved station, and a
suspension. The console is at `/admin` in the portal. The design behind it is
`docs/design/step-5a-registration-and-admin.md` (§4.4 and §9).

## Before you start

- **Your account.** A super admin is created only from the server, never from the portal:
  `SUPER_ADMIN_EMAIL=… SUPER_ADMIN_FULL_NAME=… SUPER_ADMIN_PASSWORD=… npm run admin:create-super-admin -w @lookup/api`.
  It prints an authenticator address and secret once. Scan it into an authenticator app, then clear the terminal.
- **Each sign-in** asks for your password, then the 6-digit code from the authenticator app. After five wrong codes
  within 15 minutes, the code check refuses until those 15 minutes are up.
- **A lost phone.** Someone with server access runs the same command with `-- --reset-two-factor`. That gives you a
  new secret and ends every session you had open.
- **Work only in the console.** Every decision there is written to the audit log with your name and the request's
  reference. A change made straight in the database has no record and skips the station's SMS and email.

## The queue

**Applications** lists what is waiting, oldest first. It holds two kinds of entry:

- **A new station**: its first application, or a resubmission after a rejection.
- **"Change to an approved station"**: an approved station asking to change its name, frequency or licence. The
  station keeps its approved details until you decide.

Decide every entry within the **2 working days** the station was promised on its status page and in its emails.

## Checking a new station

Open the entry. Check each of these in turn.

1. **The checks.** Phone and email must both say "confirmed", and the licence document "uploaded". The station
   cannot submit without them, so anything else means a fault: report it with the request's reference rather than
   deciding.
2. **The duplicate flag.** "Check: Same frequency and town as …" means another station has the same frequency and
   town. It is a flag, not a refusal.
   - Next to an **approved** station, it is usually someone posing as that station. Reject unless the applicant
     shows it is a genuine second licence (a new owner, say).
   - Next to a **station waiting for review**, two people may be applying for the same station. Decide the two
     together.
3. **The Independent Broadcasting Authority's list.** The IBA publishes its licensed radio stations at
   https://www.iba.org.zm/content-service-providers/ (about 190 radio rows, as found on 9 October 2026). Each row
   gives the station's name, province, area (town and frequency, for example "Kabwe 90.3FM") and category.
   - Check that the station's **name, town and frequency** match a row.
   - The list has **no licence numbers, no expiry dates and no "as at" date**, and some rows say "Frequency yet to
     be assigned". So you cannot check the licence number against it, and a station missing from it may simply be
     newer than the list.
   - Radio licences last 5 years.
4. **The licence document.** It opens in the console through a link that lasts 5 minutes. Each opening is recorded
   in the audit log, and the document is never public. Check that:
   - it is readable;
   - it is a broadcasting licence from the IBA;
   - its number matches the number typed in the application;
   - it names this station, or its owner company;
   - it has not expired.
5. **The contact.** The application shows the contact's name and a masked phone number. If you have any doubt, call
   the number the IBA list or the station's own public pages give, not the one in the application.

## Deciding

- **Approve station** makes the station active at once. It can upload ads, and listeners can be shown its buttons.
  The station is told by SMS and email.
- **Reject** needs a reason of at least 10 characters. The station reads **your words exactly**, in the portal and
  in its email, so write what to fix, not a verdict. For example: "The licence photo is too blurry to read the
  number. Please upload a clearer copy." The station can then edit its application and submit again, and it comes
  back to the queue as a new entry.
- **Never put personal details in a reason**, such as somebody else's name or number. The reason is stored and
  shown to the station.

## A change to an approved station

The panel shows "Approved now" beside "Asked for" (name, frequency, licence number and, if one came with it, the
new licence document).

- Check the new details against the IBA list and the document, as for a new station.
- **Approve the change** puts the new details live for listeners at once.
- **Reject** keeps the approved details, and the station sees your reason.

## Suspending a station

On **Stations**, open the station and choose **Suspend**. You must give a reason.

- The station's ads stop reaching listeners from the next recognition.
- The station can still sign in, but only its station profile opens. Its ads, clients and overview stay closed
  until it is reactivated.
- The station is told by SMS and email, with your reason.
- **Reactivate** brings it back the same way.

Suspend when you see:

- scam buttons (a payment link or a number that is not the advertiser's);
- a station posing as another station;
- a regulator's instruction.

## When something looks wrong

- **A page shows an error with a reference.** Quote the reference to the developers: they can find the full record
  from it.
- **A station says it never got its SMS or email.** Check **System health**: the Notifications row shows how many are
  waiting to be sent, and whether the notification worker is running. Each notification is tried five times, with
  growing waits, before it is given up.
- **"Find by reference code"** looks up a listener's or station's reference from the last 30 days, without
  showing personal details.
