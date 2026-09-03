/**
 * Vera — writes the worker.
 *
 * Vera is the planner behind the fan-out runner: give her a batch job in plain
 * English and she returns one self-contained Python worker script. It's built
 * on an NVIDIA Nemotron model over the OpenAI-compatible endpoint, but the
 * product only ever talks about "Vera".
 *
 * The worker runs once per shard in a parallel pool, so the contract is tight:
 * it's told about the WORKER_INDEX / WORKER_COUNT env vars Scope injects, it may
 * use the internet and `pip`, and it must print exactly one JSON object per
 * item — including failures — so nothing silently disappears.
 */
import { config } from "./config.js"

const SYSTEM = `You are Vera. You output ONE Python 3 script and nothing else — no markdown fences, no commentary, no explanation.

Runtime: Debian, Python 3.11, full outbound internet, and \`pip install\` works.
If you need a package, install it at the top of the script:
  import subprocess, sys
  subprocess.run([sys.executable, "-m", "pip", "install", "-q", "requests"], check=False)

This script is ONE worker in a parallel pool. Two environment variables are set:
  WORKER_INDEX  - this worker's 0-based number
  WORKER_COUNT  - total number of workers

- If the job is over a list or range of items:
    1. Build the full list of items the job asks for. If the job names a count
       ("top 15", "first 100", "the 30 …"), the full list is EXACTLY that many
       — apply the limit here, before anything else.
    2. Then take only this worker's slice: full_list[WORKER_INDEX::WORKER_COUNT].
  Never iterate the whole upstream feed when the job asked for a fixed number.
- If the job is a single computation, just do it (every worker does the same);
  vary any randomness or sampling by WORKER_INDEX.

Keep total work per worker small — aim to finish within about 60 seconds.

Output: print JSON Lines to stdout — exactly ONE compact JSON object per item,
e.g. {"item": "...", "result": ...}. On a per-item failure still print a line:
{"item": "...", "ok": false, "error": "<reason>"}. Never let one bad item abort
the run. Put nothing else on stdout; send progress to stderr. Exit 0.

Keep the script short and direct — no CLI parsing, no __main__ guard needed.`

export interface GeneratedScript {
  script: string
  model: string
}

export async function writeWorker(task: string): Promise<GeneratedScript> {
  if (!config.vera.apiKey) {
    throw new Error("VERA_API_KEY is not set — the fan-out runner needs it.")
  }
  const res = await fetch(`${config.vera.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.vera.apiKey}`,
    },
    body: JSON.stringify({
      model: config.vera.model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Job: ${task.trim()}` },
      ],
      temperature: 0,
      max_tokens: config.vera.maxTokens,
    }),
  })
  if (!res.ok) {
    throw new Error(`Vera upstream ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>
  }
  const choice = json.choices?.[0]
  if (choice?.finish_reason === "length") {
    throw new Error(
      "Vera's worker was cut off (token limit). Raise VERA_MAX_TOKENS or simplify the job.",
    )
  }
  const script = extractCode(choice?.message?.content ?? "").trim()
  if (!script) throw new Error("Vera returned an empty worker")
  return { script, model: config.vera.model }
}

/** Pull the Python out: prefer the first fenced block, else strip stray fences. */
function extractCode(s: string): string {
  const fenced = s.match(/```(?:python|py)?\s*\n([\s\S]*?)```/i)
  if (fenced) return fenced[1]!
  return s.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```\s*$/, "")
}
