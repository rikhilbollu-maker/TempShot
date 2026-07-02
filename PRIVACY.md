# TempShot Privacy Policy

*Last updated: July 1, 2026*

TempShot is a local-first screenshot utility. This policy is short because
there is genuinely nothing to disclose:

## What TempShot collects

**Nothing.** TempShot has no servers, no accounts, no analytics, no telemetry,
and makes zero network requests.

## Where your screenshots live

Screenshots are stored in your browser's local extension storage (IndexedDB)
on your own device. They remain there until you delete them, they auto-expire
based on your settings, or you export them yourself via Copy or Download.

## What leaves your device

Nothing, unless you explicitly copy a screenshot to your clipboard or download
it — both of which are actions you take, delivering the image only to where
you paste or save it.

## Permissions

- **activeTab** — capture the tab you invoke TempShot on, only when you click
  the extension or press its keyboard shortcut
- **scripting** — inject a script (only on your action) to scroll the page for
  full-page capture, copy the image to your clipboard, and show the brief
  "saved" confirmation flash
- **storage** — save your settings (auto-delete window, export format) locally
- **alarms** — run the periodic auto-delete sweep for expired screenshots
- **notifications** — show a confirmation after keyboard-shortcut captures
- **clipboardWrite / offscreen** — copy captured screenshots to your clipboard

## Changes

Any future change to this policy will be published in this repository before
it takes effect. Given the extension's design (no network access at all),
meaningful changes are unlikely.

## Contact

Open an issue at https://github.com/rikhilbollu-maker/TempShot/issues
