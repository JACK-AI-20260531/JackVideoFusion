# TTS Batch Manifest Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 TTS 批量合成结果区增加统一的“复制全部路径”和“导出清单 TXT”能力，并保持与现有批量结果交互风格一致。

**Architecture:** 采用一个共享的前端清单工具模块负责路径清单文本构建、剪贴板复制和 TXT 下载，`TtsBatchTab.vue` 只负责把结果数组映射为路径列表并调用这些工具。这样结果页不会再散落 Blob 下载和路径拼接逻辑，后续别的批量结果区可以复用同一套接口。UI 层只增加结果区标题栏的操作按钮，不改动结果列表的单条复制、定位和加入素材库行为。

**Tech Stack:** Vue 3 `<script setup lang="ts">`, TypeScript, 浏览器 `Blob`/`URL.createObjectURL`, 现有 `shouldCopy` 剪贴板工具, Node 内置 `node:test`。

## Global Constraints

- 保持对话语言和代码注释语言为中文。
- 只修改现有文件，除非必须创建共享工具或测试文件。
- 新增函数必须带函数级注释。
- 不引入新的第三方依赖。
- 结果区的操作按钮必须与现有按钮风格一致，避免引入新的视觉体系。
- 清单导出的 TXT 文件名必须包含业务前缀和时间戳，便于归档。

---

### Task 1: 定义批量清单导出共享工具

**Files:**
- Modify: `src/renderer/utils/export-manifest.ts`
- Test: `src/renderer/utils/__tests__/export-manifest.spec.ts`

**Interfaces:**
- Consumes: `shouldCopy(text: unknown): Promise<boolean>` from `src/renderer/utils/clipboard.ts`
- Produces:
  - `buildManifestText(paths: unknown[]): string`
  - `createManifestFilename(scope: string, timestamp?: number): string`
  - `copyManifestPaths(paths: unknown[]): Promise<boolean>`
  - `downloadManifest(paths: unknown[], filename: string): boolean`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifestText, createManifestFilename } from '../export-manifest.ts';

describe('buildManifestText', () => {
  it('按顺序构建每行一个路径的清单文本', () => {
    assert.equal(
      buildManifestText(['a.mp3', '', undefined, 'b.srt', 'a.mp3']),
      'a.mp3\nb.srt',
    );
  });
});

describe('createManifestFilename', () => {
  it('生成带前缀和时间戳的 txt 文件名', () => {
    assert.equal(createManifestFilename('tts-batch', 1787065751000), 'tts-batch-manifest-1787065751000.txt');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx src/renderer/utils/__tests__/export-manifest.spec.ts`
Expected: FAIL with module not found or missing export until `export-manifest.ts` exists or exports are补齐。

- [ ] **Step 3: Write minimal implementation**

```ts
import { shouldCopy } from './clipboard';
import { joinLines } from './join-lines';

export function buildManifestText(paths: unknown[]): string {
  return joinLines(paths);
}

export function createManifestFilename(scope: string, timestamp = Date.now()): string {
  return `${scope}-manifest-${timestamp}.txt`;
}

export async function copyManifestPaths(paths: unknown[]): Promise<boolean> {
  return shouldCopy(buildManifestText(paths));
}

export function downloadManifest(paths: unknown[], filename: string): boolean {
  const text = buildManifestText(paths);
  if (text.trim().length === 0) return false;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test --import tsx src/renderer/utils/__tests__/export-manifest.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/utils/export-manifest.ts src/renderer/utils/__tests__/export-manifest.spec.ts
git commit -m "feat: add shared manifest export helper"
```

### Task 2: 接入 TTS 批量结果区

**Files:**
- Modify: `src/renderer/views/material-process/TtsBatchTab.vue`

**Interfaces:**
- Consumes:
  - `BatchResult { index: number; audioPath: string; srtPath?: string }[]`
  - `copyManifestPaths(paths: unknown[]): Promise<boolean>`
  - `createManifestFilename(scope: string, timestamp?: number): string`
  - `downloadManifest(paths: unknown[], filename: string): boolean`
- Produces:
  - `handleCopyAllResultPaths(): Promise<void>`
  - `handleExportResultManifest(): void`

- [ ] **Step 1: Write the failing test**

```ts
// 这里不新增单独的组件测试框架；先通过现有 `node --test` 单测覆盖共享工具，
// 再在本任务里用类型检查和手动验收验证模板绑定与函数签名。
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/vue-tsc.cjs --noEmit`
Expected: FAIL until `TtsBatchTab.vue` 新增的处理函数和模板绑定补齐。

- [ ] **Step 3: Write minimal implementation**

```ts
import {
  copyManifestPaths,
  createManifestFilename,
  downloadManifest,
} from '../../utils/export-manifest';

async function handleCopyAllResultPaths(): Promise<void> {
  const paths = results.value.flatMap((item) => (item.srtPath ? [item.audioPath, item.srtPath] : [item.audioPath]));
  await copyManifestPaths(paths);
}

function handleExportResultManifest(): void {
  const paths = results.value.flatMap((item) => (item.srtPath ? [item.audioPath, item.srtPath] : [item.audioPath]));
  downloadManifest(paths, createManifestFilename('tts-batch'));
}
```

```vue
<section v-if="results.length > 0" class="result-section">
  <div class="result-section__header">
    <h3 class="result-section__title">合成结果({{ results.length }} 段)</h3>
    <div class="result-section__actions">
      <button class="btn btn--mini" @click="handleCopyAllResultPaths">复制全部路径</button>
      <button class="btn btn--mini" @click="handleExportResultManifest">导出清单</button>
    </div>
  </div>
  <div v-for="item in results" :key="item.index" class="result-item">
    ...
  </div>
</section>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/vue-tsc.cjs --noEmit`
Expected: PASS with no Vue template or TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/views/material-process/TtsBatchTab.vue
git commit -m "feat: add manifest export actions to tts batch results"
```

### Task 3: 验证回归与结果一致性

**Files:**
- Modify: none
- Test: `src/renderer/utils/__tests__/export-manifest.spec.ts`

**Interfaces:**
- Consumes: Task 1 and Task 2 outputs
- Produces: 已验证的测试与类型检查结论

- [ ] **Step 1: Run full verification**

Run:
```bash
node --test --import tsx src/renderer/utils/__tests__/export-manifest.spec.ts
node scripts/vue-tsc.cjs --noEmit
npm test
```
Expected: 全部通过。

- [ ] **Step 2: Inspect final diff**

Run: `git diff -- src/renderer/utils/export-manifest.ts src/renderer/utils/__tests__/export-manifest.spec.ts src/renderer/views/material-process/TtsBatchTab.vue`
Expected: 仅包含清单导出相关改动，没有多余重构。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/utils/export-manifest.ts src/renderer/utils/__tests__/export-manifest.spec.ts src/renderer/views/material-process/TtsBatchTab.vue
git commit -m "feat: complete tts batch manifest export flow"
```

## Self-Review

1. Spec coverage: 共享清单工具、TTS 批量结果区、验证与提交三个层次都有任务覆盖。
2. Placeholder scan: 未使用 TBD/TODO/implement later 等占位词。
3. Type consistency: `BatchResult`、`copyManifestPaths`、`downloadManifest`、`createManifestFilename` 的签名在各任务中保持一致。
4. Scope check: 当前计划只覆盖 TTS 批量结果区，不扩散到其他结果页，范围可单独实现和验收。
