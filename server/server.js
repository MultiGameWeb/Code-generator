import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import crypto from "crypto";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

if (!process.env.GEMINI_API_KEY) {
  console.error(
    "CRITICAL CONFIGURATION ERROR: GEMINI_API_KEY is missing from environment variables."
  );
  process.exit(1);
}

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

const MODEL_NAME = "gemini-3.5-flash-lite";
const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_ORIGIN =
  process.env.FRONTEND_ORIGIN || "http://localhost:3000";

app.set("trust proxy", 1);

// ==========================================
// METRICS
// ==========================================

const metricsData = {
  serverStartedAt: Date.now(),

  totalGenerationRequests: 0,
  successfulGenerations: 0,
  validationFailures: 0,
  rateLimitedRequests: 0,
  upstreamGenerationErrors: 0,
  timeoutRequests: 0,

  totalChatRequests: 0,
  successfulChats: 0,
  chatValidationFailures: 0,
  chatRateLimitedRequests: 0,
  chatUpstreamErrors: 0,
  chatTimeoutRequests: 0,

  generationsByLanguage: {
    Python: 0,
    JavaScript: 0,
    TypeScript: 0,
    HTML: 0,
    CSS: 0,
    Java: 0,
    C: 0,
    "C++": 0,
    "C#": 0,
    PHP: 0,
    SQL: 0
  }
};

// ==========================================
// ADMIN TOKEN
// ==========================================

function verifyAdminToken(req, res, next) {
  const adminToken = process.env.METRICS_ADMIN_TOKEN;
  const authHeader = req.headers.authorization;

  if (
    !adminToken ||
    !authHeader ||
    !authHeader.startsWith("Bearer ")
  ) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized."
    });
  }

  const token = authHeader.substring(7);

  try {
    const tokenBuffer = Buffer.from(token);
    const adminBuffer = Buffer.from(adminToken);

    if (
      tokenBuffer.length !== adminBuffer.length ||
      !crypto.timingSafeEqual(tokenBuffer, adminBuffer)
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
// CORS
// ==========================================

const allowedOrigins = FRONTEND_ORIGIN
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS policy"));
    }
  })
);

// ==========================================
// SECURITY
// ==========================================

app.use(helmet());

app.use(
  express.json({
    limit: "32kb"
  })
);

// ==========================================
// BODY PARSER ERRORS
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
// STREAMING HELPERS
// ==========================================

function startSSE(res) {
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

function sendSSE(res, payload) {
  if (res.writableEnded || res.destroyed) {
    return;
  }

  res.write(
    `data: ${JSON.stringify(payload)}\n\n`
  );
}

function startKeepAlive(res) {
  return setInterval(() => {
    if (!res.writableEnded && !res.destroyed) {
      res.write(": keepalive\n\n");
    }
  }, 15000);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function cleanGeneratedCode(code) {
  let value = String(code || "").trim();

  if (value.startsWith("```")) {
    const newlineIndex =
      value.indexOf("\n");

    if (newlineIndex !== -1) {
      value = value.substring(
        newlineIndex + 1
      );
    }

    if (value.endsWith("```")) {
      value = value.substring(
        0,
        value.length - 3
      );
    }
  }

  return value.trim();
}

// ==========================================
// LANGUAGES
// ==========================================

const SUPPORTED_LANGUAGES = [
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

// ==========================================
// ASK AI INSTRUCTION
// ==========================================

const ASK_AI_SYSTEM_INSTRUCTION = `
You are a friendly AI coding and learning assistant.

Explain concepts clearly and simply.
Adapt explanations to the user's level.
For beginners, avoid unnecessary jargon.
Use examples when useful.
When explaining code, provide small correct examples.
When a user asks a coding question, explain both what to do and why.
When the user provides code or an error, help explain and diagnose it.
For programming questions, prefer practical runnable examples.
Do not invent facts.
Return a helpful natural-language answer.
`.trim();

const SUPPORTED_ANSWER_LENGTHS = [
  "short",
  "normal",
  "long"
];

// ==========================================
// RATE LIMITERS
// ==========================================

const generateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,

  handler: (req, res) => {
    metricsData.rateLimitedRequests++;

    return res.status(429).json({
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
    metricsData.chatRateLimitedRequests++;
    metricsData.rateLimitedRequests++;

    return res.status(429).json({
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
  res.status(200).json({
    success: true,
    service: "Get Your Code Now API"
  });
});

// ==========================================
// ADMIN METRICS
// ==========================================

app.get(
  "/api/admin/metrics",
  verifyAdminToken,
  (req, res) => {
    const uptimeSeconds = Math.floor(
      (Date.now() -
        metricsData.serverStartedAt) /
        1000
    );

    return res.status(200).json({
      success: true,

      metrics: {
        uptimeSeconds,

        totalGenerationRequests:
          metricsData.totalGenerationRequests,

        successfulGenerations:
          metricsData.successfulGenerations,

        validationFailures:
          metricsData.validationFailures,

        rateLimitedRequests:
          metricsData.rateLimitedRequests,

        timeoutRequests:
          metricsData.timeoutRequests,

        upstreamGenerationErrors:
          metricsData.upstreamGenerationErrors,

        totalChatRequests:
          metricsData.totalChatRequests,

        successfulChats:
          metricsData.successfulChats,

        chatValidationFailures:
          metricsData.chatValidationFailures,

        chatRateLimitedRequests:
          metricsData.chatRateLimitedRequests,

        chatTimeoutRequests:
          metricsData.chatTimeoutRequests,

        chatUpstreamErrors:
          metricsData.chatUpstreamErrors,

        generationsByLanguage: {
          ...metricsData.generationsByLanguage
        }
      }
    });
  }
);

// ==========================================
// ASK AI - STREAMING
// ==========================================

app.post(
  "/api/chat",
  chatLimiter,
  async (req, res, next) => {
    metricsData.totalChatRequests++;

    try {
      const contentType =
        req.headers["content-type"];

      if (
        !contentType ||
        !contentType
          .toLowerCase()
          .includes("application/json")
      ) {
        metricsData.chatValidationFailures++;

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
        metricsData.chatValidationFailures++;

        return res.status(400).json({
          success: false,
          error:
            "Request body must be a JSON object."
        });
      }

      const keys = Object.keys(req.body);

      if (
        keys.some(
          (key) =>
            !["prompt", "answerLength"].includes(key)
        )
      ) {
        metricsData.chatValidationFailures++;

        return res.status(400).json({
          success: false,
          error:
            "Only 'prompt' and 'answerLength' are allowed in the request body."
        });
      }

      if (
        typeof req.body.prompt !== "string"
      ) {
        metricsData.chatValidationFailures++;

        return res.status(400).json({
          success: false,
          error:
            "Prompt must be a string."
        });
      }

      const prompt =
        req.body.prompt.trim();

      if (!prompt) {
        metricsData.chatValidationFailures++;

        return res.status(400).json({
          success: false,
          error:
            "Prompt cannot be empty."
        });
      }

      if (prompt.length > 2000) {
        metricsData.chatValidationFailures++;

        return res.status(413).json({
          success: false,
          error:
            "Prompt is too long. Maximum length is 2000 characters."
        });
      }

      const answerLength =
        req.body.answerLength === undefined
          ? "normal"
          : req.body.answerLength;

      if (
        typeof answerLength !== "string" ||
        !SUPPORTED_ANSWER_LENGTHS.includes(
          answerLength
        )
      ) {
        metricsData.chatValidationFailures++;

        return res.status(400).json({
          success: false,
          error:
            "Unsupported answer length. Use short, normal, or long."
        });
      }

      const lengthInstruction = {
        short:
          "Keep the answer concise and focused. Prefer a few short paragraphs or bullets and small examples when useful.",

        normal:
          "Give a balanced explanation with enough detail for understanding without unnecessary length.",

        long:
          "Give a detailed explanation with clear steps, examples, and useful context. Avoid unnecessary repetition."
      }[answerLength];

      startSSE(res);

      const keepAlive =
        startKeepAlive(res);

      let disconnected = false;

      req.on("close", () => {
        disconnected = true;
      });

      try {
        let fullAnswer = "";
        let completed = false;
        let attempts = 0;

        while (
          !completed &&
          attempts < 3 &&
          !disconnected
        ) {
          attempts++;

          try {
            const stream =
              await ai.models.generateContentStream(
                {
                  model: MODEL_NAME,

                  contents: prompt,

                  config: {
                    systemInstruction:
                      `${ASK_AI_SYSTEM_INSTRUCTION}\n\nAnswer style:\n${lengthInstruction}`
                  }
                }
              );

            for await (const chunk of stream) {
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

              sendSSE(res, {
                type: "chunk",
                text
              });
            }

            completed = !disconnected;
          } catch (error) {
            const status =
              error?.status ??
              error?.code ??
              error?.response?.status;

            const message =
              String(
                error?.message || ""
              ).toLowerCase();

            const unavailable =
              status === 503 ||
              message.includes("503") ||
              message.includes(
                "unavailable"
              ) ||
              message.includes(
                "service unavailable"
              );

            if (
              unavailable &&
              !fullAnswer &&
              attempts < 3 &&
              !disconnected
            ) {
              await sleep(
                attempts === 1
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
          !completed ||
          !fullAnswer.trim()
        ) {
          metricsData.chatUpstreamErrors++;

          sendSSE(res, {
            type: "error",
            error:
              "AI returned an empty response. Please try again."
          });

          return;
        }

        metricsData.successfulChats++;

        sendSSE(res, {
          type: "done",
          answerLength
        });
      } catch (error) {
        metricsData.chatUpstreamErrors++;

        if (!disconnected) {
          sendSSE(res, {
            type: "error",
            error:
              "Unable to get an AI response right now. Please try again."
          });

          console.error(
            "Gemini Chat Streaming Error:",
            error?.message || error
          );
        }
      } finally {
        clearInterval(keepAlive);

        if (
          !res.writableEnded &&
          !disconnected
        ) {
          res.end();
        }
      }
    } catch (error) {
      return next(error);
    }
  }
);

// ==========================================
// GENERATE CODE - STREAMING
// ==========================================

app.post(
  "/api/generate",
  generateLimiter,
  async (req, res, next) => {
    metricsData.totalGenerationRequests++;

    try {
      const contentType =
        req.headers["content-type"];

      if (
        !contentType ||
        !contentType
          .toLowerCase()
          .includes("application/json")
      ) {
        metricsData.validationFailures++;

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
        metricsData.validationFailures++;

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
            !["prompt", "language"].includes(key)
        )
      ) {
        metricsData.validationFailures++;

        return res.status(400).json({
          success: false,
          error:
            "Invalid request body format or unknown fields."
        });
      }

      const {
        prompt: rawPrompt,
        language: rawLanguage
      } = req.body;

      if (
        typeof rawPrompt !== "string"
      ) {
        metricsData.validationFailures++;

        return res.status(400).json({
          success: false,
          error:
            "Prompt is required and must be a string."
        });
      }

      if (
        typeof rawLanguage !== "string"
      ) {
        metricsData.validationFailures++;

        return res.status(400).json({
          success: false,
          error:
            "Language is required and must be a string."
        });
      }

      const prompt =
        rawPrompt.trim();

      const language =
        rawLanguage.trim();

      if (!prompt) {
        metricsData.validationFailures++;

        return res.status(400).json({
          success: false,
          error:
            "Prompt cannot be empty."
        });
      }

      if (prompt.length > 2000) {
        metricsData.validationFailures++;

        return res.status(413).json({
          success: false,
          error:
            "Prompt is too long. Maximum allowed length is 2000 characters."
        });
      }

      if (!language) {
        metricsData.validationFailures++;

        return res.status(400).json({
          success: false,
          error:
            "Language cannot be empty."
        });
      }

      if (
        !SUPPORTED_LANGUAGES.includes(
          language
        )
      ) {
        metricsData.validationFailures++;

        return res.status(400).json({
          success: false,
          error:
            "Unsupported programming language."
        });
      }

      metricsData.generationsByLanguage[
        language
      ]++;

      const filename =
        FILE_NAMES[language] ||
        "generated.code";

      const systemInstruction = `
You are an expert software developer and code generation assistant.

Generate clean, practical, correct source code.

Rules:
- Follow the user's requirement carefully.
- Generate code for the requested programming language.
- Prefer complete runnable code when practical.
- Include necessary imports.
- Use sensible naming and structure.
- Handle obvious edge cases.
- Do not invent unnecessary features.
- Return only source code.
- Do not return Markdown code fences.
- Do not add explanations before or after the code.
`.trim();

      startSSE(res);

      const keepAlive =
        startKeepAlive(res);

      let disconnected = false;

      req.on("close", () => {
        disconnected = true;
      });

      try {
        let fullCode = "";
        let completed = false;
        let attempts = 0;

        while (
          !completed &&
          attempts < 3 &&
          !disconnected
        ) {
          attempts++;

          try {
            const stream =
              await ai.models.generateContentStream(
                {
                  model: MODEL_NAME,

                  contents:
                    `Target programming language: ${language}\n\nUser requirement:\n${prompt}`,

                  config: {
                    systemInstruction
                  }
                }
              );

            for await (const chunk of stream) {
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

              sendSSE(res, {
                type: "chunk",
                text
              });
            }

            completed = !disconnected;
          } catch (error) {
            const status =
              error?.status ??
              error?.code ??
              error?.response?.status;

            const message =
              String(
                error?.message || ""
              ).toLowerCase();

            const unavailable =
              status === 503 ||
              message.includes("503") ||
              message.includes(
                "unavailable"
              ) ||
              message.includes(
                "service unavailable"
              );

            if (
              unavailable &&
              !fullCode &&
              attempts < 3 &&
              !disconnected
            ) {
              await sleep(
                attempts === 1
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
          !completed ||
          !fullCode.trim()
        ) {
          metricsData.upstreamGenerationErrors++;

          sendSSE(res, {
            type: "error",
            error:
              "Gemini returned an empty response. Please try again."
          });

          return;
        }

        if (
          !cleanGeneratedCode(
            fullCode
          )
        ) {
          metricsData.upstreamGenerationErrors++;

          sendSSE(res, {
            type: "error",
            error:
              "Gemini returned an empty response. Please try again."
          });

          return;
        }

        metricsData.successfulGenerations++;

        sendSSE(res, {
          type: "done",
          language,
          filename
        });
      } catch (error) {
        metricsData.upstreamGenerationErrors++;

        if (!disconnected) {
          sendSSE(res, {
            type: "error",
            error:
              "Unable to generate code right now. Please try again."
          });

          console.error(
            "Gemini Code Streaming Error:",
            error?.message || error
          );
        }
      } finally {
        clearInterval(keepAlive);

        if (
          !res.writableEnded &&
          !disconnected
        ) {
          res.end();
        }
      }
    } catch (error) {
      return next(error);
    }
  }
);

// ==========================================
// CENTRAL ERROR HANDLER
// ==========================================

app.use(
  (err, req, res, next) => {
    console.error(
      "Server Error Exception:",
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

// Long-running streaming responses
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;
