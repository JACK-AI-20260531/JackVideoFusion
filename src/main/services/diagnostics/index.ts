/**
 * 诊断包服务统一入口
 * 职责:导出诊断包(系统信息 + 脱敏配置 + 最近日志),供 IPC 层引用
 */
export { sanitizeConfig, buildSystemInfo, exportDiagnostics, DIAG_LOG_FILE_LIMIT } from './diagnostics';
export type { DiagnosticsDeps } from './diagnostics';
