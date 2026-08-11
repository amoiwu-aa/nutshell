import * as crypto from 'crypto'

// Structural subset of Electron's safeStorage, injected so this module stays
// free of electron imports and testable outside the main process.
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

const SAFE_STORAGE_PREFIX = 'v3:'
const GCM_PREFIX = 'v3g:'
const CBC_PREFIX = 'v2:'

export class CredentialCipher {
  private safeStorage: SafeStorageLike
  private encryptionKeyHex: string
  private legacyEncryptionKeyHex: string

  constructor(safeStorage: SafeStorageLike, encryptionKeyHex: string, legacyEncryptionKeyHex: string) {
    this.safeStorage = safeStorage
    this.encryptionKeyHex = encryptionKeyHex
    this.legacyEncryptionKeyHex = legacyEncryptionKeyHex
  }

  /**
   * Deliberately unguarded: returning the plaintext on failure would write the
   * credential to disk unencrypted, and the round-trip would still "work", so
   * nothing would ever surface the problem.
   *
   * Prefers the OS keychain (Electron safeStorage, `v3:`); falls back to
   * AES-256-GCM with the machine-derived key (`v3g:`) when no keychain is
   * available, e.g. Linux without a secret service. GCM replaces the old CBC
   * format because its auth tag rejects tampered or wrong-key ciphertext
   * instead of decrypting it to garbage.
   */
  encrypt(text: string): string {
    if (this.safeStorage.isEncryptionAvailable()) {
      return `${SAFE_STORAGE_PREFIX}${this.safeStorage.encryptString(text).toString('base64')}`
    }
    const key = Buffer.from(this.encryptionKeyHex, 'hex')
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    const encrypted = cipher.update(text, 'utf8', 'hex') + cipher.final('hex')
    return `${GCM_PREFIX}${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted}`
  }

  /**
   * Returns undefined when a stored credential cannot be recovered, so the user
   * is asked for it again. Returning the ciphertext (the previous behaviour)
   * sent it to the server as the password and surfaced as "wrong password".
   *
   * Reads every format ever written: `v3:` (safeStorage), `v3g:` (AES-256-GCM),
   * `v2:` (AES-256-CBC, current key) and unprefixed legacy records
   * (AES-256-CBC, old hostname-dependent key).
   */
  decrypt(text: string): string | undefined {
    try {
      if (text.startsWith(SAFE_STORAGE_PREFIX)) {
        return this.safeStorage.decryptString(
          Buffer.from(text.slice(SAFE_STORAGE_PREFIX.length), 'base64')
        )
      }
      if (text.startsWith(GCM_PREFIX)) {
        return this.decryptGcm(text.slice(GCM_PREFIX.length))
      }
      const isCurrentCbc = text.startsWith(CBC_PREFIX)
      return this.decryptCbc(
        isCurrentCbc ? text.slice(CBC_PREFIX.length) : text,
        isCurrentCbc ? this.encryptionKeyHex : this.legacyEncryptionKeyHex
      )
    } catch {
      console.warn('[config] a stored credential could not be decrypted and must be re-entered')
      return undefined
    }
  }

  // Whether a stored value is already in the format encrypt() would produce
  // right now, i.e. no migration rewrite is needed for it.
  isPreferredFormat(text: string): boolean {
    return this.safeStorage.isEncryptionAvailable()
      ? text.startsWith(SAFE_STORAGE_PREFIX)
      : text.startsWith(GCM_PREFIX)
  }

  private decryptGcm(body: string): string {
    const [ivHex, tagHex, encrypted] = body.split(':')
    if (!ivHex || !tagHex || !encrypted) throw new Error('malformed v3g record')
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      Buffer.from(this.encryptionKeyHex, 'hex'),
      Buffer.from(ivHex, 'hex')
    )
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
    return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8')
  }

  private decryptCbc(body: string, keyHex: string): string {
    const [ivHex, encrypted] = body.split(':')
    if (!ivHex || !encrypted) throw new Error('malformed cbc record')
    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      Buffer.from(keyHex, 'hex'),
      Buffer.from(ivHex, 'hex')
    )
    return decipher.update(encrypted, 'hex', 'utf8') + decipher.final('utf8')
  }
}
