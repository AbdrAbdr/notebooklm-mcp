import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { AuthManager } from './auth/auth-manager.js';
import { SessionManager } from './session/session-manager.js';
import { NotebookLibrary } from './library/notebook-library.js';
import { ToolHandlers } from './tools/index.js';
import { buildToolDefinitions } from './tools/index.js';
import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { log } from './utils/logger.js';
import cors from 'cors';

const app = express();
app.use(cors());

// Internal state
const authManager = new AuthManager();
const sessionManager = new SessionManager(authManager);
const library = new NotebookLibrary();
const toolHandlers = new ToolHandlers(sessionManager, authManager, library);
const toolDefinitions = buildToolDefinitions(library) as Tool[];

const server = new Server(
  {
    name: 'notebooklm-mcp-sse',
    version: '1.4.2',
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// Setup Request Handlers (Copied structure from index.ts)
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: toolDefinitions,
}));

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const notebooks = library.listNotebooks();
  const resources = [
    {
      uri: 'notebooklm://library',
      name: 'Notebook Library',
      description: 'Complete notebook library with all available knowledge sources.',
      mimeType: 'application/json',
    },
  ];
  for (const notebook of notebooks) {
    resources.push({
      uri: `notebooklm://library/${notebook.id}`,
      name: notebook.name,
      description: `${notebook.description} | Topics: ${notebook.topics.join(', ')}`,
      mimeType: 'application/json',
    });
  }
  return { resources };
});

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [
    {
      uriTemplate: 'notebooklm://library/{id}',
      name: 'Notebook by ID',
      description: 'Access a specific notebook from your library by ID.',
      mimeType: 'application/json',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  if (uri === 'notebooklm://library') {
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(library.listNotebooks(), null, 2),
        },
      ],
    };
  }
  const match = uri.match(/^notebooklm:\/\/library\/(.+)$/);
  if (match) {
    const id = match[1];
    const notebook = library.getNotebook(id);
    if (!notebook) throw new McpError(ErrorCode.InvalidRequest, `Notebook ${id} not found`);
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(notebook, null, 2),
        },
      ],
    };
  }
  throw new McpError(ErrorCode.InvalidRequest, `Resource not found: ${uri}`);
});

// Setup Tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments || {};
  let result: unknown;
  const sendProgress = async () => {}; // Mock progress

  try {
    switch (name) {
      case 'ask_question':
        result = await toolHandlers.handleAskQuestion(args as any, sendProgress);
        break;
      case 'auto_discover_notebook':
        result = await toolHandlers.handleAutoDiscoverNotebook(args as any);
        break;
      case 'add_notebook':
        result = await toolHandlers.handleAddNotebook(args as any);
        break;
      case 'list_notebooks':
        result = await toolHandlers.handleListNotebooks();
        break;
      case 'get_notebook':
        result = await toolHandlers.handleGetNotebook(args as any);
        break;
      case 'select_notebook':
        result = await toolHandlers.handleSelectNotebook(args as any);
        break;
      case 'update_notebook':
        result = await toolHandlers.handleUpdateNotebook(args as any);
        break;
      case 'remove_notebook':
        result = await toolHandlers.handleRemoveNotebook(args as any);
        break;
      case 'search_notebooks':
        result = await toolHandlers.handleSearchNotebooks(args as any);
        break;
      case 'get_library_stats':
        result = await toolHandlers.handleGetLibraryStats();
        break;
      case 'list_sessions':
        result = await toolHandlers.handleListSessions();
        break;
      case 'close_session':
        result = await toolHandlers.handleCloseSession(args as any);
        break;
      case 'reset_session':
        result = await toolHandlers.handleResetSession(args as any);
        break;
      case 'get_health':
        result = await toolHandlers.handleGetHealth();
        break;
      case 'setup_auth':
        result = await toolHandlers.handleSetupAuth(args as any, sendProgress);
        break;
      case 'de_auth':
        result = await toolHandlers.handleDeAuth();
        break;
      case 're_auth':
        result = await toolHandlers.handleReAuth(args as any, sendProgress);
        break;
      case 'cleanup_data':
        result = await toolHandlers.handleCleanupData(args as any);
        break;
      case 'add_source':
        result = await toolHandlers.handleAddSource(args as any);
        break;
      case 'delete_source':
        result = await toolHandlers.handleDeleteSource(args as any);
        break;
      case 'generate_content':
        result = await toolHandlers.handleGenerateContent(args as any);
        break;
      case 'list_content':
        result = await toolHandlers.handleListContent(args as any);
        break;
      case 'download_content':
        result = await toolHandlers.handleDownloadContent(args as any);
        break;
      case 'create_note':
        result = await toolHandlers.handleCreateNote(args as any);
        break;
      case 'save_chat_to_note':
        result = await toolHandlers.handleSaveChatToNote(args as any);
        break;
      case 'convert_note_to_source':
        result = await toolHandlers.handleConvertNoteToSource(args as any);
        break;
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: 'text',
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        },
      ],
      isError: false,
    };
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// SSE Transport setup
let transport: SSEServerTransport;

app.get('/mcp', async (_req, res) => {
  transport = new SSEServerTransport('/message', res);
  await server.connect(transport);
  log.info('🔌 New MCP SSE Connection established');
});

app.post('/message', async (req, res) => {
  if (!transport) {
    res.status(400).send('No active SSE connection');
    return;
  }
  await transport.handlePostMessage(req, res);
});

// Serve health
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', mcp: 'enabled', sseEndpoint: '/mcp' });
});

const PORT = process.env.PORT || process.env.HTTP_PORT || 3000;
app.listen(PORT, () => {
  log.info(`🚀 NotebookLM MCP SSE Server listening on port ${PORT}`);
  log.info(`📡 MCP Endpoint: http://localhost:${PORT}/mcp`);
});
