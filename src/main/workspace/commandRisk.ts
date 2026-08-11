export type CommandRiskLevel = 'low' | 'medium' | 'high' | 'critical'

export interface CommandRiskAssessment {
  riskLevel: CommandRiskLevel
  requiresConfirmation: boolean
  reason: string
}

const DANGEROUS_PATTERNS: ReadonlyArray<readonly [string, CommandRiskLevel, string]> = [
  ['rm -rf', 'critical', '命令包含递归强制删除'],
  ['mkfs', 'critical', '命令可能格式化磁盘'],
  ['dd if=', 'critical', '命令可能直接覆盖磁盘或分区'],
  ['shutdown', 'high', '命令会关闭远端机器'],
  ['reboot', 'high', '命令会重启远端机器'],
  ['poweroff', 'high', '命令会关闭远端机器'],
  ['halt', 'high', '命令会停止远端机器'],
  [':(){ :|:& };:', 'critical', '命令包含 fork bomb'],
  ['chmod -r 777 /', 'critical', '命令会递归修改根目录权限'],
  ['chown -r', 'high', '命令会递归更改所有者'],
  ['userdel', 'high', '命令会删除系统用户'],
  ['groupdel', 'high', '命令会删除系统组']
]

export function assessCommandRisk(command: string): CommandRiskAssessment {
  const normalized = command.toLowerCase()

  for (const [pattern, level, reason] of DANGEROUS_PATTERNS) {
    if (normalized.includes(pattern)) {
      return { riskLevel: level, requiresConfirmation: true, reason }
    }
  }

  if (normalized.includes('sudo ') || normalized.startsWith('sudo')) {
    return { riskLevel: 'medium', requiresConfirmation: true, reason: '命令将以 sudo 提权执行' }
  }

  return { riskLevel: 'low', requiresConfirmation: false, reason: '' }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function stripCommandChaining(command: string): string {
  const trimmed = command.trim()
  const cdPrefix = /^cd\s+(['"])(.*?)\1\s*&&\s*/
  return trimmed.replace(cdPrefix, '')
}
