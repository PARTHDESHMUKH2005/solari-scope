/**
 * Turn a plain-English batch job into one Python worker script, using an
 * NVIDIA Nemotron model over the OpenAI-compatible endpoint.
 *
 * The script runs as one worker in a parallel pool. It's told about the two
 * env vars Scope injects (WORKER_INDEX / WORKER_COUNT) so it can process just
 * its shard of a list, and to emit JSON Lines so Scope can aggregate every
 * worker's output into one result set.
 */
import { config } from "./config.js"

const SYSTEM = `You write ONE Python 3 script and nothing else. No markdown fences, no commentary.

Runtime: Debian, Python 3.11, full internet access, and \`pip install\` works
(install what you need quietly at the top of the script, e.g.
\`import subprocess,sys; subprocess.run([sys.executable,"-m","pip","install","-q","requests"])\`).

This script is ONE worker in a parallel pool. Two environment variables are set:
  WORKER_INDEX  - this worker's 0-based number
  WORKER_COUNT  - total number of workers

- If the task is over a list or range of items, process ONLY this worker's
  slice: items[WORKER_INDEX::WORKER_COUNT].
- If the task is a single computation, just perform it (all workers do the
  same); vary any randomness or sampling by WORKER_INDEX so the results differ.

Output: print JSON Lines to stdout - exactly one compact JSON object per
result, e.g. {"item": "...", "result": ...}. Nothing else on stdout; send any
progress or error text to stderr. Exit 0 on success.`

export interface GeneratedScript {
  script: string
  model: string
}

export async function taskToScript(task: string): Promise<GeneratedScript> {
  if (!config.nemotron.apiKey) {
    throw new Error("NEMOTRON_API_KEY is not set — the fan-out runner needs it.")
  }
  const res = await fetch(`${config.nemotron.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.nemotron.apiKey}`,
    },
    body: JSON.stringify({
      model: config.nemotron.model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Task: ${task.trim()}` },
      ],
      temperature: 0,
      max_tokens: 1200,
    }),
  })
  if (!res.ok) {
    throw new Error(`Nemotron ${res.status}: ${(await res.text()).slice(0, 300)}`)
  }
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const raw = json.choices?.[0]?.message?.content ?? ""
  const script = stripFences(raw).trim()
  if (!script) throw new Error("Nemotron returned an empty script")
  return { script, model: config.nemotron.model }
}

/** Remove a leading ```python / ``` and a trailing ``` if the model added them. */
function stripFences(s: string): string {
  const m = s.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/)
  return m ? m[1]! : s.replace(/^```[a-zA-Z]*\n?/, "").replace(/\n?```$/, "")
}
