# Security

## Reporting a problem

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/chinmay6537/bytepad/security/advisories/new) rather than a public issue.

## What to expect from Bytepad

- **Browser languages** run in Web Workers and WebAssembly on your device. Your code isn't uploaded.
- **Cloud languages** send code and input to Wandbox, a third party, when you press Run. Don't use them for secrets.
- **Share links** contain the whole project. Anyone with the link can read it, and links can end up in chat logs and browser history.
- **Saved work** is stored unencrypted in this browser's local storage.

## Running code from a share link

Treat a shared program like any code from the internet. Bytepad never runs a link automatically, but once you press
Run the program can use the network like any web page, and it runs on the same origin as the app, so it could read
Bytepad's offline cache. Workers can't read local storage, where your saved projects are. Bytepad has no accounts, so there are no
sessions or passwords to steal.

## Supply chain

Dependencies are pinned to exact versions, install scripts are disabled in CI, and CI runs `npm audit` on production dependencies.
