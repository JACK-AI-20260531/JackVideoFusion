/**
 * CLIP 服务工厂
 *
 * 职责:根据运行时环境可用性,选择真实 ONNX 引擎或降级 Mock 引擎。
 *
 * 选择策略:
 *   1. 动态 import('onnxruntime-node'),失败 → Mock
 *   2. 调用 createOnnxEngine 检查模块结构 + 模型文件,任一不满足 → Mock
 *   3. 全部通过 → 返回 OnnxClipEngine 实例
 *
 * 关键约束:onnxruntime-node 是 native binding,安装/加载失败不能让构建或运行时崩溃。
 */
import { logger } from '../../utils/logger';
import { MockClipEngine } from './mock-engine';
import { createOnnxEngine } from './onnx-engine';
import { ensureClipModel } from './model-downloader';
import type { IClipService } from './types';

/**
 * 引擎解析外部依赖(可注入以便确定性单测,绕过网络与 native 加载)
 */
export interface ClipEngineResolverDeps {
  /** 动态加载 onnxruntime-node(默认 import('onnxruntime-node')) */
  loadOnnx?: () => Promise<unknown>;
  /** 构造 ONNX 引擎(默认 createOnnxEngine) */
  createEngine?: (onnxModule: unknown) => Promise<IClipService | null>;
}

/**
 * 解析 CLIP 引擎:ONNX 可用则返回真实引擎,否则降级 Mock(纯决策逻辑)
 * @param deps 可选依赖注入
 * @returns IClipService 实例(真实或 Mock)
 */
export async function resolveClipEngine(deps: ClipEngineResolverDeps = {}): Promise<IClipService> {
  const loadOnnx = deps.loadOnnx ?? (() => import('onnxruntime-node'));
  const createEngine = deps.createEngine ?? ((m) => createOnnxEngine(m));

  // 1) 尝试动态加载 onnxruntime-node(native binding,可能失败)
  try {
    const onnxModule = await loadOnnx();
    // 2) 尝试构造 ONNX 引擎(内部还会校验模型文件存在)
    const engine = await createEngine(onnxModule);
    if (engine) {
      logger.info('[CLIP] 已启用真实 ONNX 推理引擎');
      return engine;
    }
    logger.warn('[CLIP] ONNX 引擎不可用(模块结构异常或模型缺失),降级到 Mock 引擎');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[CLIP] onnxruntime-node 不可用,降级到 Mock 引擎: ${msg}`);
  }

  // 3) 降级路径:返回 Mock 引擎
  return new MockClipEngine();
}

/**
 * 创建 CLIP 服务实例
 * 优先使用真实 ONNX 引擎,不可用时降级到 Mock 引擎。
 * 创建前会先确保模型已就绪(未配置直链时立即跳过,不阻塞)。
 * @returns IClipService 实例(真实或 Mock)
 */
export async function createClipService(): Promise<IClipService> {
  // 0) 确保模型权重已就绪(无下载源时快速返回,不阻塞启动)
  await ensureClipModel();

  // 1~3) 解析引擎(ONNX 或 Mock)
  return resolveClipEngine();
}
