import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";

import * as Sentry from "@sentry/node";
import express from "express";
import AlexaSdk from "ask-sdk-core";
import AlexaExpressAdapter from "ask-sdk-express-adapter";

const {
  SkillBuilders,
  getIntentName,
  getRequestType,
  getSlotValue,
} = AlexaSdk;
const { ExpressAdapter } = AlexaExpressAdapter;

const DEFAULT_DAILY_NOTE_PATH_TEMPLATE =
  "Bullet Journal/Daily/{{YYYY}}-{{MM}}-{{DD}} ({{DAY_NAME}} W{{ISO_WEEK}}).md";
const DEFAULT_DAILY_NOTE_TITLE_TEMPLATE = "# {{YYYY}}-{{MM}}-{{DD}}";
const DEFAULT_ALEXA_CAPTURE_INTENT_NAME = "CaptureIntent";
const DEFAULT_ALEXA_CAPTURE_SLOT_NAME = "captureText";

loadEnvFile(join(process.cwd(), ".env"));

// --- Config ---
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.API_KEY;
const SENTRY_DSN = process.env.SENTRY_DSN;
const VAULT_PATH = process.env.VAULT_PATH || "/data/vault";
const ALEXA_SKILL_ID = process.env.ALEXA_SKILL_ID?.trim();
const ALEXA_VERIFY_SIGNATURE = parseBoolean(
  process.env.ALEXA_VERIFY_SIGNATURE,
  true
);
const ALEXA_VERIFY_TIMESTAMP = parseBoolean(
  process.env.ALEXA_VERIFY_TIMESTAMP,
  true
);
const ALEXA_CAPTURE_INTENT_NAME =
  process.env.ALEXA_CAPTURE_INTENT_NAME ||
  DEFAULT_ALEXA_CAPTURE_INTENT_NAME;
const ALEXA_CAPTURE_SLOT_NAME =
  process.env.ALEXA_CAPTURE_SLOT_NAME || DEFAULT_ALEXA_CAPTURE_SLOT_NAME;
const DAILY_NOTE_PATH_TEMPLATE =
  process.env.DAILY_NOTE_PATH_TEMPLATE || DEFAULT_DAILY_NOTE_PATH_TEMPLATE;
const DAILY_NOTE_TITLE_TEMPLATE =
  process.env.DAILY_NOTE_TITLE_TEMPLATE || DEFAULT_DAILY_NOTE_TITLE_TEMPLATE;
const CAPTURE_SECTION_HEADING =
  process.env.CAPTURE_SECTION_HEADING || "Captured";
const CAPTURE_SECTION_MARKDOWN_HEADING = `## ${CAPTURE_SECTION_HEADING}`;

if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    // Setting this option to true will send default PII data to Sentry.
    // For example, automatic IP address collection on events
    sendDefaultPii: true,
  });
}

if (!API_KEY) {
  console.error("FATAL: API_KEY environment variable is required");
  process.exit(1);
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return;
  }

  const content = readFileSync(filePath, "utf-8");

  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIdx = trimmed.indexOf("=");
    if (separatorIdx === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || key in process.env) {
      continue;
    }

    let value = trimmed.slice(separatorIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function parseBoolean(value, defaultValue) {
  if (value == null || value === "") {
    return defaultValue;
  }

  return !["0", "false", "no", "off"].includes(
    value.trim().toLowerCase()
  );
}

// --- Daily note path helpers ---

function getISOWeekNumber(date) {
  const d = new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
  );
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

function getTemplateTokens(date) {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const dayName = days[date.getDay()];
  const week = getISOWeekNumber(date);

  return {
    DATE: `${yyyy}-${mm}-${dd}`,
    DAY_NAME: dayName,
    DD: dd,
    ISO_WEEK: String(week),
    MM: mm,
    YYYY: String(yyyy),
  };
}

function renderTemplate(template, tokens) {
  return template.replace(/\{\{([A-Z_]+)\}\}/gu, (match, token) => {
    return tokens[token] ?? match;
  });
}

function getDailyNotePath(date) {
  const relativePath = renderTemplate(
    DAILY_NOTE_PATH_TEMPLATE,
    getTemplateTokens(date)
  );

  return join(VAULT_PATH, relativePath);
}

function normalizeCaptureText(rawText) {
  if (typeof rawText !== "string") {
    return "";
  }

  return rawText.replace(/\s+/gu, " ").trim();
}

async function captureText(rawText) {
  const text = normalizeCaptureText(rawText);

  if (!text) {
    throw new Error("Missing 'text' field");
  }

  const filePath = await appendToCapture(text);
  console.log(`Captured: "${text}" -> ${filePath}`);

  return { filePath, text };
}

// --- File manipulation ---

async function appendToCapture(text) {
  const now = new Date();
  const filePath = getDailyNotePath(now);
  const dir = dirname(filePath);
  const taskLine = `- [ ] ${text}`;
  const templateTokens = getTemplateTokens(now);

  // Ensure directory exists
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }

  if (existsSync(filePath)) {
    // File exists — find the capture heading and append after it
    let content = await readFile(filePath, "utf-8");

    const capturedIdx = content.indexOf(CAPTURE_SECTION_MARKDOWN_HEADING);
    if (capturedIdx !== -1) {
      // Find the end of the heading line
      const headingEnd = content.indexOf("\n", capturedIdx);
      if (headingEnd === -1) {
        // Heading is at EOF
        content = content + "\n" + taskLine + "\n";
      } else {
        // Insert after the heading line
        // Find where the next section starts (or EOF) to append at the end of the capture section
        const afterHeading = content.substring(headingEnd + 1);
        const nextHeadingMatch = afterHeading.match(/^## /m);

        let insertPos;
        if (nextHeadingMatch) {
          // Insert just before the next heading
          insertPos = headingEnd + 1 + nextHeadingMatch.index;
          // Ensure blank line before next heading
          content =
            content.substring(0, insertPos).trimEnd() +
            "\n" +
            taskLine +
            "\n\n" +
            content.substring(insertPos);
        } else {
          // No next heading — append at end of file
          content = content.trimEnd() + "\n" + taskLine + "\n";
        }
      }
    } else {
      // No capture heading — add it at the end
      content =
        content.trimEnd() +
        "\n\n" +
        CAPTURE_SECTION_MARKDOWN_HEADING +
        "\n" +
        taskLine +
        "\n";
    }

    await writeFile(filePath, content, "utf-8");
  } else {
    // File doesn't exist — create a minimal daily note with the capture section
    const title = renderTemplate(DAILY_NOTE_TITLE_TEMPLATE, templateTokens);
    const content =
      `${title}\n\n` +
      `${CAPTURE_SECTION_MARKDOWN_HEADING}\n` +
      `${taskLine}\n`;
    await writeFile(filePath, content, "utf-8");
  }

  return filePath;
}

// --- Alexa skill ---

const LaunchRequestHandler = {
  canHandle({ requestEnvelope }) {
    return getRequestType(requestEnvelope) === "LaunchRequest";
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak("What would you like to capture?")
      .reprompt("Say capture, followed by what you want me to save.")
      .getResponse();
  },
};

const CaptureIntentHandler = {
  canHandle({ requestEnvelope }) {
    return (
      getRequestType(requestEnvelope) === "IntentRequest" &&
      getIntentName(requestEnvelope) === ALEXA_CAPTURE_INTENT_NAME
    );
  },
  async handle(handlerInput) {
    const text = normalizeCaptureText(
      getSlotValue(handlerInput.requestEnvelope, ALEXA_CAPTURE_SLOT_NAME)
    );

    if (!text) {
      return handlerInput.responseBuilder
        .speak(
          "I didn't catch what you want to capture. Say capture followed by your note."
        )
        .reprompt("Say capture followed by your note.")
        .getResponse();
    }

    await captureText(text);

    return handlerInput.responseBuilder
      .speak("Captured.")
      .withSimpleCard("Obsidian Capture", text)
      .getResponse();
  },
};

const HelpIntentHandler = {
  canHandle({ requestEnvelope }) {
    return (
      getRequestType(requestEnvelope) === "IntentRequest" &&
      getIntentName(requestEnvelope) === "AMAZON.HelpIntent"
    );
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak(
        "Say capture followed by what you want to save. For example, say capture buy milk."
      )
      .reprompt("Try saying, capture buy milk.")
      .getResponse();
  },
};

const CancelAndStopIntentHandler = {
  canHandle({ requestEnvelope }) {
    return (
      getRequestType(requestEnvelope) === "IntentRequest" &&
      ["AMAZON.CancelIntent", "AMAZON.StopIntent"].includes(
        getIntentName(requestEnvelope)
      )
    );
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder.speak("Okay.").getResponse();
  },
};

const FallbackIntentHandler = {
  canHandle({ requestEnvelope }) {
    return (
      getRequestType(requestEnvelope) === "IntentRequest" &&
      getIntentName(requestEnvelope) === "AMAZON.FallbackIntent"
    );
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder
      .speak("Try saying, capture followed by what you want me to save.")
      .reprompt("Say capture followed by your note.")
      .getResponse();
  },
};

const SessionEndedRequestHandler = {
  canHandle({ requestEnvelope }) {
    return getRequestType(requestEnvelope) === "SessionEndedRequest";
  },
  handle(handlerInput) {
    return handlerInput.responseBuilder.getResponse();
  },
};

const AlexaErrorHandler = {
  canHandle() {
    return true;
  },
  handle(handlerInput, error) {
    console.error("Alexa error:", error);
    Sentry.captureException(error);

    return handlerInput.responseBuilder
      .speak("Sorry, I couldn't save that right now. Please try again.")
      .reprompt("Please try again.")
      .getResponse();
  },
};

let alexaSkillBuilder = SkillBuilders.custom()
  .addRequestHandlers(
    LaunchRequestHandler,
    CaptureIntentHandler,
    HelpIntentHandler,
    CancelAndStopIntentHandler,
    FallbackIntentHandler,
    SessionEndedRequestHandler
  )
  .addErrorHandlers(AlexaErrorHandler)
  .withCustomUserAgent("@mtharrison/obsidian-capture");

if (ALEXA_SKILL_ID) {
  alexaSkillBuilder = alexaSkillBuilder.withSkillId(ALEXA_SKILL_ID);
}

const alexaSkill = alexaSkillBuilder.create();
const alexaAdapter = new ExpressAdapter(
  alexaSkill,
  ALEXA_VERIFY_SIGNATURE,
  ALEXA_VERIFY_TIMESTAMP
);

// --- Start obsidian-headless sync ---

function startSync() {
  const obPath = join(
    process.cwd(),
    "node_modules",
    ".bin",
    "ob"
  );

  console.log(`Starting ob sync --continuous in ${VAULT_PATH}`);
  const child = spawn(obPath, ["sync", "--continuous"], {
    cwd: VAULT_PATH,
    stdio: "inherit",
    env: { ...process.env, HOME: process.env.HOME || "/root" },
  });

  child.on("error", (err) => {
    console.error("Failed to start ob sync:", err.message);
  });

  child.on("exit", (code) => {
    console.error(`ob sync exited with code ${code}, restarting in 10s...`);
    setTimeout(startSync, 10000);
  });

  return child;
}

// --- HTTP server ---

const app = express();

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post("/capture", express.json(), async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const { text } = await captureText(req.body?.text);
    res.json({ status: "captured", text });
  } catch (err) {
    if (err.message === "Missing 'text' field") {
      res.status(400).json({ error: err.message });
      return;
    }

    console.error("Capture error:", err);
    Sentry.captureException(err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/alexa", ...alexaAdapter.getRequestHandlers());

app.use((err, _req, res, next) => {
  if (err?.type === "entity.parse.failed") {
    res.status(400).json({ error: "Invalid JSON" });
    return;
  }

  next(err);
});

app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// --- Boot ---
startSync();

app.listen(PORT, () => {
  console.log(`Capture webhook listening on :${PORT}`);
  console.log(`Vault path: ${VAULT_PATH}`);
  console.log(
    `Alexa endpoint: /alexa (signature verification: ${ALEXA_VERIFY_SIGNATURE}, timestamp verification: ${ALEXA_VERIFY_TIMESTAMP})`
  );
});
