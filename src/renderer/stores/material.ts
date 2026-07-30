/**
 * 素材状态仓库
 * 职责:维护已注册的素材文件夹、素材列表、文件夹隔离作用域
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';

// 文件夹元信息
export interface FolderMeta {
  id: string;
  path: string;
  name: string;
  materialCount: number;
  addedAt: string;
}

export const useMaterialStore = defineStore('material', () => {
  // 已注册的文件夹列表(顺序敏感,混剪按此顺序执行)
  const folders = ref<FolderMeta[]>([]);
  // 当前选中文件夹 ID
  const activeFolderId = ref<string | null>(null);

  // 添加文件夹
  function addFolder(folder: FolderMeta): void {
    folders.value.push(folder);
  }
  // 移除文件夹(同时清理其下素材引用)
  function removeFolder(id: string): void {
    folders.value = folders.value.filter((f) => f.id !== id);
    if (activeFolderId.value === id) activeFolderId.value = null;
  }
  // 设置当前选中文件夹
  function setActive(id: string | null): void {
    activeFolderId.value = id;
  }
  // 重排序(用于调整混剪优先级)
  function reorder(from: number, to: number): void {
    const [moved] = folders.value.splice(from, 1);
    folders.value.splice(to, 0, moved);
  }

  return { folders, activeFolderId, addFolder, removeFolder, setActive, reorder };
});
