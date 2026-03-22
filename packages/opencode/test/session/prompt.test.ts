import path from "path"
import fs from "fs/promises"
import { describe, expect, test } from "bun:test"
import { fileURLToPath, pathToFileURL } from "url"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

function readHookPlugin(logFile: string, options?: { block?: boolean }) {
  return [
    'import fs from "fs/promises"',
    `const logFile = ${JSON.stringify(logFile)}`,
    "export default async () => ({",
    '  "tool.execute.before": async (input, output) => {',
    '    if (input.tool !== "read") return',
    '    await fs.appendFile(logFile, JSON.stringify({ stage: "before", callID: input.callID, filePath: output.args.filePath }) + "\\n")',
    ...(options?.block ? ['    throw new Error("blocked by plugin")'] : []),
    "  },",
    '  "tool.execute.after": async (input, output) => {',
    '    if (input.tool !== "read") return',
    '    await fs.appendFile(logFile, JSON.stringify({ stage: "after", callID: input.callID, filePath: input.args.filePath, title: output.title }) + "\\n")',
    "  },",
    "})",
    "",
  ].join("\n")
}

async function configurePluginProject(dir: string, filename: string, source: string) {
  const pluginPath = path.join(dir, filename)
  await Bun.write(pluginPath, source)
  await Bun.write(
    path.join(dir, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      plugin: [pathToFileURL(pluginPath).href],
      agent: {
        build: {
          model: "opencode/kimi-k2.5-free",
        },
      },
    }),
  )
}

async function readHookLog(logFile: string) {
  const text = await fs.readFile(logFile, "utf8").catch(() => "")
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe("session.prompt missing file", () => {
  test("does not fail the prompt when a file part is missing", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const missing = path.join(tmp.path, "does-not-exist.ts")
        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            { type: "text", text: "please review @does-not-exist.ts" },
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "does-not-exist.ts",
            },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")

        const hasFailure = msg.parts.some(
          (part) => part.type === "text" && part.synthetic && part.text.includes("Read tool failed to read"),
        )
        expect(hasFailure).toBe(true)

        await Session.remove(session.id)
      },
    })
  })

  test("keeps stored part order stable when file resolution is async", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          build: {
            model: "openai/gpt-5.2",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})

        const missing = path.join(tmp.path, "still-missing.ts")
        const msg = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [
            {
              type: "file",
              mime: "text/plain",
              url: `file://${missing}`,
              filename: "still-missing.ts",
            },
            { type: "text", text: "after-file" },
          ],
        })

        if (msg.info.role !== "user") throw new Error("expected user message")

        const stored = await MessageV2.get({
          sessionID: session.id,
          messageID: msg.info.id,
        })
        const text = stored.parts.filter((part) => part.type === "text").map((part) => part.text)

        expect(text[0]?.startsWith("Called the Read tool with the following input:")).toBe(true)
        expect(text[1]?.includes("Read tool failed to read")).toBe(true)
        expect(text[2]).toBe("after-file")

        await Session.remove(session.id)
      },
    })
  })
})

describe("session.prompt tool hooks", () => {
  test("fires read hooks for first-message @file inclusion", async () => {
    const logFile = path.join(process.cwd(), `tmp-hook-log-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)

    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "hello.txt"), "hello from first message\n")
        await configurePluginProject(dir, "read-hooks.ts", readHookPlugin(logFile))
      },
      dispose: async () => {
        await fs.rm(logFile, { force: true })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const parts = await SessionPrompt.resolvePromptParts("read @hello.txt")
        const message = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts,
        })

        const stored = await MessageV2.get({ sessionID: session.id, messageID: message.info.id })
        const textParts = stored.parts.filter((part) => part.type === "text").map((part) => part.text)
        const hookLog = await readHookLog(logFile)

        expect(hookLog).toHaveLength(2)
        expect(hookLog[0]).toEqual(
          expect.objectContaining({
            stage: "before",
            filePath: path.join(tmp.path, "hello.txt"),
          }),
        )
        expect(hookLog[1]).toEqual(
          expect.objectContaining({
            stage: "after",
            filePath: path.join(tmp.path, "hello.txt"),
          }),
        )
        expect(textParts.some((text) => text.startsWith("Called the Read tool with the following input:"))).toBe(true)
        expect(textParts.some((text) => text.includes("hello from first message"))).toBe(true)

        await Session.remove(session.id)
      },
    })
  })

  test("plugin before hook can block first-message @file inclusion", async () => {
    const logFile = path.join(process.cwd(), `tmp-hook-log-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)

    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "secret.txt"), "should never be included\n")
        await configurePluginProject(dir, "block-read.ts", readHookPlugin(logFile, { block: true }))
      },
      dispose: async () => {
        await fs.rm(logFile, { force: true })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const parts = await SessionPrompt.resolvePromptParts("read @secret.txt")
        const message = await SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts,
        })

        const stored = await MessageV2.get({ sessionID: session.id, messageID: message.info.id })
        const textParts = stored.parts.filter((part) => part.type === "text").map((part) => part.text)
        const hookLog = await readHookLog(logFile)

        expect(hookLog).toHaveLength(1)
        expect(hookLog[0]).toEqual(
          expect.objectContaining({
            stage: "before",
            filePath: path.join(tmp.path, "secret.txt"),
          }),
        )
        expect(textParts.some((text) => text.includes("Read tool failed to read"))).toBe(true)
        expect(textParts.some((text) => text.includes("blocked by plugin"))).toBe(true)
        expect(textParts.some((text) => text.includes("should never be included"))).toBe(false)

        await Session.remove(session.id)
      },
    })
  })

  test("normal resolveTools read execution still triggers hooks", async () => {
    const logFile = path.join(process.cwd(), `tmp-hook-log-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`)

    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "normal.txt"), "normal read path\n")
        await configurePluginProject(dir, "read-hooks.ts", readHookPlugin(logFile))
      },
      dispose: async () => {
        await fs.rm(logFile, { force: true })
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const agent = await Agent.get("build")
        if (!agent?.model) throw new Error("expected build agent with model")
        const model = await Provider.getModel(agent.model.providerID, agent.model.modelID)
        const tools = await SessionPrompt.resolveTools({
          agent,
          model,
          session,
          bypassAgentCheck: false,
          messages: [],
          processor: {
            message: { id: "msg_test" },
            partFromToolCall() {
              return undefined
            },
          } as any,
        })

        const read = tools.read as any
        expect(read).toBeDefined()

        const result = await read.execute(
          { filePath: path.join(tmp.path, "normal.txt") },
          {
            abortSignal: new AbortController().signal,
            toolCallId: "call-normal",
          },
        )
        const hookLog = await readHookLog(logFile)

        expect(result.output).toContain("normal read path")
        expect(hookLog).toHaveLength(2)
        expect(hookLog[0]).toEqual(
          expect.objectContaining({
            stage: "before",
            callID: "call-normal",
            filePath: path.join(tmp.path, "normal.txt"),
          }),
        )
        expect(hookLog[1]).toEqual(
          expect.objectContaining({
            stage: "after",
            callID: "call-normal",
            filePath: path.join(tmp.path, "normal.txt"),
          }),
        )

        await Session.remove(session.id)
      },
    })
  })
})

describe("session.prompt special characters", () => {
  test("handles filenames with # character", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "file#name.txt"), "special content\n")
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const template = "Read @file#name.txt"
        const parts = await SessionPrompt.resolvePromptParts(template)
        const fileParts = parts.filter((part) => part.type === "file")

        expect(fileParts.length).toBe(1)
        expect(fileParts[0].filename).toBe("file#name.txt")
        expect(fileParts[0].url).toContain("%23")

        const decodedPath = fileURLToPath(fileParts[0].url)
        expect(decodedPath).toBe(path.join(tmp.path, "file#name.txt"))

        const message = await SessionPrompt.prompt({
          sessionID: session.id,
          parts,
          noReply: true,
        })
        const stored = await MessageV2.get({ sessionID: session.id, messageID: message.info.id })
        const textParts = stored.parts.filter((part) => part.type === "text")
        const hasContent = textParts.some((part) => part.text.includes("special content"))
        expect(hasContent).toBe(true)

        await Session.remove(session.id)
      },
    })
  })
})

describe("session.prompt agent variant", () => {
  test("applies agent variant only when using agent model", async () => {
    const prev = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = "test-openai-key"

    try {
      await using tmp = await tmpdir({
        git: true,
        config: {
          agent: {
            build: {
              model: "openai/gpt-5.2",
              variant: "xhigh",
            },
          },
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({})

          const other = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            model: { providerID: ProviderID.make("opencode"), modelID: ModelID.make("kimi-k2.5-free") },
            noReply: true,
            parts: [{ type: "text", text: "hello" }],
          })
          if (other.info.role !== "user") throw new Error("expected user message")
          expect(other.info.variant).toBeUndefined()

          const match = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "hello again" }],
          })
          if (match.info.role !== "user") throw new Error("expected user message")
          expect(match.info.model).toEqual({ providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") })
          expect(match.info.variant).toBe("xhigh")

          const override = await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "build",
            noReply: true,
            variant: "high",
            parts: [{ type: "text", text: "hello third" }],
          })
          if (override.info.role !== "user") throw new Error("expected user message")
          expect(override.info.variant).toBe("high")

          await Session.remove(session.id)
        },
      })
    } finally {
      if (prev === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = prev
    }
  })
})
