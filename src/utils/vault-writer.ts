/**
 * Vault writer — formats NotebookLM answers as RTFM-ingestable markdown files
 *
 * Each answer is written as two artifacts:
 *   - {slug}.md   — markdown with YAML frontmatter (human + RTFM markdown parser)
 *   - {slug}.json — structured payload conforming to nblm-answer-v1 schema
 *
 * Schema URL: https://schemas.roomi-fields.com/nblm-answer-v1.json
 */

import type { AskQuestionSuccess, Citation } from '../types.js';

export interface NotebookMeta {
  id?: string;
  name?: string;
  url?: string;
}

export interface NblmAnswerPayload {
  $schema: string;
  type: 'nblm-answer';
  version: '1.0';
  asked_at: string;
  session_id: string | null;
  notebook: {
    id: string | null;
    name: string | null;
    url: string | null;
  };
  question: string;
  answer: {
    text: string;
    format: 'markdown';
  };
  citations: Array<{
    marker: string;
    number: number;
    source_name: string | null;
    source_text: string | null;
  }>;
  metadata: {
    tags: string[];
    extraction_success: boolean | null;
    citations_count: number;
    source_names: string[];
  };
}

export const NBLM_ANSWER_SCHEMA_URL = 'https://schemas.roomi-fields.com/nblm-answer-v1.json';

/**
 * Slugify a question into a filesystem-safe filename component.
 * Truncates to ~80 chars and prefixes with a zero-padded index.
 */
export function makeSlug(question: string, prefix: string, index: number): string {
  const base = question
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 80)
    .replace(/-+$/, '')
    .replace(/^-+/, '');
  const idx = String(index + 1).padStart(3, '0');
  const cleanBase = base || 'question';
  return prefix ? `${prefix}-${idx}-${cleanBase}` : `${idx}-${cleanBase}`;
}

/**
 * Escape a string for safe use as a YAML scalar value.
 * Wraps in double quotes and escapes backslashes + double quotes.
 */
function yamlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Format a NotebookLM answer as a vault-ready markdown document
 * with YAML frontmatter compatible with RTFM's markdown parser.
 */
export function formatAnswerMarkdown(
  data: AskQuestionSuccess,
  notebookMeta: NotebookMeta,
  askedAt: string
): string {
  const citations: Citation[] = data.sources?.citations ?? [];
  const sourceNames = Array.from(
    new Set(citations.map((c) => c.sourceName).filter((s): s is string => Boolean(s)))
  );

  const frontmatterLines: string[] = ['---'];
  frontmatterLines.push(`title: ${yamlString(data.question)}`);
  frontmatterLines.push(`type: nblm-answer`);
  frontmatterLines.push(`asked_at: ${askedAt}`);
  if (notebookMeta.id) frontmatterLines.push(`notebook_id: ${yamlString(notebookMeta.id)}`);
  if (notebookMeta.name) frontmatterLines.push(`notebook_name: ${yamlString(notebookMeta.name)}`);
  if (notebookMeta.url || data.notebook_url) {
    frontmatterLines.push(`notebook_url: ${yamlString(notebookMeta.url ?? data.notebook_url)}`);
  }
  if (data.session_id) frontmatterLines.push(`session_id: ${yamlString(data.session_id)}`);
  frontmatterLines.push(`citations_count: ${citations.length}`);
  if (sourceNames.length > 0) {
    frontmatterLines.push('sources:');
    for (const name of sourceNames) {
      frontmatterLines.push(`  - ${yamlString(name)}`);
    }
  }
  frontmatterLines.push('---');

  const sourcesBlock =
    citations.length > 0
      ? '\n\n## Sources\n\n' +
        citations
          .map((c) => {
            const name = c.sourceName ?? 'Unknown source';
            const text = (c.sourceText ?? '').trim();
            const quoted = text ? text.replace(/\r?\n/g, '\n> ') : '_(no excerpt)_';
            return `### [${c.number}] ${name}\n\n> ${quoted}`;
          })
          .join('\n\n')
      : '';

  const notebookLink =
    notebookMeta.url || data.notebook_url
      ? `\n\n> Asked on ${askedAt} against [${notebookMeta.name ?? 'NotebookLM notebook'}](${notebookMeta.url ?? data.notebook_url})`
      : '';

  return `${frontmatterLines.join('\n')}

# ${data.question}${notebookLink}

## Answer

${data.answer}${sourcesBlock}
`;
}

/**
 * Build the structured JSON payload (sidecar) for a NotebookLM answer.
 * Conforms to nblm-answer-v1 schema.
 */
export function formatAnswerJson(
  data: AskQuestionSuccess,
  notebookMeta: NotebookMeta,
  askedAt: string
): NblmAnswerPayload {
  const citations: Citation[] = data.sources?.citations ?? [];
  const sourceNames = Array.from(
    new Set(citations.map((c) => c.sourceName).filter((s): s is string => Boolean(s)))
  );

  return {
    $schema: NBLM_ANSWER_SCHEMA_URL,
    type: 'nblm-answer',
    version: '1.0',
    asked_at: askedAt,
    session_id: data.session_id ?? null,
    notebook: {
      id: notebookMeta.id ?? null,
      name: notebookMeta.name ?? null,
      url: notebookMeta.url ?? data.notebook_url ?? null,
    },
    question: data.question,
    answer: {
      text: data.answer,
      format: 'markdown',
    },
    citations: citations.map((c) => ({
      marker: c.marker,
      number: c.number,
      source_name: c.sourceName ?? null,
      source_text: c.sourceText ?? null,
    })),
    metadata: {
      tags: [],
      extraction_success: data.sources?.extraction_success ?? null,
      citations_count: citations.length,
      source_names: sourceNames,
    },
  };
}
