import { describe, expect, it } from 'vitest';

describe('public api', () => {
  it('index exports only the public API', async () => {
    const mod = await import('../src/index.js');
    expect(Object.keys(mod).sort()).toEqual(['MailsiftError', 'PROVIDERS', 'connect']);
  });
});
