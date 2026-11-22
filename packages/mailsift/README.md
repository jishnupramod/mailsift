# mailsift

A read-only mail reader for Node. It connects to a mailbox over IMAP, searches it with a portable query, and returns
messages as plain text.

## Read-only

mailsift never changes a mailbox.

- Every folder is opened with `EXAMINE`, which is read-only.
- Every body is fetched with `BODY.PEEK`, so messages stay unread.
- The public API has no call that writes: no send, move, flag or delete.

## Providers

| Provider | Host | Sign-in | Status |
|---|---|---|---|
| Gmail and Google Workspace (`gmail`) | imap.gmail.com | App password | tested |
| Outlook.com and Microsoft 365 (`outlook`) | outlook.office365.com | Microsoft sign-in: planned | untested |
| Yahoo Mail (`yahoo`) | imap.mail.yahoo.com | App password | untested |
| iCloud Mail (`icloud`) | imap.mail.me.com | App password | untested |
| Fastmail (`fastmail`) | imap.fastmail.com | App password | untested |
| Any IMAP server (`custom`) | your host | App password | untested |

"Untested" means the preset has not yet been tried against a live account. In 0.1.0, Outlook works only if you bring
your own Microsoft access token: `{ kind: 'microsoft', user, accessToken: async () => token }`.

## App passwords

Most providers do not accept your normal password over IMAP. Make an app password and pass it as the password.

- **Gmail:** turn on 2-Step Verification first, then create an app password at
  https://myaccount.google.com/apppasswords.
- **Yahoo:** create an app password under Account security at
  https://login.yahoo.com/account/security/app-passwords.
- **iCloud:** sign in at your Apple Account and generate an app-specific password; see
  https://support.apple.com/102654.
- **Fastmail:** create an app password with mail (IMAP) access; see
  https://www.fastmail.help/hc/en-us/articles/360058752854.

## Quick start

```sh
npm i mailsift
```

```js
import { connect } from 'mailsift';

const mailbox = await connect({
  provider: 'gmail',
  auth: { kind: 'password', user: 'someone@example.com', password: process.env.MAIL_APP_PASSWORD },
});

try {
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const refs = await mailbox.search({ fromDomains: ['example.org'], since }, { limit: 10 });
  if (refs.length > 0) {
    const message = await mailbox.fetch(refs[0]);
    console.log(message.subject, message.text.slice(0, 200));
  }
} finally {
  await mailbox.close();
}
```

`mailbox.folders()` lists the folders on the server.

## Connect options

| Option | Meaning |
|---|---|
| `provider` | `'gmail'`, `'outlook'`, `'yahoo'`, `'icloud'`, `'fastmail'` or `'custom'`. |
| `auth` | `{ kind: 'password', user, password }`, or `{ kind: 'microsoft', user, accessToken }`. |
| `host`, `port`, `secure` | `custom` only. `secure: false` is allowed only for `localhost` or `127.0.0.1`. |
| `folders` | Folder paths to search. Overrides the preset's folders. |
| `timeoutMs` | Time to wait for the server. Default 30 000. |

```js
const auth = { kind: 'password', user: 'someone@example.com', password: process.env.MAIL_APP_PASSWORD };
const mailbox = await connect({ provider: 'custom', host: 'imap.example.com', port: 993, auth });
```

mailsift is ESM only (`import`, no `require`) and needs Node 20 or later.

## Query reference

| Field | Meaning |
|---|---|
| `fromDomains` | Match when the sender's address ends with `@domain` or `.domain`. |
| `phrases` | Match when a phrase appears in one of `phraseFields`. |
| `phraseFields` | Where phrases are looked for: any of `'from'`, `'subject'`, `'body'`. Default `['from', 'subject']`. `'from'` covers the name and the address. |
| `excludeFrom` | Never match these sender addresses. |
| `since` | Received on or after this day (UTC date). |

A query with no `fromDomains` and no `phrases` matches nothing.

Options: `search(query, { limit })` returns at most `limit` results (default 200), newest first, deduplicated by `key`.
`fetch(ref, { maxChars })` caps the text at `maxChars` (default 100 000). `connect` takes `timeoutMs` (default 30 000).

On Gmail, the query is compiled to Gmail's own search syntax and sent with `X-GM-RAW`, across All Mail and Spam, leaving
out Sent and Drafts. On other servers it becomes a standard IMAP `SEARCH`, and domain and exclusion rules are checked
again in code because IMAP's `FROM` matches substrings. Long queries are split into several searches and the results are
merged. The person's own Sent and Drafts folders are never searched.

A fetched `Message` has `text` (HTML converted to plain text), `to`, `cc`, attachment metadata (file name, type, size;
never contents), and a small header allowlist: `Message-ID`, `Date`, `From`, `To`, `Cc`, `Reply-To`, `List-Id`.

## Errors

Failures are thrown as `MailsiftError` with a `code`. The message is fixed per code and never contains credentials or
message text.

| Code | Meaning |
|---|---|
| `AUTH_FAILED` | The server rejected the sign-in. |
| `APP_PASSWORD_REQUIRED` | The server needs an app password instead of the normal password. |
| `CONNECTION_FAILED` | Could not connect to the server. |
| `TLS_FAILED` | The secure connection could not be verified. |
| `TIMEOUT` | The server did not respond in time. |
| `FOLDER_MISSING` | The folder was not found. |
| `RATE_LIMITED` | The server is limiting requests; try again later. |
| `TOKEN_EXPIRED` | The sign-in token has expired. |
| `PROTOCOL_ERROR` | An unexpected server response or an unrecognised failure. |

Programming errors (an unknown provider, a custom provider without a host) throw `TypeError`; an error from your own
`accessToken` function passes through unchanged.

## Security model

- mailsift stores nothing: no credentials, no tokens, no messages.
- Passwords, tokens and message text are never written to a log, an error message or an error's `cause`.
- TLS is required and certificate checks stay on. `secure: false` is accepted only for the host `127.0.0.1` or
  `localhost`, for test servers.
- Read-only, as above.

To report a vulnerability, see `SECURITY.md` in the repository.

## Roadmap

- Microsoft sign-in for Outlook.com and Microsoft 365.
- An MCP server, `mailsift-mcp`, exposing read-only tools to AI assistants.

## Running the live check

The repository includes a script that runs connect, folders, search, fetch and close against a real account. It only
reads, and it prints pass or fail, counts and folder types, never addresses, folder names or message text.

```sh
pnpm --filter mailsift test:live gmail yahoo
```

It asks for the address and the app password. The password is typed at a hidden prompt, so it never lands in your shell
history. Alternatively set `MAILSIFT_LIVE_<PROVIDER>_USER` and `MAILSIFT_LIVE_<PROVIDER>_PASSWORD`, for example
`MAILSIFT_LIVE_GMAIL_USER`. The script is not part of `pnpm test` or CI.

## Licence

MIT.
