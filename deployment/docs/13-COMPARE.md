# Comparing NotebookLM MCP servers

There are a handful of community projects that automate Google NotebookLM. The two most active TypeScript implementations are **`PleasePrompto/notebooklm-mcp`** (the original, MCP-only) and **`@roomi-fields/notebooklm-mcp`** (this project — REST API + MCP, Studio-complete, batch-oriented).

This page is an honest, side-by-side comparison so you can pick the right one for your workflow. Both are MIT-licensed and actively maintained.

> **TL;DR**
>
> - You want a quick **MCP server** for Claude Code / Cursor / Codex with citations and audio overviews → either works; PleasePrompto v2 is a clean, MCP-spec-first build.
> - You need a **REST API** to call from n8n / Zapier / Make / curl / any non-MCP client → use this project. PleasePrompto v2 ships MCP-over-HTTP (Streamable HTTP transport) which is **not** a REST API.
> - You generate **video / infographic / presentation / data table** from NotebookLM Studio → use this project. PleasePrompto v2 ships audio only; the rest is deferred to a follow-up.
> - You run **long batches** (PhD research, market reports, content pipelines) and need **auto-reauth with TOTP** → use this project. PleasePrompto v2 explicitly does not store credentials.
