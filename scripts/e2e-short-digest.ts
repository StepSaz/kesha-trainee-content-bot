/**
 * E2E smoke test for the short digest pipeline (generateShortDigest).
 *
 * Runs the REAL pipeline end to end: Hacker News + light web search →
 * select topics → generate short post → review → validate + fix loop.
 * Prints the produced post, the selected-topic count, per-step timing,
 * and an independent validateShort check.
 *
 * Required env: ANTHROPIC_API_KEY (web search / HN gather may also use
 * other providers; the script warns but still runs).
 *
 *   npx tsx scripts/e2e-short-digest.ts
 *   # or: npm run e2e:short-digest
 */
import { generateShortDigest } from '../src/lib/short-digest.js';
import { validateShort, countLinkedSources } from '../src/lib/validator.js';

function checkEnv(): void {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Missing env: ANTHROPIC_API_KEY');
    process.exit(1);
  }
  if (!process.env.TAVILY_API_KEY) {
    console.warn('⚠️  TAVILY_API_KEY not set — light web search may return less context (pipeline still runs).');
  }
}

async function main(): Promise<void> {
  checkEnv();
  console.log('Smoke: short digest pipeline (generateShortDigest)\n');

  const t0 = Date.now();
  const result = await generateShortDigest({ memoryEntries: [] });
  const elapsed = Date.now() - t0;

  console.log(`── Result ──`);
  console.log(`success: ${result.success}`);
  console.log(`topics selected: ${result.selectedTopics.topics.length}`);
  console.log(`elapsed: ${elapsed}ms`);
  console.log(`timing: ${JSON.stringify(result.timing)}`);

  if (result.selectedTopics.topics.length > 0) {
    console.log(`\n── Selected topics ──`);
    result.selectedTopics.topics.forEach((t, i) => {
      console.log(`${i + 1}. ${t.title} (${t.sourceUrl})`);
    });
  }

  if (!result.success) {
    console.log(`\n❌ Pipeline failed. Errors:`);
    (result.errors ?? []).forEach((e) => console.log(`  - ${e}`));
    if (result.draft) {
      console.log(`\n── Last draft (failed validation) ──\n${result.draft}`);
    }
    process.exit(1);
  }

  const post = result.post!;
  console.log(`\n── Generated short digest ──\n${post}`);

  // Independent validation summary (the pipeline already validated, but show it explicitly).
  const v = validateShort(post);
  const linked = countLinkedSources(post);
  console.log(`\n── Validation ──`);
  console.log(`validateShort.valid: ${v.valid}`);
  console.log(`linked sources (📎+URL lines): ${linked} (topics: ${result.selectedTopics.topics.length})`);
  console.log(`post length: ${post.length} chars`);
  if (!v.valid) {
    console.log(`validation errors: ${v.errors.join('; ')}`);
  }

  const ok = v.valid && linked === result.selectedTopics.topics.length;
  console.log(`\n${ok ? '✅ PASS' : '❌ FAIL'} — post ${ok ? 'is valid and bullet count matches topics' : 'has validation/count issues'}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
