import { describe, expect, it } from 'vitest';
import { apiConfigSchema, loadConfig } from './index.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    const cfg = loadConfig(apiConfigSchema, {});
    expect(cfg.PORT).toBe(3000);
    expect(cfg.LLM_PROVIDER).toBe('auto');
    expect(cfg.COOKIE_SECURE).toBe(false);
  });

  it('coerces and treats empty strings as unset', () => {
    const cfg = loadConfig(apiConfigSchema, { PORT: '8080', ANTHROPIC_API_KEY: '', COOKIE_SECURE: 'true' });
    expect(cfg.PORT).toBe(8080);
    expect(cfg.ANTHROPIC_API_KEY).toBeUndefined();
    expect(cfg.COOKIE_SECURE).toBe(true);
  });

  it('fails fast with a readable error', () => {
    expect(() => loadConfig(apiConfigSchema, { DATABASE_URL: 'not a url' })).toThrow(/DATABASE_URL/);
  });
});
