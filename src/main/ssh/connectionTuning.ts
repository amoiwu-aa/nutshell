import { configStore } from '../store/ConfigStore'

/**
 * Centralized SSH connection tuning.
 *
 * This module is the single source of truth for every tunable that affects
 * connection stability (keepalive, reconnection, command timeouts) across both
 * the Node `ssh2` engine and the Rust (`russh`) engine. Keeping these values in
 * one place avoids the previous problem where connect/reconnect code paths each
 * hard-coded their own (and subtly different) magic numbers.
 *
 * All values can be overridden per-installation via app settings; any missing
 * setting falls back to the conservative defaults below.
 */

export interface ConnectionTuning {
  /** Interval between SSH-level keepalive probes (ms). */
  keepaliveIntervalMs: number
  /** Consecutive missed keepalive probes tolerated before the link is dead. */
  keepaliveCountMax: number
  /** Handshake timeout when establishing a connection (ms). */
  readyTimeoutMs: number
  /** Default timeout for one-off remote command execution (ms). */
  execTimeoutMs: number
  /** Whether a dropped session should be transparently reconnected. */
  autoReconnect: boolean
  /** Max reconnect attempts. `<= 0` means retry indefinitely with capped backoff. */
  maxReconnectAttempts: number
  /** Base delay for exponential reconnect backoff (ms). */
  reconnectBaseDelayMs: number
  /** Upper bound for a single reconnect backoff delay (ms). */
  reconnectMaxDelayMs: number
}

export const DEFAULT_CONNECTION_TUNING: ConnectionTuning = {
  keepaliveIntervalMs: 15_000,
  keepaliveCountMax: 6,
  readyTimeoutMs: 30_000,
  execTimeoutMs: 30_000,
  autoReconnect: true,
  // 0 => infinite retries (capped backoff). Resilient by default, like mosh/FinalShell.
  maxReconnectAttempts: 0,
  reconnectBaseDelayMs: 1_000,
  reconnectMaxDelayMs: 15_000
}

/**
 * Cipher preference list shared by both engines. AES-GCM first to benefit from
 * hardware AES-NI acceleration, then CTR/ChaCha fallbacks for older servers.
 */
export const PREFERRED_CIPHERS = [
  'aes128-gcm',
  'aes128-gcm@openssh.com',
  'aes256-gcm',
  'aes256-gcm@openssh.com',
  'aes128-ctr',
  'aes192-ctr',
  'aes256-ctr',
  'chacha20-poly1305@openssh.com'
] as const

/** SSH channel buffer size (1MB) — the ssh2 default of 32KB starves gigabit links. */
export const SSH_HIGH_WATER_MARK = 1024 * 1024

function clampPositive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * Resolve the effective tuning by layering persisted settings over defaults.
 * Reads are cheap (electron-store is in-memory) so callers may invoke per-connect.
 */
export function getConnectionTuning(): ConnectionTuning {
  let settings: Partial<Record<keyof ConnectionTuning, unknown>> & {
    autoReconnect?: boolean
    maxReconnectAttempts?: number
  } = {}

  try {
    settings = configStore.getSettings() as never
  } catch {
    // Settings unavailable (e.g. during early startup) — use defaults.
  }

  const maxAttempts =
    typeof settings.maxReconnectAttempts === 'number' && Number.isFinite(settings.maxReconnectAttempts)
      ? Math.max(0, Math.floor(settings.maxReconnectAttempts))
      : DEFAULT_CONNECTION_TUNING.maxReconnectAttempts

  return {
    keepaliveIntervalMs: clampPositive(settings.keepaliveIntervalMs, DEFAULT_CONNECTION_TUNING.keepaliveIntervalMs),
    keepaliveCountMax: clampPositive(settings.keepaliveCountMax, DEFAULT_CONNECTION_TUNING.keepaliveCountMax),
    readyTimeoutMs: clampPositive(settings.readyTimeoutMs, DEFAULT_CONNECTION_TUNING.readyTimeoutMs),
    execTimeoutMs: clampPositive(settings.execTimeoutMs, DEFAULT_CONNECTION_TUNING.execTimeoutMs),
    autoReconnect: settings.autoReconnect !== false,
    maxReconnectAttempts: maxAttempts,
    reconnectBaseDelayMs: clampPositive(settings.reconnectBaseDelayMs, DEFAULT_CONNECTION_TUNING.reconnectBaseDelayMs),
    reconnectMaxDelayMs: clampPositive(settings.reconnectMaxDelayMs, DEFAULT_CONNECTION_TUNING.reconnectMaxDelayMs)
  }
}

/**
 * Exponential backoff with an absolute cap. `attempt` is 1-based.
 */
export function computeReconnectDelay(attempt: number, tuning: ConnectionTuning): number {
  const exponent = Math.max(0, attempt - 1)
  const delay = tuning.reconnectBaseDelayMs * Math.pow(2, exponent)
  return Math.min(delay, tuning.reconnectMaxDelayMs)
}

/**
 * Whether another reconnect attempt is permitted under the current tuning.
 * `maxReconnectAttempts <= 0` means unlimited.
 */
export function shouldRetryReconnect(attempt: number, tuning: ConnectionTuning): boolean {
  if (!tuning.autoReconnect) return false
  if (tuning.maxReconnectAttempts <= 0) return true
  return attempt <= tuning.maxReconnectAttempts
}
