export type RPCBrokerAccount = {
  config: { id: string; enabled: boolean; priority: number };
  quota: { limit: number };
  stateFilePath: string;
};

type BrowserState = {
  cookies?: Array<{ name?: string; value?: string; domain?: string }>;
  csrf_token?: string;
  session_id?: string;
  bl?: string;
};

export type RPCAuthBundleResult = {
  status: number;
  headers: { 'Cache-Control': 'no-store' };
  body: {
    success: boolean;
    error?: string;
    accounts?: Array<{
      id: string;
      enabled: true;
      priority: number;
      daily_quota: number;
      cookies: Record<string, string>;
      csrf_token?: string;
      session_id?: string;
      bl?: string;
    }>;
  };
};

export async function buildRPCAuthBundle(options: {
  expectedToken?: string;
  suppliedToken?: string;
  accounts: RPCBrokerAccount[];
  readState: (path: string) => Promise<BrowserState>;
  readLiveState?: (account: RPCBrokerAccount) => Promise<BrowserState | null>;
  onSkip?: (accountId: string, error: unknown) => void;
}): Promise<RPCAuthBundleResult> {
  const headers = { 'Cache-Control': 'no-store' } as const;
  if (!options.expectedToken?.trim()) {
    return {
      status: 503,
      headers,
      body: { success: false, error: 'RPC auth broker is not configured' },
    };
  }
  if (
    !options.suppliedToken?.trim() ||
    options.suppliedToken.trim() !== options.expectedToken.trim()
  ) {
    return { status: 401, headers, body: { success: false, error: 'Unauthorized' } };
  }

  const accounts: NonNullable<RPCAuthBundleResult['body']['accounts']> = [];
  for (const account of options.accounts) {
    if (!account.config.enabled) continue;
    try {
      const state =
        (await options.readLiveState?.(account)) ??
        (await options.readState(account.stateFilePath));
      const cookies = Object.fromEntries(
        (state.cookies || [])
          .filter(
            (cookie) =>
              cookie.name &&
              typeof cookie.value === 'string' &&
              (!cookie.domain || cookie.domain.includes('google.com'))
          )
          .map((cookie) => [cookie.name as string, cookie.value as string])
      );
      if (Object.keys(cookies).length === 0) continue;
      accounts.push({
        id: account.config.id,
        enabled: true,
        priority: account.config.priority,
        daily_quota: account.quota.limit,
        cookies,
        ...(state.csrf_token ? { csrf_token: state.csrf_token } : {}),
        ...(state.session_id ? { session_id: state.session_id } : {}),
        ...(state.bl ? { bl: state.bl } : {}),
      });
    } catch (error) {
      options.onSkip?.(account.config.id, error);
    }
  }

  return { status: 200, headers, body: { success: true, accounts } };
}
