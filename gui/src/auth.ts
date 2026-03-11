/**
 * 动态获取 auth token（每次调用从 localStorage 读取）
 * 修复 #37：模块顶层静态读取导致登录后 token 仍为空
 */
export function getAuthToken(): string {
  return localStorage.getItem('boluo_auth_token') || ''
}

/** Authorization header 便捷函数 */
export function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${getAuthToken()}` }
}
