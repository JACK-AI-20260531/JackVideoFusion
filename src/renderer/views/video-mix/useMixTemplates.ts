/**
 * 混剪参数模板 composable(PRD-v2.1 FR-1)
 * 职责:封装 mix-template:* IPC 调用,供 MixTemplateBar 与宿主 Tab 共用
 */
import { ref } from 'vue';
import type { MixParams } from './useMixActions';

/** 主进程 MixTemplate 元数据(与 main/services/mix-template/types.ts 对齐) */
export interface MixTemplateMeta {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
}

interface IpcResp<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

interface WindowApi {
  invoke: <TReq, TResp>(channel: string, payload?: TReq) => Promise<IpcResp<TResp>>;
}

function getApi(): WindowApi {
  return (window as unknown as { api: WindowApi }).api;
}

/** 模板列表 + 增删查 */
export function useMixTemplates() {
  const templates = ref<MixTemplateMeta[]>([]);
  const loading = ref(false);

  /** 刷新元数据列表 */
  async function refresh(): Promise<void> {
    const res = await getApi().invoke<undefined, MixTemplateMeta[]>('mix-template:list');
    if (res.ok && res.data) templates.value = res.data;
  }

  /** 保存模板;失败返回错误信息,成功返回 null */
  async function save(
    name: string,
    params: MixParams,
    description?: string,
  ): Promise<string | null> {
    const res = await getApi().invoke<
      { name: string; params: MixParams; description?: string },
      MixTemplateMeta
    >('mix-template:save', JSON.parse(JSON.stringify({ name, params, description })));
    if (!res.ok) return res.error ?? '保存失败';
    await refresh();
    return null;
  }

  /** 按名称取完整参数快照 */
  async function load(name: string): Promise<MixParams | null> {
    const res = await getApi().invoke<{ name: string }, { params: MixParams }>(
      'mix-template:load',
      { name },
    );
    if (!res.ok || !res.data) return null;
    return JSON.parse(JSON.stringify(res.data.params)) as MixParams;
  }

  /** 删除模板 */
  async function remove(name: string): Promise<void> {
    await getApi().invoke<{ name: string }, boolean>('mix-template:delete', { name });
    await refresh();
  }

  return { templates, loading, refresh, save, load, remove };
}
