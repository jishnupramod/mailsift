# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0] - 2026-11-23

### Added

- `requireAny` on a query: a search matches only mail that also has one of these words, as a whole word, in the
  subject or the sender. A word list longer than 600 characters (joined with ` OR `) throws `TypeError`.

### Tested live

- Gmail: connect, folders, search, a search with a required word, fetch and close pass. The IMAP form of a required
  word (`NOT NOT`) is checked against the test server only.

## [0.1.0] - 2026-11-22

### Added

- `connect` to a mailbox over IMAP with TLS required and certificate checks on.
- `folders()` to list the folders on the server.
- `search()` with a portable query (sender domains, phrases, excluded senders, a start date), compiled to Gmail's
  search syntax or to standard IMAP `SEARCH`, with long queries split and results merged and deduplicated.
- `fetch()` to read a message as plain text, with a size cap, a small header allowlist and attachment metadata.
- Provider presets for Gmail, Outlook, Yahoo, iCloud, Fastmail and any IMAP server, with app-password links.
- Typed `MailsiftError` codes whose messages never carry credentials or message text.
- Read-only guarantees: folders opened with `EXAMINE`, bodies fetched with `BODY.PEEK`, and no call that writes.
- A live check script, `pnpm --filter mailsift test:live`, for trying a preset against a real account.

### Tested live

- Gmail: connect, folders, search, fetch and close pass. Other presets are untested.

[Unreleased]: https://github.com/jishnupramod/mailsift/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/jishnupramod/mailsift/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jishnupramod/mailsift/releases/tag/v0.1.0
