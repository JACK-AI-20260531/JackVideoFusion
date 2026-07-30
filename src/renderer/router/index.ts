/**
 * 路由配置
 * 职责:注册 7 个功能模块路由,默认重定向到素材处理
 */
import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';

// 路由表:每个模块独立 chunk,提升首屏速度
const routes: RouteRecordRaw[] = [
  {
    path: '/',
    redirect: '/material-process',
  },
  {
    path: '/material-process',
    name: 'material-process',
    component: () => import('../views/MaterialProcessView.vue'),
    meta: { title: '素材处理', icon: 'material' },
  },
  {
    path: '/video-mix',
    name: 'video-mix',
    component: () => import('../views/VideoMixView.vue'),
    meta: { title: '视频混剪', icon: 'mix' },
  },
  {
    path: '/ai-edit',
    name: 'ai-edit',
    component: () => import('../views/AIEditView.vue'),
    meta: { title: 'AI剪辑', icon: 'ai' },
  },
  {
    path: '/ai-slice',
    name: 'ai-slice',
    component: () => import('../views/AISliceView.vue'),
    meta: { title: 'AI切片剪辑', icon: 'slice' },
  },
  {
    path: '/film-dub-clone',
    name: 'film-dub-clone',
    component: () => import('../views/FilmDubCloneView.vue'),
    meta: { title: '影视解说克隆', icon: 'clone' },
  },
  {
    path: '/auto-publish',
    name: 'auto-publish',
    component: () => import('../views/AutoPublishView.vue'),
    meta: { title: '自动发布', icon: 'publish' },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('../views/SettingsView.vue'),
    meta: { title: '系统设置', icon: 'settings' },
  },
];

// 哈希路由(Electron 文件协议兼容)
export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
