# EveryPound

Zero-based budgeting with no adverts. Runs in the browser and installs as an app on Android, iPhone and desktop.

- `index.html` – the app
- `app.js` – Google sign-in, households, and Firestore sync
- `sw.js` – offline app shell
- `firestore.rules` – database security rules (paste into Firebase console → Firestore → Rules)

Budget data lives in Firestore, never in this repository.
