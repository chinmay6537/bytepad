# Contributing

Bug reports, ideas and pull requests are all welcome. Please be kind to each other.

## Setup

```bash
npm ci --ignore-scripts
npm run dev
```

## Before opening a pull request

```bash
npm run build
npm test
npx playwright install chromium   # first time only
npm run test:e2e
```

Browser tests run against the production build, so build first. `vite preview` deliberately sends no isolation
headers, which makes it behave like GitHub Pages.

## Guidelines

- Put logic in `src/core/` with unit tests. Keep DOM code out of it.
- Add a browser test for anything a user can see.
- Set shared or user-provided text with `textContent` (the `el()` helper does this), never `innerHTML`.
- Features must keep working on a free static host. A required backend is out of scope.
- If a feature sends code off the device, the UI must say so.

## Adding a cloud language

Add an entry to `LANGUAGES` in `src/core/languages.ts`, then run `npm run test:cloud` to check its template on Wandbox.

## Good first ideas

- A C and C++ stepping debugger
- More Node.js APIs for JavaScript programs
- A browser-based runtime for another language, such as Lua or Ruby
- Translations of the interface
