import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join } from 'path';
import { validatePost } from './validator.js';

const BETA_HEADER = 'managed-agents-2026-04-01';

function readPrompt(filename: string): string {
  return readFileSync(join(import.meta.dirname, '../config', filename), 'utf-8');
}

function readPipelineConfig() {
  return JSON.parse(
    readFileSync(join(import.meta.dirname, '../config/pipeline.json'), 'utf-8')
  ) as { managed: { model: string } };
}

// Intentional use of `any` — Managed Agents API is beta and not in SDK types yet
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function betaClient(client: Anthropic): any {
  return (client as unknown as Record<string, unknown>).beta;
}

export async function createManagedAgent(): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const config = readPipelineConfig();
  const systemPrompt = readPrompt('kesha-agent-prompt.txt');

  const agent = await betaClient(client).managedAgents.agents.create(
    {
      model: config.managed.model,
      system_prompt: systemPrompt,
      tools: ['bash', 'web_search', 'web_fetch', 'file_read', 'file_write'],
    },
    { headers: { 'anthropic-beta': BETA_HEADER } }
  );

  return agent.id as string;
}

export async function createManagedEnvironment(): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const env = await betaClient(client).managedAgents.environments.create(
    { packages: [] },
    { headers: { 'anthropic-beta': BETA_HEADER } }
  );

  return env.id as string;
}

async function runSession(agentId: string, environmentId: string): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const date = new Date().toLocaleDateString('ru-RU', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const session = await betaClient(client).managedAgents.sessions.create(
    { agent_id: agentId, environment_id: environmentId },
    { headers: { 'anthropic-beta': BETA_HEADER } }
  );

  await betaClient(client).managedAgents.sessions.events.create(
    session.id,
    {
      type: 'user',
      content: `Сегодня ${date}. Выполни свой рабочий процесс и подготовь пост.`,
    },
    { headers: { 'anthropic-beta': BETA_HEADER } }
  );

  // Wait for session to complete via SSE stream
  await new Promise<void>((resolve, reject) => {
    const stream = betaClient(client).managedAgents.sessions.stream(session.id, {
      headers: { 'anthropic-beta': BETA_HEADER },
    });

    stream.on('event', (event: { type: string; error?: string }) => {
      console.log(`[managed-agent] event: ${event.type}`);
      if (event.type === 'session.completed') resolve();
      if (event.type === 'session.failed') reject(new Error(`Session failed: ${event.error ?? 'unknown'}`));
    });

    stream.on('error', reject);
  });

  // Read final post from container filesystem
  const file = await betaClient(client).managedAgents.sessions.files.read(
    session.id,
    '/tmp/final_post.txt',
    { headers: { 'anthropic-beta': BETA_HEADER } }
  );

  return file.content as string;
}

export interface ManagedResult {
  success: boolean;
  post?: string;
  errors?: string[];
}

export async function generateManagedPost(): Promise<ManagedResult> {
  const agentId = process.env.MANAGED_AGENT_ID;
  const environmentId = process.env.MANAGED_ENVIRONMENT_ID;

  if (!agentId || !environmentId) {
    throw new Error(
      'MANAGED_AGENT_ID and MANAGED_ENVIRONMENT_ID must be set. Run: npm run setup:managed'
    );
  }

  try {
    const post = await runSession(agentId, environmentId);
    const validation = validatePost(post);

    return {
      success: validation.valid,
      post: validation.valid ? post : undefined,
      errors: validation.valid ? undefined : validation.errors,
    };
  } catch (err) {
    console.error('[managed-agent] session error:', err);
    return {
      success: false,
      errors: [err instanceof Error ? err.message : String(err)],
    };
  }
}
