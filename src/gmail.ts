import { access, readFile } from "node:fs/promises";

import { google, gmail_v1 } from "googleapis";

import { CREDENTIALS_PATH, SCOPES, TOKEN_PATH } from "./config.js";

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;
type OAuthCredentials = Parameters<OAuth2Client["setCredentials"]>[0];

type OAuthClientConfig = {
  client_id: string;
  client_secret: string;
  redirect_uris?: string[];
};

type GoogleCredentialsFile = {
  installed?: OAuthClientConfig;
  web?: OAuthClientConfig;
};

export type AuthStatus = {
  credentialsPath: string;
  tokenPath: string;
  credentialsPresent: boolean;
  tokenPresent: boolean;
  scopes: string[];
};

export type GmailLabel = {
  id: string | null;
  name: string | null;
  type: string | null;
  messageListVisibility: string | null;
  labelListVisibility: string | null;
};

export type GmailMessageIdSearchResult = {
  ids: string[];
  nextPageToken: string | null;
  resultSizeEstimate: number | null;
};

export type GmailCount = {
  count: number;
  resultSizeEstimate: number | null;
};

export type GmailInboxCounts = {
  messageCount: number;
  threadCount: number;
  unreadMessageCount: number;
  unreadThreadCount: number;
  estimates: {
    messageCount: number | null;
    threadCount: number | null;
    unreadMessageCount: number | null;
    unreadThreadCount: number | null;
  };
};

const GMAIL_LIST_PAGE_SIZE = 500;
const GMAIL_BATCH_MODIFY_SIZE = 1000;

async function exists(pathname: string): Promise<boolean> {
  try {
    await access(pathname);
    return true;
  } catch {
    return false;
  }
}

export async function getAuthStatus(): Promise<AuthStatus> {
  const [credentialsPresent, tokenPresent] = await Promise.all([
    exists(CREDENTIALS_PATH),
    exists(TOKEN_PATH),
  ]);

  return {
    credentialsPath: CREDENTIALS_PATH,
    tokenPath: TOKEN_PATH,
    credentialsPresent,
    tokenPresent,
    scopes: SCOPES,
  };
}

async function readJsonFile<T>(pathname: string): Promise<T> {
  const raw = await readFile(pathname, "utf8");
  return JSON.parse(raw) as T;
}

async function createOAuthClient(): Promise<OAuth2Client> {
  const credentialsFile = await readJsonFile<GoogleCredentialsFile>(CREDENTIALS_PATH);
  const config = credentialsFile.installed ?? credentialsFile.web;

  if (!config?.client_id || !config.client_secret) {
    throw new Error(
      `Invalid Google OAuth credentials file at ${CREDENTIALS_PATH}. Expected an installed or web client.`,
    );
  }

  const redirectUri = config.redirect_uris?.[0] ?? "http://localhost";
  return new google.auth.OAuth2(config.client_id, config.client_secret, redirectUri);
}

export async function getAuthorizedClient(): Promise<OAuth2Client> {
  const status = await getAuthStatus();
  if (!status.credentialsPresent) {
    throw new Error(`Missing Google OAuth credentials at ${CREDENTIALS_PATH}. Run npm run auth after adding credentials.json.`);
  }

  if (!status.tokenPresent) {
    throw new Error(`Missing Gmail OAuth token at ${TOKEN_PATH}. Run npm run auth to authorize Gmail access.`);
  }

  const oauthClient = await createOAuthClient();
  const token = await readJsonFile<OAuthCredentials>(TOKEN_PATH);
  oauthClient.setCredentials(token);
  return oauthClient;
}

export async function getGmailClient(): Promise<gmail_v1.Gmail> {
  const auth = await getAuthorizedClient();
  return google.gmail({ version: "v1", auth });
}

export async function listGmailLabels(): Promise<GmailLabel[]> {
  const gmail = await getGmailClient();
  const response = await gmail.users.labels.list({ userId: "me" });

  return (response.data.labels ?? []).map((label) => ({
    id: label.id ?? null,
    name: label.name ?? null,
    type: label.type ?? null,
    messageListVisibility: label.messageListVisibility ?? null,
    labelListVisibility: label.labelListVisibility ?? null,
  }));
}

export async function getGmailMessage(messageId: string, format: "full" | "metadata" = "full"): Promise<gmail_v1.Schema$Message> {
  const gmail = await getGmailClient();
  const response = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format,
  });

  return response.data;
}

async function countGmailMessages(
  gmail: gmail_v1.Gmail,
  params: {
    q?: string;
    labelIds?: string[];
    includeSpamTrash?: boolean;
  },
): Promise<GmailCount> {
  let count = 0;
  let pageToken: string | undefined;
  let resultSizeEstimate: number | null = null;

  do {
    const response = await gmail.users.messages.list({
      userId: "me",
      q: params.q || undefined,
      labelIds: params.labelIds,
      includeSpamTrash: params.includeSpamTrash,
      maxResults: GMAIL_LIST_PAGE_SIZE,
      pageToken,
    });

    resultSizeEstimate = response.data.resultSizeEstimate ?? resultSizeEstimate;
    count += (response.data.messages ?? []).length;
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return {
    count,
    resultSizeEstimate,
  };
}

async function countGmailThreads(
  gmail: gmail_v1.Gmail,
  params: {
    q?: string;
    labelIds?: string[];
    includeSpamTrash?: boolean;
  },
): Promise<GmailCount> {
  let count = 0;
  let pageToken: string | undefined;
  let resultSizeEstimate: number | null = null;

  do {
    const response = await gmail.users.threads.list({
      userId: "me",
      q: params.q || undefined,
      labelIds: params.labelIds,
      includeSpamTrash: params.includeSpamTrash,
      maxResults: GMAIL_LIST_PAGE_SIZE,
      pageToken,
    });

    resultSizeEstimate = response.data.resultSizeEstimate ?? resultSizeEstimate;
    count += (response.data.threads ?? []).length;
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return {
    count,
    resultSizeEstimate,
  };
}

export async function getGmailInboxCounts(client?: gmail_v1.Gmail): Promise<GmailInboxCounts> {
  const gmail = client ?? await getGmailClient();
  const inboxParams = { labelIds: ["INBOX"] };
  const unreadInboxParams = { labelIds: ["INBOX"], q: "is:unread" };

  const [messages, threads, unreadMessages, unreadThreads] = await Promise.all([
    countGmailMessages(gmail, inboxParams),
    countGmailThreads(gmail, inboxParams),
    countGmailMessages(gmail, unreadInboxParams),
    countGmailThreads(gmail, unreadInboxParams),
  ]);

  return {
    messageCount: messages.count,
    threadCount: threads.count,
    unreadMessageCount: unreadMessages.count,
    unreadThreadCount: unreadThreads.count,
    estimates: {
      messageCount: messages.resultSizeEstimate,
      threadCount: threads.resultSizeEstimate,
      unreadMessageCount: unreadMessages.resultSizeEstimate,
      unreadThreadCount: unreadThreads.resultSizeEstimate,
    },
  };
}

export async function modifyMessageLabels(params: {
  messageId: string;
  addLabelIds?: string[];
  removeLabelIds?: string[];
}): Promise<gmail_v1.Schema$Message> {
  const gmail = await getGmailClient();
  const response = await gmail.users.messages.modify({
    userId: "me",
    id: params.messageId,
    requestBody: {
      addLabelIds: params.addLabelIds,
      removeLabelIds: params.removeLabelIds,
    },
  });

  return response.data;
}

export async function batchModifyMessageLabels(params: {
  messageIds: string[];
  addLabelIds?: string[];
  removeLabelIds?: string[];
}): Promise<{ requested: number; batches: number }> {
  if (params.messageIds.length === 0) {
    throw new Error("At least one message ID is required.");
  }

  const gmail = await getGmailClient();
  let batches = 0;

  for (let index = 0; index < params.messageIds.length; index += GMAIL_BATCH_MODIFY_SIZE) {
    const ids = params.messageIds.slice(index, index + GMAIL_BATCH_MODIFY_SIZE);
    await gmail.users.messages.batchModify({
      userId: "me",
      requestBody: {
        ids,
        addLabelIds: params.addLabelIds,
        removeLabelIds: params.removeLabelIds,
      },
    });
    batches += 1;
  }

  return {
    requested: params.messageIds.length,
    batches,
  };
}

export async function collectGmailMessageIds(params: {
  q?: string;
  labelIds?: string[];
  includeSpamTrash?: boolean;
  maxMessages: number;
}): Promise<GmailMessageIdSearchResult> {
  if (params.maxMessages < 1) {
    throw new Error("maxMessages must be at least 1.");
  }

  const gmail = await getGmailClient();
  const ids: string[] = [];
  let nextPageToken: string | null = null;
  let resultSizeEstimate: number | null = null;

  do {
    const pageSize = Math.min(GMAIL_LIST_PAGE_SIZE, params.maxMessages - ids.length);
    const response: { data: gmail_v1.Schema$ListMessagesResponse } = await gmail.users.messages.list({
      userId: "me",
      q: params.q || undefined,
      maxResults: pageSize,
      pageToken: nextPageToken ?? undefined,
      labelIds: params.labelIds,
      includeSpamTrash: params.includeSpamTrash,
    });

    resultSizeEstimate = response.data.resultSizeEstimate ?? resultSizeEstimate;
    const pageIds = (response.data.messages ?? [])
      .map((message: gmail_v1.Schema$Message) => message.id)
      .filter((id): id is string => Boolean(id));
    ids.push(...pageIds);
    nextPageToken = response.data.nextPageToken ?? null;
  } while (nextPageToken && ids.length < params.maxMessages);

  return {
    ids,
    nextPageToken,
    resultSizeEstimate,
  };
}

export async function createGmailLabel(name: string): Promise<GmailLabel> {
  const gmail = await getGmailClient();
  const response = await gmail.users.labels.create({
    userId: "me",
    requestBody: {
      name,
    },
  });

  return {
    id: response.data.id ?? null,
    name: response.data.name ?? null,
    type: response.data.type ?? null,
    messageListVisibility: response.data.messageListVisibility ?? null,
    labelListVisibility: response.data.labelListVisibility ?? null,
  };
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/g, "");
}

function normalizeSubject(subject: string | null): string {
  const trimmed = subject?.trim() ?? "";
  if (!trimmed) {
    return "Re:";
  }

  return /^re:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

export async function replyToMessage(params: {
  messageId: string;
  body: string;
  cc?: string[];
}): Promise<gmail_v1.Schema$Message> {
  const gmail = await getGmailClient();
  const original = await gmail.users.messages.get({
    userId: "me",
    id: params.messageId,
    format: "metadata",
    metadataHeaders: ["From", "Subject", "Message-ID", "Reply-To", "References"],
  });

  const headers = new Map(
    (original.data.payload?.headers ?? [])
      .filter((header) => header.name && header.value != null)
      .map((header) => [header.name!.toLowerCase(), header.value!]),
  );

  const recipient = headers.get("reply-to") ?? headers.get("from");
  if (!recipient) {
    throw new Error("Original message does not include a From or Reply-To address.");
  }

  const subject = normalizeSubject(headers.get("subject") ?? null);
  const messageId = headers.get("message-id") ?? null;
  const referenceHeaders = [headers.get("references"), messageId].filter((value): value is string => Boolean(value));

  const mimeParts = [
    `To: ${recipient}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset="UTF-8"`,
  ];

  if (params.cc && params.cc.length > 0) {
    mimeParts.splice(1, 0, `Cc: ${formatAddressList(params.cc)}`);
  }

  if (messageId) {
    mimeParts.push(`In-Reply-To: ${messageId}`);
    mimeParts.push(`References: ${referenceHeaders.join(" ")}`);
  }

  mimeParts.push("", params.body);

  const response = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: base64UrlEncode(mimeParts.join("\r\n")),
      threadId: original.data.threadId ?? undefined,
    },
  });

  return response.data;
}

function formatAddressList(values: string[]): string {
  return values.join(", ");
}

export async function sendGmailMessage(params: {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
}): Promise<gmail_v1.Schema$Message> {
  if (params.to.length === 0) {
    throw new Error("At least one recipient is required.");
  }

  const headers = [
    `To: ${formatAddressList(params.to)}`,
    `Subject: ${params.subject.trim()}`,
    `Content-Type: text/plain; charset="UTF-8"`,
  ];

  if (params.cc && params.cc.length > 0) {
    headers.push(`Cc: ${formatAddressList(params.cc)}`);
  }

  if (params.bcc && params.bcc.length > 0) {
    headers.push(`Bcc: ${formatAddressList(params.bcc)}`);
  }

  const mime = `${headers.join("\r\n")}\r\n\r\n${params.body}`;
  const gmail = await getGmailClient();
  const response = await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: base64UrlEncode(mime),
    },
  });

  return response.data;
}

export async function getGmailAttachment(params: {
  messageId: string;
  attachmentId: string;
}): Promise<gmail_v1.Schema$MessagePartBody> {
  const gmail = await getGmailClient();
  const response = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId: params.messageId,
    id: params.attachmentId,
  });

  return response.data;
}

export async function resolveLabelIds(labelNamesOrIds: string[]): Promise<string[]> {
  if (labelNamesOrIds.length === 0) {
    return [];
  }

  const labels = await listGmailLabels();
  const byName = new Map(
    labels
      .filter((label) => label.name)
      .map((label) => [label.name!.toLowerCase(), label.id ?? label.name!]),
  );
  const byId = new Set(labels.map((label) => label.id).filter((id): id is string => Boolean(id)));

  const resolved: string[] = [];
  for (const value of labelNamesOrIds) {
    const direct = byId.has(value) ? value : byName.get(value.toLowerCase());
    if (!direct) {
      throw new Error(`Unknown Gmail label: ${value}`);
    }
    resolved.push(direct);
  }

  return resolved;
}
