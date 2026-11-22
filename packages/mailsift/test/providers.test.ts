import { describe, expect, it } from 'vitest';
import { PROVIDERS } from '../src/index.js';

const all = Object.values(PROVIDERS);

describe('PROVIDERS', () => {
  it('uses TLS on port 993 for every preset', () => {
    for (const p of all) {
      expect(p.port).toBe(993);
      expect(p.secure).toBe(true);
    }
  });

  it('uses the gmail dialect for gmail only', () => {
    for (const p of all) expect(p.dialect).toBe(p.id === 'gmail' ? 'gmail' : 'imap');
  });

  it('signs in to outlook with Microsoft and everything else with a password', () => {
    for (const p of all) expect(p.auth).toBe(p.id === 'outlook' ? 'microsoft' : 'password');
  });

  it('links an https app-password page for each named password provider', () => {
    for (const p of all.filter((x) => x.auth === 'password' && x.id !== 'custom')) {
      expect(p.appPasswordUrl).toMatch(/^https:\/\//);
    }
  });

  it('has the documented hosts', () => {
    expect(PROVIDERS.gmail.host).toBe('imap.gmail.com');
    expect(PROVIDERS.outlook.host).toBe('outlook.office365.com');
    expect(PROVIDERS.yahoo.host).toBe('imap.mail.yahoo.com');
    expect(PROVIDERS.icloud.host).toBe('imap.mail.me.com');
    expect(PROVIDERS.fastmail.host).toBe('imap.fastmail.com');
    expect(PROVIDERS.custom.host).toBeNull();
  });

  it('searches All Mail and Spam on gmail, inbox archive and junk elsewhere', () => {
    expect(PROVIDERS.gmail.folders.map((f) => f.specialUse)).toEqual(['\\All', '\\Junk']);
    for (const id of ['outlook', 'yahoo', 'icloud', 'fastmail'] as const) {
      expect(PROVIDERS[id].folders.map((f) => f.specialUse)).toEqual(['\\Inbox', '\\Archive', '\\Junk']);
    }
  });

  it('marks only gmail and yahoo as tested', () => {
    expect(all.filter((p) => p.tested).map((p) => p.id).sort()).toEqual(['gmail', 'yahoo']);
  });
});
