# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's security advisories: open the repository's Security tab and choose
"Report a vulnerability". Please do not open a public issue for a security problem.

## Supported versions

The latest 0.x release.

## What counts

- A password, token or message text reaching a log, an error message or an error's `cause`.
- Any way for the library to write to a mailbox, including marking a message as read.
- Any way to connect without TLS, or to accept an invalid certificate, other than `secure: false` for `127.0.0.1` or
  `localhost`.
