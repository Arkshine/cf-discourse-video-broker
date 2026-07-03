import { authCallback, authExchange, authStart } from './auth';
import { processPendingDeletes, discourseWebhook } from './cleanup';
import { createCloudflareUpload, getCloudflareStatus } from './cloudflare';
import { corsJson, corsResponse } from './http';
import { createMuxUpload, getMuxUploadStatus, muxWebhook } from './mux';
import type { Env } from './types';

// Bump on each release so deployments can report which version they run.
const VERSION = '1.0.0';

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === 'OPTIONS') {
			return corsResponse(null, env);
		}

		if (url.pathname === '/health' && request.method === 'GET') {
			return corsJson(
				{
					ok: true,
					version: VERSION,
					providers: {
						cloudflare_stream: Boolean(env.CLOUDFLARE_STREAM_TOKEN),
						mux: Boolean(env.MUX_TOKEN_ID),
					},
					cleanup: Boolean(env.DISCOURSE_WEBHOOK_SECRET),
				},
				env,
			);
		}

		if (url.pathname === '/auth/start' && request.method === 'GET') {
			return authStart(request, env);
		}

		if (url.pathname === '/auth/callback' && request.method === 'GET') {
			return authCallback(request, env);
		}

		if (url.pathname === '/auth/exchange' && request.method === 'POST') {
			return authExchange(request, env);
		}

		if (url.pathname === '/uploads/direct' && request.method === 'POST') {
			return createCloudflareUpload(request, env);
		}

		if (url.pathname.startsWith('/videos/') && request.method === 'GET') {
			const uid = url.pathname.split('/')[2];
			return getCloudflareStatus(request, env, uid);
		}

		if (url.pathname === '/mux/uploads' && request.method === 'POST') {
			return createMuxUpload(request, env);
		}

		if (url.pathname.startsWith('/mux/uploads/') && request.method === 'GET') {
			const uploadId = url.pathname.split('/')[3];
			return getMuxUploadStatus(request, env, uploadId);
		}

		if (url.pathname === '/mux/webhook' && request.method === 'POST') {
			return muxWebhook(request, env);
		}

		if (url.pathname === '/discourse/webhook' && request.method === 'POST') {
			return discourseWebhook(request, env);
		}

		return new Response('Not found', { status: 404 });
	},

	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(processPendingDeletes(env));
	},
};
