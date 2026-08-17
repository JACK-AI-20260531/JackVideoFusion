/**
 * Less 模块的 ambient 类型声明
 * 职责:让 TypeScript 识别 .less 文件的 side-effect import
 *
 * 背景:Vite 在运行时会处理 .less 文件注入 CSS,但 TypeScript 本身
 *       不认识 .less 扩展名,需要 ambient 声明告诉它"这是有副作用的模块"。
 *
 * 适用范围:所有 `import 'xxx.less'` 形式的导入
 */
declare module '*.less';
