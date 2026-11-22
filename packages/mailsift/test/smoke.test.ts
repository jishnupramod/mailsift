import { describe, expect, it } from 'vitest';

describe('package entry', () => {
  it('can be imported', async () => {
    const mod = await import('../src/index.ts');
    expect(mod).toBeDefined();
  });
});
