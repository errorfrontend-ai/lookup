# Portal component inventory

The shared building blocks in `apps/portal/src/components/`, and the screens that use each one. A screen's own parts live in its feature folder (`apps/portal/src/features/<feature>/`) and are not listed here.

This list is kept current by a test: `apps/portal/src/source-scan.test.ts` fails when a file in `components/` is missing from it. When you add a component, add a row.

| Component | What it is | Used on |
|---|---|---|
| `components/ad-audio-player` | Plays an ad's uploaded audio. It asks for the playback link only when Play is pressed, and starting one player stops any other. | Ads list, Ad page (overview), New ad (review) |
| `components/badge` | A short status label. The words carry the meaning, never the colour alone. | Every status badge; Station profile |
| `components/button` | `Button`, `ButtonLink` and `buttonClassName`: the one look for actions, at least 44 px tall (48 px for the main action). | Overview, Ads list, Ad page, every New ad step, Clients, Station profile |
| `components/client-avatar` | A client's initials on a colour pair taken from the design tokens. | Overview, Ads list, Ad page, Clients, New ad (client) |
| `components/empty-state` | What a list says when it has nothing to show, and what to do next when the person may. | Ads list, Clients |
| `components/error-notice` | A failure in plain words with the reference (request id) to quote. Never technical text. | Sign in, Your account, Overview, Ads list, Ad page, New ad, Clients, Station profile, the signed-in check |
| `components/field-frame` | The label, hint and error around any form control, tied together with `aria-describedby`; the error is announced. | Inside the three field components below |
| `components/frequency-dial` | The station's name and frequency drawn as a radio tuning scale with a needle. Decoration only. | The menu (every station page) |
| `components/icons` | `Icon`: the portal's own inline SVG line icons, hidden from screen readers. | The menu and top bar, and most screens |
| `components/link-tabs` | Tabs that are links, so the address keeps the view. Underlined from `md` up, scrollable chips on a phone. | Ads list, Ad page |
| `components/listener-card-preview` | What a listener sees after identifying the ad, drawn from the card by the same reader the app uses. | New ad (buttons, review), Ad page (overview, buttons) |
| `components/modal-dialog` | `ModalDialog` and `ConfirmDialog`: a window that asks for a decision, keeping focus inside until it closes. | Ad page (rename, remove), New ad (leaving, publishing) |
| `components/page-header` | The top of a page: where you are, what it is, and its main action. | Overview, Ads list, Ad page, Clients, Station profile |
| `components/phone-width-toggle` | Switches the preview between a 320 px and a 411 px phone (a "Preview width" button group). | New ad (buttons, review), Ad page (buttons) |
| `components/plain-pages` | `LoadingScreen`, `NotFoundPage` and `NoStationPage`. | Every page while signing in is checked; addresses that lead nowhere |
| `components/programme-rundown` | The week drawn like a programme rundown: which hours of each day the ad is on air. | New ad (schedule, review), Ad page (schedule) |
| `components/progress-bar` | A bar showing how far something has got, announced as a percentage. | New ad (audio upload) |
| `components/select-field` | A drop-down list with label, hint and error. | New ad (buttons, schedule), Station profile |
| `components/skeleton` | Grey placeholders while content loads, hidden from screen readers. | Overview, Ads list, Ad page, Clients, Station profile, New ad |
| `components/status-badges` | `OnAirBadge` (pulsing dot, still under reduced motion), `CampaignStatusBadge` and `FileStatusBadge`. | Overview, Ads list, Ad page, Clients, New ad (review) |
| `components/text-area-field` | A text box for more than one line, with label, hint, error and character count. | New ad (buttons: a WhatsApp first message) |
| `components/text-field` | A one-line text box with label, hint, error and character count. | New ad (client, audio, buttons, schedule), Ad page (rename), Clients, Station profile |
| `components/toast-region` | `ToastProvider` and `useToast`: a short confirmation that goes away by itself and is announced politely. | Every station page (provider); Ad page, Clients, New ad, Station profile |
| `components/waveform-bars` | The bars of an audio waveform, from the real file where known. | Inside the audio player; New ad (audio preview) |
| `components/use-focus-heading-on-change` | Moves focus to the main heading when the page or the step changes, so a screen reader announces it. | Every station page; every New ad step |
| `components/use-media-query` | Whether a screen-width query matches now, and follows changes (a phone turned, a window resized). | Ads list (table or cards), New ad (buttons, schedule) |
