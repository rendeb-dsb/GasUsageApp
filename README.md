# Gas Usage

A finished, offline fill-up tracker. Open `index.html` in any browser. Nothing is uploaded. Data stays in this browser’s IndexedDB (`gas-usage-db`: vehicles, fillups, and settings).

## What it does

- Log fill-ups: date, odometer, volume, price, station, notes, full or partial tank
- Multiple vehicles
- MPG from full-tank intervals (partials are included in the next full tank)
- Dashboard: last tank, average economy, total spend, cost per distance
- MPG trend and six-month spend charts
- History with search, date filter, edit, and delete
- CSV export, JSON backup, and JSON import
- Miles/gallons or kilometer/liter labels

## How to use it

1. Unzip this folder.
2. Double-click `index.html`.
3. Log two full tanks on the same vehicle. Economy appears on the second full tank.
4. Use Reports to download a JSON backup. Erase all data deletes the IndexedDB database.

Numbers are stored as entered. Do not mix gallons and liters on the same vehicle.
