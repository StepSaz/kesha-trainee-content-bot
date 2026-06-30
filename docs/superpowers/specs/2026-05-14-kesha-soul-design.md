# Kesha Soul: Adding Lived Experience to Digests

## Problem

Channel analytics show readers value humanity and lived experience — content "filtered through a person." Kesha's digests are informative but lack this quality: intros have personality, but news sections read as factual summaries without personal engagement. The persona prompt explicitly restricts character to intro/conclusion, making sections dry.

## Solution: Approach B — New Pipeline Step + Persona Update

Two changes:
1. New `experienceTopics` pipeline step that generates personal reactions for each selected topic
2. Updated `kesha-persona.txt` to allow and require personal moments in news sections

## New Pipeline Step: `experienceTopics`

### Position in Pipeline

```
selectTopics → experienceTopics (NEW) → generatePost → reviewPost → ...
```

Sequential after `selectTopics` — needs the selected topics as input.

### Input

- `SelectedTopic[]` from the previous step
- `hnContext` and `webContext` — raw source material so reactions reference specific details, not abstract headlines

### Output

Structured via `callClaudeStructured` with tool `experience_topics`:

```typescript
interface TopicExperience {
  topicTitle: string;
  reaction: string;        // 1-2 sentences, first person, Kesha's voice
  reactionType: ReactionType;
}

type ReactionType =
  | 'studied'    // dug into docs, demos, examples
  | 'hooked'     // a specific number or fact caught attention while reading
  | 'surprised'  // expectation vs reality mismatch
  | 'connected'  // link to past channel topics or trainee context
  | 'confused'   // honest bewilderment
  | 'personal'   // what this means for Kesha/the channel audience
  | 'compared';  // juxtaposition with something familiar
```

### Seven Reaction Types

1. **studied** — went deeper: docs, demos, examples. Honest for a bot: "opened the docs — they show how to spin up an agent in three prompts, suspiciously simple"
2. **hooked** — a specific detail snagged attention while reading: "$40B — that's more than the whole market was two years ago"
3. **surprised** — expectation subverted: "thought it was another minor update — turns out they rebuilt the whole architecture"
4. **connected** — link to past topics or trainee context: "we were guessing about this last week — here's the answer"
5. **confused** — genuine bewilderment: "read it three times — still don't understand why they need this now"
6. **personal** — what it means for Kesha/audience: "if this takes off, half my job becomes unnecessary"
7. **compared** — juxtaposition: "competitors charge $20, these guys offer it free — something doesn't add up"

### Constraint

No reaction type may repeat within a single post. With 3-5 topics and 7 types, this forces variety.

### System Prompt (experience step)

Short prompt establishing Kesha as a trainee reading through selected topics and reacting. Includes:
- The 7 reaction types with examples
- Rule: no type repetition within one request
- Instruction to ground reactions in specific details from the source material, not generic commentary

### Model Config

New key in `pipeline.json`:

```json
"experience": {
  "model": "claude-sonnet-5-20260401",
  "temperature": 0.7,
  "max_tokens": 1024,
  "tools": []
}
```

Sonnet (not Haiku) — reactions require creativity and character knowledge. Temperature 0.7 for liveliness without chaos. 1024 tokens is sufficient for 5 reactions of 1-2 sentences each.

## Persona Prompt Changes

### Current Rule (to be replaced)

> "Шутки, самоирония, 'я маленький бот', неуверенность — ТОЛЬКО во вступлении и выводе. Сами секции — без 'я бот', без 'звучит серьёзно', без явной самоиронии."

### New Rule

Self-irony ("я бот") remains restricted to intro and conclusion. But each news section now **requires one personal moment** — Kesha's reaction to the topic. Not as a separate paragraph, but woven into the text.

The seven reaction types are listed in the prompt with examples. The model picks the appropriate one per topic. No type repetition within a post.

### How Reactions Reach generatePost

In the `topicsProse` block passed to generatePost, each topic's summary gets an appended line:

```
Твоя реакция: {reaction}
```

Plus an instruction in the userMessage: "Для каждой темы у тебя есть личная реакция — вплети её в текст секции естественно, не как отдельный абзац."

## Cost and Latency Impact

- +1 Sonnet API call per digest (~$0.02-0.05)
- +5-10s latency (single call, 1024 max tokens)
- Monthly impact: ~$0.10-0.20 (4 digests/month)

## Files to Change

1. `src/config/pipeline.json` — add `experience` step config
2. `src/config/kesha-persona.txt` — update section voice rules, add reaction types
3. `src/lib/pipeline.ts` — add `experienceTopics()` function, wire into `generatePipelinePost()`
4. New file: `src/config/kesha-experience.txt` — system prompt for the experience step (or inline in pipeline.ts)
