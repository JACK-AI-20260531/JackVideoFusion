/**
 * 导出路径服务单测
 * 职责:验证 resolveExportPath 自定义目录优先逻辑与默认目录回退
 * 说明:默认目录分支依赖 app.getPath,纯 node 下回退到 cwd
 * 运行:npm run test 或 node --test --import tsx src/main/services/common/__tests__/paths.spec.ts
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveExportPath, getDefaultExportDir } from '../paths.ts';
import { join } from 'path';

describe('resolveExportPath', () => {
  it('提供自定义目录时优先使用自定义目录', () => {
    assert.equal(resolveExportPath('D:/out', 'v.mp4'), join('D:/out', 'v.mp4'));
    assert.equal(resolveExportPath('/data/exports', 'x.mp4'), join('/data/exports', 'x.mp4'));
  });

  it('自定义目录为空白时使用默认目录', () => {
    const p = resolveExportPath('', 'v.mp4');
    assert.equal(p, join(getDefaultExportDir(), 'v.mp4'));
    const p2 = resolveExportPath('   ', 'v.mp4');
    assert.equal(p2, join(getDefaultExportDir(), 'v.mp4'));
  });

  it('未传自定义目录时使用默认目录', () => {
    const p = resolveExportPath(undefined, 'v.mp4');
    assert.equal(p, join(getDefaultExportDir(), 'v.mp4'));
  });
});
