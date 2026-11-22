import type { ProviderId } from './types.js';

export interface FolderSpec {
  specialUse: '\\Inbox' | '\\All' | '\\Junk' | '\\Archive';
  /** Name fallbacks, tried in order when the server reports no special-use flag. */
  names: string[];
}

export interface Provider {
  id: ProviderId;
  label: string;
  /** null for custom, which takes any host. */
  host: string | null;
  port: number;
  secure: true;
  auth: 'password' | 'microsoft';
  dialect: 'gmail' | 'imap';
  folders: FolderSpec[];
  appPasswordUrl: string | null;
  /** True once the preset has been tried against a live account. */
  tested: boolean;
}

const inbox: FolderSpec = { specialUse: '\\Inbox', names: ['INBOX'] };

export const PROVIDERS: Readonly<Record<ProviderId, Provider>> = {
  gmail: {
    id: 'gmail',
    label: 'Gmail and Google Workspace',
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: 'password',
    dialect: 'gmail',
    folders: [
      { specialUse: '\\All', names: ['[Gmail]/All Mail', '[Google Mail]/All Mail'] },
      { specialUse: '\\Junk', names: ['[Gmail]/Spam', '[Google Mail]/Spam'] },
    ],
    appPasswordUrl: 'https://myaccount.google.com/apppasswords',
    tested: true,
  },
  outlook: {
    id: 'outlook',
    label: 'Outlook.com and Microsoft 365',
    host: 'outlook.office365.com',
    port: 993,
    secure: true,
    auth: 'microsoft',
    dialect: 'imap',
    folders: [
      inbox,
      { specialUse: '\\Archive', names: ['Archive'] },
      { specialUse: '\\Junk', names: ['Junk Email', 'Junk E-mail', 'Junk'] },
    ],
    appPasswordUrl: null,
    tested: false,
  },
  yahoo: {
    id: 'yahoo',
    label: 'Yahoo Mail',
    host: 'imap.mail.yahoo.com',
    port: 993,
    secure: true,
    auth: 'password',
    dialect: 'imap',
    folders: [
      inbox,
      { specialUse: '\\Archive', names: ['Archive'] },
      { specialUse: '\\Junk', names: ['Bulk', 'Bulk Mail'] },
    ],
    appPasswordUrl: 'https://login.yahoo.com/account/security/app-passwords',
    tested: false,
  },
  icloud: {
    id: 'icloud',
    label: 'iCloud Mail',
    host: 'imap.mail.me.com',
    port: 993,
    secure: true,
    auth: 'password',
    dialect: 'imap',
    folders: [
      inbox,
      { specialUse: '\\Archive', names: ['Archive'] },
      { specialUse: '\\Junk', names: ['Junk'] },
    ],
    appPasswordUrl: 'https://support.apple.com/102654',
    tested: false,
  },
  fastmail: {
    id: 'fastmail',
    label: 'Fastmail',
    host: 'imap.fastmail.com',
    port: 993,
    secure: true,
    auth: 'password',
    dialect: 'imap',
    folders: [
      inbox,
      { specialUse: '\\Archive', names: ['Archive'] },
      { specialUse: '\\Junk', names: ['Spam', 'Junk'] },
    ],
    appPasswordUrl: 'https://www.fastmail.help/hc/en-us/articles/360058752854',
    tested: false,
  },
  custom: {
    id: 'custom',
    label: 'Any IMAP server',
    host: null,
    port: 993,
    secure: true,
    auth: 'password',
    dialect: 'imap',
    folders: [inbox, { specialUse: '\\Junk', names: ['Junk', 'Junk E-mail', 'Spam', 'Bulk Mail'] }],
    appPasswordUrl: null,
    tested: false,
  },
};
