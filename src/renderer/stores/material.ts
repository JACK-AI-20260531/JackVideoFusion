/**
 * 素材状态仓库
 * 职责:维护已注册的素材文件夹、素材列表、文件夹隔离作用域
 *       通过 IPC(material:*)与主进程素材仓库同步
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';

// IPC 响应结构
interface IpcResp<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// window.api 的最小类型声明
interface WindowApi {
  invoke: <TReq, TResp>(channel: string, payload?: TReq) => Promise<IpcResp<TResp>>;
}

/**
 * 从 window 安全获取 api
 * @returns window.api 实例
 */
function getApi(): WindowApi {
  return (window as unknown as { api: WindowApi }).api;
}

// 文件夹元信息
export interface FolderMeta {
  id: string;
  path: string;
  name: string;
  materialCount: number;
  addedAt: string;
}

// 素材元信息(简化版,与 shared/types.ts MaterialMeta 对齐)
export interface MaterialMeta {
  id: string;
  folderId: string;
  path: string;
  name: string;
  kind: 'video' | 'audio' | 'text' | 'subtitle';
  durationSec?: number;
  sizeBytes?: number;
  createdAt: string;
}

export const useMaterialStore = defineStore('material', () => {
  // 已注册的文件夹列表(顺序敏感,混剪按此顺序执行)
  const folders = ref<FolderMeta[]>([]);
  // 当前选中文件夹 ID
  const activeFolderId = ref<string | null>(null);
  // 各文件夹的素材列表缓存:folderId → MaterialMeta[]
  const materialsByFolder = ref<Record<string, MaterialMeta[]>>({});

  /**
   * 从主进程加载已注册文件夹列表
   * 调用 material:listFolders IPC,替换本地 folders
   */
  async function loadFolders(): Promise<void> {
    const res = await getApi().invoke<unknown, FolderMeta[]>('material:listFolders');
    if (res.ok && res.data) {
      folders.value = res.data;
    }
  }

  /**
   * 添加文件夹:调用 dialog 选择目录 → material:registerFolder → material:scanFolder
   * @param folderPath 文件夹绝对路径
   * @returns 注册后的 FolderMeta,失败返回 null
   */
  async function registerFolder(folderPath: string): Promise<FolderMeta | null> {
    const res = await getApi().invoke<{ path: string }, FolderMeta>(
      'material:addFolder',
      { path: folderPath },
    );
    if (res.ok && res.data) {
      folders.value.push(res.data);
      return res.data;
    }
    return null;
  }

  /**
   * 扫描指定文件夹素材,更新 materialsByFolder 缓存
   * @param folderId 文件夹 ID
   * @returns 扫描到的素材列表
   */
  async function scanFolder(folderId: string): Promise<MaterialMeta[]> {
    const res = await getApi().invoke<{ folderId: string }, MaterialMeta[]>(
      'material:scanFolder',
      { folderId },
    );
    if (res.ok && res.data) {
      materialsByFolder.value[folderId] = res.data;
      // 同步更新 folder.materialCount
      const folder = folders.value.find((f) => f.id === folderId);
      if (folder) folder.materialCount = res.data.length;
      return res.data;
    }
    return [];
  }

  /**
   * 移除文件夹(同时清理其下素材引用)
   * @param id 文件夹 ID
   */
  async function removeFolder(id: string): Promise<void> {
    await getApi().invoke<{ folderId: string }, { removed: string }>(
      'material:removeFolder',
      { folderId: id },
    );
    folders.value = folders.value.filter((f) => f.id !== id);
    delete materialsByFolder.value[id];
    if (activeFolderId.value === id) activeFolderId.value = null;
  }

  /**
   * 设置当前选中文件夹
   * @param id 文件夹 ID
   */
  function setActive(id: string | null): void {
    activeFolderId.value = id;
  }

  /**
   * 重排序(用于调整混剪优先级)
   * @param from 起始位置
   * @param to 目标位置
   */
  function reorder(from: number, to: number): void {
    const [moved] = folders.value.splice(from, 1);
    folders.value.splice(to, 0, moved);
  }

  /**
   * 获取指定文件夹的素材列表(从缓存读取)
   * @param folderId 文件夹 ID
   * @returns 素材列表(缓存未命中时返回空数组)
   */
  function getMaterials(folderId: string): MaterialMeta[] {
    return materialsByFolder.value[folderId] ?? [];
  }

  return {
    folders,
    activeFolderId,
    materialsByFolder,
    loadFolders,
    registerFolder,
    scanFolder,
    removeFolder,
    setActive,
    reorder,
    getMaterials,
  };
});
