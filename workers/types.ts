// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;
	RESEND_API_KEY?: string;
	RESEND_FROM_EMAIL?: string;
	ERROR_NOTIFICATION_EMAIL?: string;
	RESEND_DOMAIN?: string;
	ADMIN_EMAIL?: string;
	ADMIN_API_TOKEN?: string;
	AUTO_REPLY_TIMEOUT?: string;
}

export interface EmailConfig {
	id: string;
	address: string;
	name: string;
	senderName: string;
	replyTemplate: string;
	forwardAddresses: string[];
	autoReply: boolean;
	webhookUrl?: string;
	tags: string[];
	replyTo?: string;
	createdAt: string;
	enabled: boolean;
}
