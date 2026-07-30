/**
 * 渲染层入口
 * 职责:挂载 Vue 应用、注册 Pinia 与路由
 */
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { router } from './router';
import './styles/global.less';

// 创建 Vue 应用并挂载插件
const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount('#app');
