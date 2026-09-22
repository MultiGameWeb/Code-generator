import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import crypto from "crypto";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

if (!process.env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is missing from environment variables.");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL_NAME = "gemini-3.5-flash-lite";
const PORT = process.env.PORT || 3000;
const FRONTEND_ORIGIN =
  process.env.FRONTEND_ORIGIN || "http://localhost:3000";

const MAX_PROMPT = 2000;
const MAX_HISTORY_MESSAGES = 20;
const MAX_HISTORY_MESSAGE_LENGTH = 6000;

const LANGUAGES = [
  "Python",
  "JavaScript",
  "TypeScript",
  "HTML",
  "CSS",
  "Java",
  "C",
  "C++",
  "C#",
  "PHP",
  "SQL"
];

const FILE_NAMES = {
  Python: "generated.py",
  JavaScript: "generated.js",
  TypeScript: "generated.ts",
  HTML: "index.html",
  CSS: "styles.css",
  Java: "Generated.java",
  C: "generated.c",
  "C++": "generated.cpp",
  "C#": "Generated.cs",
  PHP: "generated.php",
  SQL: "query.sql"
};

const ANSWER_LENGTHS = ["short", "normal", "long"];

const ASK_AI_SYSTEM = `
You are a friendly AI coding and learning assistant.
Explain concepts clearly and simply.
Adapt explanations to the user's level.
For beginners, avoid unnecessary jargon.
Use examples when useful.
When explaining code, provide small correct examples.
When a user asks a coding question, explain both what to do and why.
When the user provides code or an error, help explain and diagnose it.
For programming questions, prefer practical runnable examples.
Use the current conversation context for follow-up questions.
Do not invent facts.
Return a helpful natural-language answer.
`.trim();

const CODE_SYSTEM = `
You are an expert software developer and code generation assistant.
Generate clean, practical, correct source code.
Follow the user's requirement carefully.
Generate code for the requested programming language.
Prefer complete runnable code when practical.
Include necessary imports.
Use sensible naming and structure.
Handle obvious edge cases.
Do not invent unnecessary features.
Return only source code without Markdown code fences or explanations.
`.trim();

const metrics = {
  serverStartedAt: Date.now(),

  totalGenerationRequests: 0,
  successfulGenerations: 0,
  validationFailures: 0,
  rateLimitedRequests: 0,
  timeoutRequests: 0,
  upstreamGenerationErrors: 0,

  totalChatRequests: 0,
  successfulChats: 0,
  chatValidationFailures: 0,
  chatRateLimitedRequests: 0,
  chatTimeoutRequests: 0,
  chatUpstreamErrors: 0,

  generationsByLanguage: Object.fromEntries(
    LANGUAGES.map((x) => [x, 0])
  )
};

const app = express();

app.set("trust proxy", 1);

const allowedOrigins = FRONTEND_ORIGIN
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

app.use(helmet());

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      callback(new Error("Not allowed by CORS policy"));
    }
  })
);

app.use(
  express.json({
    limit: "32kb"
  })
);

// ==========================================
// JSON / BODY PARSER ERRORS
// ==========================================

app.use((err, req, res, next) => {
  if (
    err instanceof SyntaxError &&
    err.status === 400 &&
    "body" in err
  ) {
    return res.status(400).json({
      success: false,
      error: "Invalid JSON request body."
    });
  }

  if (
    err?.type === "entity.too.large" ||
    err?.status === 413
  ) {
    return res.status(413).json({
      success: false,
      error:
        "Request body too large. Maximum allowed size is 32kb."
    });
  }

  next(err);
});

// ==========================================
// ADMIN AUTH
// ==========================================

function adminAuth(req, res, next) {
  const secret = process.env.METRICS_ADMIN_TOKEN;
  const header = req.headers.authorization;

  if (
    !secret ||
    !header?.startsWith("Bearer ")
  ) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized."
    });
  }

  try {
    const a = Buffer.from(header.slice(7));
    const b = Buffer.from(secret);

    if (
      a.length !== b.length ||
      !crypto.timingSafeEqual(a, b)
    ) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized."
      });
    }
  } catch {
    return res.status(401).json({
      success: false,
      error: "Unauthorized."
    });
  }

  next();
}

// ==========================================
// SSE HELPERS
// ==========================================

function sseStart(res) {
  res.status(200);

  res.setHeader(
    "Content-Type",
    "text/event-stream; charset=utf-8"
  );

  res.setHeader(
    "Cache-Control",
    "no-cache, no-transform"
  );

  res.setHeader(
    "Connection",
    "keep-alive"
  );

  res.setHeader(
    "X-Accel-Buffering",
    "no"
  );

  res.flushHeaders?.();
}

function sseSend(res, data) {
  if (
    !res.writableEnded &&
    !res.destroyed
  ) {
    res.write(
      `data: ${JSON.stringify(data)}\n\n`
    );
  }
}

function keepAlive(res) {
  return setInterval(() => {
    if (
      !res.writableEnded &&
      !res.destroyed
    ) {
      res.write(": keepalive\n\n");
    }
  }, 15000);
}

const sleep = (ms) =>
  new Promise((resolve) =>
    setTimeout(resolve, ms)
  );

function cleanCode(code) {
  let value = String(code || "").trim();

  if (value.startsWith("```")) {
    const n = value.indexOf("\n");

    if (n !== -1) {
      value = value.slice(n + 1);
    }

    if (value.endsWith("```")) {
      value = value.slice(0, -3);
    }
  }

  return value.trim();
}

// ==========================================
// HISTORY VALIDATION
// ==========================================

function validateHistory(history) {
  if (history === undefined) {
    return [];
  }

  if (!Array.isArray(history)) {
    throw new Error(
      "History must be an array."
    );
  }

  if (
    history.length >
    MAX_HISTORY_MESSAGES
  ) {
    throw new Error(
      `History cannot contain more than ${MAX_HISTORY_MESSAGES} messages.`
    );
  }

  return history.map((item, i) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item)
    ) {
      throw new Error(
        `Invalid history message at position ${i + 1}.`
      );
    }

    if (
      !("role" in item) ||
      !("content" in item)
    ) {
      throw new Error(
        "History messages must contain role and content."
      );
    }

    let role = item.role;

    const content =
      typeof item.content === "string"
        ? item.content.trim()
        : "";

    if (role === "assistant") {
      role = "model";
    }

    if (
      role !== "user" &&
      role !== "model"
    ) {
      throw new Error(
        `Unsupported history role at position ${i + 1}.`
      );
    }

    if (!content) {
      throw new Error(
        `History content cannot be empty at position ${i + 1}.`
      );
    }

    if (
      content.length >
      MAX_HISTORY_MESSAGE_LENGTH
    ) {
      throw new Error(
        `History message at position ${i + 1} is too long.`
      );
    }

    return {
      role,
      parts: [
        {
          text: content
        }
      ]
    };
  });
}

// ==========================================
// RATE LIMITERS
// ==========================================

const generateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,

  handler: (req, res) => {
    metrics.rateLimitedRequests++;

    res.status(429).json({
      success: false,
      error:
        "Too many generation requests. Please try again later."
    });
  }
});

const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,

  handler: (req, res) => {
    metrics.chatRateLimitedRequests++;
    metrics.rateLimitedRequests++;

    res.status(429).json({
      success: false,
      error:
        "Too many chat requests. Please try again later."
    });
  }
});

// ==========================================
// HEALTH
// ==========================================

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    service: "Get Your Code Now API"
  });
});

// ==========================================
// ADMIN METRICS
// ==========================================

app.get(
  "/api/admin/metrics",
  adminAuth,
  (req, res) => {
    res.json({
      success: true,

      metrics: {
        uptimeSeconds: Math.floor(
          (Date.now() -
            metrics.serverStartedAt) /
            1000
        ),

        ...metrics,

        generationsByLanguage: {
          ...metrics.generationsByLanguage
        }
      }
    });
  }
);

// ==========================================
// ASK AI
// STREAMING + CURRENT CHAT CONTEXT
// ==========================================

app.post(
  "/api/chat",
  chatLimiter,
  async (req, res, next) => {
    metrics.totalChatRequests++;

    try {
      const type =
        req.headers["content-type"];

      if (
        !type ||
        !type
          .toLowerCase()
          .includes("application/json")
      ) {
        metrics.chatValidationFailures++;

        return res.status(415).json({
          success: false,
          error:
            "Content-Type must be application/json."
        });
      }

      if (
        !req.body ||
        typeof req.body !== "object" ||
        Array.isArray(req.body)
      ) {
        metrics.chatValidationFailures++;

        return res.status(400).json({
          success: false,
          error:
            "Request body must be a JSON object."
        });
      }

      const keys =
        Object.keys(req.body);

      if (
        keys.some(
          (key) =>
            ![
              "prompt",
              "answerLength",
              "history"
            ].includes(key)
        )
      ) {
        metrics.chatValidationFailures++;

        return res.status(400).json({
          success: false,
          error:
            "Only prompt, answerLength, and history are allowed."
        });
      }

      const prompt =
        typeof req.body.prompt === "string"
          ? req.body.prompt.trim()
          : "";

      const answerLength =
        req.body.answerLength ?? "normal";

      if (!prompt) {
        metrics.chatValidationFailures++;

        return res.status(400).json({
          success: false,
          error:
            "Prompt cannot be empty."
        });
      }

      if (prompt.length > MAX_PROMPT) {
        metrics.chatValidationFailures++;

        return res.status(413).json({
          success: false,
          error:
            "Prompt is too long. Maximum length is 2000 characters."
        });
      }

      if (
        !ANSWER_LENGTHS.includes(
          answerLength
        )
      ) {
        metrics.chatValidationFailures++;

        return res.status(400).json({
          success: false,
          error:
            "Unsupported answer length. Use short, normal, or long."
        });
      }

      let history;

      try {
        history = validateHistory(
          req.body.history
        );
      } catch (error) {
        metrics.chatValidationFailures++;

        return res.status(400).json({
          success: false,
          error: error.message
        });
      }

      const style = {
        short:
          "Keep the answer concise and focused.",

        normal:
          "Give a balanced explanation with useful detail.",

        long:
          "Give a detailed explanation with clear steps, examples, and useful context."
      }[answerLength];

      const contents = [
        ...history,

        {
          role: "user",
          parts: [
            {
              text: prompt
            }
          ]
        }
      ];

      sseStart(res);

      const ping =
        keepAlive(res);

      let disconnected = false;

      req.on("close", () => {
        disconnected = true;
      });

      try {
        let fullAnswer = "";
        let attempt = 0;
        let done = false;

        while (
          !done &&
          attempt < 3 &&
          !disconnected
        ) {
          attempt++;

          try {
            const stream =
              await ai.models.generateContentStream(
                {
                  model: MODEL_NAME,

                  contents,

                  config: {
                    systemInstruction:
                      `${ASK_AI_SYSTEM}\n\nAnswer style:\n${style}`
                  }
                }
              );

            for await (
              const chunk of stream
            ) {
              if (disconnected) {
                break;
              }

              const text =
                typeof chunk?.text === "string"
                  ? chunk.text
                  : "";

              if (!text) {
                continue;
              }

              fullAnswer += text;

              sseSend(res, {
                type: "chunk",
                text
              });
            }

            done = !disconnected;
          } catch (error) {
            const status =
              error?.status ??
              error?.code ??
              error?.response?.status;

            const msg =
              String(
                error?.message || ""
              ).toLowerCase();

            const temporary =
              status === 503 ||
              msg.includes("503") ||
              msg.includes("unavailable");

            if (
              temporary &&
              !fullAnswer &&
              attempt < 3 &&
              !disconnected
            ) {
              await sleep(
                attempt === 1
                  ? 1500
                  : 3000
              );

              continue;
            }

            throw error;
          }
        }

        if (disconnected) {
          return;
        }

        if (
          !done ||
          !fullAnswer.trim()
        ) {
          metrics.chatUpstreamErrors++;

          sseSend(res, {
            type: "error",
            error:
              "No answer was returned. Please try again."
          });

          return;
        }

        metrics.successfulChats++;

        sseSend(res, {
          type: "done",
          answerLength
        });
      } catch (error) {
        metrics.chatUpstreamErrors++;

        if (!disconnected) {
          console.error(
            "Chat streaming error:",
            error?.message || error
          );

          sseSend(res, {
            type: "error",
            error:
              "Unable to get an AI response right now. Please try again."
          });
        }
      } finally {
        clearInterval(ping);

        if (
          !res.writableEnded &&
          !disconnected
        ) {
          res.end();
        }
      }
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// CODE GENERATION
// STREAMING
// ==========================================

app.post(
  "/api/generate",
  generateLimiter,
  async (req, res, next) => {
    metrics.totalGenerationRequests++;

    try {
      const type =
        req.headers["content-type"];

      if (
        !type ||
        !type
          .toLowerCase()
          .includes("application/json")
      ) {
        metrics.validationFailures++;

        return res.status(415).json({
          success: false,
          error:
            "Content-Type must be application/json."
        });
      }

      if (
        !req.body ||
        typeof req.body !== "object" ||
        Array.isArray(req.body)
      ) {
        metrics.validationFailures++;

        return res.status(400).json({
          success: false,
          error:
            "Invalid request body."
        });
      }

      const keys =
        Object.keys(req.body);

      if (
        keys.some(
          (key) =>
            ![
              "prompt",
              "language"
            ].includes(key)
        )
      ) {
        metrics.validationFailures++;

        return res.status(400).json({
          success: false,
          error:
            "Invalid request body format or unknown fields."
        });
      }

      const prompt =
        typeof req.body.prompt ===
        "string"
          ? req.body.prompt.trim()
          : "";

      const language =
        typeof req.body.language ===
        "string"
          ? req.body.language.trim()
          : "";

      if (!prompt) {
        metrics.validationFailures++;

        return res.status(400).json({
          success: false,
          error:
            "Prompt cannot be empty."
        });
      }

      if (prompt.length > MAX_PROMPT) {
        metrics.validationFailures++;

        return res.status(413).json({
          success: false,
          error:
            "Prompt is too long. Maximum allowed length is 2000 characters."
        });
      }

      if (
        !LANGUAGES.includes(language)
      ) {
        metrics.validationFailures++;

        return res.status(400).json({
          success: false,
          error:
            "Unsupported programming language."
        });
      }

      metrics.generationsByLanguage[
        language
      ]++;

      const filename =
        FILE_NAMES[language] ||
        "generated.code";

      sseStart(res);

      const ping =
        keepAlive(res);

      let disconnected = false;

      req.on("close", () => {
        disconnected = true;
      });

      try {
        const contents = [
          {
            role: "user",

            parts: [
              {
                text:
                  `Target programming language: ${language}\n\nUser requirement:\n${prompt}`
              }
            ]
          }
        ];

        let fullCode = "";
        let attempt = 0;
        let done = false;

        while (
          !done &&
          attempt < 3 &&
          !disconnected
        ) {
          attempt++;

          try {
            const stream =
              await ai.models.generateContentStream(
                {
                  model: MODEL_NAME,

                  contents,

                  config: {
                    systemInstruction:
                      CODE_SYSTEM
                  }
                }
              );

            for await (
              const chunk of stream
            ) {
              if (disconnected) {
                break;
              }

              const text =
                typeof chunk?.text === "string"
                  ? chunk.text
                  : "";

              if (!text) {
                continue;
              }

              fullCode += text;

              sseSend(res, {
                type: "chunk",
                text
              });
            }

            done = !disconnected;
          } catch (error) {
            const status =
              error?.status ??
              error?.code ??
              error?.response?.status;

            const msg =
              String(
                error?.message || ""
              ).toLowerCase();

            const temporary =
              status === 503 ||
              msg.includes("503") ||
              msg.includes("unavailable");

            if (
              temporary &&
              !fullCode &&
              attempt < 3 &&
              !disconnected
            ) {
              await sleep(
                attempt === 1
                  ? 1500
                  : 3000
              );

              continue;
            }

            throw error;
          }
        }

        if (disconnected) {
          return;
        }

        const cleaned =
          cleanCode(fullCode);

        if (
          !done ||
          !cleaned
        ) {
          metrics.upstreamGenerationErrors++;

          sseSend(res, {
            type: "error",
            error:
              "No code was returned. Please try again."
          });

          return;
        }

        metrics.successfulGenerations++;

        sseSend(res, {
          type: "done",
          language,
          filename
        });
      } catch (error) {
        metrics.upstreamGenerationErrors++;

        if (!disconnected) {
          console.error(
            "Code streaming error:",
            error?.message || error
          );

          sseSend(res, {
            type: "error",
            error:
              "Unable to generate code right now. Please try again."
          });
        }
      } finally {
        clearInterval(ping);

        if (
          !res.writableEnded &&
          !disconnected
        ) {
          res.end();
        }
      }
    } catch (error) {
      next(error);
    }
  }
);

// ==========================================
// CENTRAL ERROR HANDLER
// ==========================================

app.use(
  (err, req, res, next) => {
    console.error(
      "Server Error:",
      err?.message || err
    );

    if (!res.headersSent) {
      return res.status(500).json({
        success: false,
        error:
          "Internal server error."
      });
    }

    if (!res.writableEnded) {
      res.end();
    }
  }
);

// ==========================================
// START SERVER
// ==========================================

const server = app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `[Get Your Code Now] Backend server running on port ${PORT}`
    );
  }
);

// No application-level response timeout.
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;
