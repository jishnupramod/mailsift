# mailsift

A read-only mail reader for Node: connect to a mailbox, search it, and fetch messages as plain text. Folders are opened
with `EXAMINE` and bodies fetched with `BODY.PEEK`, so reading never changes the mailbox.

Work in progress. See the repository's `docs/design.md` for the design.

Licence: MIT.
