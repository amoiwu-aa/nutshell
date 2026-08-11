import { afterEach, describe, expect, it, vi } from 'vitest'
import * as crypto from 'crypto'
import { CredentialCipher, type SafeStorageLike } from './credentialCipher'

const MOCK_MARKER = 'SS!'

interface MockSafeStorage extends SafeStorageLike {
  available: boolean
}

function createMockSafeStorage(available: boolean): MockSafeStorage {
  return {
    available,
    isEncryptionAvailable() {
      return this.available
    },
    encryptString(plainText: string) {
      if (!this.available) throw new Error('safeStorage unavailable')
      return Buffer.from(MOCK_MARKER + plainText, 'utf8')
    },
    decryptString(encrypted: Buffer) {
      if (!this.available) throw new Error('safeStorage unavailable')
      const text = encrypted.toString('utf8')
      if (!text.startsWith(MOCK_MARKER)) throw new Error('not a mock safeStorage payload')
      return text.slice(MOCK_MARKER.length)
    }
  }
}

const salt = 'per-install-salt'
const currentKeyHex = crypto.scryptSync('linux|x64|user|/home/user', salt, 32).toString('hex')
const legacyKeyHex = crypto
  .scryptSync('old-hostname|linux|x64|user|/home/user', salt, 32)
  .toString('hex')

function createCipher(available: boolean): { cipher: CredentialCipher; mock: MockSafeStorage } {
  const mock = createMockSafeStorage(available)
  return { cipher: new CredentialCipher(mock, currentKeyHex, legacyKeyHex), mock }
}

function encryptCbc(text: string, keyHex: string): string {
  const iv = crypto.randomBytes(16)
  const cbc = crypto.createCipheriv('aes-256-cbc', Buffer.from(keyHex, 'hex'), iv)
  const encrypted = cbc.update(text, 'utf8', 'hex') + cbc.final('hex')
  return `${iv.toString('hex')}:${encrypted}`
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CredentialCipher', () => {
  it('uses safeStorage (v3) when available and round-trips', () => {
    const { cipher } = createCipher(true)
    const stored = cipher.encrypt('s3cret-пароль-密码')
    expect(stored.startsWith('v3:')).toBe(true)
    expect(cipher.decrypt(stored)).toBe('s3cret-пароль-密码')
  })

  it('falls back to AES-256-GCM (v3g) when safeStorage is unavailable and round-trips', () => {
    const { cipher } = createCipher(false)
    const stored = cipher.encrypt('s3cret-пароль-密码')
    expect(stored.startsWith('v3g:')).toBe(true)
    expect(cipher.decrypt(stored)).toBe('s3cret-пароль-密码')
  })

  it('rejects a tampered v3g ciphertext', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { cipher } = createCipher(false)
    const stored = cipher.encrypt('do not tamper')
    const [ivHex, tagHex, cipherHex] = stored.slice('v3g:'.length).split(':')
    const bytes = Buffer.from(cipherHex, 'hex')
    bytes[0] ^= 0xff
    const tampered = `v3g:${ivHex}:${tagHex}:${bytes.toString('hex')}`

    expect(cipher.decrypt(tampered)).toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('decrypts v2 CBC records written with the current key', () => {
    const { cipher } = createCipher(true)
    const stored = `v2:${encryptCbc('old-v2-password', currentKeyHex)}`
    expect(cipher.decrypt(stored)).toBe('old-v2-password')
  })

  it('decrypts unprefixed legacy CBC records written with the legacy key', () => {
    const { cipher } = createCipher(true)
    const stored = encryptCbc('ancient-password', legacyKeyHex)
    expect(cipher.decrypt(stored)).toBe('ancient-password')
  })

  it('returns undefined for a v3 record when safeStorage became unavailable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { cipher, mock } = createCipher(true)
    const stored = cipher.encrypt('keychain-only')
    mock.available = false

    expect(cipher.decrypt(stored)).toBeUndefined()
    expect(warn).toHaveBeenCalledOnce()
  })

  it('reports the preferred format according to safeStorage availability', () => {
    const { cipher: withSafeStorage } = createCipher(true)
    const { cipher: withoutSafeStorage } = createCipher(false)
    const v3 = withSafeStorage.encrypt('a')
    const v3g = withoutSafeStorage.encrypt('a')
    const v2 = `v2:${encryptCbc('a', currentKeyHex)}`
    const legacy = encryptCbc('a', legacyKeyHex)

    expect(withSafeStorage.isPreferredFormat(v3)).toBe(true)
    expect(withSafeStorage.isPreferredFormat(v3g)).toBe(false)
    expect(withSafeStorage.isPreferredFormat(v2)).toBe(false)
    expect(withSafeStorage.isPreferredFormat(legacy)).toBe(false)

    expect(withoutSafeStorage.isPreferredFormat(v3g)).toBe(true)
    expect(withoutSafeStorage.isPreferredFormat(v3)).toBe(false)
    expect(withoutSafeStorage.isPreferredFormat(v2)).toBe(false)
    expect(withoutSafeStorage.isPreferredFormat(legacy)).toBe(false)
  })
})
