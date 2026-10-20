import { describe, expect, it } from 'vitest';
import { readGatewayUserId } from '../src/shared/identity.ts';
import { aliceUserId, gatewayHeaders } from './helpers/identity.ts';

describe('gateway identity context', () => {
  it('reads and normalizes the user ID supplied by the gateway', () => {
    expect(readGatewayUserId(new Headers(gatewayHeaders()))).toBe(aliceUserId);
    const upper = 'abcdefab-cdef-4abc-8def-abcdefabcdef'.toUpperCase();
    expect(readGatewayUserId(new Headers(gatewayHeaders(upper)))).toBe(upper.toLowerCase());
  });

  it('rejects missing, malformed and ambiguous headers without interpreting bearer tokens', () => {
    expect(readGatewayUserId(new Headers())).toBeNull();
    expect(readGatewayUserId(new Headers(gatewayHeaders('alice')))).toBeNull();
    expect(
      readGatewayUserId(new Headers(gatewayHeaders(`${aliceUserId}, ${aliceUserId}`))),
    ).toBeNull();
    expect(
      readGatewayUserId(new Headers({ Authorization: 'Bearer token-for-the-gateway' })),
    ).toBeNull();
  });
});
