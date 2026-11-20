# Captions

Live captions in large print that show who is speaking. Made for a hard-of-hearing person
following a group conversation with an iPhone on the table.

**The app's address: https://coreysb123-web.github.io/captions/**

It is a web app: the phone opens it from a Home Screen icon like any other app, but nothing
goes through the App Store. The words come from a speech service (ElevenLabs "Scribe v3 Live"),
which the phone talks to directly. There is no server of your own to run.

## What it costs

- The app and the hosting: free.
- The speech service: pay-as-you-go, **$0.22 per hour of listening**, no subscription.
  ElevenLabs' pricing page (checked 20 Nov 2026) lists 2 hours 30 minutes included on the free
  tier. Confirm in your own account how often that renews.
- Optional: filling in "Names and unusual words" adds $0.08 per hour.

- On a paid ElevenLabs plan, listening is taken from the plan's monthly credits rather than
  charged on top. Nothing extra is charged when those run out unless the account has Top Up
  funds, Auto Top Up, or the older "usage based billing" switched on.

Silence is billed like speech, so the app pauses by itself after 20 minutes with no words
(changeable in Setup).

## Keeping the cost in check

- **The app's own meter.** Menu > Setup shows how long this phone has listened this month and
  roughly what that came to. It counts the audio actually sent to the service, which is what is
  billed. It is that phone's own tally; the ElevenLabs account has the real total.
- **A monthly limit per phone.** "Stop for the rest of the month after" in Setup stops listening
  once the phone has used that many hours, until the 1st of the next month. The limit travels
  in the setup link, so choose it before sending the link to another phone.
- **A limit on the key itself.** In ElevenLabs, give the key that other people's phones use its
  own monthly credit limit, and restrict it to Speech to Text. That limit cannot be got round
  from a phone, and it covers every phone using that key.
- The app only listens while it is on screen.

## What has and has not been tested

Tested on a computer, in a browser at phone size:

- The screens, text sizes, light and dark colours, sideways layout, naming speakers, saved
  conversations, the setup link.
- The layout at several iPhone sizes, upright and sideways, in a test browser built on
  Safari's engine. That is the current engine on Windows: close to an iPhone, not the same
  as one, and it does not show how older iOS versions behave.
- The audio conversion (48 kHz and other microphone rates down to 16 kHz), measured.
- Dropped connections and pause/resume: no words lost or repeated, names stay on the right
  people. Tested against a stand-in for the speech service built from its documentation.
- Against the real service: only the key check and the "key rejected" path.

Not yet tested, because they need a service key and a real phone:

- A real conversation through the real service.
- Anything on an actual iPhone (microphone capture, keeping the screen on, Home Screen install).

So expect a round of fixes after the first real try.

## Step 1: get a service key

1. Create a free account at elevenlabs.io.
2. Open **Developers**, then **API Keys**, and create a key. If it offers to restrict the key,
   allow Speech to Text only, and set a monthly spending limit. The key will live on the phones,
   so a limit is a sensible safety net.
3. If the app later says the terms have not been accepted, accept the Scribe terms in the
   ElevenLabs dashboard.

## Step 2: try it on a computer

Open the app's address in Chrome or Edge and press **Paste setup link or key** (or go to
**Menu > Setup** and paste the key into **Service key**). The app checks the key with
ElevenLabs and says whether it works. Then press **Start listening**. Talk, or play a recording
of a few people talking. This is the quickest way to judge accuracy before involving the phones.

"See a demonstration" (in Setup) plays a made-up conversation with no key and no microphone.

## Step 3: set up each iPhone

1. On your own device, open the app with the key already working, go to **Menu > Setup** and
   press **Send these settings to another phone**. Choose **Email it**, **Text message** or
   **Copy the link**. The link contains the key, so treat it like a password.
2. On the iPhone, tap the link. It opens in Safari and says Captions is set up.
3. Still in Safari, tap **Share**, then **Add to Home Screen**.
4. Open **Captions** from the Home Screen. If it does not already know its settings, tap
   **Paste setup link or key** and paste the link you sent.
5. Tap **Start listening** and allow the microphone.

## Using it

- Put the phone on the table, near the middle of the group, microphone end unobstructed.
- **Start listening** / **Pause** is the big button. **A-** and **A+** change the text size.
- Each voice gets a colour and a name chip ("Person 1"). Tap a chip to say who it is. Names you
  have used appear as one-tap buttons next time.
- Scroll up to re-read; **Latest** jumps back to the newest words.
- **Menu** has past conversations (kept on the phone only), light or dark colours, and Setup.

## Things to know

- **The phone asks for the microphone every time the app is opened.** This is an iPhone
  limitation for Home Screen web apps. It is one tap on Allow.
- **The app has to stay on screen.** iPhones stop the microphone when you switch apps or lock
  the phone. The app keeps the screen awake while listening and picks up where it left off when
  you come back.
- **It needs a connection.** About 150 MB per hour, so Wi-Fi is kinder than mobile data.
- **Speaker labels are the hard part.** Around a noisy table with people talking over each
  other, every service gets some labels wrong. The words are generally much more reliable than
  the labels. A quieter spot and the phone nearer the speakers help more than anything.
- **Names are remembered within a conversation**, including across a pause or a dropped
  connection. They are not yet remembered from one day to the next.
- **Setup > Microphone style** has two settings, Room and Close-up. Phones differ, so try both
  in a real room and keep the better one.
- If hearing aids or earbuds are connected, the phone may listen through them instead of its
  own microphone. Setup > Microphone lets you choose.

## If something goes wrong

| What you see | What to do |
| --- | --- |
| "The service key was not accepted" | Check the key in Setup with **Test key**. |
| "The speech service allowance has run out" | Add credit or a payment method in the ElevenLabs account. |
| "Reconnecting..." for a long time | Check the phone's connection. If it says "Still trying to connect", tap **Restart**; the words on screen are kept. |
| "Mic paused" | A call or another app took the microphone. Tap **Tap to continue**. |
| Captions are poor | Move the phone closer, try the other Microphone style, add family names to "Names and unusual words". |
| Something looks wrong on the screen | Open **Menu > Setup**, scroll to the bottom and tap **Open the display check** (or go to the app's address followed by `check.html`). Tap **Copy the results** and send them to whoever looks after Captions. It reports how that phone lays the app out; it contains no key and nothing personal. |

## How it is published

The app is hosted free by GitHub Pages, straight from this repository: whatever is in the
`docs` folder on the `main` branch is what the phones load. (GitHub Pages requires that folder
name; it holds the app, not documentation.)

To publish a change, commit it and push to `main`. The live address updates a minute or two
later, and each phone picks up the new version the next time the app is opened with a
connection.

The address should not change: the Home Screen icon and its saved settings belong to it.

To preview changes on a computer before publishing:

```powershell
python serve.py
```

Then open http://localhost:8123.

## How it is put together

Plain HTML, CSS and JavaScript in `docs/`, no build tools.

| File | What it does |
| --- | --- |
| `index.html`, `css/app.css` | The screen and its sheets. |
| `js/app.js` | Buttons, settings, saved conversations: ties the parts together. |
| `js/session.js` | Runs a conversation: microphone to engine to screen, reconnects, keeps names matched to voices. |
| `js/view.js` | Draws the transcript. |
| `js/audio.js`, `js/pcm-worklet.js` | Microphone capture and conversion to 16 kHz audio. |
| `js/engines/elevenlabs.js` | The connection to the speech service. To try a different service, write another file with the same interface (described at the top of `session.js`). |
| `js/engines/demo.js` | The made-up conversation used for the demonstration and for testing. |
| `js/store.js`, `js/history.js` | Settings, setup codes, saved conversations. |
| `js/usage.js` | The month-by-month tally of listening time behind the meter and the limit. |
| `js/wake.js` | Keeps the screen on. |
| `sw.js`, `manifest.webmanifest`, `icons/` | Home Screen install and offline start-up. |
| `check.html` | The display check: measures how a phone lays the app out, for diagnosing layout problems. |

`serve.py` (outside `docs/`) is only for previewing on a computer.

### Seeing it the way Safari draws it

iPhones use Safari's engine (WebKit), which sometimes lays things out differently from Chrome
or Edge. `tools/webkit_check.py` opens the app in a WebKit test browser at iPhone sizes, saves
a picture of every screen and popup, and prints their measurements. It needs Python with the
`playwright` package and its WebKit browser (`python -m playwright install webkit`). With the
preview running:

```powershell
python tools/webkit_check.py http://localhost:8123/ out now - "iPhone 13" 375x548 "iPhone 13 landscape"
```

Other services considered (November 2026): AssemblyAI scored best in its own published test of
live speaker labelling and gives $50 of free credit, but a phone cannot connect to it without a
small server in between. Deepgram gives $200 of free credit and connects directly, but its live
speaker labelling is weaker. Either could be added as a second engine for a side-by-side trial.
