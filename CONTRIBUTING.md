# Contributing

## Setup

```sh
pnpm install
pnpm -r typecheck
pnpm -r test
pnpm -r build
```

Tests run against an in-process fake IMAP server and never touch the network. mailsift is read-only, so changes must
not add any call that writes to a mailbox.

## Adding a provider preset

Add an entry to `PROVIDERS` in `packages/mailsift/src/providers.ts` (and the id to `ProviderId` in `src/types.ts`):

- `id`, `label`, `host`, `port` and `secure: true`;
- `auth`: `'password'` or `'microsoft'`;
- `dialect`: `'gmail'` or `'imap'`;
- `folders`: special-use flags with name fallbacks;
- `appPasswordUrl`: the provider's app-password page, or `null`;
- `tested: false` until someone has run the live check against a real account (`pnpm --filter mailsift test:live
  <provider>`).

Then add a row to the provider table in both READMEs and a case to the provider tests.

## Commits

Use `<type>: <summary>` with a lowercase summary of at most 72 characters and no trailing period, where type is one of
feat, fix, refactor, docs, test or chore. Explain why in the body when it is not obvious.
