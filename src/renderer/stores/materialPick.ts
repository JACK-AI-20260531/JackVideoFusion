/**
 * 素材选中仓库(跨页传递,PRD-v2.2 FR-6)
 * 职责:热点选题页「语义推荐素材」→ 视频混剪页「素材清单模式」的跨路由传参
 * 设计要点:仅存显式素材路径列表;一次性消费方(随机混剪页)自行决定何时 clear
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';

export const useMaterialPickStore = defineStore('materialPick', () => {
  /** 显式素材路径清单(语义推荐/搜索命中带入) */
  const pickedPaths = ref<string[]>([]);

  /** 覆盖设置清单 */
  function set(paths: string[]): void {
    pickedPaths.value = [...paths];
  }

  /** 移除单条 */
  function remove(path: string): void {
    pickedPaths.value = pickedPaths.value.filter((p) => p !== path);
  }

  /** 清空(回文件夹模式) */
  function clear(): void {
    pickedPaths.value = [];
  }

  return { pickedPaths, set, remove, clear };
});
