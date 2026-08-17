/**
 * 渲染层入口
 * 职责:挂载 Vue 应用、注册 Pinia 与路由
 */
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import './styles/global.less';
// dev 环境注入 IPC mock(必须在 createApp 之前,确保组件挂载时 window.api 已就绪)
import { setupDevApiMock } from './utils/dev-api-mock';

// 浏览器 dev 环境注入 mock API,避免组件因 window.api 未定义而崩溃
setupDevApiMock();

// 创建 Vue 应用并挂载插件
const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount('#app');
