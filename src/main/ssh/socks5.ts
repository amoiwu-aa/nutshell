export const SOCKS5_VERSION = 0x05

export const SOCKS5_REPLY = {
  succeeded: 0x00,
  generalFailure: 0x01,
  connectionRefused: 0x05,
  commandNotSupported: 0x07,
  addressTypeNotSupported: 0x08
} as const

const CMD_CONNECT = 0x01
const ATYP_IPV4 = 0x01
const ATYP_DOMAIN = 0x03
const ATYP_IPV6 = 0x04

export type Socks5ConnectResult = { host: string; port: number } | { replyCode: number }

/**
 * Parses a SOCKS5 CONNECT request (RFC 1928: VER CMD RSV ATYP DST.ADDR DST.PORT).
 * Every read is bounds-checked so truncated or malformed packets yield a reply
 * code instead of an out-of-range access. Trailing bytes are ignored.
 */
export function parseConnectRequest(request: Buffer): Socks5ConnectResult {
  if (request.length < 4 || request[0] !== SOCKS5_VERSION) {
    return { replyCode: SOCKS5_REPLY.generalFailure }
  }
  if (request[1] !== CMD_CONNECT) {
    return { replyCode: SOCKS5_REPLY.commandNotSupported }
  }

  const addrType = request[3]

  if (addrType === ATYP_IPV4) {
    if (request.length < 10) {
      return { replyCode: SOCKS5_REPLY.generalFailure }
    }
    return {
      host: `${request[4]}.${request[5]}.${request[6]}.${request[7]}`,
      port: request.readUInt16BE(8)
    }
  }

  if (addrType === ATYP_DOMAIN) {
    if (request.length < 5) {
      return { replyCode: SOCKS5_REPLY.generalFailure }
    }
    const domainLength = request[4]
    if (domainLength === 0 || request.length < 5 + domainLength + 2) {
      return { replyCode: SOCKS5_REPLY.generalFailure }
    }
    return {
      host: request.subarray(5, 5 + domainLength).toString('utf8'),
      port: request.readUInt16BE(5 + domainLength)
    }
  }

  if (addrType === ATYP_IPV6) {
    if (request.length < 22) {
      return { replyCode: SOCKS5_REPLY.generalFailure }
    }
    const groups: string[] = []
    for (let i = 0; i < 8; i++) {
      groups.push(request.readUInt16BE(4 + i * 2).toString(16))
    }
    return { host: groups.join(':'), port: request.readUInt16BE(20) }
  }

  return { replyCode: SOCKS5_REPLY.addressTypeNotSupported }
}

/** BND.ADDR/BND.PORT are zeroed: clients only need real values for BIND. */
export function buildConnectReply(replyCode: number): Buffer {
  return Buffer.from([SOCKS5_VERSION, replyCode, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0])
}
