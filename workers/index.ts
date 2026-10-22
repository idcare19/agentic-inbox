// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import PostalMime from "postal-mime";
import { z } from "zod";
import { sendEmail, sendResendEmail } from "./email-sender";
import { storeAttachments, type StoredAttachment } from "./lib/attachments";
import {
	validateSender,
	SenderValidationError,
	generateMessageId,
	buildThreadingHeaders,
	listMailboxes,
} from "./lib/email-helpers";
import { SendEmailRequestSchema } from "./lib/schemas";
import { handleReplyEmail, handleForwardEmail } from "./routes/reply-forward";
import { Folders } from "../shared/folders";
import type { Env } from "./types";
import type { EmailConfig } from "./types";
import { requireMailbox, type MailboxContext } from "./lib/mailbox";
import { stripHtmlToText, textToHtml } from "./lib/email-helpers";

type AppContext = Context<MailboxContext>;

// -- Request body schemas (kept for validation) ---------------------

const CreateMailboxBody = z.object({
	email: z.string().email(),
	name: z.string().min(1),
	settings: z.record(z.any()).optional(), // unvalidated — agentSystemPrompt goes straight to AI
});

const DraftBody = z.object({
	to: z.string().optional(),
	cc: z.string().optional(),
	bcc: z.string().optional(),
	subject: z.string().optional(),
	body: z.string(),
	in_reply_to: z.string().optional(),
	thread_id: z.string().optional(),
	draft_id: z.string().optional(),
});

// -- Helpers --------------------------------------------------------

function slugify(text: string) { // can return "" for non-alphanumeric input
	return text.toString().toLowerCase()
		.replace(/\s+/g, "-").replace(/[^\w-]+/g, "")
		.replace(/--+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
}

function intQuery(c: AppContext, key: string): number | undefined {
	const v = c.req.query(key);
	if (!v) return undefined;
	const n = Number(v);
	return Number.isNaN(n) ? undefined : n;
}

function boolQuery(c: AppContext, key: string): boolean | undefined {
	const v = c.req.query(key);
	if (v === undefined || v === "") return undefined;
	return v === "true" || v === "1";
}

// -- App & middleware -----------------------------------------------

const app = new Hono<MailboxContext>();

function configStub(env: Env) {
	return env.EMAIL_CONFIG.get(env.EMAIL_CONFIG.idFromName("registry"));
}
function requireAdmin(c: Context<{ Bindings: Env }>) {
	const configured = c.env.ADMIN_API_TOKEN;
	if (!configured) return true; // Cloudflare Access remains the production guard.
	return c.req.header("authorization") === `Bearer ${configured}`;
}
function validateAlias(name: string) {
	return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name) && !name.includes("--");
}

app.get("/emails", async (c) => {
	if (!requireAdmin(c)) return c.json({ error: "Unauthorized" }, 401);
	return c.json(await (configStub(c.env) as any).list());
});
app.post("/emails", async (c) => {
	if (!requireAdmin(c)) return c.json({ error: "Unauthorized" }, 401);
	const body = await c.req.json() as Partial<EmailConfig> & { name?: string; forwardTo?: string[] };
	const name = String(body.name || "").trim().toLowerCase();
	const domain = (c.env.RESEND_DOMAIN || "idcare19.me").toLowerCase().trim();
	if (!validateAlias(name)) return c.json({ error: "Invalid name. Use lowercase letters, numbers, and hyphens." }, 400);
	if (!domain || domain.includes("@")) return c.json({ error: "Invalid RESEND_DOMAIN" }, 500);
	if (!c.env.RESEND_API_KEY) return c.json({ error: "Configure RESEND_API_KEY first" }, 503);
	const existing = await (configStub(c.env) as any).get(name);
	if (existing) return c.json({ error: "Email alias already exists", email: existing.address }, 409);
	const address = `${name}@${domain}`;
	const config: EmailConfig = {
		id: crypto.randomUUID(), address, name, senderName: String(body.senderName || name),
		replyTemplate: String(body.replyTemplate || "Thanks for contacting us. We received your message and will get back to you shortly."),
		forwardAddresses: (body.forwardTo || body.forwardAddresses || []).map(String).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)),
		autoReply: body.autoReply !== false, webhookUrl: body.webhookUrl, tags: Array.isArray(body.tags) ? body.tags.map(String) : [],
		replyTo: body.replyTo || address, createdAt: new Date().toISOString(), enabled: body.enabled !== false,
	};
	await c.env.BUCKET.put(`mailboxes/${address}.json`, JSON.stringify({ fromName: config.senderName, forwarding: { enabled: false, email: "" }, signature: { enabled: false, text: "" }, autoReply: { enabled: config.autoReply, subject: "", message: config.replyTemplate } }));
	await (configStub(c.env) as any).put(config);
	return c.json(config, 201);
});
app.get("/emails/:name", async (c) => {
	if (!requireAdmin(c)) return c.json({ error: "Unauthorized" }, 401);
	const result = await (configStub(c.env) as any).get(c.req.param("name"));
	return result ? c.json(result) : c.json({ error: "Email alias not found" }, 404);
});
app.put("/emails/:name", async (c) => {
	if (!requireAdmin(c)) return c.json({ error: "Unauthorized" }, 401);
	const current = await (configStub(c.env) as any).get(c.req.param("name")) as EmailConfig | null;
	if (!current) return c.json({ error: "Email alias not found" }, 404);
	const patch = await c.req.json() as Partial<EmailConfig> & { forwardTo?: string[] };
	const updated: EmailConfig = { ...current, ...patch, name: current.name, address: current.address, id: current.id, forwardAddresses: patch.forwardTo || patch.forwardAddresses || current.forwardAddresses, tags: Array.isArray(patch.tags) ? patch.tags : current.tags };
	await (configStub(c.env) as any).put(updated);
	return c.json(updated);
});
app.get("/messages/:email", async (c) => {
	if (!requireAdmin(c)) return c.json({ error: "Unauthorized" }, 401);
	const email = decodeURIComponent(c.req.param("email")).toLowerCase();
	const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(email));
	return c.json(await stub.getEmails({ folder: c.req.query("status") === "replied" ? Folders.SENT : Folders.INBOX, page: 1, limit: 100 }));
});
app.get("/messages/:email/:id", async (c) => {
	if (!requireAdmin(c)) return c.json({ error: "Unauthorized" }, 401);
	const email = decodeURIComponent(c.req.param("email")).toLowerCase();
	const message = await c.env.MAILBOX.get(c.env.MAILBOX.idFromName(email)).getEmail(c.req.param("id"));
	return message ? c.json(message) : c.json({ error: "Message not found" }, 404);
});
app.post("/messages/:email/reply", async (c) => {
	if (!requireAdmin(c)) return c.json({ error: "Unauthorized" }, 401);
	if (!c.env.RESEND_API_KEY) return c.json({ error: "Configure RESEND_API_KEY first" }, 503);
	const email = decodeURIComponent(c.req.param("email")).toLowerCase();
	const config = await (configStub(c.env) as any).get(email) as EmailConfig | null;
	if (!config || !config.enabled) return c.json({ error: "Email alias not found or disabled" }, 404);
	const body = await c.req.json() as { to: string; subject: string; text?: string; html?: string; inReplyTo?: string };
	if (!body.to || !body.subject || (!body.text && !body.html)) return c.json({ error: "to, subject, and text or html are required" }, 400);
	if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.to)) return c.json({ error: "Invalid recipient" }, 400);
	const result = await sendResendEmail(c.env.RESEND_API_KEY, { to: body.to, from: { email, name: config.senderName }, subject: body.subject, text: body.text, html: body.html, replyTo: config.replyTo || email, headers: body.inReplyTo ? { "In-Reply-To": body.inReplyTo, References: body.inReplyTo } : undefined });
	return c.json({ id: result.id, status: "sent" }, 202);
});
app.use("/api/*", cors({
	origin: (origin) => {
		// Same-origin requests have no Origin header — allow them.
		if (!origin) return origin;
		// In development, allow localhost for Vite dev server.
		try {
			const url = new URL(origin);
			if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return origin;
		} catch { /* invalid origin */ }
		// Block all other cross-origin requests. The app is served from the
		// same origin as the API, so legitimate browser requests never send
		// an Origin header. Returning undefined omits Access-Control-Allow-Origin.
		return undefined;
	},
}));
app.use("/api/v1/mailboxes/:mailboxId/*", requireMailbox);

// -- Config ---------------------------------------------------------

app.get("/api/v1/config", (c) => {
	const domainsRaw = c.env.DOMAINS || "";
	const domains = domainsRaw.split(",").map((d) => d.trim()).filter(Boolean);
	const emailAddresses = c.env.EMAIL_ADDRESSES ?? [];
	return c.json({ domains, emailAddresses });
});

// -- Mailboxes ------------------------------------------------------

app.get("/api/v1/mailboxes", async (c) => {
	const allMailboxes = await listMailboxes(c.env.BUCKET);
	return c.json(allMailboxes.map((m) => ({ ...m, name: m.id })));
});

app.post("/api/v1/mailboxes", async (c) => {
	const { name, settings, email: rawEmail } = CreateMailboxBody.parse(await c.req.json());
	const email = rawEmail.toLowerCase();
	const allowedAddresses = (c.env.EMAIL_ADDRESSES ?? []) as string[];
	if (allowedAddresses.length > 0 && !allowedAddresses.map((a) => a.toLowerCase()).includes(email)) {
		return c.json({ error: "Mailbox creation is restricted to configured EMAIL_ADDRESSES" }, 403);
	}
	const key = `mailboxes/${email}.json`;
	if (await c.env.BUCKET.head(key)) return c.json({ error: "Mailbox already exists" }, 409);
	const defaultSettings = { fromName: name, forwarding: { enabled: false, email: "" }, signature: { enabled: false, text: "" }, autoReply: { enabled: false, subject: "", message: "" } };
	const finalSettings = { ...defaultSettings, ...settings };
	await c.env.BUCKET.put(key, JSON.stringify(finalSettings));
	const stub = c.env.MAILBOX.get(c.env.MAILBOX.idFromName(email));
	await stub.getFolders();
	return c.json({ id: email, email, name, settings: finalSettings }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const obj = await c.env.BUCKET.get(`mailboxes/${mailboxId}.json`);
	if (!obj) return c.json({ error: "Not found" }, 404);
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings: await obj.json() });
});

app.put("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { settings } = (await c.req.json()) as { settings: Record<string, unknown> };
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	await c.env.BUCKET.put(key, JSON.stringify(settings));
	return c.json({ id: mailboxId, name: mailboxId, email: mailboxId, settings });
});

app.delete("/api/v1/mailboxes/:mailboxId", async (c) => {
	const mailboxId = c.req.param("mailboxId")!;
	const key = `mailboxes/${mailboxId}.json`;
	if (!(await c.env.BUCKET.head(key))) return c.json({ error: "Not found" }, 404);
	await c.env.BUCKET.delete(key); // TODO: also delete DO data and R2 attachment blobs
	return c.body(null, 204);
});

// -- Emails ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const folder = c.req.query("folder");
	const thread_id = c.req.query("thread_id");
	const threaded = boolQuery(c, "threaded");
	const page = intQuery(c, "page");
	const limit = intQuery(c, "limit");
	const sortColumn = c.req.query("sortColumn") as any;
	const sortDirection = c.req.query("sortDirection") as "ASC" | "DESC" | undefined;
	const stub = c.var.mailboxStub;

	if (threaded && folder) {
		const emails = await (stub as any).getThreadedEmails({ folder, page, limit });
		const totalCount = await (stub as any).countThreadedEmails(folder);
		return c.json({ emails, totalCount });
	}
	const emails = await stub.getEmails({ folder, thread_id, page, limit, sortColumn, sortDirection });
	if (folder) {
		const totalCount = await stub.countEmails({ folder, thread_id });
		return c.json({ emails, totalCount });
	}
	return c.json(emails);
});

app.post("/api/v1/mailboxes/:mailboxId/emails", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const body = SendEmailRequestSchema.parse(await c.req.json());
	const { to, cc, bcc, from, subject, html, text, attachments, in_reply_to, references, thread_id } = body;

	let toStr: string, fromEmail: string, fromDomain: string;
	try {
		({ toStr, fromEmail, fromDomain } = validateSender(to, from, mailboxId));
	} catch (e) {
		if (e instanceof SenderValidationError) return c.json({ error: e.message }, 400);
		throw e;
	}

	const { messageId, outgoingMessageId } = generateMessageId(fromDomain);
	const stub = c.var.mailboxStub;
	const rateLimitError = await (stub as any).checkSendRateLimit();
	if (rateLimitError) return c.json({ error: rateLimitError }, 429);
	const attachmentData = await storeAttachments(c.env.BUCKET, messageId, attachments);

	await stub.createEmail(Folders.SENT, {
		id: messageId, subject, sender: fromEmail, recipient: toStr,
		cc: cc ? (Array.isArray(cc) ? cc.join(", ") : cc).toLowerCase() : null,
		bcc: bcc ? (Array.isArray(bcc) ? bcc.join(", ") : bcc).toLowerCase() : null,
		date: new Date().toISOString(), body: html || text || "",
		in_reply_to: in_reply_to || null, email_references: references ? JSON.stringify(references) : null,
		thread_id: thread_id || in_reply_to || messageId, message_id: outgoingMessageId,
		raw_headers: JSON.stringify([
			{ key: "from", value: typeof from === "string" ? from : `${from.name} <${from.email}>` },
			{ key: "to", value: Array.isArray(to) ? to.join(", ") : to },
			...(cc ? [{ key: "cc", value: Array.isArray(cc) ? cc.join(", ") : cc }] : []),
			...(bcc ? [{ key: "bcc", value: Array.isArray(bcc) ? bcc.join(", ") : bcc }] : []),
			{ key: "subject", value: subject }, { key: "date", value: new Date().toISOString() },
			{ key: "message-id", value: `<${outgoingMessageId}>` },
		]),
	}, attachmentData);

	c.executionCtx.waitUntil(
		sendEmail(c.env.EMAIL, {
			to, cc, bcc, from, subject, html, text,
			attachments: attachments?.map((att) => ({ content: att.content, filename: att.filename, type: att.type, disposition: att.disposition || "attachment", contentId: att.contentId })),
			...(in_reply_to ? { headers: buildThreadingHeaders(in_reply_to, references || []) } : {}),
		}).catch((e) => console.error("Deferred email delivery failed:", (e as Error).message)),
	);
	return c.json({ id: messageId, status: "sent" }, 202);
});

app.post("/api/v1/mailboxes/:mailboxId/drafts", async (c: AppContext) => {
	const mailboxId = c.req.param("mailboxId")!;
	const { to, cc, bcc, subject, body, in_reply_to, thread_id, draft_id } = DraftBody.parse(await c.req.json());
	const stub = c.var.mailboxStub;
	if (draft_id) await stub.deleteEmail(draft_id); // not atomic — create-then-delete would be safer
	const messageId = crypto.randomUUID();
	const now = new Date().toISOString();
	await stub.createEmail(Folders.DRAFT, {
		id: messageId, subject: subject || "", sender: mailboxId.toLowerCase(),
		recipient: (to || "").toLowerCase(), cc: cc?.toLowerCase() || null, bcc: bcc?.toLowerCase() || null,
		date: now, body, in_reply_to: in_reply_to || null, email_references: null,
		thread_id: thread_id || in_reply_to || messageId,
	}, []);
	return c.json({ id: messageId, status: "draft", subject: subject || "", recipient: to || "", date: now }, 201);
});

app.get("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const email = await c.var.mailboxStub.getEmail(c.req.param("id")!);
	if (!email) return c.json({ error: "Email not found" }, 404);
	return new Response(JSON.stringify(email), {
		headers: { "Content-Type": "application/json" },
	});
});

app.put("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const { read, starred } = (await c.req.json()) as { read?: boolean; starred?: boolean };
	const email = await c.var.mailboxStub.updateEmail(c.req.param("id")!, { read, starred });
	return email ? c.json(email) : c.json({ error: "Email not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/emails/:id", async (c: AppContext) => {
	const id = c.req.param("id")!;
	const attachments = await c.var.mailboxStub.deleteEmail(id);
	if (attachments === null) return c.json({ error: "Not found" }, 404);
	if (attachments.length > 0) await c.env.BUCKET.delete(attachments.map((att: any) => `attachments/${id}/${att.id}/${att.filename}`));
	return c.body(null, 204);
});

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/move", async (c: AppContext) => {
	const { folderId } = (await c.req.json()) as { folderId: string };
	const success = await c.var.mailboxStub.moveEmail(c.req.param("id")!, folderId);
	return success ? c.json({ status: "moved" }) : c.json({ error: "Folder not found" }, 400);
});

// -- Threads --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/threads/:threadId", async (c: AppContext) => {
	return c.json(await (c.var.mailboxStub as any).getThreadEmails(c.req.param("threadId")!));
});

app.post("/api/v1/mailboxes/:mailboxId/threads/:threadId/read", async (c: AppContext) => {
	await c.var.mailboxStub.markThreadRead(c.req.param("threadId")!);
	return c.json({ status: "marked_read" });
});

// -- Reply / Forward ------------------------------------------------

app.post("/api/v1/mailboxes/:mailboxId/emails/:id/reply", handleReplyEmail);
app.post("/api/v1/mailboxes/:mailboxId/emails/:id/forward", handleForwardEmail);

// -- Folders --------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => c.json(await c.var.mailboxStub.getFolders()));

app.post("/api/v1/mailboxes/:mailboxId/folders", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const slug = slugify(name);
	if (!slug) return c.json({ error: "Folder name must contain alphanumeric characters" }, 400);
	const f = await c.var.mailboxStub.createFolder(slug, name);
	return f ? c.json(f, 201) : c.json({ error: "Folder with this name already exists" }, 409);
});

app.put("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const { name } = (await c.req.json()) as { name: string };
	const f = await c.var.mailboxStub.updateFolder(c.req.param("id")!, name);
	return f ? c.json(f) : c.json({ error: "Folder not found" }, 404);
});

app.delete("/api/v1/mailboxes/:mailboxId/folders/:id", async (c: AppContext) => {
	const ok = await c.var.mailboxStub.deleteFolder(c.req.param("id")!);
	return ok ? c.body(null, 204) : c.json({ error: "Folder not found or cannot be deleted" }, 400);
});

// -- Search ---------------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/search", async (c: AppContext) => {
	const searchOpts: Record<string, unknown> = {
		query: c.req.query("query") || "", folder: c.req.query("folder"), from: c.req.query("from"),
		to: c.req.query("to"), subject: c.req.query("subject"), date_start: c.req.query("date_start"),
		date_end: c.req.query("date_end"), is_read: boolQuery(c, "is_read"),
		is_starred: boolQuery(c, "is_starred"), has_attachment: boolQuery(c, "has_attachment"),
	};
	const stub = c.var.mailboxStub as any;
	const emails = await stub.searchEmails({ ...searchOpts, page: intQuery(c, "page"), limit: intQuery(c, "limit") });
	const totalCount = await stub.countSearchResults(searchOpts);
	return c.json({ emails, totalCount });
});

// -- Attachments ----------------------------------------------------

app.get("/api/v1/mailboxes/:mailboxId/emails/:emailId/attachments/:attachmentId", async (c: AppContext) => {
	const emailId = c.req.param("emailId")!;
	const attachmentId = c.req.param("attachmentId")!;
	const attachment = await c.var.mailboxStub.getAttachment(attachmentId);
	if (!attachment) return c.json({ error: "Attachment not found" }, 404);
	const obj = await c.env.BUCKET.get(`attachments/${emailId}/${attachmentId}/${attachment.filename}`);
	if (!obj) return c.json({ error: "Attachment file not found" }, 404);
	const headers = new Headers();
	headers.set("Content-Type", attachment.mimetype);
	const sanitized = attachment.filename.replace(/[\x00-\x1f"\\]/g, "_");
	headers.set("Content-Disposition", `attachment; filename="${sanitized}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`);
	return new Response(obj.body, { headers });
});

// -- Receive inbound email ------------------------------------------

const MAX_EMAIL_SIZE = 25 * 1024 * 1024;

async function streamToArrayBuffer(stream: ReadableStream, streamSize: number) {
	if (streamSize > MAX_EMAIL_SIZE) throw new Error(`Email too large: ${streamSize} bytes exceeds ${MAX_EMAIL_SIZE} byte limit`);
	if (streamSize <= 0) throw new Error(`Invalid stream size: ${streamSize}`);
	const result = new Uint8Array(streamSize);
	let bytesRead = 0;
	const reader = stream.getReader();
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (bytesRead + value.length > streamSize) { reader.cancel(); throw new Error(`Stream exceeds declared size`); }
		result.set(value, bytesRead);
		bytesRead += value.length;
	}
	return result;
}

async function receiveEmail(event: { raw: ReadableStream; rawSize: number }, env: Env, ctx: ExecutionContext) {
	const rawEmail = await streamToArrayBuffer(event.raw, event.rawSize);
	const parsedEmail = await new PostalMime().parse(rawEmail);

	if (!parsedEmail.to?.length || !parsedEmail.to[0].address) throw new Error("received email with empty to");

	const allRecipients = parsedEmail.to.map((t) => t.address?.toLowerCase()).filter(Boolean) as string[];
	const ccRecipients = (parsedEmail.cc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];
	const bccRecipients = (parsedEmail.bcc || []).map((e) => e.address?.toLowerCase()).filter(Boolean) as string[];

	// Inbound delivery is intentionally open to every sender. Select the first
	// recipient and use the mailbox existence check below as the guard.
	const mailboxId = allRecipients[0];
	if (!mailboxId) throw new Error("received email with no valid recipient address");
	const dynamicConfig = await (env.EMAIL_CONFIG.get(env.EMAIL_CONFIG.idFromName("registry")) as any).get(mailboxId) as EmailConfig | null;
	if (dynamicConfig && !dynamicConfig.enabled) { console.log(`Ignoring disabled dynamic email ${mailboxId}`); return; }

	const messageId = crypto.randomUUID();
	if (!(await env.BUCKET.head(`mailboxes/${mailboxId}.json`))) { console.log(`Ignoring email for ${mailboxId}: mailbox does not exist`); return; }

	const stub = env.MAILBOX.get(env.MAILBOX.idFromName(mailboxId));

	const attachmentData: StoredAttachment[] = [];
	if (parsedEmail.attachments) {
		for (const att of parsedEmail.attachments) {
			const attId = crypto.randomUUID();
			const filename = (att.filename || "untitled").replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
			await env.BUCKET.put(`attachments/${messageId}/${attId}/${filename}`, att.content);
			attachmentData.push({ id: attId, email_id: messageId, filename, mimetype: att.mimeType,
				size: typeof att.content === "string" ? att.content.length : att.content.byteLength,
				content_id: att.contentId || null, disposition: att.disposition || "attachment" });
		}
	}

	const extractMsgId = (s: string) => { const m = s.match(/<([^>]+)>/); return m ? m[1] : s.trim().split(/\s+/)[0]; };
	const inReplyTo = parsedEmail.inReplyTo ? extractMsgId(parsedEmail.inReplyTo) : null;
	const emailReferences = parsedEmail.references ? parsedEmail.references.split(/\s+/).filter(Boolean).map(extractMsgId) : [];
	let threadId = emailReferences[0] || inReplyTo || messageId;

	if (!inReplyTo && emailReferences.length === 0) {
		const subjectThread = await (stub as any).findThreadBySubject(parsedEmail.subject || "", parsedEmail.from?.address || undefined);
		if (subjectThread) threadId = subjectThread;
	}

	const originalMessageId = parsedEmail.messageId ? extractMsgId(parsedEmail.messageId) : null;

	await stub.createEmail(Folders.INBOX, {
		id: messageId, subject: parsedEmail.subject || "",
		sender: (parsedEmail.from?.address || "").toLowerCase(), recipient: allRecipients.join(", "),
		cc: ccRecipients.join(", ") || null, bcc: bccRecipients.join(", ") || null,
		date: new Date().toISOString(), // uses receive time, not the email's Date header
		body: parsedEmail.html || parsedEmail.text || "",
		in_reply_to: inReplyTo, email_references: emailReferences.length > 0 ? JSON.stringify(emailReferences) : null,
		thread_id: threadId, message_id: originalMessageId, raw_headers: JSON.stringify(parsedEmail.headers),
	}, attachmentData);

	const agentStub = env.EMAIL_AGENT.get(env.EMAIL_AGENT.idFromName(mailboxId));
	ctx.waitUntil(agentStub.fetch(new Request("https://agents/onNewEmail", {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ mailboxId, emailId: messageId, sender: (parsedEmail.from?.address || "").toLowerCase(), subject: parsedEmail.subject || "", threadId }),
	})).catch((e) => console.error("Auto-draft trigger failed:", (e as Error).message)));

	ctx.waitUntil(sendAutoReply({ parsedEmail, mailboxId, messageId, threadId, inReplyTo, originalMessageId, stub, env, config: dynamicConfig })
		.catch((e) => notifyAutoReplyFailure(env, mailboxId, parsedEmail, e)));
}

async function sendAutoReply(args: { parsedEmail: any; mailboxId: string; messageId: string; threadId: string; inReplyTo: string | null; originalMessageId: string | null; stub: any; env: Env; config?: EmailConfig | null }) {
	if (!args.env.RESEND_API_KEY || !args.env.RESEND_FROM_EMAIL) throw new Error("RESEND_API_KEY and RESEND_FROM_EMAIL must be configured");
	if (args.config && !args.config.autoReply) return;
	const sender = args.parsedEmail.from?.address?.toLowerCase();
	if (!sender) throw new Error("Incoming email has no sender address");
	const input = stripHtmlToText(args.parsedEmail.html || args.parsedEmail.text || "").slice(0, 12000);
	const template = args.config?.replyTemplate || "Write a concise, helpful email reply.";
	const result = await args.env.AI.run("@cf/mistral/mistral-7b-instruct-v0.1", {
		messages: [
			{ role: "system", content: `${template}\nReturn only the reply body, without subject or commentary about being an AI.` },
			{ role: "user", content: `From: ${sender}\nSubject: ${args.parsedEmail.subject || "(no subject)"}\n\n${input}` },
		], max_tokens: 600, temperature: 0.4,
	}) as { response?: string };
	const text = result.response?.trim();
	if (!text) throw new Error("Workers AI returned an empty reply");
	const subject = /^re:/i.test(args.parsedEmail.subject || "") ? args.parsedEmail.subject : `Re: ${args.parsedEmail.subject || ""}`.trim();
	const messageId = crypto.randomUUID();
	const providerMessage = await sendResendEmail(args.env.RESEND_API_KEY, {
		to: sender, from: args.config ? { email: args.mailboxId, name: args.config.senderName } : args.env.RESEND_FROM_EMAIL, subject, text, html: textToHtml(text), replyTo: args.config?.replyTo || args.mailboxId,
		headers: args.originalMessageId ? { "In-Reply-To": `<${args.originalMessageId}>`, References: `<${args.originalMessageId}>` } : undefined,
	});
	if (args.config?.forwardAddresses.length) await sendResendEmail(args.env.RESEND_API_KEY, { to: args.config.forwardAddresses, from: { email: args.mailboxId, name: args.config.senderName }, subject: args.parsedEmail.subject || "Forwarded message", text: input, html: textToHtml(input), replyTo: sender });
	await args.stub.createEmail(Folders.SENT, { id: messageId, subject, sender: args.mailboxId, recipient: sender, date: new Date().toISOString(), body: textToHtml(text), in_reply_to: args.inReplyTo || args.originalMessageId, email_references: null, thread_id: args.threadId, message_id: providerMessage.id }, []);
}

async function notifyAutoReplyFailure(env: Env, mailboxId: string, email: any, error: unknown) {
	console.error("Auto-reply failed:", error);
	if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) return;
	try { await sendResendEmail(env.RESEND_API_KEY, { to: env.ERROR_NOTIFICATION_EMAIL || "idcare19@gmail.com", from: env.RESEND_FROM_EMAIL, subject: `Auto-reply failed for ${mailboxId}`, text: `Mailbox: ${mailboxId}\nSender: ${email.from?.address || "unknown"}\nSubject: ${email.subject || "(no subject)"}\nError: ${error instanceof Error ? error.message : String(error)}` }); }
	catch (notificationError) { console.error("Auto-reply failure notification failed:", notificationError); }
}

export { app, receiveEmail };
