export type {
  ProviderId,
  Auth,
  ConnectOptions,
  Query,
  RequireAny,
  Address,
  MessageRef,
  Message,
} from './types.js';
export { PROVIDERS, type Provider, type FolderSpec } from './providers.js';
export { MailsiftError, type ErrorCode } from './errors.js';
export { connect, type Mailbox } from './connect.js';
