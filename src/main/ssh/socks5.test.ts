import { describe, expect, it } from 'vitest'
import { buildConnectReply, parseConnectRequest, SOCKS5_REPLY } from './socks5'

function connectRequest(addrType: number, addr: number[], port: number): Buffer {
  return Buffer.from([0x05, 0x01, 0x00, addrType, ...addr, port >> 8, port & 0xff])
}

describe('parseConnectRequest', () => {
  it('parses IPv4 requests', () => {
    const result = parseConnectRequest(connectRequest(0x01, [192, 168, 1, 10], 8080))
    expect(result).toEqual({ host: '192.168.1.10', port: 8080 })
  })

  it('parses domain requests', () => {
    const name = [...Buffer.from('example.com')]
    const result = parseConnectRequest(connectRequest(0x03, [name.length, ...name], 443))
    expect(result).toEqual({ host: 'example.com', port: 443 })
  })

  it('parses IPv6 requests into colon-separated hex groups', () => {
    const addr = [0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x01]
    const result = parseConnectRequest(connectRequest(0x04, addr, 22))
    expect(result).toEqual({ host: '2001:db8:0:0:0:0:0:1', port: 22 })
  })

  it('rejects truncated requests with general failure instead of reading out of range', () => {
    const generalFailure = { replyCode: SOCKS5_REPLY.generalFailure }
    expect(parseConnectRequest(Buffer.alloc(0))).toEqual(generalFailure)
    expect(parseConnectRequest(Buffer.from([0x05, 0x01]))).toEqual(generalFailure)
    // IPv4 address present but port bytes missing
    expect(parseConnectRequest(Buffer.from([0x05, 0x01, 0x00, 0x01, 1, 2, 3, 4]))).toEqual(
      generalFailure
    )
    // Domain length byte claims more bytes than the packet carries
    expect(parseConnectRequest(Buffer.from([0x05, 0x01, 0x00, 0x03, 11, 0x61]))).toEqual(
      generalFailure
    )
    // IPv6 address cut short
    expect(parseConnectRequest(Buffer.from([0x05, 0x01, 0x00, 0x04, 0x20, 0x01]))).toEqual(
      generalFailure
    )
  })

  it('rejects non-CONNECT commands with command not supported', () => {
    const bind = Buffer.from([0x05, 0x02, 0x00, 0x01, 1, 2, 3, 4, 0x00, 0x50])
    expect(parseConnectRequest(bind)).toEqual({ replyCode: SOCKS5_REPLY.commandNotSupported })
  })

  it('rejects unknown address types with address type not supported', () => {
    const request = Buffer.from([0x05, 0x01, 0x00, 0x02, 1, 2, 3, 4, 0x00, 0x50])
    expect(parseConnectRequest(request)).toEqual({
      replyCode: SOCKS5_REPLY.addressTypeNotSupported
    })
  })
})

describe('buildConnectReply', () => {
  it('builds replies with the given code and zeroed BND fields', () => {
    expect([...buildConnectReply(SOCKS5_REPLY.succeeded)]).toEqual([
      0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0
    ])
    expect([...buildConnectReply(SOCKS5_REPLY.connectionRefused)]).toEqual([
      0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0
    ])
  })
})
