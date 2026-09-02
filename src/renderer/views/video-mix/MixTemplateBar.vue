<script setup lang="ts">
/**
 * 混剪参数模板条(PRD-v2.1 FR-1)
 * 职责:模板下拉选择 + 套用 + 存为模板 + 删除
 * props.buildParams 由宿主提供(从表单组装快照);套用时 emit('apply') 由宿主写回表单
 */
import { ref, onMounted } from 'vue';
import { useMixTemplates } from './useMixTemplates';
import type { MixParams } from './useMixActions';

const props = defineProps<{ buildParams: () => MixParams }>();
const emit = defineEmits<{
  (e: 'apply', params: MixParams): void;
}>();

const { templates, refresh, save, load, remove } = useMixTemplates();
const selectedName = ref('');
const newName = ref('');
const message = ref('');
const messageType = ref<'ok' | 'err'>('ok');

onMounted(() => {
  void refresh();
});

/** 套用选中模板:取快照交给宿主写回表单 */
async function handleApply(): Promise<void> {
  if (!selectedName.value) return;
  const params = await load(selectedName.value);
  if (params) emit('apply', params);
}

/** 存为模板:宿主从当前表单组装快照 */
async function handleSave(): Promise<void> {
  const name = newName.value.trim();
  if (!name) {
    message.value = '请填写模板名称';
    messageType.value = 'err';
    return;
  }
  const snapshot = props.buildParams();
  const err = await save(name, snapshot);
  message.value = err ? `保存失败:${err}` : `已保存模板「${name}」`;
  messageType.value = err ? 'err' : 'ok';
  newName.value = '';
  if (!err) selectedName.value = name;
}

/** 删除选中模板 */
async function handleDelete(): Promise<void> {
  if (!selectedName.value) return;
  await remove(selectedName.value);
  selectedName.value = '';
  message.value = '已删除';
  messageType.value = 'ok';
}
</script>

<template>
  <div class="tpl-bar">
    <span class="tpl-label">参数模板</span>
    <select v-model="selectedName" :disabled="!templates.length">
      <option value="" disabled>选择模板…</option>
      <option v-for="t in templates" :key="t.id" :value="t.name">{{ t.name }}</option>
    </select>
    <button class="btn" :disabled="!selectedName" @click="handleApply">套用</button>
    <button class="btn danger" :disabled="!selectedName" @click="handleDelete">删除</button>
    <input v-model="newName" placeholder="新模板名称" class="tpl-name" />
    <button class="btn primary" @click="handleSave">存为模板</button>
    <span v-if="message" :class="['msg', messageType]">{{ message }}</span>
  </div>
</template>

<style scoped>
.tpl-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.tpl-label { font-size: 13px; color: #666; }
.tpl-name { width: 160px; }
.msg.ok { color: #2e9e5b; font-size: 13px; }
.msg.err { color: #d9534f; font-size: 13px; }
.btn.danger { color: #d9534f; }
</style>
