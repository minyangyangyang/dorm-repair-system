export function validateAccount(account) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{2,31}$/.test(account.username.trim())) return '用户名须为 3–32 位字母、数字、下划线、点或短横线，首位为字母或数字'
  if (account.password.length < 12 || account.password.length > 128 || !account.password.trim()) return '密码须为 12–128 个字符，不能全为空白'
  if (!account.display_name.trim() || account.display_name.trim().length > 50 || /[\u0000-\u001f\u007f]/.test(account.display_name)) return '显示名称须为 1–50 个字符，且不含控制字符'
  return ''
}
