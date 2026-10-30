# SehatWaadi Companion (Windows)

React + Vite app wrapped in Electron. Runs on the chemist's billing PC: rings on a new order, brings itself to the front,
keeps running in the tray and starts with Windows.

    npm install            # (set ELECTRON_SKIP_BINARY_DOWNLOAD=1 to skip the Electron download when only testing the web app)
    npm run dev            # web version at http://localhost:5175, for development
    npm test               # unit tests
    npm start              # build and run the desktop app
    npm run dist           # Windows installer (run this on Windows)

First run asks for the Hub address, pharmacy ID and key. Needs the Hub patch (../sehatwaadi-hub-patch).

Screens: Orders (offer, tick-to-pick, dispatch, QR handover) · Deliveries (live riders, problem alerts, reassign/return) · Earnings (per-order lines) · Shelf (items you are not offered).
