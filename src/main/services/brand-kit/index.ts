/**
 * 品牌套件服务统一入口
 * 职责:导出 BrandStore 单例与滤镜链纯函数,供 IPC 层与混剪管线引用
 */
export {
  brandStore,
  BrandStore,
  buildBrandFilter,
  hasBrandVisuals,
} from './brand-kit';
export type { BrandKitConfig, BrandStoreDeps } from './brand-kit';
