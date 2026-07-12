/**
 * HTTP Wrapper for NotebookLM MCP Server
 *
 * Exposes the MCP server via HTTP REST API
 * Allows n8n and other tools to call the server without stdio
 */

import express, { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import net from 'net';
import path from 'path';
import { execSync } from 'child_process';
import { AuthManager } from './auth/auth-manager.js';
import { SessionManager } from './session/session-manager.js';
import { NotebookLibrary } from './library/notebook-library.js';
import { ToolHandlers } from './tools/index.js';
import { AutoDiscovery } from './auto-discovery/auto-discovery.js';
import { StartupManager } from './startup/startup-manager.js';
import { AutoLoginManager, getAccountManager, maskEmail } from './accounts/index.js';
import type { RotationStrategy } from './accounts/index.js';
import { CONFIG } from './config.js';
import { log } from './utils/logger.js';
import { buildRPCAuthBundle, extractRPCPageTokens } from './rpc-auth-broker.js';

// Extend Express Request to include requestId
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

const app = express();
app.use(express.json({ limit: '10mb' }));

const ROTATION_STRATEGIES: RotationStrategy[] = ['least_used', 'round_robin', 'failover', 'random'];
type ManualAuthJobStatus = 'running' | 'success' | 'failed';

type ManualAuthJob = {
  id: string;
  accountId: string;
  email: string;
  status: ManualAuthJobStatus;
  startedAt: string;
  updatedAt: string;
  durationMs?: number;
  error?: string;
  progress?: {
    message: string;
    current: number;
    total: number;
  };
  result?: {
    accountPool?: unknown;
  };
};

type ManualAuthResult = {
  statusCode: number;
  payload: {
    success: boolean;
    data?: Record<string, unknown>;
    error?: string;
  };
};

const manualAuthJobs = new Map<string, ManualAuthJob>();
const manualAuthJobByAccount = new Map<string, string>();

function serializeManualAuthJob(job: ManualAuthJob): ManualAuthJob {
  return {
    ...job,
    progress: job.progress ? { ...job.progress } : undefined,
    result: job.result ? { ...job.result } : undefined,
  };
}

async function hasValidGoogleAuthState(stateFilePath: string): Promise<boolean> {
  try {
    const stateData = await fs.readFile(stateFilePath, 'utf-8');
    const state = JSON.parse(stateData);
    if (!Array.isArray(state.cookies) || state.cookies.length === 0) {
      return false;
    }

    const criticalCookieNames = ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID'];
    const criticalCookies = state.cookies.filter((cookie: { name?: string }) =>
      criticalCookieNames.includes(cookie.name || '')
    );
    if (criticalCookies.length === 0) {
      return false;
    }

    const currentTime = Date.now() / 1000;
    return !criticalCookies.some((cookie: { expires?: number }) => {
      const expires = cookie.expires ?? -1;
      return expires !== -1 && expires < currentTime;
    });
  } catch {
    return false;
  }
}

// Request ID middleware for debugging and log correlation
app.use((req: Request, res: Response, next: NextFunction) => {
  // Use existing X-Request-ID header or generate a new one
  const requestId = (req.headers['x-request-id'] as string) || randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  next();
});

// CORS for n8n
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (_req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Initialize managers
const authManager = new AuthManager();
const sessionManager = new SessionManager(authManager);
const library = new NotebookLibrary(sessionManager);
const toolHandlers = new ToolHandlers(sessionManager, authManager, library);

type LiveNotebookLMAuthProbe = {
  authenticated: boolean;
  final_url: string;
  reason: string;
  checked_at: string;
};

let authProbeCache: { expiresAt: number; value: LiveNotebookLMAuthProbe } | null = null;
let authProbeInFlight: Promise<LiveNotebookLMAuthProbe> | null = null;

async function probeNotebookLMAuth(force = false): Promise<LiveNotebookLMAuthProbe> {
  // Health polling must not launch a competing persistent Chromium while the
  // operator is completing Google login in noVNC. The manual-auth flow performs
  // its own forced probe after browser setup and profile sync finish.
  if (!force && Array.from(manualAuthJobs.values()).some((job) => job.status === 'running')) {
    return {
      authenticated: false,
      final_url: '',
      reason: 'manual_auth_in_progress',
      checked_at: new Date().toISOString(),
    };
  }
  if (!force && authProbeCache && authProbeCache.expiresAt > Date.now()) {
    return authProbeCache.value;
  }
  if (authProbeInFlight) return authProbeInFlight;

  authProbeInFlight = (async () => {
    const result = await toolHandlers.handleProbeNotebookLMAuth();
    if (!result.success || !result.data) {
      throw new Error(result.error || 'NotebookLM live auth probe failed');
    }
    const value = result.data as LiveNotebookLMAuthProbe;
    authProbeCache = { expiresAt: Date.now() + 60_000, value };
    return value;
  })();

  try {
    return await authProbeInFlight;
  } finally {
    authProbeInFlight = null;
  }
}

// Root endpoint - API info
app.get('/', (_req: Request, res: Response) => {
  res.json({
    name: 'NotebookLM MCP HTTP Server',
    version: process.env.npm_package_version || '1.5.2',
    endpoints: {
      health: 'GET /health',
      auth_probe: 'GET /auth/probe',
      ask: 'POST /ask',
      setup_auth: 'POST /setup-auth',
      notebooks: 'GET /notebooks',
      sessions: 'GET /sessions',
      accounts: 'GET /accounts',
      accounts_health: 'GET /accounts/health',
      account_manual_auth_start: 'POST /accounts/:id/manual-auth/start',
      account_manual_auth_status: 'GET /accounts/:id/manual-auth/status',
      file_download: 'GET /files/download?path=...',
    },
    docs: 'https://github.com/carterlasalle/notebooklm-mcp',
  });
});

// Health check
app.get('/health', async (_req: Request, res: Response) => {
  try {
    const stats = sessionManager.getStats();
    let stateFileAuthenticated = false;
    let currentAccount: string | undefined;

    try {
      const accountManager = await getAccountManager();
      const currentAccountId = await accountManager.getCurrentAccountId();
      if (currentAccountId) {
        const account = accountManager.getAccount(currentAccountId);
        if (account) {
          currentAccount = maskEmail(account.config.email);
          stateFileAuthenticated = await hasValidGoogleAuthState(account.stateFilePath);
        }
      }
    } catch (error) {
      log.warning(
        `Health account check skipped: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // The saved state only proves that a cookie file exists. Prefer the live
    // NotebookLM probe so health cannot report a stale Google session as valid.
    const liveProbe = await probeNotebookLMAuth().catch((error) => ({
      authenticated: false,
      final_url: '',
      reason: error instanceof Error ? error.message : String(error),
      checked_at: new Date().toISOString(),
    }));
    res.json({
      success: true,
      data: {
        status: 'ok',
        authenticated: liveProbe.authenticated,
        auth_state_file_valid: stateFileAuthenticated,
        auth_probe: liveProbe,
        notebook_url: CONFIG.notebookUrl || 'not configured',
        active_sessions: stats.active_sessions,
        max_sessions: stats.max_sessions,
        session_timeout: stats.session_timeout,
        total_messages: stats.total_messages,
        headless: CONFIG.headless,
        auto_login_enabled: CONFIG.autoLoginEnabled,
        stealth_enabled: CONFIG.stealthEnabled,
        ...(currentAccount ? { current_account: currentAccount } : {}),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get('/auth/probe', async (_req: Request, res: Response) => {
  try {
    const probe = await probeNotebookLMAuth();
    res.json({ success: true, data: probe });
  } catch (error) {
    res.status(503).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Account pool overview (sanitized; never returns credentials or cookies)
app.get('/accounts', async (_req: Request, res: Response) => {
  try {
    const accountManager = await getAccountManager();
    res.json({
      success: true,
      data: accountManager.getPoolOverview(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Account pool health (sanitized)
app.get('/accounts/health', async (_req: Request, res: Response) => {
  try {
    const accountManager = await getAccountManager();
    const [health, liveAuth] = await Promise.all([
      accountManager.healthCheck(),
      probeNotebookLMAuth().catch((error) => ({
        authenticated: false,
        final_url: '',
        reason: error instanceof Error ? error.message : String(error),
        checked_at: new Date().toISOString(),
      })),
    ]);
    res.json({
      success: true,
      data: health.map((entry) => {
        const sessionValid = entry.sessionValid && liveAuth.authenticated;
        return {
          ...entry,
          sessionValid,
          issues: sessionValid
            ? entry.issues
            : [...entry.issues, `Live NotebookLM auth failed: ${liveAuth.reason}`],
          email: maskEmail(entry.email),
        };
      }),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Server-to-server auth broker for the RPC pilot. This route never reaches the
// admin browser: Cloudflare reads the bundle and immediately imports it into
// the isolated Railway service.
app.get('/rpc/auth-bundle', async (req: Request, res: Response) => {
  try {
    const expectedBrokerToken = process.env.NOTEBOOKLM_RPC_BROKER_TOKEN?.trim();
    const suppliedBrokerToken = String(req.headers['x-rpc-broker-token'] || '').trim();
    res.setHeader('Cache-Control', 'no-store');
    if (!expectedBrokerToken) {
      return res.status(503).json({ success: false, error: 'RPC auth broker is not configured' });
    }
    if (!suppliedBrokerToken || suppliedBrokerToken !== expectedBrokerToken) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    if (Array.from(manualAuthJobs.values()).some((job) => job.status === 'running')) {
      return res
        .status(409)
        .json({ success: false, error: 'Manual authentication is in progress' });
    }
    const accountManager = await getAccountManager();
    const currentAccountId = await accountManager.getCurrentAccountId();
    const liveAuth = await probeNotebookLMAuth(true);
    if (!currentAccountId || !liveAuth.authenticated) {
      return res.status(409).json({
        success: false,
        error: 'No live authenticated NotebookLM account is available',
      });
    }

    const currentAccount = accountManager.getAccount(currentAccountId);
    if (!currentAccount) {
      return res
        .status(409)
        .json({ success: false, error: 'Current NotebookLM account was not found' });
    }

    // Persistent Chromium can refresh Google cookies while the account state
    // file remains stale. Snapshot the live context for the current account so
    // the RPC provider receives the same session that just passed the live probe.
    const context = await sessionManager.getSharedContextManager().getOrCreateContext();
    const liveState = await context.storageState();
    let notebookLMPage = context
      .pages()
      .find((page) => page.url().startsWith('https://notebooklm.google.com'));
    if (!notebookLMPage) {
      notebookLMPage = await context.newPage();
      await notebookLMPage.goto('https://notebooklm.google.com/', {
        waitUntil: 'domcontentloaded',
        timeout: CONFIG.browserTimeout,
      });
    }
    const livePageTokens = await notebookLMPage.evaluate(() => {
      const data = (
        globalThis as unknown as {
          WIZ_global_data?: { SNlM0e?: string; FdrFJe?: string; cfb2h?: string };
        }
      ).WIZ_global_data;
      return {
        csrf_token: data?.SNlM0e || '',
        session_id: data?.FdrFJe || '',
        bl: data?.cfb2h || '',
      };
    });
    const htmlPageTokens = extractRPCPageTokens(await notebookLMPage.content());
    const liveBundleState = {
      cookies: await context.cookies('https://notebooklm.google.com/'),
      csrf_token: livePageTokens.csrf_token || htmlPageTokens.csrf_token,
      session_id: livePageTokens.session_id || htmlPageTokens.session_id,
      bl: livePageTokens.bl || htmlPageTokens.bl,
    };
    const tempStatePath = `${currentAccount.stateFilePath}.${process.pid}.tmp`;
    await fs.writeFile(tempStatePath, JSON.stringify(liveState, null, 2), { mode: 0o600 });
    await fs.rename(tempStatePath, currentAccount.stateFilePath);

    const result = await buildRPCAuthBundle({
      expectedToken: expectedBrokerToken,
      suppliedToken: suppliedBrokerToken,
      accounts: accountManager.listAccounts(),
      readState: async (statePath) => JSON.parse(await fs.readFile(statePath, 'utf8')),
      readLiveState: async (account) =>
        account.config.id === currentAccountId ? liveBundleState : null,
      onSkip: (accountId, error) =>
        log.warning(
          `RPC auth bundle skipped account ${accountId}: ${error instanceof Error ? error.message : String(error)}`
        ),
    });
    res.setHeader('Cache-Control', result.headers['Cache-Control']);
    return res.status(result.status).json(result.body);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Add account slot. Password is optional: if omitted, the account can be
// authenticated manually through /accounts/:id/manual-auth.
app.post('/accounts', async (req: Request, res: Response) => {
  try {
    const { email, password, totp_secret, totpSecret, priority, notes } = req.body ?? {};
    const normalizedEmail = typeof email === 'string' ? email.trim() : '';
    if (!normalizedEmail || !normalizedEmail.includes('@')) {
      return res.status(400).json({
        success: false,
        error: 'email is required',
      });
    }

    const accountManager = await getAccountManager();
    const safePriority = Number.isFinite(Number(priority)) ? Number(priority) : undefined;
    const safeNotes = typeof notes === 'string' ? notes : undefined;
    const accountId =
      typeof password === 'string' && password.length > 0
        ? await accountManager.addAccount(normalizedEmail, password, totp_secret || totpSecret, {
            priority: safePriority,
            notes: safeNotes,
          })
        : await accountManager.addManualAccount(normalizedEmail, {
            priority: safePriority,
            notes: safeNotes,
          });

    res.status(201).json({
      success: true,
      data: {
        accountId,
        accountPool: accountManager.getPoolOverview(),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Remove account slot and its stored profile/state.
app.delete('/accounts/:id', async (req: Request, res: Response) => {
  try {
    const accountManager = await getAccountManager();
    const removed = await accountManager.removeAccount(req.params.id);
    if (!removed) {
      return res.status(404).json({
        success: false,
        error: 'Account not found',
      });
    }

    res.json({
      success: true,
      data: accountManager.getPoolOverview(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Update rotation strategy
app.put('/accounts/strategy', async (req: Request, res: Response) => {
  try {
    const { strategy } = req.body;
    if (!ROTATION_STRATEGIES.includes(strategy)) {
      return res.status(400).json({
        success: false,
        error: `Invalid strategy. Supported strategies: ${ROTATION_STRATEGIES.join(', ')}`,
      });
    }

    const accountManager = await getAccountManager();
    await accountManager.setRotationStrategy(strategy);
    res.json({
      success: true,
      data: accountManager.getPoolOverview(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Enable account without deleting stored state/profile
app.post('/accounts/:id/enable', async (req: Request, res: Response) => {
  try {
    const accountManager = await getAccountManager();
    const updated = await accountManager.setAccountEnabled(req.params.id, true);
    if (!updated) {
      return res.status(404).json({
        success: false,
        error: 'Account not found',
      });
    }

    res.json({
      success: true,
      data: accountManager.getPoolOverview(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Disable account without deleting stored state/profile
app.post('/accounts/:id/disable', async (req: Request, res: Response) => {
  try {
    const accountManager = await getAccountManager();
    const updated = await accountManager.setAccountEnabled(req.params.id, false);
    if (!updated) {
      return res.status(404).json({
        success: false,
        error: 'Account not found',
      });
    }

    res.json({
      success: true,
      data: accountManager.getPoolOverview(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Update failover priority; lower priority value wins
app.put('/accounts/:id/priority', async (req: Request, res: Response) => {
  try {
    const priority = Number(req.body?.priority);
    if (!Number.isFinite(priority) || priority < 1) {
      return res.status(400).json({
        success: false,
        error: 'priority must be a positive number',
      });
    }

    const accountManager = await getAccountManager();
    const updated = await accountManager.setAccountPriority(req.params.id, priority);
    if (!updated) {
      return res.status(404).json({
        success: false,
        error: 'Account not found',
      });
    }

    res.json({
      success: true,
      data: accountManager.getPoolOverview(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Test/login a single account using stored encrypted credentials
app.post('/accounts/:id/test', async (req: Request, res: Response) => {
  try {
    const { show_browser, timeout_ms } = req.body ?? {};
    const accountManager = await getAccountManager();
    const account = accountManager.getAccount(req.params.id);
    if (!account) {
      return res.status(404).json({
        success: false,
        error: 'Account not found',
      });
    }

    const autoLogin = new AutoLoginManager(accountManager);
    const result = await autoLogin.performAutoLogin(req.params.id, {
      showBrowser: show_browser === true,
      timeout: Number.isFinite(Number(timeout_ms)) ? Number(timeout_ms) : undefined,
    });

    res.json({
      success: result.success,
      data: {
        ...result,
        email: maskEmail(account.config.email),
      },
      error: result.error,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

async function performManualAccountAuth(
  accountId: string,
  options: { showBrowser?: boolean; clearExisting?: boolean },
  onProgress?: (message: string, progress?: number, total?: number) => void
): Promise<ManualAuthResult> {
  try {
    const showBrowser = options.showBrowser !== false;
    const clearExisting = options.clearExisting !== false;
    const accountManager = await getAccountManager();
    const account = accountManager.getAccount(accountId);
    if (!account) {
      return { statusCode: 404, payload: { success: false, error: 'Account not found' } };
    }

    if (clearExisting) {
      await sessionManager.closeAllSessions();
      await authManager.clearAllAuthData();
    }

    const startedAt = Date.now();
    const authenticated = await authManager.performSetup(
      async (message, progress, total) => {
        log.info(`[manual-auth:${accountId}] ${message} (${progress}/${total})`);
        onProgress?.(message, progress, total);
      },
      showBrowser,
      true
    );
    const durationMs = Date.now() - startedAt;

    if (!authenticated) {
      await accountManager.recordLoginFailure(accountId, 'Manual Google auth failed');
      return {
        statusCode: 400,
        payload: {
          success: false,
          error: 'Manual Google auth failed',
          data: {
            accountId,
            email: maskEmail(account.config.email),
            durationMs,
          },
        },
      };
    }

    const synced = await accountManager.syncMainToAccount(accountId);
    if (!synced) {
      await accountManager.recordLoginFailure(
        accountId,
        'Manual Google auth succeeded but profile sync failed'
      );
      return {
        statusCode: 500,
        payload: {
          success: false,
          error: 'Manual Google auth succeeded but profile sync failed',
        },
      };
    }

    // The saved state file is only a local artifact. Confirm that a fresh runtime
    // context can actually reach NotebookLM before reporting a successful login.
    // This also prevents a stale shared context from masking a newly selected profile.
    await sessionManager.closeAllSessions();
    authProbeCache = null;
    const liveAuth = await probeNotebookLMAuth(true);
    if (!liveAuth.authenticated) {
      const error = `NotebookLM live authentication verification failed: ${liveAuth.reason}`;
      await accountManager.recordLoginFailure(accountId, error);
      return {
        statusCode: 409,
        payload: {
          success: false,
          error,
          data: {
            accountId,
            email: maskEmail(account.config.email),
            durationMs,
            authProbe: liveAuth,
          },
        },
      };
    }

    await accountManager.saveCurrentAccountId(accountId);
    await accountManager.recordLoginSuccess(accountId);

    return {
      statusCode: 200,
      payload: {
        success: true,
        data: {
          accountId,
          email: maskEmail(account.config.email),
          durationMs,
          accountPool: accountManager.getPoolOverview(),
        },
      },
    };
  } catch (error) {
    return {
      statusCode: 500,
      payload: {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function handleManualAccountAuth(req: Request, res: Response) {
  const { show_browser, clear_existing } = req.body ?? {};
  const result = await performManualAccountAuth(req.params.id, {
    showBrowser: show_browser !== false,
    clearExisting: clear_existing !== false,
  });
  res.status(result.statusCode).json(result.payload);
}

app.post('/accounts/:id/manual-auth/start', async (req: Request, res: Response) => {
  try {
    const { show_browser, clear_existing } = req.body ?? {};
    const accountManager = await getAccountManager();
    const account = accountManager.getAccount(req.params.id);
    if (!account) {
      return res.status(404).json({
        success: false,
        error: 'Account not found',
      });
    }

    const existingJobId = manualAuthJobByAccount.get(req.params.id);
    const existingJob = existingJobId ? manualAuthJobs.get(existingJobId) : undefined;
    if (existingJob?.status === 'running') {
      return res.status(202).json({
        success: true,
        data: {
          job: serializeManualAuthJob(existingJob),
        },
      });
    }

    const now = new Date().toISOString();
    const job: ManualAuthJob = {
      id: `manual-auth-${Date.now()}-${randomUUID().slice(0, 8)}`,
      accountId: req.params.id,
      email: maskEmail(account.config.email),
      status: 'running',
      startedAt: now,
      updatedAt: now,
    };
    manualAuthJobs.set(job.id, job);
    manualAuthJobByAccount.set(req.params.id, job.id);

    void (async () => {
      const result = await performManualAccountAuth(
        req.params.id,
        {
          showBrowser: show_browser !== false,
          clearExisting: clear_existing !== false,
        },
        (message, progress, total) => {
          job.progress = { message, current: progress ?? 0, total: total ?? 0 };
          job.updatedAt = new Date().toISOString();
        }
      );

      job.status = result.payload.success ? 'success' : 'failed';
      job.updatedAt = new Date().toISOString();
      if (typeof result.payload.error === 'string') {
        job.error = result.payload.error;
      }
      const data = result.payload.data || {};
      if (typeof data.durationMs === 'number') {
        job.durationMs = data.durationMs;
      }
      if (data.accountPool) {
        job.result = { accountPool: data.accountPool };
      }
    })().catch((error) => {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      job.updatedAt = new Date().toISOString();
    });

    res.status(202).json({
      success: true,
      data: {
        job: serializeManualAuthJob(job),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get('/accounts/:id/manual-auth/status', async (req: Request, res: Response) => {
  try {
    const accountManager = await getAccountManager();
    const account = accountManager.getAccount(req.params.id);
    if (!account) {
      return res.status(404).json({
        success: false,
        error: 'Account not found',
      });
    }

    const jobId = manualAuthJobByAccount.get(req.params.id);
    const job = jobId ? manualAuthJobs.get(jobId) : undefined;
    res.json({
      success: true,
      data: {
        job: job ? serializeManualAuthJob(job) : null,
        accountPool: accountManager.getPoolOverview(),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Manual browser login for a selected account slot. The saved global auth state
// is copied into that account's private profile after Google login completes.
app.post('/accounts/:id/manual-auth', handleManualAccountAuth);
app.post('/accounts/:id/setup-auth', handleManualAccountAuth);

// Ask question
app.post('/ask', async (req: Request, res: Response) => {
  const reqId = req.requestId.substring(0, 8); // Short ID for logs
  try {
    const { question, session_id, notebook_id, notebook_url, show_browser, source_format } =
      req.body;

    if (!question) {
      log.warning(`[${reqId}] /ask - Missing question`);
      return res.status(400).json({
        success: false,
        error: 'Missing required field: question',
      });
    }

    const result = await toolHandlers.handleAskQuestion(
      { question, session_id, notebook_id, notebook_url, show_browser, source_format },
      async (message, progress, total) => {
        log.info(`[${reqId}] Progress: ${message} (${progress}/${total})`);
      }
    );

    log.success(`[${reqId}] /ask - Completed`);
    res.json(result);
  } catch (error) {
    log.error(`[${reqId}] /ask - Error: ${error instanceof Error ? error.message : String(error)}`);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Setup auth
app.post('/setup-auth', async (req: Request, res: Response) => {
  try {
    const { show_browser } = req.body;

    const result = await toolHandlers.handleSetupAuth(
      { show_browser },
      async (message, progress, total) => {
        log.info(`Progress: ${message} (${progress}/${total})`);
      }
    );

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// De-authenticate (logout)
app.post('/de-auth', async (_req: Request, res: Response) => {
  try {
    const result = await toolHandlers.handleDeAuth();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Re-authenticate
app.post('/re-auth', async (req: Request, res: Response) => {
  try {
    const { show_browser } = req.body;

    const result = await toolHandlers.handleReAuth(
      { show_browser },
      async (message, progress, total) => {
        log.info(`Progress: ${message} (${progress}/${total})`);
      }
    );

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Cleanup data
app.post('/cleanup-data', async (req: Request, res: Response) => {
  try {
    const { confirm, preserve_library } = req.body;
    const result = await toolHandlers.handleCleanupData({ confirm, preserve_library });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// List notebooks
app.get('/notebooks', async (_req: Request, res: Response) => {
  try {
    const result = await toolHandlers.handleListNotebooks();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Add notebook
app.post('/notebooks', async (req: Request, res: Response) => {
  try {
    const { url, name, description, topics, content_types, use_cases, tags } = req.body;

    if (!url || !name || !description || !topics) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: url, name, description, topics',
      });
    }

    const result = await toolHandlers.handleAddNotebook({
      url,
      name,
      description,
      topics,
      content_types,
      use_cases,
      tags,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Search notebooks (MUST be before /notebooks/:id to avoid being shadowed)
app.get('/notebooks/search', async (req: Request, res: Response) => {
  try {
    const { query } = req.query;
    if (typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Missing or invalid query parameter',
      });
    }
    const result = await toolHandlers.handleSearchNotebooks({ query });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Get library stats (MUST be before /notebooks/:id to avoid being shadowed)
app.get('/notebooks/stats', async (_req: Request, res: Response) => {
  try {
    const result = await toolHandlers.handleGetLibraryStats();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Scrape notebooks from NotebookLM homepage (MUST be before /notebooks/:id to avoid being shadowed)
app.get('/notebooks/scrape', async (req: Request, res: Response) => {
  try {
    const showBrowser = req.query.show_browser === 'true';

    const result = await toolHandlers.handleListNotebooksFromNblm(
      { show_browser: showBrowser },
      async (message, progress, total) => {
        log.info(`Progress: ${message} (${progress}/${total})`);
      }
    );

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Import scraped notebooks into library (MUST be before /notebooks/:id)
app.post('/notebooks/import-from-scrape', async (req: Request, res: Response) => {
  try {
    const { notebook_ids, auto_discover, show_browser } = req.body;

    // Step 1: Scrape notebooks from NotebookLM
    log.info('📥 [IMPORT] Starting import from scrape...');
    const scrapeResult = await toolHandlers.handleListNotebooksFromNblm(
      { show_browser: show_browser === true },
      async (message, progress, total) => {
        log.info(`Progress: ${message} (${progress}/${total})`);
      }
    );

    if (!scrapeResult.success || !scrapeResult.data) {
      res.status(500).json({
        success: false,
        error: `Scrape failed: ${scrapeResult.error || 'Unknown error'}`,
      });
      return;
    }

    const scrapedNotebooks = scrapeResult.data.notebooks;
    log.info(`  📋 Found ${scrapedNotebooks.length} notebooks from scrape`);

    // Step 2: Filter notebooks if notebook_ids provided
    let notebooksToImport = scrapedNotebooks;
    if (notebook_ids && Array.isArray(notebook_ids) && notebook_ids.length > 0) {
      notebooksToImport = scrapedNotebooks.filter((nb) => notebook_ids.includes(nb.id));
      log.info(`  🔍 Filtered to ${notebooksToImport.length} notebooks`);
    }

    // Step 3: Import each notebook
    const imported: Array<{ id: string; name: string; status: string }> = [];
    const errors: Array<{ id: string; name: string; error: string }> = [];

    for (const notebook of notebooksToImport) {
      try {
        if (auto_discover === true) {
          // Use auto-discovery to generate metadata
          log.info(`  🤖 Auto-discovering: ${notebook.name}`);
          const discoverResult = await toolHandlers.handleAutoDiscoverNotebook({
            url: notebook.url,
          });
          if (discoverResult.success) {
            imported.push({ id: notebook.id, name: notebook.name, status: 'auto-discovered' });
          } else {
            errors.push({
              id: notebook.id,
              name: notebook.name,
              error: discoverResult.error || 'Auto-discovery failed',
            });
          }
        } else {
          // Add with minimal metadata
          log.info(`  📝 Adding: ${notebook.name}`);
          const addResult = await toolHandlers.handleAddNotebook({
            url: notebook.url,
            name: notebook.name,
            description: `Imported from NotebookLM scrape`,
            topics: [notebook.name.toLowerCase().replace(/\s+/g, '-')],
          });
          if (addResult.success) {
            imported.push({ id: notebook.id, name: notebook.name, status: 'imported' });
          } else {
            errors.push({
              id: notebook.id,
              name: notebook.name,
              error: addResult.error || 'Add failed',
            });
          }
        }
      } catch (error) {
        errors.push({
          id: notebook.id,
          name: notebook.name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    log.success(`✅ [IMPORT] Completed: ${imported.length} imported, ${errors.length} errors`);

    res.json({
      success: true,
      data: {
        imported,
        errors,
        total_scraped: scrapedNotebooks.length,
        total_imported: imported.length,
        total_errors: errors.length,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Bulk delete notebooks from NotebookLM (MUST be before /notebooks/:id)
app.delete('/notebooks/bulk-delete', async (req: Request, res: Response) => {
  try {
    const { notebook_ids, show_browser } = req.body;

    if (!notebook_ids || !Array.isArray(notebook_ids) || notebook_ids.length === 0) {
      res.status(400).json({
        success: false,
        error: 'notebook_ids array is required',
      });
      return;
    }

    const result = await toolHandlers.handleDeleteNotebooksFromNblm(
      { notebook_ids, show_browser: show_browser === true },
      async (message, progress, total) => {
        log.info(`Progress: ${message} (${progress}/${total})`);
      }
    );

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Get notebook
app.get('/notebooks/:id', async (req: Request, res: Response) => {
  try {
    const result = await toolHandlers.handleGetNotebook({ id: req.params.id });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Update notebook
app.put('/notebooks/:id', async (req: Request, res: Response) => {
  try {
    const result = await toolHandlers.handleUpdateNotebook({
      id: req.params.id,
      ...req.body,
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Delete notebook
app.delete('/notebooks/:id', async (req: Request, res: Response) => {
  try {
    const result = await toolHandlers.handleRemoveNotebook({ id: req.params.id });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Auto-discover notebook metadata
app.post('/notebooks/auto-discover', async (req: Request, res: Response) => {
  try {
    const { url } = req.body;

    // Validate URL is provided
    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: url',
      });
    }

    // Validate it's a NotebookLM URL (proper URL parsing to prevent bypass)
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.hostname !== 'notebooklm.google.com') {
        return res.status(400).json({
          success: false,
          error: 'Invalid URL: must be a NotebookLM URL (notebooklm.google.com)',
        });
      }
    } catch {
      return res.status(400).json({
        success: false,
        error: 'Invalid URL format',
      });
    }

    // Create AutoDiscovery instance and discover metadata
    const autoDiscovery = new AutoDiscovery(sessionManager);

    let metadata;
    try {
      metadata = await autoDiscovery.discoverMetadata(url);
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: `Failed to discover metadata: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    // Transform metadata to NotebookLibrary format
    // - tags → topics (rename field)
    // - Add default content_types
    // - Add default use_cases based on first few tags
    const notebookInput = {
      url,
      name: metadata.name,
      description: metadata.description,
      topics: metadata.tags, // tags → topics
      content_types: ['documentation'],
      use_cases: metadata.tags.slice(0, 3), // Use first 3 tags as use cases
      auto_generated: true,
    };

    // Add notebook to library
    let notebook;
    try {
      notebook = await library.addNotebook(notebookInput);
    } catch (error) {
      return res.status(500).json({
        success: false,
        error: `Failed to add notebook to library: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    // Return success with created notebook
    res.json({
      success: true,
      notebook,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Create a new notebook in NotebookLM (via browser automation)
app.post('/notebooks/create', async (req: Request, res: Response) => {
  try {
    const { name, show_browser } = req.body;

    const result = await toolHandlers.handleCreateNotebook(
      { name, show_browser },
      async (message, progress, total) => {
        log.info(`Progress: ${message} (${progress}/${total})`);
      }
    );

    if (
      !result.success &&
      /authentication expired|google sign-in redirect/i.test(String(result.error || ''))
    ) {
      res.status(401).json(result);
      return;
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Activate notebook (set as active)
app.put('/notebooks/:id/activate', async (req: Request, res: Response) => {
  try {
    const result = await toolHandlers.handleSelectNotebook({ id: req.params.id });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// List sessions
app.get('/sessions', async (_req: Request, res: Response) => {
  try {
    const result = await toolHandlers.handleListSessions();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Close session
app.delete('/sessions/:id', async (req: Request, res: Response) => {
  try {
    const result = await toolHandlers.handleCloseSession({ session_id: req.params.id });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Reset session
app.post('/sessions/:id/reset', async (req: Request, res: Response) => {
  try {
    const result = await toolHandlers.handleResetSession({ session_id: req.params.id });
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// ========================================
// Content Management Routes
// ========================================

// Add source to notebook
app.post('/content/sources', async (req: Request, res: Response) => {
  try {
    const { source_type, file_path, url, text, title, notebook_url, session_id, show_browser } =
      req.body;

    if (!source_type) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: source_type',
      });
    }

    const result = await toolHandlers.handleAddSource({
      source_type,
      file_path,
      url,
      text,
      title,
      notebook_url,
      session_id,
      show_browser,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Delete source from notebook
app.delete('/content/sources/:id', async (req: Request, res: Response) => {
  try {
    const { notebook_url, session_id } = req.query;
    const sourceId = req.params.id;

    if (!sourceId) {
      return res.status(400).json({
        success: false,
        error: 'Missing source ID in URL path',
      });
    }

    const result = await toolHandlers.handleDeleteSource({
      source_id: sourceId,
      notebook_url: typeof notebook_url === 'string' ? notebook_url : undefined,
      session_id: typeof session_id === 'string' ? session_id : undefined,
    });

    if (!result.success) {
      // Return 404 if source not found
      if (result.error?.includes('not found')) {
        return res.status(404).json(result);
      }
      return res.status(500).json(result);
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Delete source by name (alternative endpoint)
app.delete('/content/sources', async (req: Request, res: Response) => {
  try {
    const { source_name, source_id, notebook_url, session_id } = req.query;

    if (!source_name && !source_id) {
      return res.status(400).json({
        success: false,
        error: 'Missing required query parameter: source_name or source_id',
      });
    }

    const result = await toolHandlers.handleDeleteSource({
      source_id: typeof source_id === 'string' ? source_id : undefined,
      source_name: typeof source_name === 'string' ? source_name : undefined,
      notebook_url: typeof notebook_url === 'string' ? notebook_url : undefined,
      session_id: typeof session_id === 'string' ? session_id : undefined,
    });

    if (!result.success) {
      // Return 404 if source not found
      if (result.error?.includes('not found')) {
        return res.status(404).json(result);
      }
      return res.status(500).json(result);
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Generate content (audio_overview, presentation, report, data_table, infographic, and video are supported)
app.post('/content/generate', async (req: Request, res: Response) => {
  try {
    const {
      content_type,
      custom_instructions,
      notebook_url,
      session_id,
      language,
      video_style,
      video_format,
      infographic_format,
      report_format,
      presentation_style,
      presentation_length,
    } = req.body;

    if (!content_type) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: content_type',
      });
    }

    // Validate content_type is supported
    const supportedTypes = [
      'audio_overview',
      'presentation',
      'report',
      'infographic',
      'data_table',
      'video',
    ];
    if (!supportedTypes.includes(content_type)) {
      return res.status(400).json({
        success: false,
        error:
          `Content type '${content_type}' is not supported. Supported types: ${supportedTypes.join(', ')}. ` +
          'These use real NotebookLM Studio UI buttons or the generic ContentGenerator.',
      });
    }

    // Warn if custom_instructions provided for content types that don't support it
    const noCustomInstructionsTypes = ['report']; // report and mindmap (when implemented) don't support prompts
    if (custom_instructions && noCustomInstructionsTypes.includes(content_type)) {
      return res.status(400).json({
        success: false,
        error:
          `Content type '${content_type}' does not support custom_instructions. ` +
          `Only format/language options are available for this type.`,
      });
    }

    // Validate video_style if provided (only valid for video content type)
    const validVideoStyles = [
      'classroom',
      'documentary',
      'animated',
      'corporate',
      'cinematic',
      'minimalist',
    ];
    if (video_style && !validVideoStyles.includes(video_style)) {
      return res.status(400).json({
        success: false,
        error: `Video style '${video_style}' is not supported. Supported styles: ${validVideoStyles.join(', ')}.`,
      });
    }

    if (video_style && content_type !== 'video') {
      return res.status(400).json({
        success: false,
        error: `video_style is only valid for content_type 'video', not '${content_type}'.`,
      });
    }

    // Validate video_format if provided
    if (video_format && !['brief', 'explainer'].includes(video_format)) {
      return res.status(400).json({
        success: false,
        error: `Video format '${video_format}' is not supported. Supported formats: brief, explainer.`,
      });
    }

    // Validate infographic_format if provided
    if (infographic_format && !['horizontal', 'vertical'].includes(infographic_format)) {
      return res.status(400).json({
        success: false,
        error: `Infographic format '${infographic_format}' is not supported. Supported formats: horizontal, vertical.`,
      });
    }

    // Validate report_format if provided
    if (report_format && !['summary', 'detailed'].includes(report_format)) {
      return res.status(400).json({
        success: false,
        error: `Report format '${report_format}' is not supported. Supported formats: summary, detailed.`,
      });
    }

    // Validate presentation_style if provided
    if (
      presentation_style &&
      !['detailed_slideshow', 'presenter_notes'].includes(presentation_style)
    ) {
      return res.status(400).json({
        success: false,
        error: `Presentation style '${presentation_style}' is not supported. Supported styles: detailed_slideshow, presenter_notes.`,
      });
    }

    // Validate presentation_length if provided
    if (presentation_length && !['short', 'default'].includes(presentation_length)) {
      return res.status(400).json({
        success: false,
        error: `Presentation length '${presentation_length}' is not supported. Supported lengths: short, default.`,
      });
    }

    // Note: data_table has no format options - it exports to Google Sheets

    const result = await toolHandlers.handleGenerateContent({
      content_type,
      custom_instructions,
      notebook_url,
      session_id,
      language,
      video_style,
      video_format,
      infographic_format,
      report_format,
      presentation_style,
      presentation_length,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// List sources and generated content
app.get('/content', async (req: Request, res: Response) => {
  try {
    const { notebook_url, session_id } = req.query;

    const result = await toolHandlers.handleListContent({
      notebook_url: typeof notebook_url === 'string' ? notebook_url : undefined,
      session_id: typeof session_id === 'string' ? session_id : undefined,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Download/export content (audio, video, infographic, presentation, data_table)
app.get('/content/download', async (req: Request, res: Response) => {
  try {
    const { content_type, output_path, notebook_url, session_id } = req.query;

    if (!content_type) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: content_type',
      });
    }

    // Validate content_type is downloadable/exportable
    // - audio_overview, video, infographic: downloadable as files
    // - presentation: exports to Google Slides
    // - data_table: exports to Google Sheets
    // - report: text-based only (no export)
    const exportableTypes = [
      'audio_overview',
      'video',
      'infographic',
      'presentation',
      'data_table',
    ];
    if (!exportableTypes.includes(content_type as string)) {
      return res.status(400).json({
        success: false,
        error:
          `Content type '${content_type}' is not exportable. Exportable types: ${exportableTypes.join(', ')}. ` +
          'Report content is text-based and returned in the generation response.',
      });
    }

    const result = await toolHandlers.handleDownloadContent({
      content_type: content_type as
        | 'audio_overview'
        | 'video'
        | 'infographic'
        | 'presentation'
        | 'data_table',
      output_path: typeof output_path === 'string' ? output_path : undefined,
      notebook_url: typeof notebook_url === 'string' ? notebook_url : undefined,
      session_id: typeof session_id === 'string' ? session_id : undefined,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Download a generated local file from the Railway data directory.
// This exists for Cloudflare workers that need to upload generated media to R2.
app.get('/files/download', async (req: Request, res: Response) => {
  try {
    const filePath = req.query.path;
    if (typeof filePath !== 'string' || !filePath.trim()) {
      return res.status(400).json({
        success: false,
        error: 'Missing required query parameter: path',
      });
    }

    if (/^https?:\/\//i.test(filePath)) {
      return res.status(400).json({
        success: false,
        error: 'Remote URLs should be fetched directly by the caller',
      });
    }

    const dataDir = path.resolve(CONFIG.dataDir);
    const resolvedPath = path.resolve(filePath);
    if (resolvedPath !== dataDir && !resolvedPath.startsWith(`${dataDir}${path.sep}`)) {
      return res.status(403).json({
        success: false,
        error: 'File path is outside the allowed data directory',
      });
    }

    const stat = await fs.stat(resolvedPath);
    if (!stat.isFile()) {
      return res.status(400).json({
        success: false,
        error: 'Path is not a file',
      });
    }

    const file = await fs.readFile(resolvedPath);
    res.setHeader('Content-Type', contentTypeForPath(resolvedPath));
    res.setHeader('Content-Length', String(file.length));
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(resolvedPath)}"`);
    res.send(file);
  } catch (error) {
    res.status(404).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Create a note in the notebook
app.post('/content/notes', async (req: Request, res: Response) => {
  try {
    const { title, content, notebook_url, session_id } = req.body;

    if (!title) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: title',
      });
    }

    if (!content) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: content',
      });
    }

    const result = await toolHandlers.handleCreateNote({
      title,
      content,
      notebook_url,
      session_id,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Save chat/discussion to a note
app.post('/content/chat-to-note', async (req: Request, res: Response) => {
  try {
    const { title, notebook_url, session_id } = req.body;

    const result = await toolHandlers.handleSaveChatToNote({
      title,
      notebook_url,
      session_id,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Convert a note to a source
app.post('/content/notes/:noteTitle/to-source', async (req: Request, res: Response) => {
  try {
    const { noteTitle } = req.params;
    const { notebook_url, session_id } = req.body;

    if (!noteTitle) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameter: noteTitle',
      });
    }

    const result = await toolHandlers.handleConvertNoteToSource({
      note_title: decodeURIComponent(noteTitle),
      notebook_url,
      session_id,
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

// Global error handler - catches any unhandled errors in async routes
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  const reqId = req.requestId?.substring(0, 8) || 'unknown';
  log.error(`[${reqId}] Unhandled error: ${err.message}`);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    requestId: req.requestId,
  });
});

// Start server with startup sequence
const PORT = Number(process.env.PORT) || Number(process.env.HTTP_PORT) || 3000;
const HOST = process.env.HTTP_HOST || '0.0.0.0';
const VERSION = '1.5.3';
const RUN_STARTUP_SEQUENCE = process.env.RUN_STARTUP_SEQUENCE === 'true';

const startupManager = new StartupManager(authManager);

// ============================================================================
// Port management: detect and free ghost processes
// ============================================================================

/**
 * Check if a port is currently in use
 */
function checkPort(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true); // port is in use
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false); // port is free
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false); // port is free
    });
    socket.connect(port, host === '0.0.0.0' ? '127.0.0.1' : host);
  });
}

/**
 * Try to determine if the process on the port is a ghost (not responding to /health)
 */
async function isGhostProcess(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    // If it responds, it's a live server — not a ghost
    return !res.ok;
  } catch {
    // No response = ghost process
    return true;
  }
}

/**
 * Try to kill the process occupying a port
 */
function tryKillPort(port: number): boolean {
  const isWindows = process.platform === 'win32';
  try {
    if (isWindows) {
      // On Windows, find PID and kill it
      const output = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
      const lines = output.trim().split('\n');
      const pids = new Set<string>();
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && pid !== '0') pids.add(pid);
      }
      for (const pid of pids) {
        try {
          execSync(`taskkill /F /PID ${pid}`, { timeout: 5000 });
          log.info(`  Killed PID ${pid}`);
        } catch {
          // PID may already be dead
        }
      }
      return pids.size > 0;
    } else {
      // On Linux/WSL, use fuser
      execSync(`fuser -k ${port}/tcp`, { timeout: 5000 });
      return true;
    }
  } catch {
    return false;
  }
}

/**
 * Start the HTTP server with port conflict detection
 */
async function startServer(port: number, host: string): Promise<void> {
  const portBusy = await checkPort(port, host);

  if (portBusy) {
    log.warning(`Port ${port} is already in use, checking if it's a ghost process...`);

    const ghost = await isGhostProcess(port);
    if (ghost) {
      log.warning(`Ghost process detected on port ${port}, attempting to free it...`);
      const freed = tryKillPort(port);

      if (freed) {
        log.success(`Port ${port} freed successfully`);
        // Wait for OS to release the port
        await new Promise((resolve) => setTimeout(resolve, 1500));

        // Verify port is now free
        const stillBusy = await checkPort(port, host);
        if (stillBusy) {
          log.error(`Port ${port} is still in use after kill attempt.`);
          log.error(`  Manual fix:`);
          log.error(`    Linux/WSL: fuser -k ${port}/tcp`);
          log.error(`    Windows:   netstat -ano | findstr :${port}`);
          log.error(`               taskkill /F /PID <PID>`);
          process.exit(1);
        }
      } else {
        log.error(`Could not free port ${port}.`);
        log.error(`  Manual fix:`);
        log.error(`    Linux/WSL: fuser -k ${port}/tcp`);
        log.error(`    Windows PowerShell: wsl --shutdown (then retry)`);
        log.error(`    Windows:   netstat -ano | findstr :${port}`);
        log.error(`               taskkill /F /PID <PID>`);
        process.exit(1);
      }
    } else {
      // Port is busy but it's a live server responding to /health
      log.error(`Port ${port} is already used by a running NotebookLM server.`);
      log.error(`  Stop the other instance first, or use HTTP_PORT=<other_port>`);
      process.exit(1);
    }
  }

  // Start the server
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        log.error(`Port ${port} became busy during startup (race condition).`);
        log.error(`  Retry or use HTTP_PORT=<other_port>`);
        process.exit(1);
      }
      reject(err);
    });

    server.once('listening', () => {
      resolve();
    });
  });
}

// Main startup
(async () => {
  await startServer(PORT, HOST);

  log.success(`🌐 NotebookLM MCP HTTP Server v${VERSION}`);
  log.success(`   Listening on ${HOST}:${PORT}`);

  // Production HTTP mode must become ready immediately. Manual Google auth is
  // triggered per account from the admin panel, so startup browser verification
  // is opt-in for local/debug runs only.
  const startupResult = RUN_STARTUP_SEQUENCE
    ? await startupManager.startup()
    : {
        success: true,
        serverStarted: true,
        authenticated: false,
        message: 'Startup auth verification skipped',
        details: [] as string[],
      };

  if (!RUN_STARTUP_SEQUENCE) {
    log.info('🚦 Startup auth verification skipped (set RUN_STARTUP_SEQUENCE=true to enable)');
  }

  // Show quick links and endpoints after startup
  log.info('');
  log.info('📊 Quick Links:');
  log.info(`   Health check: http://localhost:${PORT}/health`);
  log.info(`   API endpoint: http://localhost:${PORT}/ask`);
  log.info('');
  log.info('📖 Available Endpoints:');
  log.info('   Authentication:');
  log.info('   POST   /setup-auth             First-time authentication');
  log.info('   POST   /de-auth                Logout (clear credentials)');
  log.info('   POST   /re-auth                Re-authenticate / switch account');
  log.info('   POST   /cleanup-data           Clean all data (requires confirm)');
  log.info('');
  log.info('   Queries:');
  log.info('   POST   /ask                    Ask a question to NotebookLM');
  log.info('   GET    /health                 Server health check');
  log.info('');
  log.info('   Account Pool:');
  log.info('   GET    /accounts               Account pool overview');
  log.info('   GET    /accounts/health        Account health and quota status');
  log.info('   PUT    /accounts/strategy      Set rotation strategy');
  log.info('   POST   /accounts/:id/enable    Enable an account');
  log.info('   POST   /accounts/:id/disable   Disable an account');
  log.info('   PUT    /accounts/:id/priority  Set failover priority');
  log.info('   POST   /accounts/:id/test      Test/login stored account');
  log.info('');
  log.info('   Notebooks:');
  log.info('   GET    /notebooks              List all notebooks');
  log.info('   POST   /notebooks              Add a new notebook');
  log.info('   POST   /notebooks/auto-discover Auto-discover notebook metadata');
  log.info('   GET    /notebooks/search       Search notebooks by query');
  log.info('   GET    /notebooks/stats        Get library statistics');
  log.info('   GET    /notebooks/scrape       Scrape real notebooks from NotebookLM');
  log.info('   GET    /notebooks/:id          Get notebook details');
  log.info('   PUT    /notebooks/:id          Update notebook metadata');
  log.info('   DELETE /notebooks/:id          Delete a notebook');
  log.info('   PUT    /notebooks/:id/activate Activate a notebook (set as default)');
  log.info('');
  log.info('   Sessions:');
  log.info('   GET    /sessions               List active sessions');
  log.info('   POST   /sessions/:id/reset     Reset session history');
  log.info('   DELETE /sessions/:id           Close a session');
  log.info('');
  log.info('   Content Management:');
  log.info('   POST   /content/sources        Add source to notebook');
  log.info('   DELETE /content/sources/:id    Delete source by ID');
  log.info('   DELETE /content/sources        Delete source by name (query param)');
  log.info('   POST   /content/generate       Generate content (audio, video, etc.)');
  log.info('   GET    /content/download       Download/export generated content');
  log.info('   GET    /files/download         Download a generated local file');
  log.info('   POST   /content/notes          Create a note in the notebook');
  log.info('   POST   /content/chat-to-note   Save chat/discussion to a note');
  log.info('   POST   /content/notes/:title/to-source  Convert note to source');
  log.info('   GET    /content                List sources and content');
  log.info('');
  log.info('💡 Configuration:');
  log.info(
    `   Host: ${HOST} ${HOST === '0.0.0.0' ? '(accessible from network)' : '(localhost only)'}`
  );
  log.info(`   Port: ${PORT}`);

  // Show startup result summary
  log.info('');
  if (startupResult.authenticated) {
    log.success(
      `🔐 Status: Authenticated${startupResult.accountEmail ? ` as ${startupResult.accountEmail}` : ''}`
    );
  } else {
    log.warning(`🔐 Status: Not authenticated - ${startupResult.message}`);
  }
  log.info('');
  log.dim('📖 Documentation: ./deployment/docs/');
  log.dim('⏹️  Press Ctrl+C to stop');
})();

// Graceful shutdown with error handling
process.on('SIGTERM', async () => {
  log.info('SIGTERM received, shutting down gracefully...');
  try {
    await toolHandlers.cleanup();
  } catch (error) {
    log.error(`Cleanup failed: ${error}`);
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  log.info('SIGINT received, shutting down gracefully...');
  try {
    await toolHandlers.cleanup();
  } catch (error) {
    log.error(`Cleanup failed: ${error}`);
  }
  process.exit(0);
});

function contentTypeForPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const contentTypes: Record<string, string> = {
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.json': 'application/json',
    '.txt': 'text/plain; charset=utf-8',
  };

  return contentTypes[ext] || 'application/octet-stream';
}
