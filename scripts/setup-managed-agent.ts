import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BETA_HEADER = 'managed-agents-2026-04-01';

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Error: ANTHROPIC_API_KEY not set');
    process.exit(1);
  }

  const client = new Anthropic({ apiKey });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const beta = (client as unknown as Record<string, any>).beta;

  const systemPrompt = readFileSync(
    join(__dirname, '../src/config/kesha-agent-prompt.txt'),
    'utf-8'
  );

  const config = JSON.parse(
    readFileSync(join(__dirname, '../src/config/pipeline.json'), 'utf-8')
  ) as { managed: { model: string } };

  console.log('Creating Managed Agent...');
  const agent = await beta.managedAgents.agents.create(
    {
      model: config.managed.model,
      system_prompt: systemPrompt,
      tools: ['bash', 'web_search', 'web_fetch', 'file_read', 'file_write'],
    },
    { headers: { 'anthropic-beta': BETA_HEADER } }
  );
  console.log(`Agent created: ${agent.id}`);

  console.log('Creating Environment...');
  const env = await beta.managedAgents.environments.create(
    { packages: [] },
    { headers: { 'anthropic-beta': BETA_HEADER } }
  );
  console.log(`Environment created: ${env.id}`);

  console.log('\n=== Add these to your Netlify env vars ===');
  console.log(`MANAGED_AGENT_ID=${agent.id}`);
  console.log(`MANAGED_ENVIRONMENT_ID=${env.id}`);
  console.log('==========================================\n');
}

main().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
