import { z } from 'zod';

const userId = z.uuid();

// AuthGateway validates tokens and replaces client-supplied identity headers.
// This service is reachable only from that trusted network boundary.
export function readGatewayUserId(headers: Headers): string | null {
  const result = userId.safeParse(headers.get('X-User-Id'));
  return result.success ? result.data.toLowerCase() : null;
}
