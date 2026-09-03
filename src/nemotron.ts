/**
 * Turn a plain-English task into one self-contained Python script, using an
 * NVIDIA Nemotron model over the OpenAI-compatible endpoint.
 *
 * The script is what every fan-out worker runs, so the constraints are tight:
 * standard library only (no pip in the base sandbox), no input, print the
 * result to stdout, exit 0. Nemotron is told to emit raw code; we strip
 * fences anyway in case it doesn't listen.
 */
import { config } from "./config.js"

const SYSTEM = `You write a single Python 3 script and nothing else.
Rules:
- Output raw Python only. No markdown fences, no commentary, no explanation.
- Standard library only. The runtime has no internet and no pip packages.
- The script takes no input. It computes the task and prints the result to stdout.
- Keep it short and deterministic. Exit 0 on success.`

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
      max_tokens: 900,
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
