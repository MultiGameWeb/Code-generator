import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import crypto from "crypto";
import { GoogleGenAI } from "@google/genai";

// Load environment variables from .env file
dotenv.config();

// Verify server-side Gemini API key configuration
if (!process.env.GEMINI_API_KEY) {
  console.error("CRITICAL CONFIGURATION ERROR: GEMINI_API_KEY is missing from environment variables.");
  process.exit(1);
}

// Initialize official Google GenAI SDK client
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY
});

const MODEL_NAME = "gemini-3.5-flash-lite";

const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "http://localhost:3000";

// Trust the first proxy hop for accurate client IP detection behind Render's load balancer
app.set("trust proxy", 1);

// ==========================================
// STEP 4C: IN-MEMORY PRIVACY-SAFE AGGREGATE METRICS
// ==========================================
const metricsData = {
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

// Safe timing-safe comparison helper for METRICS_ADMIN_TOKEN
function verifyAdminToken(req, res, next) {
  const adminToken = process.env.METRICS_ADMIN_TOKEN;
  
  // If token is misconfigured/unset on server, block all admin requests securely
  if (!adminToken) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized."
    });
  }

  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized."
    });
  }

  const token = authHeader.substring(7);

  try {
    const tokenBuffer = Buffer.from(token);
    const adminTokenBuffer = Buffer.from(adminToken);

    if (tokenBuffer.length !== adminTokenBuffer.length || !crypto.timingSafeEqual(tokenBuffer, adminTokenBuffer)) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized."
      });
    }
  } catch (err) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized."
    });
  }

  next();
}

// Parse allowed origins list cleanly from comma-separated environment variables
const allowedOrigins = FRONTEND_ORIGIN
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

// CORS options configuration
const corsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS policy"));
    }
  }
};

// Security middleware setup (Helmet)
app.use(helmet());

// CORS setup
app.use(cors(corsOptions));

// JSON Body Parser with 32kb production-safe limit
app.use(express.json({ limit: "32kb" }));

// Express body-parser size limit and malformed JSON syntax error interception
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      success: false,
      error: "Invalid JSON request body."
    });
  }
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({
      success: false,
      error: "Request body too large. Maximum allowed size is 32kb."
    });
  }
  next(err);
});

// IP-based Rate Limiter strictly for POST /api/generate
const generateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // limit each IP to 20 requests per windowMs
  standardHeaders: 'draft-7', // Enable standard RateLimit headers
  legacyHeaders: false, // Disable legacy X-RateLimit-* headers
  handler: (req, res) => {
    metricsData.rateLimitedRequests++;
    return res.status(429).json({
      success: false,
      error: "Too many generation requests. Please try again later."
    });
  }
});

// Explicit list of allowed programming languages
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

// Language to filename mapping dictionary
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
// IP-based Rate Limiter strictly for POST /api/chat
const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // limit each IP to 20 chat requests per windowMs
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (req, res) => {
    metricsData.chatRateLimitedRequests++;
    metricsData.rateLimitedRequests++;

    return res.status(429).json({
      success: false,
      error: "Too many chat requests. Please try again later."
    });
  }
});

// Ask AI Endpoint
app.post("/api/chat", chatLimiter, async (req, res, next) => {
  metricsData.totalChatRequests++;

  try {
    // 1. Content-Type validation
    const contentType = req.headers["content-type"];

    if (!contentType || !contentType.toLowerCase().includes("application/json")) {
      metricsData.chatValidationFailures++;

      return res.status(415).json({
        success: false,
        error: "Content-Type must be application/json."
      });
    }

    // 2. Validate request body
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      metricsData.chatValidationFailures++;

      return res.status(400).json({
        success: false,
        error: "Request body must be a JSON object."
      });
    }

    // 3. Strict request shape: only prompt is allowed
    const bodyKeys = Object.keys(req.body);

    if (bodyKeys.some((key) => key !== "prompt")) {
      metricsData.chatValidationFailures++;

      return res.status(400).json({
        success: false,
        error: "Only 'prompt' is allowed in the request body."
      });
    }

    // 4. Validate prompt
    if (typeof req.body.prompt !== "string") {
      metricsData.chatValidationFailures++;

      return res.status(400).json({
        success: false,
        error: "Prompt must be a string."
      });
    }

    const trimmedPrompt = req.body.prompt.trim();

    if (!trimmedPrompt) {
      metricsData.chatValidationFailures++;

      return res.status(400).json({
        success: false,
        error: "Prompt cannot be empty."
      });
    }

    // 5. Prompt length limit
    if (trimmedPrompt.length > 2000) {
      metricsData.chatValidationFailures++;

      return res.status(413).json({
        success: false,
        error: "Prompt is too long. Maximum length is 2000 characters."
      });
    }

    // 6. Timeout guard
    const controller = new AbortController();

    const timeoutId = setTimeout(() => {
      controller.abort();
    }, 45000);

    try {
      let response;

      // 7. Retry only temporary Gemini 503 / UNAVAILABLE errors
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          response = await ai.models.generateContent({
            model: MODEL_NAME,
            contents: trimmedPrompt,
            config: {
              systemInstruction: ASK_AI_SYSTEM_INSTRUCTION,
              abortSignal: controller.signal
            }
          });

          break;
        } catch (error) {
          const status =
            error?.status ??
            error?.code ??
            error?.response?.status;

          const isUnavailable =
            status === 503 ||
            String(error?.message || "")
              .toLowerCase()
              .includes("unavailable");

          if (!isUnavailable || attempt === 3) {
            throw error;
          }

          await new Promise((resolve) =>
            setTimeout(resolve, attempt * 1500)
          );
        }
      }

      const answer = response?.text?.trim();

      if (!answer) {
        metricsData.chatUpstreamErrors++;

        return res.status(502).json({
          success: false,
          error: "AI returned an empty response. Please try again."
        });
      }

      metricsData.successfulChats++;

      return res.status(200).json({
        success: true,
        answer
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        metricsData.chatTimeoutRequests++;

        return res.status(504).json({
          success: false,
          error: "AI request timed out. Please try again."
        });
      }

      metricsData.chatUpstreamErrors++;

      return next(error);
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    return next(error);
  }
});
// Health Check Endpoint (Exempt from rate-limiting & completely isolated from private metrics)
app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    service: "Get Your Code Now API"
  });
});

// Private Admin Metrics Endpoint (Protected by METRICS_ADMIN_TOKEN bearer verification)
app.get("/api/admin/metrics", verifyAdminToken, (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - metricsData.serverStartedAt) / 1000);

  res.status(200).json({
    success: true,
    metrics: {
      uptimeSeconds,
      totalGenerationRequests: metricsData.totalGenerationRequests,
      successfulGenerations: metricsData.successfulGenerations,
      validationFailures: metricsData.validationFailures,
      rateLimitedRequests: metricsData.rateLimitedRequests,
      timeoutRequests: metricsData.timeoutRequests,
      upstreamGenerationErrors: metricsData.upstreamGenerationErrors,
          totalChatRequests: metricsData.totalChatRequests,
      successfulChats: metricsData.successfulChats,
      chatValidationFailures: metricsData.chatValidationFailures,
      chatRateLimitedRequests: metricsData.chatRateLimitedRequests,
      chatTimeoutRequests: metricsData.chatTimeoutRequests,
      chatUpstreamErrors: metricsData.chatUpstreamErrors,
      generationsByLanguage: { ...metricsData.generationsByLanguage }
    }
  });
});

// Generate Endpoint with shape validation, content-type check, timeout guard, rate-limiting, privacy metrics tracking, and Gemini AI integration
app.post("/api/generate", generateLimiter, async (req, res, next) => {
  // Count request reaching the generation endpoint
  metricsData.totalGenerationRequests++;

  try {
    // 1. Content-Type Validation
    const contentType = req.headers['content-type'];
    if (!contentType || !contentType.toLowerCase().includes('application/json')) {
      metricsData.validationFailures++;
      return res.status(415).json({
        success: false,
        error: "Content-Type must be application/json."
      });
    }

    // 2. Validate JSON payload body existence and strict shape (only prompt and language allowed)
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      metricsData.validationFailures++;
      return res.status(400).json({
        success: false,
        error: "Invalid request body."
      });
    }

    const bodyKeys = Object.keys(req.body);
    const allowedKeys = ['prompt', 'language'];
    const hasInvalidKeys = bodyKeys.some(key => !allowedKeys.includes(key));
    if (hasInvalidKeys) {
      metricsData.validationFailures++;
      return res.status(400).json({
        success: false,
        error: "Invalid request body format or unknown fields."
      });
    }

    const { prompt, language } = req.body;

    // Validate prompt presence and type
    if (prompt === undefined || prompt === null || typeof prompt !== 'string') {
      metricsData.validationFailures++;
      return res.status(400).json({
        success: false,
        error: "Prompt is required and must be a string."
      });
    }

    const trimmedPrompt = prompt.trim();

    // Validate empty prompt
    if (trimmedPrompt.length === 0) {
      metricsData.validationFailures++;
      return res.status(400).json({
        success: false,
        error: "Prompt cannot be empty."
      });
    }

    // Set maximum prompt length check (2000 characters)
    const MAX_PROMPT_LENGTH = 2000;
    if (trimmedPrompt.length > MAX_PROMPT_LENGTH) {
      metricsData.validationFailures++;
      return res.status(400).json({
        success: false,
        error: `Prompt is too long. Maximum allowed length is ${MAX_PROMPT_LENGTH} characters.`
      });
    }

    // Validate language presence and type
    if (language === undefined || language === null || typeof language !== 'string') {
      metricsData.validationFailures++;
      return res.status(400).json({
        success: false,
        error: "Language is required and must be a string."
      });
    }

    const trimmedLanguage = language.trim();

    // Validate empty language
    if (trimmedLanguage.length === 0) {
      metricsData.validationFailures++;
      return res.status(400).json({
        success: false,
        error: "Language cannot be empty."
      });
    }

    // Validate against explicit supported languages whitelist
    if (!SUPPORTED_LANGUAGES.includes(trimmedLanguage)) {
      metricsData.validationFailures++;
      return res.status(400).json({
        success: false,
        error: "Unsupported programming language."
      });
    }

    // Increment corresponding valid language counter safely
    if (metricsData.generationsByLanguage[trimmedLanguage] !== undefined) {
      metricsData.generationsByLanguage[trimmedLanguage]++;
    }

    // Fixed application rules separated from user prompt content
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

    // Separate user content prompt parameter containing target language and requirement
    const generationPrompt = `
Target programming language: ${trimmedLanguage}

User requirement:
${trimmedPrompt}
`.trim();

        // 3. 45-Second Request Timeout & AbortController with 503 Retry Logic
    const controller = new AbortController();
    let isTimedOut = false;

    const timeoutId = setTimeout(() => {
      isTimedOut = true;
      controller.abort();
    }, 45000);

    // Sleep helper that respects the AbortController signal
    const sleep = (ms, signal) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) {
          return reject(new DOMException("Aborted", "AbortError"));
        }

        const timer = setTimeout(resolve, ms);

        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true }
        );
      });

    let geminiResponse;
    const maxAttempts = 3;
    let attempt = 0;

    while (attempt < maxAttempts) {
      attempt++;

      if (isTimedOut || controller.signal.aborted) {
        break;
      }

      try {
        geminiResponse = await ai.models.generateContent({
          model: MODEL_NAME,
          contents: generationPrompt,
          config: {
            systemInstruction,
            abortSignal: controller.signal
          }
        });

        break;
      } catch (sdkError) {
        // Request timeout / abort
        const errorMessage = String(sdkError?.message || "").toLowerCase();

        if (
          isTimedOut ||
          sdkError?.name === "AbortError" ||
          errorMessage.includes("aborted")
        ) {
          clearTimeout(timeoutId);

          metricsData.timeoutRequests++;

          return res.status(504).json({
            success: false,
            error: "Code generation timed out. Please try again."
          });
        }

        // Detect temporary Gemini 503 / UNAVAILABLE errors
        const errorStatus =
          sdkError?.status ||
          sdkError?.statusCode ||
          sdkError?.response?.status;

        const isTemporary503 =
          errorStatus === 503 ||
          errorMessage.includes("503") ||
          errorMessage.includes("unavailable") ||
          errorMessage.includes("service unavailable");

        // Do not retry non-503 errors
        if (!isTemporary503) {
          clearTimeout(timeoutId);

          metricsData.upstreamGenerationErrors++;

          return res.status(500).json({
            success: false,
            error: "Unable to generate code right now. Please try again."
          });
        }

        // Stop after 3 total attempts
        if (attempt >= maxAttempts) {
          clearTimeout(timeoutId);

          metricsData.upstreamGenerationErrors++;

          return res.status(500).json({
            success: false,
            error: "Unable to generate code right now. Please try again."
          });
        }

        // Retry delays:
        // 1st retry = 1.5 seconds
        // 2nd retry = 3 seconds
        const delayMs = attempt === 1 ? 1500 : 3000;

        try {
          await sleep(delayMs, controller.signal);
        } catch (sleepError) {
          if (isTimedOut || controller.signal.aborted) {
            clearTimeout(timeoutId);

            metricsData.timeoutRequests++;

            return res.status(504).json({
              success: false,
              error: "Code generation timed out. Please try again."
            });
          }

          clearTimeout(timeoutId);

          metricsData.upstreamGenerationErrors++;

          return res.status(500).json({
            success: false,
            error: "Unable to generate code right now. Please try again."
          });
        }
      }
    }

    clearTimeout(timeoutId);

    if (isTimedOut || controller.signal.aborted) {
      metricsData.timeoutRequests++;

      return res.status(504).json({
        success: false,
        error: "Code generation timed out. Please try again."
      });
    }

    let rawCodeText =
      geminiResponse && geminiResponse.text
        ? geminiResponse.text.trim()
        : "";

    if (!rawCodeText) {
      metricsData.upstreamGenerationErrors++;

      return res.status(502).json({
        success: false,
        error: "Gemini returned an empty response."
      });
    }

    // Remove accidental Markdown code fences
    if (rawCodeText.startsWith("```")) {
      const firstNewlineIndex = rawCodeText.indexOf("\n");

      if (firstNewlineIndex !== -1) {
        rawCodeText = rawCodeText.substring(firstNewlineIndex + 1);
      }

      if (rawCodeText.endsWith("```")) {
        rawCodeText = rawCodeText.substring(
          0,
          rawCodeText.length - 3
        );
      }

      rawCodeText = rawCodeText.trim();
    }

    const filename = FILE_NAMES[trimmedLanguage] || "generated.code";

    // Increment successful generations counter
    metricsData.successfulGenerations++;

    return res.status(200).json({
      success: true,
      language: trimmedLanguage,
      code: rawCodeText,
      filename: filename
    });

  } catch (err) {
    console.error("Gemini Generation Error:", err.message || err);
    metricsData.upstreamGenerationErrors++;
    return res.status(500).json({
      success: false,
      error: "Unable to generate code right now. Please try again."
    });
  }
});

// Centralized Error Handling Middleware
app.use((err, req, res, next) => {
  console.error("Server Error Exception:", err.message || err);
  
  res.status(500).json({
    success: false,
    error: "Internal server error."
  });
});

// Start Express Server bound to 0.0.0.0 for Render compatibility
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[Get Your Code Now] Backend server running on port ${PORT}`);
});
