import { app } from 'electron'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Trust-on-first-use store for SSH server host keys.
 *
 * Both engines (`ssh2` and the Rust `russh` core) verify against this single
 * file so a server can never present one identity to one engine and a different
 * one to the other. Fingerprints use the OpenSSH `SHA256:<base64>` format, so
 * they can be compared by eye with `ssh-keygen -lf`.
 */

export type HostKeyVerdict =
  | { status: 'trusted' }
  | { status: 'new' }
  | { status: 'mismatch'; expected: string }

interface KnownHostRecord {
  fingerprint: string
  firstSeen: number
  lastSeen: number
}

/** Retrying never resolves this, so callers must stop rather than loop. */
export class HostKeyMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostKeyMismatchError'
  }
}

/** OpenSSH-style SHA256 fingerprint of a raw SSH public key blob. */
export function fingerprintHostKey(key: Buffer): string {
  const digest = crypto.createHash('sha256').update(key).digest('base64')
  return `SHA256:${digest.replace(/=+$/, '')}`
}

function hostId(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`
}

/** Shared by both engines so the warning reads identically either way. */
export function hostKeyMismatchMessage(
  host: string,
  port: number,
  expected: string,
  actual: string
): string {
  return (
    `主机密钥已变更，连接已中断（可能存在中间人攻击）。\n` +
    `服务器：${hostId(host, port)}\n` +
    `已记录：${expected}\n` +
    `本次收到：${actual}\n` +
    `若确认服务器已重装或更换密钥，请移除该主机的密钥记录后重连。`
  )
}

class KnownHostsStore {
  private records: Record<string, KnownHostRecord> | null = null
  private filePath: string | null = null

  private getFilePath(): string {
    if (!this.filePath) {
      this.filePath = path.join(app.getPath('userData'), 'known_hosts.json')
    }
    return this.filePath
  }

  private load(): Record<string, KnownHostRecord> {
    if (this.records) return this.records

    let records: Record<string, KnownHostRecord> = {}
    try {
      const parsed = JSON.parse(fs.readFileSync(this.getFilePath(), 'utf8'))
      if (parsed && typeof parsed === 'object') records = parsed
    } catch {
      // Missing or corrupt file: start empty rather than failing every
      // connection. A corrupt file degrades to trust-on-first-use.
    }
    this.records = records
    return records
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.getFilePath(), JSON.stringify(this.records ?? {}, null, 2), 'utf8')
    } catch (error) {
      console.error('[known-hosts] failed to persist', error)
    }
  }

  /** Fingerprint previously accepted for this host, if any. */
  getExpected(host: string, port: number): string | null {
    return this.load()[hostId(host, port)]?.fingerprint ?? null
  }

  verify(host: string, port: number, fingerprint: string): HostKeyVerdict {
    const existing = this.load()[hostId(host, port)]
    if (!existing) return { status: 'new' }
    if (existing.fingerprint === fingerprint) return { status: 'trusted' }
    return { status: 'mismatch', expected: existing.fingerprint }
  }

  /** Record a fingerprint as trusted (first contact, or after an explicit reset). */
  trust(host: string, port: number, fingerprint: string): void {
    const records = this.load()
    const id = hostId(host, port)
    const now = Date.now()
    records[id] = {
      fingerprint,
      firstSeen: records[id]?.firstSeen ?? now,
      lastSeen: now
    }
    this.persist()
  }

  private touch(host: string, port: number): void {
    const records = this.load()
    const record = records[hostId(host, port)]
    if (!record) return
    record.lastSeen = Date.now()
    this.persist()
  }

  /** Drop a host so the next connection re-trusts whatever key it presents. */
  forget(host: string, port: number): void {
    const records = this.load()
    delete records[hostId(host, port)]
    this.persist()
  }

  list(): Array<{ id: string; host: string; port: number; fingerprint: string; lastSeen: number }> {
    return Object.entries(this.load()).map(([id, record]) => {
      const match = /^\[(.+)\]:(\d+)$/.exec(id)
      return {
        id,
        host: match ? match[1] : id,
        port: match ? Number(match[2]) : 22,
        fingerprint: record.fingerprint,
        lastSeen: record.lastSeen
      }
    })
  }

  /**
   * Apply the trust-on-first-use policy. Returns normally when the key is
   * acceptable and throws with an actionable message when it changed.
   */
  check(host: string, port: number, fingerprint: string): void {
    const verdict = this.verify(host, port, fingerprint)

    if (verdict.status === 'new') {
      this.trust(host, port, fingerprint)
      return
    }

    if (verdict.status === 'trusted') {
      this.touch(host, port)
      return
    }

    throw new HostKeyMismatchError(
      hostKeyMismatchMessage(host, port, verdict.expected, fingerprint)
    )
  }
}

export const knownHosts = new KnownHostsStore()
