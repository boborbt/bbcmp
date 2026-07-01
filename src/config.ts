import path from "node:path";

export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

export const CREDENTIALS_PATH =
  process.env.GMAIL_OAUTH_CREDENTIALS ?? path.join(process.cwd(), "credentials.json");

export const TOKEN_PATH =
  process.env.GMAIL_TOKEN_PATH ?? path.join(process.cwd(), ".tokens", "gmail-token.json");

export const DEFAULT_MAX_BODY_CHARS = Number.parseInt(
  process.env.GMAIL_MAX_BODY_CHARS ?? "12000",
  10,
);

export const TOOL_PREFIX = (process.env.MAILCMP_TOOL_PREFIX ?? "gmail").replace(/[^a-zA-Z0-9_]+/g, "_");

export const INSTANCE_LABEL = (process.env.MAILCMP_INSTANCE_LABEL ?? "").trim();
