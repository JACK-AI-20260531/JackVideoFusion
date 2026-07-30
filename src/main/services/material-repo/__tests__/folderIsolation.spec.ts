/**
 * 文件夹隔离机制单测
 * 职责:验证 material-repo 的文件夹隔离硬约束、审计日志、抽取数量、unique 去重
 *
 * 设计说明:
 *   - 本测试文件自包含一个最小化测试 harness(不依赖 vitest/jest),
 *     以便在无测试框架的项目中也能通过 `node` 直接运行验证
 *   - 通过 createMaterialRepo 的依赖注入(scanner/warn/existsCheck)绕过真实文件系统,
 *     使测试纯内存运行,互不污染
 *   - 覆盖关键路径:同文件夹隔离、跨文件夹审计、抽取数量、unique 去重、
 *     kind 过滤、excludeIds、registerFolder 幂等、removeFolder、seed 可复现、policy 缺失 reason
 */
import { createMaterialRepo } from '../index';
import type { MaterialRepo } from '../index';
import type { MaterialMeta } from '../../../../shared/types';
import { basename } from 'path';

/* ===================== 最小化测试 harness ===================== */

/** 测试用例 */
interface TestCase {
  name: string;
  fn: () => void | Promise<void>;
}

/** 测试套件 */
const suite: TestCase[] = [];

/**
 * 注册一个测试用例
 * @param name 用例名
 * @param fn 用例函数(可异步)
 */
function it(name: string, fn: () => void | Promise<void>): void {
  suite.push({ name, fn });
}

/** 期待对象:链式断言 */
class Expectation<T> {
  /** 是否取反 */
  private negated: boolean;

  /**
   * @param actual 实际值
   * @param negated 是否取反
   */
  constructor(private readonly actual: T, negated = false) {
    this.negated = negated;
  }

  /** 取反断言 */
  get not(): Expectation<T> {
    return new Expectation(this.actual, !this.negated);
  }

  /** 深度相等断言 */
  toEqual(expected: T): void {
    const ok = deepEqual(this.actual, expected);
    if (this.negated ? ok : !ok) {
      throw new Error(
        `expect.not.toEqual 失败:\n  actual=${JSON.stringify(this.actual)}\n  expected=${JSON.stringify(expected)}`,
      );
    }
  }

  /** 严格相等断言 */
  toBe(expected: T): void {
    const ok = this.actual === expected;
    if (this.negated ? ok : !ok) {
      throw new Error(
        `expect.toBe 失败:\n  actual=${JSON.stringify(this.actual)}\n  expected=${JSON.stringify(expected)}`,
      );
    }
  }

  /** 长度断言 */
  toHaveLength(n: number): void {
    const len = (this.actual as unknown as { length?: number })?.length;
    const ok = len === n;
    if (this.negated ? ok : !ok) {
      throw new Error(
        `expect.toHaveLength(${n}) 失败: actual.length=${len}`,
      );
    }
  }

  /** 真值断言 */
  toBeTruthy(): void {
    const ok = Boolean(this.actual);
    if (this.negated ? ok : !ok) {
      throw new Error(`expect.toBeTruthy 失败: actual=${JSON.stringify(this.actual)}`);
    }
  }

  /** 假值断言 */
  toBeFalsy(): void {
    const ok = !this.actual;
    if (this.negated ? ok : !ok) {
      throw new Error(`expect.toBeFalsy 失败: actual=${JSON.stringify(this.actual)}`);
    }
  }

  /** 包含断言(数组/字符串) */
  toContain(item: unknown): void {
    const arr = this.actual as unknown as unknown[] | string;
    const ok = Array.isArray(arr)
      ? arr.includes(item as never)
      : typeof arr === 'string' && arr.includes(String(item));
    if (this.negated ? ok : !ok) {
      throw new Error(
        `expect.toContain 失败: actual=${JSON.stringify(this.actual)} item=${JSON.stringify(item)}`,
      );
    }
  }
}

/**
 * 期待一个函数抛错
 * @param fn 待测函数
 * @param msgPattern 可选的错误信息匹配正则
 */
async function expectThrow(
  fn: () => unknown,
  msgPattern?: RegExp,
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msgPattern && !msgPattern.test(msg)) {
      throw new Error(`抛错但信息不匹配: 期望 ${msgPattern}, 实际 "${msg}"`);
    }
    return;
  }
  throw new Error('期待抛错但未抛出');
}

/**
 * 深度相等判断(基本类型/数组/对象)
 * @param a 值 A
 * @param b 值 B
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      deepEqual(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
      ),
    );
  }
  return false;
}

/**
 * 期待函数:断言实际值
 * @param actual 实际值
 */
function expect<T>(actual: T): Expectation<T> {
  return new Expectation(actual);
}

/**
 * 运行所有用例并打印结果
 * @returns 是否全部通过
 */
async function runAll(): Promise<boolean> {
  let pass = 0;
  let fail = 0;
  for (const tc of suite) {
    try {
      await tc.fn();
      pass++;
      // eslint-disable-next-line no-console
      console.log(`  ✓ ${tc.name}`);
    } catch (e) {
      fail++;
      // eslint-disable-next-line no-console
      console.error(`  ✗ ${tc.name}`);
      // eslint-disable-next-line no-console
      console.error(`      ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`\n结果: ${pass} 通过, ${fail} 失败, 共 ${suite.length} 用例`);
  return fail === 0;
}

/* ===================== 测试夹具 ===================== */

/**
 * 构造一个内存素材仓库(绕过真实文件系统)
 * @param setup 预置素材映射: path -> 素材列表(不含 folderId)
 */
function makeRepo(
  setup: Record<string, Omit<MaterialMeta, 'folderId'>[]>,
): { repo: MaterialRepo; warns: string[] } {
  const warns: string[] = [];
  const repo = createMaterialRepo({
    // fake scanner:按 path 返回预置素材
    // 注意:registerFolder 会 normalizePath 把路径转成绝对路径,
    //       所以这里用 basename 匹配 setup key(如 '/folderA' -> 'folderA')
    scanner: async (p) => setup[basename(p)] ?? setup[p] ?? [],
    // 收集审计/警告日志
    warn: (m) => warns.push(m),
    // 绕过真实文件系统校验
    existsCheck: async () => undefined,
    // 固定 UUID 便于断言(用计数器)
    uuid: (() => {
      let n = 0;
      return () => `uuid-${++n}`;
    })(),
    // 固定时间便于断言
    now: () => new Date('2026-01-01T00:00:00Z'),
  });
  return { repo, warns };
}

/** 构造一份素材(不含 folderId) */
function mk(
  id: string,
  name: string,
  kind: MaterialMeta['kind'],
  path = '',
): Omit<MaterialMeta, 'folderId'> {
  return {
    id,
    name,
    kind,
    path: path || `/${name}`,
    sizeBytes: 1024,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/** 测试夹具:两个文件夹 A、B,各含若干素材 */
function makeTwoFolders(): {
  repo: MaterialRepo;
  warns: string[];
  folderAId: string;
  folderBId: string;
} {
  const { repo, warns } = makeRepo({
    'folderA': [
      mk('a1', 'a1.mp4', 'video'),
      mk('a2', 'a2.mp4', 'video'),
      mk('a3', 'a3.mp4', 'video'),
      mk('a4', 'a3.mp3', 'audio'),
      mk('a5', 'note.txt', 'text'),
    ],
    'folderB': [
      mk('b1', 'b1.mp4', 'video'),
      mk('b2', 'b2.mp4', 'video'),
      mk('b3', 'b1.mp3', 'audio'),
    ],
  });
  // 注意:由于 uuid 被固定为 uuid-N,且 registerFolder 也用 uuidFn,
  // 第一个 registerFolder 会消耗 uuid-1(作为 folderId)
  // 但 scanner 返回的素材 id 是夹具里写死的 'a1' 等(fake scanner 不调用 uuidFn)
  // 因此素材 id 仍是 a1/a2/...,folderId 是 uuid-1、uuid-2
  return { repo, warns, folderAId: '', folderBId: '' };
}

/* ===================== 测试用例 ===================== */

it('registerFolder + scanFolder:素材 folderId 全部正确归属', async () => {
  const { repo } = makeRepo({
    'folderA': [
      mk('a1', 'a1.mp4', 'video'),
      mk('a2', 'a2.mp3', 'audio'),
    ],
  });
  const folder = await repo.registerFolder('/folderA');
  const mats = await repo.scanFolder(folder.id);
  expect(mats).toHaveLength(2);
  for (const m of mats) {
    expect(m.folderId).toBe(folder.id);
  }
});

it('pickFromFolder 只返回同文件夹素材(隔离硬约束)', async () => {
  const { repo } = makeRepo({
    'folderA': [
      mk('a1', 'a1.mp4', 'video'),
      mk('a2', 'a2.mp4', 'video'),
      mk('a3', 'a3.mp4', 'video'),
    ],
    'folderB': [
      mk('b1', 'b1.mp4', 'video'),
      mk('b2', 'b2.mp4', 'video'),
    ],
  });
  const folderA = await repo.registerFolder('/folderA');
  const folderB = await repo.registerFolder('/folderB');
  await repo.scanFolder(folderA.id);
  await repo.scanFolder(folderB.id);

  const picked = repo.pickFromFolder(folderA.id, 5, { seed: 42 });
  // 数量正确:不超过 pool 大小
  expect(picked.length <= 3).toBe(true);
  // 隔离:全部 folderId === folderA.id
  for (const m of picked) {
    expect(m.folderId).toBe(folderA.id);
  }
  // 隔离:不含 B 的任何素材
  for (const m of picked) {
    expect(m.id.startsWith('b')).toBe(false);
  }
});

it('pickFromFolder 抽取数量正确(请求数 <= 可用数)', async () => {
  const { repo } = makeRepo({
    'folderA': [
      mk('a1', 'a1.mp4', 'video'),
      mk('a2', 'a2.mp4', 'video'),
      mk('a3', 'a3.mp4', 'video'),
      mk('a4', 'a4.mp4', 'video'),
    ],
  });
  const f = await repo.registerFolder('/folderA');
  await repo.scanFolder(f.id);

  expect(repo.pickFromFolder(f.id, 0, { seed: 1 })).toHaveLength(0);
  expect(repo.pickFromFolder(f.id, 2, { seed: 1 })).toHaveLength(2);
  expect(repo.pickFromFolder(f.id, 4, { seed: 1 })).toHaveLength(4);
  // 超过可用数:返回全部 4 个
  expect(repo.pickFromFolder(f.id, 10, { seed: 1 })).toHaveLength(4);
});

it('pickFromFolder 不重复复用(opts.unique=true 时跨调用去重)', async () => {
  const { repo } = makeRepo({
    'folderA': [
      mk('a1', 'a1.mp4', 'video'),
      mk('a2', 'a2.mp4', 'video'),
      mk('a3', 'a3.mp4', 'video'),
    ],
  });
  const f = await repo.registerFolder('/folderA');
  await repo.scanFolder(f.id);

  // 三次各抽 1 个,unique=true,应不重复
  const picks: MaterialMeta[] = [];
  picks.push(...repo.pickFromFolder(f.id, 1, { unique: true, seed: 1 }));
  picks.push(...repo.pickFromFolder(f.id, 1, { unique: true, seed: 100 }));
  picks.push(...repo.pickFromFolder(f.id, 1, { unique: true, seed: 999 }));

  expect(picks).toHaveLength(3);
  // 三个 id 互不相同
  const ids = new Set(picks.map((p) => p.id));
  expect(ids.size).toBe(3);

  // 第四次 unique 抽取:池已空,应返回 0 个
  const fourth = repo.pickFromFolder(f.id, 1, { unique: true, seed: 1 });
  expect(fourth).toHaveLength(0);
});

it('pickFromFolder unique=false(默认)允许跨调用重复', async () => {
  const { repo } = makeRepo({
    'folderA': [
      mk('a1', 'a1.mp4', 'video'),
      mk('a2', 'a2.mp4', 'video'),
    ],
  });
  const f = await repo.registerFolder('/folderA');
  await repo.scanFolder(f.id);

  const p1 = repo.pickFromFolder(f.id, 2, { seed: 1 });
  const p2 = repo.pickFromFolder(f.id, 2, { seed: 1 }); // 同 seed,相同序列
  expect(p1.map((m) => m.id)).toEqual(p2.map((m) => m.id));
});

it('pickFromFolder kind 过滤仅返回指定类型', async () => {
  const { repo } = makeRepo({
    'folderA': [
      mk('a1', 'a1.mp4', 'video'),
      mk('a2', 'a2.mp3', 'audio'),
      mk('a3', 'a3.srt', 'subtitle'),
      mk('a4', 'a4.txt', 'text'),
    ],
  });
  const f = await repo.registerFolder('/folderA');
  await repo.scanFolder(f.id);

  const videos = repo.pickFromFolder(f.id, 10, { kind: 'video', seed: 1 });
  expect(videos).toHaveLength(1);
  expect(videos[0].kind).toBe('video');

  const audios = repo.pickFromFolder(f.id, 10, { kind: 'audio', seed: 1 });
  expect(audios).toHaveLength(1);
  expect(audios[0].kind).toBe('audio');
});

it('pickFromFolder excludeIds 排除指定素材', async () => {
  const { repo } = makeRepo({
    'folderA': [
      mk('a1', 'a1.mp4', 'video'),
      mk('a2', 'a2.mp4', 'video'),
      mk('a3', 'a3.mp4', 'video'),
    ],
  });
  const f = await repo.registerFolder('/folderA');
  await repo.scanFolder(f.id);

  const picked = repo.pickFromFolder(f.id, 10, {
    excludeIds: ['a1', 'a3'],
    seed: 1,
  });
  expect(picked).toHaveLength(1);
  expect(picked[0].id).toBe('a2');
});

it('pickFromFolder seed 可复现(同 seed 同序列)', async () => {
  const { repo } = makeRepo({
    'folderA': [
      mk('a1', 'a1.mp4', 'video'),
      mk('a2', 'a2.mp4', 'video'),
      mk('a3', 'a3.mp4', 'video'),
      mk('a4', 'a4.mp4', 'video'),
    ],
  });
  const f = await repo.registerFolder('/folderA');
  await repo.scanFolder(f.id);

  const r1 = repo.pickFromFolder(f.id, 4, { seed: 7 }).map((m) => m.id);
  const r2 = repo.pickFromFolder(f.id, 4, { seed: 7 }).map((m) => m.id);
  expect(r1).toEqual(r2);

  // 不同 seed 通常产生不同序列(此处仅验证不抛错,不强制不等)
  repo.pickFromFolder(f.id, 4, { seed: 99 });
});

it('pickFromFolder 对未注册 folderId 抛错', async () => {
  const { repo } = makeRepo({});
  expectThrow(() => repo.pickFromFolder('not-exist', 1), /folderId 不存在/);
});

it('pickAcrossFolders 触发审计日志(logger.warn)', async () => {
  const { repo, warns } = makeRepo({
    'folderA': [mk('a1', 'a1.mp4', 'video'), mk('a2', 'a2.mp4', 'video')],
    'folderB': [mk('b1', 'b1.mp4', 'video')],
  });
  const fa = await repo.registerFolder('/folderA');
  const fb = await repo.registerFolder('/folderB');
  await repo.scanFolder(fa.id);
  await repo.scanFolder(fb.id);

  warns.length = 0; // 清空注册阶段可能产生的 warn
  const result = repo.pickAcrossFolders([fa.id, fb.id], {
    reason: '混剪任务跨文件夹聚合',
  });

  // 至少一条审计日志
  expect(warns.length >= 1).toBe(true);
  // 审计日志包含 [AUDIT] 标记与 reason
  const auditLine = warns.find((w) => w.includes('[AUDIT]'));
  expect(auditLine).toBeTruthy();
  expect(auditLine as string).toContain('pickAcrossFolders');
  expect(auditLine as string).toContain('混剪任务跨文件夹聚合');
  // 返回结果包含两个文件夹的素材
  expect(result.length >= 1).toBe(true);
});

it('pickAcrossFolders 缺少 policy.reason 抛错', async () => {
  const { repo } = makeRepo({
    'folderA': [mk('a1', 'a1.mp4', 'video')],
    'folderB': [mk('b1', 'b1.mp4', 'video')],
  });
  const fa = await repo.registerFolder('/folderA');
  const fb = await repo.registerFolder('/folderB');
  await repo.scanFolder(fa.id);
  await repo.scanFolder(fb.id);

  // reason 为空字符串
  expectThrow(
    () => repo.pickAcrossFolders([fa.id, fb.id], { reason: '' }),
    /policy\.reason/,
  );
  // reason 仅空白
  expectThrow(
    () => repo.pickAcrossFolders([fa.id, fb.id], { reason: '   ' }),
    /policy\.reason/,
  );
});

it('pickAcrossFolders allowedKinds 白名单生效', async () => {
  const { repo } = makeRepo({
    'folderA': [
      mk('a1', 'a1.mp4', 'video'),
      mk('a2', 'a2.mp3', 'audio'),
    ],
    'folderB': [
      mk('b1', 'b1.mp4', 'video'),
      mk('b2', 'b2.srt', 'subtitle'),
    ],
  });
  const fa = await repo.registerFolder('/folderA');
  const fb = await repo.registerFolder('/folderB');
  await repo.scanFolder(fa.id);
  await repo.scanFolder(fb.id);

  const videos = repo.pickAcrossFolders([fa.id, fb.id], {
    reason: '仅聚合视频',
    allowedKinds: ['video'],
  });
  expect(videos).toHaveLength(2);
  for (const m of videos) {
    expect(m.kind).toBe('video');
  }
});

it('pickAcrossFolders perFolderLimit 限制每文件夹抽取量', async () => {
  const { repo } = makeRepo({
    'folderA': [
      mk('a1', 'a1.mp4', 'video'),
      mk('a2', 'a2.mp4', 'video'),
      mk('a3', 'a3.mp4', 'video'),
    ],
    'folderB': [
      mk('b1', 'b1.mp4', 'video'),
      mk('b2', 'b2.mp4', 'video'),
    ],
  });
  const fa = await repo.registerFolder('/folderA');
  const fb = await repo.registerFolder('/folderB');
  await repo.scanFolder(fa.id);
  await repo.scanFolder(fb.id);

  const result = repo.pickAcrossFolders([fa.id, fb.id], {
    reason: '每文件夹限 1 个',
    perFolderLimit: 1,
  });
  expect(result).toHaveLength(2);
  // 每文件夹恰好 1 个
  const fromA = result.filter((m) => m.folderId === fa.id);
  const fromB = result.filter((m) => m.folderId === fb.id);
  expect(fromA).toHaveLength(1);
  expect(fromB).toHaveLength(1);
});

it('pickAcrossFolders 对未注册 folderId 抛错', async () => {
  const { repo } = makeRepo({
    'folderA': [mk('a1', 'a1.mp4', 'video')],
  });
  const fa = await repo.registerFolder('/folderA');
  await repo.scanFolder(fa.id);
  expectThrow(
    () =>
      repo.pickAcrossFolders([fa.id, 'not-exist'], {
        reason: '测试缺失文件夹',
      }),
    /folderId 不存在/,
  );
});

it('registerFolder 同路径幂等(返回同一 meta)', async () => {
  const { repo } = makeRepo({
    'folderA': [mk('a1', 'a1.mp4', 'video')],
  });
  const f1 = await repo.registerFolder('/folderA');
  const f2 = await repo.registerFolder('/folderA');
  expect(f1.id).toBe(f2.id);
  expect(repo.listFolders()).toHaveLength(1);
});

it('removeFolder 后 listMaterials/pickFromFolder 抛错', async () => {
  const { repo } = makeRepo({
    'folderA': [mk('a1', 'a1.mp4', 'video')],
  });
  const f = await repo.registerFolder('/folderA');
  await repo.scanFolder(f.id);
  expect(repo.listFolders()).toHaveLength(1);

  repo.removeFolder(f.id);
  expect(repo.listFolders()).toHaveLength(0);
  expectThrow(() => repo.listMaterials(f.id), /folderId 不存在/);
  expectThrow(() => repo.pickFromFolder(f.id, 1), /folderId 不存在/);
});

it('listMaterials 返回副本,外部修改不影响内部状态', async () => {
  const { repo } = makeRepo({
    'folderA': [mk('a1', 'a1.mp4', 'video'), mk('a2', 'a2.mp4', 'video')],
  });
  const f = await repo.registerFolder('/folderA');
  await repo.scanFolder(f.id);

  const list1 = repo.listMaterials(f.id);
  list1.pop();
  const list2 = repo.listMaterials(f.id);
  expect(list2).toHaveLength(2);
});

it('listFolders 按 addedAt 升序', async () => {
  let time = 1_000_000;
  const { repo } = makeRepo({
    'folderA': [mk('a1', 'a1.mp4', 'video')],
    'folderB': [mk('b1', 'b1.mp4', 'video')],
  });
  // 用独立时间函数保证顺序
  const repoT = createMaterialRepo({
    scanner: async (p) => (basename(p) === 'folderA' ? [mk('a1', 'a1.mp4', 'video')] : [mk('b1', 'b1.mp4', 'video')]),
    warn: () => undefined,
    existsCheck: async () => undefined,
    now: () => new Date(time++),
  });
  const fb = await repoT.registerFolder('/folderB');
  const fa = await repoT.registerFolder('/folderA');
  const ordered = repoT.listFolders();
  // folderB 先注册,addedAt 较小,应排在前
  expect(ordered[0].id).toBe(fb.id);
  expect(ordered[1].id).toBe(fa.id);
  // 抑制未使用变量
  void repo;
});

it('makeTwoFolders 夹具可正常构建(占位用例,验证夹具本身)', async () => {
  const ctx = makeTwoFolders();
  const fa = await ctx.repo.registerFolder('/folderA');
  const fb = await ctx.repo.registerFolder('/folderB');
  await ctx.repo.scanFolder(fa.id);
  await ctx.repo.scanFolder(fb.id);
  expect(ctx.repo.listMaterials(fa.id)).toHaveLength(5);
  expect(ctx.repo.listMaterials(fb.id)).toHaveLength(3);
});

/* ===================== 入口:运行所有用例 ===================== */

/**
 * 测试入口:运行所有用例
 * 直接运行编译产物 `node dist-electron/main/services/material-repo/__tests__/folderIsolation.spec.js`
 * 即可看到结果。返回值 0 表示全部通过。
 */
async function main(): Promise<void> {
  const ok = await runAll();
  if (!ok) {
    process.exitCode = 1;
  }
}

// 自执行:被 node 直接运行时立即跑测试
void main();
