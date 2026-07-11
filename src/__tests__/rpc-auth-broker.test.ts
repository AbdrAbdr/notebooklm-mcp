import { describe, expect, it, jest } from '@jest/globals';
import { buildRPCAuthBundle, type RPCBrokerAccount } from '../rpc-auth-broker.js';

const accounts: RPCBrokerAccount[] = [
  {
    config: { id: 'enabled', enabled: true, priority: 1 },
    quota: { limit: 200 },
    stateFilePath: '/enabled.json',
  },
  {
    config: { id: 'disabled', enabled: false, priority: 2 },
    quota: { limit: 100 },
    stateFilePath: '/disabled.json',
  },
];

describe('RPC auth broker', () => {
  it('fails closed when the broker token is not configured', async () => {
    const result = await buildRPCAuthBundle({ accounts, readState: jest.fn() });
    expect(result).toMatchObject({ status: 503, headers: { 'Cache-Control': 'no-store' } });
  });

  it('rejects a wrong broker token', async () => {
    const result = await buildRPCAuthBundle({
      expectedToken: 'correct',
      suppliedToken: 'wrong',
      accounts,
      readState: jest.fn(),
    });
    expect(result).toMatchObject({ status: 401, body: { success: false, error: 'Unauthorized' } });
  });

  it('exports only enabled account Google cookies and disables caching', async () => {
    const readState = jest.fn(async () => ({
      cookies: [
        { name: 'SID', value: 'sid', domain: '.google.com' },
        { name: 'SAPISID', value: 'sapi', domain: 'notebooklm.google.com' },
        { name: 'OTHER', value: 'drop', domain: 'example.com' },
      ],
    }));
    const result = await buildRPCAuthBundle({
      expectedToken: 'secret',
      suppliedToken: 'secret',
      accounts,
      readState,
    });
    expect(result.status).toBe(200);
    expect(result.headers).toEqual({ 'Cache-Control': 'no-store' });
    expect(result.body.accounts).toEqual([
      expect.objectContaining({
        id: 'enabled',
        daily_quota: 200,
        cookies: { SID: 'sid', SAPISID: 'sapi' },
      }),
    ]);
    expect(readState).toHaveBeenCalledTimes(1);
  });

  it('prefers current live browser cookies over stale state on disk', async () => {
    const readState = jest.fn(async () => ({
      cookies: [{ name: 'SID', value: 'stale', domain: '.google.com' }],
    }));
    const readLiveState = jest.fn(async (account: RPCBrokerAccount) =>
      account.config.id === 'enabled'
        ? {
            cookies: [{ name: 'SID', value: 'fresh', domain: '.google.com' }],
            csrf_token: 'fresh-csrf',
            session_id: 'fresh-session',
            bl: 'fresh-build',
          }
        : null
    );

    const result = await buildRPCAuthBundle({
      expectedToken: 'secret',
      suppliedToken: 'secret',
      accounts,
      readState,
      readLiveState,
    });

    expect(result.body.accounts?.[0]).toMatchObject({
      cookies: { SID: 'fresh' },
      csrf_token: 'fresh-csrf',
      session_id: 'fresh-session',
      bl: 'fresh-build',
    });
    expect(readLiveState).toHaveBeenCalledTimes(1);
    expect(readState).not.toHaveBeenCalled();
  });
});
