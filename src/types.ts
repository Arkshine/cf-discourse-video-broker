export type Env = {
	DISCOURSE_ORIGIN: string;
	BROKER_ORIGIN?: string;
	DISCOURSE_CONNECT_SECRET: string;
	DISCOURSE_WEBHOOK_SECRET: string;
	COOKIE_SECRET?: string;

	MUX_TOKEN_ID: string;
	MUX_TOKEN_SECRET: string;
	MUX_WEBHOOK_SECRET: string;
	MUX_VIDEO_QUALITY: string;

	CLOUDFLARE_ACCOUNT_ID?: string;
	CLOUDFLARE_STREAM_TOKEN: string;
	MAX_DURATION_SECONDS: string;
	CLOUDFLARE_MAX_FILE_BYTES: string;

	MUX_MAX_FILE_BYTES: string;
	CLEANUP_GRACE_DAYS: string;

	ALLOWED_GROUPS?: string;
	MAX_UPLOADS_PER_DAY: string;

	KV: KVNamespace;
};

export type BrokerUser = {
	id: string | null;
	username: string | null;
	name: string | null;
	email: string | null;
	admin: boolean;
	moderator: boolean;
	groups: string[];
};
