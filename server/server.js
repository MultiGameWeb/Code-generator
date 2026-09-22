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

    // 3. 45-Second Request Timeout & AbortController Implementation
    const controller = new AbortController();
    let isTimedOut = false;

    const timeoutId = setTimeout(() => {
      isTimedOut = true;
      controller.abort();
    }, 45000);

    let geminiResponse;
    try {
      geminiResponse = await ai.models.generateContent({
        model: MODEL_NAME,
        contents: generationPrompt,
        config: {
          systemInstruction,
          abortSignal: controller.signal
        }
      });
    } catch (sdkError) {
      clearTimeout(timeoutId);
      if (isTimedOut || sdkError.name === 'AbortError' || (sdkError.message && sdkError.message.toLowerCase().includes('aborted'))) {
        metricsData.timeoutRequests++;
        return res.status(504).json({
          success: false,
          error: "Code generation timed out. Please try again."
        });
      }
      throw sdkError;
    }

    clearTimeout(timeoutId);

    if (isTimedOut) {
      metricsData.timeoutRequests++;
      return res.status(504).json({
        success: false,
        error: "Code generation timed out. Please try again."
      });
    }

    let rawCodeText = geminiResponse && geminiResponse.text ? geminiResponse.text.trim() : "";

    if (!rawCodeText) {
      metricsData.upstreamGenerationErrors++;
      return res.status(502).json({
        success: false,
        error: "Gemini returned an empty response."
      });
    }

    // Defensively clean accidental markdown code block fences if returned by the model
    if (rawCodeText.startsWith("```")) {
      const firstNewlineIndex = rawCodeText.indexOf("\n");
      if (firstNewlineIndex !== -1) {
        rawCodeText = rawCodeText.substring(firstNewlineIndex + 1);
      }
      if (rawCodeText.endsWith("```")) {
        rawCodeText = rawCodeText.substring(0, rawCodeText.length - 3);
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
