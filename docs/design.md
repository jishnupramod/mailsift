# mailsift design

mailsift is a read-only mail reader for Node: connect to a mailbox, search it, and fetch messages as plain text. It
works across providers (Gmail, Outlook.com and Microsoft 365, Yahoo, iCloud, Fastmail, any IMAP server), with a thin
MCP server on top for AI tools.

## Purpose

Finding specific emails in a person's own mailbox, from their own computer, should not require passing the mail through
a third-party relay or obtaining Google's restricted Gmail permission. Existing open-source IMAP MCP servers are small,
and none of them signs in to Microsoft accounts, now that Outlook.com no longer accepts passwords over IMAP.

A focused, read-only, multi-provider reader is useful for:
- anyone who wants an AI tool to look through their mail without being able to change it;
- scripts that need "find these emails and give me the text".

## Goals

- **One API for every provider:** connect, search, fetch as plain text, close.
- **Sign-in per provider:**
  - an app password over IMAP for Gmail, Yahoo, iCloud, Fastmail and custom IMAP;
  - Microsoft sign-in (OAuth 2.0) over IMAP for Outlook.com and Microsoft 365 (planned for a later release; 0.1.0
    accepts a Microsoft access token the caller obtains, and has no sign-in functions).
- **Provider presets:** host, port, TLS, sign-in kind, which folders to search, search dialect, and a link to the
  provider's app-password page.
- **A portable search query:** "from any of these domains, or containing any of these phrases, since this date". It is
  compiled to each provider's search: Gmail's own search syntax, or standard IMAP SEARCH.
- **Strictly read-only.**
  - Folders are opened read-only (`EXAMINE`) and bodies are fetched with `BODY.PEEK`. Reading never marks a message as
    read, and never moves, flags, sends or deletes anything.
  - The API has no write calls at all.
- **Spam and junk are searched too,** alongside the inbox and archive. Job mail that lands in spam is exactly the mail
  people miss.
- **The library never stores credentials.** The caller passes a password, or a function that returns a fresh
  Microsoft access token. The library has no logging of credentials or message bodies.
- **Pure JavaScript, with no native add-ons,** so it bundles into single-file executables.
  TypeScript types are included.
- **A second package, `mailsift-mcp`.** It is an MCP server exposing read-only tools (`list_folders`, `search_emails`,
  `get_email`), with a small CLI to sign in to Microsoft and to save a password.

## Non-goals (first version)

- Gmail's own OAuth sign-in. It is restricted by Google, and a "bring your own Google client" option can come later.
- Microsoft Graph. Outlook support uses IMAP with XOAUTH2; Microsoft Graph is a possible fallback.
- Sending, replying, moving, flagging, deleting, drafts.
- Attachment contents. Metadata only: file name, type and size.
- Push or IDLE notifications. Callers poll.
- Storing or caching messages.
- POP3.

## Safety model: never

- Any call that changes the mailbox, including marking a message read.
- A password, token or message body ends up in a log, an error message or a thrown stack trace.
- A connection falls back to unencrypted transport, or accepts an invalid certificate by default.
- The MCP server gives an AI tool a way to write to the mailbox, or to read beyond the result and size limits.

## Design

### Repository and packages

- A pnpm workspace with two packages, `mailsift` (the library) and `mailsift-mcp`.
- **Licence:** MIT.
- **Versions:** semver, with a changelog.
  - `0.1.0` is the library alone, for the app-password providers. Microsoft sign-in is not in it.
  - A later release adds Microsoft sign-in, and `mailsift-mcp` follows.
  - A preset that hasn't been tried on a live account is marked "untested" in the provider table.
- **CI:** GitHub Actions (type check, tests, build) on pull requests and on main.
- **Publishing:** published to npm from a tagged release.

### Dependencies

- **`imapflow`** for IMAP. It is pure JS, actively maintained, and supports XOAUTH2, `EXAMINE` and `BODY.PEEK`.
- **`mailparser`** for MIME parsing. It is pure JS.
- **Microsoft sign-in (planned, not in 0.1.0) uses plain `fetch`** against the Microsoft identity platform:
  authorization code with PKCE and a loopback redirect, plus device code as a fallback. This avoids the larger MSAL
  package.
- Nothing native.
- Runtime: Node 22 or later.

### Provider presets

`PROVIDERS` is a constant, one entry per provider. Each entry has:
- **IMAP connection:** host, port and TLS.
- **Sign-in kind:** `password` or `microsoft`.
- **Search dialect:** `gmail` (sent with `X-GM-RAW`) or `imap`.
- **Folders to search:** chosen by special-use flag (`\Inbox`, `\All`, `\Junk`, `\Archive`), with name fallbacks.
- **Help:** for password providers, a help URL for making an app password.
- **`custom`:** takes any host, port and TLS.

The provider list:

| Id | Provider | Sign-in | Dialect | Folders |
|---|---|---|---|---|
| `gmail` | Gmail and Google Workspace | password | gmail | All Mail + Spam |
| `outlook` | Outlook.com and Microsoft 365 | microsoft | imap | Inbox + Archive + Junk |
| `yahoo` | Yahoo Mail | password | imap | Inbox + Archive + Bulk |
| `icloud` | iCloud Mail | password | imap | Inbox + Archive + Junk |
| `fastmail` | Fastmail | password | imap | Inbox + Archive + Spam |
| `custom` | Any IMAP server | password | imap | Inbox + Junk, or as given |

Each preset's host and folder names are checked against the provider's documentation; the `tested` flag records which presets have passed the live check.

### Library API

```ts
type Auth =
  | { kind: 'password'; user: string; password: string }
  | { kind: 'microsoft'; user: string; accessToken: () => Promise<string> };

interface ConnectOptions {
  provider: ProviderId;
  auth: Auth;
  host?: string; port?: number; secure?: boolean;   // custom only
  folders?: string[];                                  // overrides the preset
  timeoutMs?: number;                                  // default 30 000
}

interface Query {
  fromDomains?: string[];   // match when the sender's address ends with @domain or .domain
  phrases?: string[];       // match when the phrase appears in one of phraseFields
  phraseFields?: ('from' | 'subject' | 'body')[];   // default ['from', 'subject'] ('from' covers name and address)
  requireAny?: { words: string[]; fields?: ('from' | 'subject')[] };   // also require one word; fields default ['subject']
  excludeFrom?: string[];   // never match these sender addresses (callers pass the person's own address here)
  since?: Date;             // received on or after this day (UTC date)
}

interface MessageRef {
  folder: string; uid: number; uidValidity: string;
  key: string;              // stable: Message-ID when present, else `${folder}:${uidValidity}:${uid}`
  date: Date | null; from: Address | null; subject: string;
}

interface Message extends MessageRef {
  to: Address[]; cc: Address[];
  text: string;             // plain text; HTML converted; capped (default 100 000 chars)
  headers: Record<string, string>;   // a fixed allowlist: Message-ID, Date, From, To, Cc, Reply-To, List-Id
  attachments: { filename: string | null; contentType: string; size: number }[];
  sizeBytes: number;
}

function connect(opts: ConnectOptions): Promise<Mailbox>;
interface Mailbox {
  folders(): Promise<{ path: string; specialUse: string | null }[]>;
  search(q: Query, opts?: { limit?: number }): Promise<MessageRef[]>;  // newest first, deduped by key, default limit 200
  fetch(ref: MessageRef, opts?: { maxChars?: number }): Promise<Message>;
  close(): Promise<void>;
}

// Microsoft sign-in (planned for a later release; these functions do not exist in 0.1.0). The caller stores the tokens.
// Two-step form, for callers that own the redirect route:
function microsoftStartSignIn(opts: { clientId: string; redirectUri: string; tenant?: 'common' | string }):
  { url: string; state: string; verifier: string };
function microsoftFinishSignIn(opts: { clientId: string; redirectUri: string; tenant?: string;
  code: string; verifier: string }): Promise<MicrosoftTokens>;
// One-call form: starts its own loopback listener on 127.0.0.1 (path /callback), opens the browser, waits:
function microsoftSignIn(opts: { clientId: string; tenant?: 'common' | string;
  openBrowser: (url: string) => Promise<void>; loopbackPort?: number }): Promise<MicrosoftTokens>;
function microsoftDeviceSignIn(opts: { clientId: string; tenant?: string;
  showCode: (code: { userCode: string; verificationUri: string }) => void }): Promise<MicrosoftTokens>;
function microsoftRefresh(opts: { clientId: string; refreshToken: string; tenant?: string }): Promise<MicrosoftTokens>;
interface MicrosoftTokens { accessToken: string; refreshToken: string; expiresAt: Date; account: string }
```

**Query compilation:**
- **Phrase fields:** by default, phrases match only the sender (name or address) and the subject, not the body. Body
  matching is opt-in, because common company names ("Apple", "Box") in bodies pull in newsletters and digests.
- **Own mail:** the person's own sent mail and drafts are always left out. Gmail adds `-in:sent -in:drafts`. The other
  presets don't search Sent or Drafts. `excludeFrom` covers replies of theirs that sit elsewhere.
- **Gmail:** `(from:(a.com OR b.com) OR from:"Phrase" OR subject:"Phrase") -from:x -in:sent -in:drafts
  after:YYYY/MM/DD`, sent with `X-GM-RAW`.
  Gmail limits the length of a search, so a long query is split into several searches (under 1,400 characters each),
  run one after another, with the results merged.
- **Standard IMAP:** an `OR` tree of `FROM domain`, `SUBJECT phrase` and `BODY phrase`, plus `SINCE date`. Any
  `excludeFrom` and domain-suffix checks are applied in code after the search, because IMAP's `FROM` matches substrings.
  Large trees are split the same way.
- **Phrases:** quotes inside a phrase are removed, and empty phrases are dropped.
- **Required words (`requireAny`):** a message must match the rest of the query and also have one of `words`, as a
  whole word or phrase, ignoring case and accents, in one of `fields`. Words are cleaned like phrases; a list left
  empty means no requirement. Gmail ANDs `subject:(application OR "next steps")` (and `from:(…)` when asked) onto
  every piece, counted toward the 1,400-character limit. Standard IMAP ANDs `NOT NOT <OR group>` onto every piece,
  because an imapflow search object holds one `or` key and the piece may already use it. The check is always repeated
  in code, as whole words, whether or not `fromDomains` is given: IMAP's `SUBJECT` matches substrings and Gmail's word
  rules differ slightly, so the server search alone would let "applications" stand in for "application".

**Errors** are typed with a `code`:
- `AUTH_FAILED`
- `APP_PASSWORD_REQUIRED` (the server said a normal password won't work)
- `CONNECTION_FAILED`
- `TLS_FAILED`
- `TIMEOUT`
- `FOLDER_MISSING`
- `RATE_LIMITED`
- `TOKEN_EXPIRED`
- `PROTOCOL_ERROR` (anything else: an unexpected server response or an unrecognised failure)

Messages never include credentials or message text.

**Safety in code:**
- TLS is required, and certificate checks stay on. `custom` with `secure: false` is refused unless the host is
  `127.0.0.1` or `localhost` (for test servers).
- All folders are opened with `EXAMINE`.
- Only `BODY.PEEK` fetches are used.

### `mailsift-mcp`

- **Tools:**
  - `list_folders`
  - `search_emails` (the `Query` fields plus `limit` up to 50)
  - `get_email` (by key; text capped at 20,000 characters, with a note when cut)
- **Results are plain text.** Each result says the email's text is untrusted content written by its sender.
- **No write tools exist.**
- **Configuration:**
  - `MAILSIFT_PROVIDER` and `MAILSIFT_USER`.
  - For password providers, `MAILSIFT_PASSWORD`, or a password saved by `mailsift-mcp login`.
  - For Outlook, `mailsift-mcp login outlook` runs the Microsoft sign-in in the browser (device code with `--device`)
    and saves the refresh token.
- **Where saved secrets live:** the OS keychain (macOS `security`, Linux `secret-tool`, Windows DPAPI via PowerShell)
  when available, else a `0600` file in the user's config folder, with a warning. Saved secrets are never printed.
- **Microsoft client id:** mailsift ships a default Microsoft app registration (public client, no secret). Callers may
  pass their own `clientId`.

### Microsoft sign-in (planned for a later release)

Not in 0.1.0. Until then, a caller can pass its own Microsoft access token to `connect`.

Outlook support uses IMAP with XOAUTH2; Microsoft Graph is a possible fallback. The flow uses authorization code with
PKCE and a loopback redirect, with the scopes `https://outlook.office.com/IMAP.AccessAsUser.All offline_access` on the
`common` tenant, then connects to `outlook.office365.com:993`.

A Microsoft app registration for this flow needs, in the Microsoft Entra admin center:
- supported accounts: "any organizational directory and personal Microsoft accounts";
- public client flows: on;
- redirect URIs (Entra ignores the port on loopback addresses but matches the path):
  - `http://localhost/callback` and `http://127.0.0.1/callback`, for the one-call form;
  - a callback path of the caller's choosing on both loopback hosts, for the two-step form;
- delegated permission: `IMAP.AccessAsUser.All` (Office 365 Exchange Online), plus `offline_access`.

mailsift ships a default client id, and callers may pass their own. Publisher verification (free, needs a Microsoft
Partner Network id) is recommended, because some work tenants block unverified apps.

### Testing

- **Unit tests** cover query compilation per dialect: splitting, escaping, phrase cleanup and exclude rules.
- **Connection tests** cover connect, search, fetch, read-only behaviour (no `\Seen` change) and errors. They run
  against an in-process fake IMAP server or recorded sessions. They exercise `EXAMINE`,
  `BODY.PEEK`, `X-GM-RAW` and XOAUTH2.
- **Microsoft sign-in tests** (with the sign-in itself, in a later release) use a fake token endpoint.
- **A live check script** (`pnpm --filter mailsift test:live <provider>`, never run in CI) runs connect, folders,
  search, fetch and close against a real account. It reads the address and app password from environment variables or
  a hidden prompt, and prints only pass or fail, counts and folder types.
- **MCP tests** cover tool schemas, limits and the untrusted-content wording.

### Documentation

- **README:** what it is, the read-only promise, the provider table, how to make an app password per provider (with
  links), the library quick start, MCP setup for Claude Desktop and Claude Code, and the security model.
- **`SECURITY.md`** pointing to GitHub's private security advisories.
- **`CONTRIBUTING.md`:** how to add a provider preset.
