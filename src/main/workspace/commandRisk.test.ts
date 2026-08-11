import { describe, expect, it } from 'vitest'
import { assessCommandRisk, shellQuote, stripCommandChaining } from './commandRisk'

describe('assessCommandRisk', () => {
  it.each([
    ['rm -rf /var/www', 'critical', '命令包含递归强制删除'],
    ['mkfs.ext4 /dev/sdb1', 'critical', '命令可能格式化磁盘'],
    ['dd if=/dev/zero of=/dev/sda bs=1M', 'critical', '命令可能直接覆盖磁盘或分区'],
    ['shutdown -h now', 'high', '命令会关闭远端机器'],
    ['reboot', 'high', '命令会重启远端机器'],
    ['poweroff', 'high', '命令会关闭远端机器'],
    ['halt', 'high', '命令会停止远端机器'],
    [':(){ :|:& };:', 'critical', '命令包含 fork bomb'],
    ['chmod -R 777 /', 'critical', '命令会递归修改根目录权限'],
    ['chown -R www-data /var/www', 'high', '命令会递归更改所有者'],
    ['userdel deploy', 'high', '命令会删除系统用户'],
    ['groupdel staff', 'high', '命令会删除系统组']
  ])('blocks %s', (command, riskLevel, reason) => {
    const risk = assessCommandRisk(command)
    expect(risk.requiresConfirmation).toBe(true)
    expect(risk.riskLevel).toBe(riskLevel)
    expect(risk.reason).toBe(reason)
  })

  it('matches case-insensitively', () => {
    const risk = assessCommandRisk('RM -RF /srv')
    expect(risk.requiresConfirmation).toBe(true)
    expect(risk.reason).toBe('命令包含递归强制删除')
  })

  it('requires confirmation for sudo commands', () => {
    const leading = assessCommandRisk('sudo systemctl restart nginx')
    expect(leading.requiresConfirmation).toBe(true)
    expect(leading.riskLevel).toBe('medium')
    expect(leading.reason).toBe('命令将以 sudo 提权执行')

    const embedded = assessCommandRisk('echo start && sudo whoami')
    expect(embedded.requiresConfirmation).toBe(true)
    expect(embedded.riskLevel).toBe('medium')
  })

  it('matches dangerous patterns before the sudo check', () => {
    const risk = assessCommandRisk('sudo rm -rf /')
    expect(risk.riskLevel).toBe('critical')
    expect(risk.reason).toBe('命令包含递归强制删除')
  })

  it('detects danger hidden behind a cd prefix', () => {
    const risk = assessCommandRisk("cd '/srv/app' && rm -rf /")
    expect(risk.requiresConfirmation).toBe(true)
    expect(risk.reason).toBe('命令包含递归强制删除')
  })

  it.each(['ls -la', 'git status', 'npm run build'])('allows %s', (command) => {
    const risk = assessCommandRisk(command)
    expect(risk.requiresConfirmation).toBe(false)
    expect(risk.riskLevel).toBe('low')
    expect(risk.reason).toBe('')
  })
})

describe('shellQuote', () => {
  it('wraps plain strings in single quotes', () => {
    expect(shellQuote('/srv/app')).toBe("'/srv/app'")
  })

  it('escapes embedded single quotes', () => {
    expect(shellQuote("it's here")).toBe("'it'\\''s here'")
  })

  it('keeps $() and backticks inert inside single quotes', () => {
    expect(shellQuote('$(whoami)')).toBe("'$(whoami)'")
    expect(shellQuote('`id`')).toBe("'`id`'")
  })
})

describe('stripCommandChaining', () => {
  it('removes a quoted cd prefix', () => {
    expect(stripCommandChaining("cd '/srv/app' && npm run build")).toBe('npm run build')
    expect(stripCommandChaining('cd "/srv/app" && ls -la')).toBe('ls -la')
  })

  it('trims surrounding whitespace', () => {
    expect(stripCommandChaining('  git status  ')).toBe('git status')
  })

  it('removes only the first quoted cd prefix', () => {
    expect(stripCommandChaining("cd '/a' && cd '/b' && ls")).toBe("cd '/b' && ls")
  })

  it('leaves unquoted cd prefixes and other chaining untouched', () => {
    expect(stripCommandChaining('cd /tmp && ls')).toBe('cd /tmp && ls')
    expect(stripCommandChaining('ls && whoami')).toBe('ls && whoami')
  })
})
