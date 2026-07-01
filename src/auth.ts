import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";

import { google } from "googleapis";

import { CREDENTIALS_PATH, SCOPES, TOKEN_PATH } from "./config.js";
import type { AuthStatus } from "./gmail.js";
import { getAuthStatus } from "./gmail.js";

type OAuthClientConfig = {
  client_id: string;
  client_secret: string;
  redirect_uris?: string[];
};

type GoogleCredentialsFile = {
  installed?: OAuthClientConfig;
  web?: OAuthClientConfig;
};

function credentialsSetupHelp(): string {
  return [
    `Missing Google OAuth credentials at ${CREDENTIALS_PATH}.`,
    "",
    "Create a Google OAuth desktop client, download its JSON file, then either:",
    `1. Save it as ${path.join(process.cwd(), "credentials.json")}`,
    "2. Or run auth with GMAIL_OAUTH_CREDENTIALS=/absolute/path/to/client_secret.json",
    "",
    "Google Cloud path: APIs & Services -> Credentials -> Create credentials -> OAuth client ID -> Desktop app.",
  ].join("\n");
}

async function readCredentials(): Promise<OAuthClientConfig> {
  let raw: string;
  try {
    raw = await readFile(CREDENTIALS_PATH, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error(credentialsSetupHelp());
    }

    throw error;
  }

  let parsed: GoogleCredentialsFile;
  try {
    parsed = JSON.parse(raw) as GoogleCredentialsFile;
  } catch {
    throw new Error(`Invalid JSON in Google OAuth credentials file at ${CREDENTIALS_PATH}.`);
  }

  const config = parsed.installed ?? parsed.web;

  if (!config?.client_id || !config.client_secret || !config.redirect_uris?.length) {
    throw new Error(
      `Invalid Google OAuth credentials at ${CREDENTIALS_PATH}. Expected a downloaded OAuth desktop/web client JSON with client_id, client_secret, and redirect_uris.`,
    );
  }

  return config;
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => undefined);
    child.unref();
  } catch {
    // The authorization URL is always printed, so browser auto-open is best effort.
  }
}

async function authorize() {
  const config = await readCredentials();
  const redirectUri = new URL(config.redirect_uris?.[0] ?? "http://localhost");

  if (redirectUri.hostname !== "localhost") {
    throw new Error("The first OAuth redirect URI must use localhost for local authorization.");
  }

  const oauthClient = new google.auth.OAuth2(config.client_id, config.client_secret);

  return await new Promise<InstanceType<typeof google.auth.OAuth2>>((resolve, reject) => {
    const server = createServer(async (request, response) => {
      try {
        const requestUrl = new URL(request.url ?? "/", "http://localhost");
        if (requestUrl.pathname !== redirectUri.pathname) {
          response.writeHead(404);
          response.end("Invalid callback URL.");
          return;
        }

        const error = requestUrl.searchParams.get("error");
        if (error) {
          response.end("Authorization rejected. You can close this tab.");
          reject(new Error(error));
          return;
        }

        const code = requestUrl.searchParams.get("code");
        if (!code) {
          response.writeHead(400);
          response.end("No authorization code provided.");
          reject(new Error("No authorization code provided."));
          return;
        }

        const { tokens } = await oauthClient.getToken({
          code,
          redirect_uri: redirectUri.toString(),
        });

        oauthClient.setCredentials(tokens);
        response.end("Authentication successful. You can close this tab.");
        resolve(oauthClient);
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });

    server.on("error", reject);

    const listenPort = redirectUri.port ? Number(redirectUri.port) : 0;
    server.listen(listenPort, "localhost", () => {
      const address = server.address() as AddressInfo | null;
      if (address) {
        redirectUri.port = String(address.port);
      }

      const authorizeUrl = oauthClient.generateAuthUrl({
        access_type: "offline",
        prompt: "consent select_account",
        redirect_uri: redirectUri.toString(),
        scope: SCOPES.join(" "),
      });

      console.error("Open this URL to authorize Gmail access:");
      console.error(authorizeUrl);
      openBrowser(authorizeUrl);
    });
  });
}

function renderStatus(status: AuthStatus): string {
  return JSON.stringify(status, null, 2);
}

async function main() {
  console.error("Current auth status:");
  console.error(renderStatus(await getAuthStatus()));

  const authClient = await authorize();

  await mkdir(path.dirname(TOKEN_PATH), { recursive: true });
  await writeFile(TOKEN_PATH, JSON.stringify(authClient.credentials, null, 2), {
    mode: 0o600,
  });

  console.error(`Saved Gmail OAuth token to ${TOKEN_PATH}`);
  console.error("The MCP server will use Gmail modify and send scopes.");
}

main().catch((error: unknown) => {
  console.error("Failed to authorize Gmail access.");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
