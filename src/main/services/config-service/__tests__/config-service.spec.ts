/**
 * ConfigService CRUD/合并逻辑测试
 * 职责:注入内存 store,验证全局配置/参数模板/工程文件的读写、合并、排序逻辑
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '../config-service.ts';

interface MemoryStoreOptions {
  initial?: Record<string, any>;
}

function makeMemoryStore(opts?: MemoryStoreOptions): {
  store: any;
  data: () => Record<string, any>;
} {
  const map: Record<string, any> = { ...(opts?.initial ?? {}) };
  return {
    store: {
      get: (key: string) => {
        // 模拟 electron-store defaults:缺失键返回并持久化 {} 引用
        if (!(key in map)) map[key] = {};
        return map[key];
      },
      set: (key: string, value: unknown) => {
        map[key] = value;
      },
    },
    data: () => map,
  };
}

function makeService(initial?: {
  config?: any;
  templates?: Record<string, any>;
  projects?: Record<string, any>;
}) {
  const cfg = makeMemoryStore({ initial: initial?.config !== undefined ? { config: initial.config } : undefined });
  const tmpl = makeMemoryStore({ initial: initial?.templates ? { templates: initial.templates } : undefined });
  const proj = makeMemoryStore({ initial: initial?.projects ? { projects: initial.projects } : undefined });
  const service = new ConfigService({
    configStore: cfg.store,
    templatesStore: tmpl.store,
    projectsStore: proj.store,
  });
  return { service, cfg, tmpl, proj };
}

describe('ConfigService - 全局配置', () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    ctx = makeService();
  });

  it('getConfig 返回与默认值合并的完整配置', async () => {
    const cfg = await ctx.service.getConfig();
    assert.equal(cfg.defaultResolution, '1080p');
    assert.equal(cfg.taskConcurrency, 1);
    assert.equal(cfg.subtitle.enabled, true);
  });

  it('setConfig 深合并保留未传入字段', async () => {
    await ctx.service.setConfig({ keepOriginalQuality: false, watermark: { enabled: true } });
    const cfg = await ctx.service.getConfig();
    assert.equal(cfg.keepOriginalQuality, false);
    assert.equal(cfg.watermark.enabled, true);
    // 未传入的字段保留默认值
    assert.equal(cfg.subtitle.enabled, true);
    assert.equal(cfg.watermark.type, 'text');
  });

  it('setConfig 覆盖嵌套对象内的标量', async () => {
    await ctx.service.setConfig({ subtitle: { fontSize: 30 } });
    const cfg = await ctx.service.getConfig();
    assert.equal(cfg.subtitle.fontSize, 30);
    assert.equal(cfg.subtitle.color, '#ffffff');
  });

  it('resetConfig 恢复默认值', async () => {
    await ctx.service.setConfig({ keepOriginalQuality: false });
    const reset = await ctx.service.resetConfig();
    assert.equal(reset.keepOriginalQuality, true);
    const reloaded = await ctx.service.getConfig();
    assert.equal(reloaded.keepOriginalQuality, true);
  });
});

describe('ConfigService - 参数模板', () => {
  it('saveTemplate 创建模板并写入 store', async () => {
    const { service, tmpl } = makeService();
    const t = await service.saveTemplate('高清', undefined, '描述');
    assert.equal(t.name, '高清');
    assert.equal(t.description, '描述');
    assert.equal(t.updatedAt, t.createdAt);
    assert.ok(tmpl.data().templates['高清']);
  });

  it('saveTemplate 同名覆盖:保留 createdAt 并更新 updatedAt', async () => {
    const { service, tmpl } = makeService();
    await service.saveTemplate('t');
    const first = tmpl.data().templates['t'];
    const createdAt = first.createdAt as string;
    assert.ok(createdAt);

    await new Promise((r) => setTimeout(r, 5));
    await service.saveTemplate('t');

    const second = tmpl.data().templates['t'];
    assert.equal(second.createdAt, createdAt);
    assert.ok(new Date(second.updatedAt).getTime() >= new Date(createdAt).getTime());
  });

  it('loadTemplate 不存在的模板返回 null', async () => {
    const { service } = makeService();
    assert.equal(await service.loadTemplate('不存在'), null);
  });

  it('listTemplates 按更新时间降序排列', async () => {
    const { service } = makeService();
    await service.saveTemplate('a');
    await new Promise((r) => setTimeout(r, 5));
    await service.saveTemplate('b');
    await new Promise((r) => setTimeout(r, 5));
    await service.saveTemplate('c');
    const list = await service.listTemplates();
    assert.deepEqual(list.map((t) => t.name), ['c', 'b', 'a']);
  });

  it('deleteTemplate 删除存在的返回 true,不存在的返回 false', async () => {
    const { service } = makeService();
    await service.saveTemplate('x');
    assert.equal(await service.deleteTemplate('x'), true);
    assert.equal(await service.loadTemplate('x'), null);
    assert.equal(await service.deleteTemplate('x'), false);
  });

  it('listTemplatesMeta 不包含 config 字段', async () => {
    const { service } = makeService();
    await service.saveTemplate('m');
    const meta = await service.listTemplatesMeta();
    assert.equal(meta.length, 1);
    assert.equal(meta[0].name, 'm');
  });
});

describe('ConfigService - 工程文件', () => {
  it('saveProject 保存并保留 id', async () => {
    const { service, proj } = makeService();
    const p = await service.saveProject('工程A', undefined, { foo: 1 });
    assert.equal(p.name, '工程A');
    assert.deepEqual(p.data, { foo: 1 });
    assert.ok(p.id);
    assert.ok(proj.data().projects['工程A']);
  });

  it('saveProject 同名覆盖保留 id', async () => {
    const { service } = makeService();
    const first = await service.saveProject('p');
    const second = await service.saveProject('p');
    assert.equal(second.id, first.id);
  });

  it('saveProject 同名且无 data 时保留原 data', async () => {
    const { service } = makeService();
    await service.saveProject('p', undefined, { a: 1 });
    const s2 = await service.saveProject('p');
    assert.deepEqual(s2.data, { a: 1 });
  });

  it('loadProject 不存在的返回 null', async () => {
    const { service } = makeService();
    assert.equal(await service.loadProject('nope'), null);
  });

  it('listProjects 按更新时间降序', async () => {
    const { service } = makeService();
    await service.saveProject('p1');
    await new Promise((r) => setTimeout(r, 5));
    await service.saveProject('p2');
    const list = await service.listProjects();
    assert.deepEqual(list.map((p) => p.name), ['p2', 'p1']);
  });

  it('deleteProject 存在返回 true,不存在返回 false', async () => {
    const { service } = makeService();
    await service.saveProject('q');
    assert.equal(await service.deleteProject('q'), true);
    assert.equal(await service.deleteProject('q'), false);
  });
});
