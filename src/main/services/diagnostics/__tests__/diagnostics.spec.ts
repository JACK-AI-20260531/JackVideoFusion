/**
 * 诊断包纯函数与账号健康度单测(PRD-v1.7 FR-8)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeConfig, buildSystemInfo } from '../diagnostics.ts';
import { assessAccountHealth, LOGIN_CHECK_THRESHOLD_MS } from '../../auto-publish/account-health.ts';
import type { AccountInfo, PublishPlatform } from '../../auto-publish/types.ts';

describe('sanitizeConfig', () => {
  it('嵌套脱敏 apiKey/token/secret/password 键', () => {
    const config = {
      llm: { provider: 'openai', apiKey: 'sk-secret', endpoint: 'https://x' },
      accessToken: 'tok',
      password: 'pwd',
      model: 'gpt',
      nested: { deep: { secret_key: 'v' } },
      list: [{ apiKey: 'a' }, { name: 'b' }],
      num: 42,
    };
    const out = sanitizeConfig(config) as {
      llm: { apiKey: string; endpoint: string };
      accessToken: string;
      num: number;
    };
    assert.equal(out.llm.apiKey, '***');
    assert.equal(out.llm.endpoint, 'https://x');
    assert.equal(out.accessToken, '***');
    assert.equal((config as { accessToken: string }).accessToken, 'tok'); // 原对象不变
    assert.equal(out.model, 'gpt');
    assert.equal(out.num, 42);
    const list = out.list as { apiKey?: string; name?: string }[];
    assert.equal(list[0].apiKey, '***');
    assert.equal(list[1].name, 'b');
  });

  it('原始值与数组顶层安全', () => {
    assert.equal(sanitizeConfig('plain'), 'plain');
    assert.deepEqual(sanitizeConfig([1, 2]), [1, 2]);
  });
});

describe('buildSystemInfo', () => {
  it('包含版本与时间', () => {
    const text = buildSystemInfo({
      appVersion: '1.7.0',
      electronVersion: '32.0.0',
      nodeVersion: '20.0.0',
      osType: 'win32',
      osRelease: '10.0.22631',
      userDataDir: 'C:/ud',
      generatedAt: '2026-09-01T00:00:00.000Z',
    });
    assert.ok(text.includes('1.7.0'));
    assert.ok(text.includes('win32 10.0.22631'.split(' ')[1]) || text.includes('10.0.22631'));
    assert.ok(text.includes('C:/ud'));
  });
});

describe('assessAccountHealth', () => {
  const now = Date.parse('2026-09-01T00:00:00Z');
  const DAY = 24 * 60 * 60 * 1000;

  function account(
    platform: PublishPlatform,
    loginStatus: 'logged-in' | 'logged-out' | 'expired',
    lastActiveAt?: string,
  ): AccountInfo {
    return { platform, loginStatus, lastActiveAt };
  }

  it('expired → 需要注意', () => {
    const [h] = assessAccountHealth([account('douyin', 'expired')], now);
    assert.equal(h.needsAttention, true);
    assert.ok((h.reason ?? '').includes('过期'));
  });

  it('logged-out → 不预警', () => {
    const [h] = assessAccountHealth([account('kuaishou', 'logged-out')], now);
    assert.equal(h.needsAttention, false);
  });

  it('logged-in 且最近活跃超过 3 天 → 建议检测', () => {
    const [h] = assessAccountHealth(
      [account('bilibili', 'logged-in', new Date(now - 4 * DAY).toISOString())],
      now,
    );
    assert.equal(h.needsAttention, true);
    assert.ok((h.reason ?? '').includes('检测'));
  });

  it('logged-in 且活跃时间在阈值内 → 正常', () => {
    const [h] = assessAccountHealth(
      [account('douyin', 'logged-in', new Date(now - 1 * DAY).toISOString())],
      now,
    );
    assert.equal(h.needsAttention, false);
  });

  it('阈值为 3 天', () => {
    assert.equal(LOGIN_CHECK_THRESHOLD_MS, 3 * 24 * 60 * 60 * 1000);
  });
});
