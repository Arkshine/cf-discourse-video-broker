import { enforceUploadQuota } from './access';
import { hmacHex, timingSafeEqual } from './crypto';
import { brokerOrigin, corsJson, corsResponse } from './http';
import { getUploadRecord, saveUploadRecord, UPLOAD_TTL_SECONDS } from './records';
import { requireBrokerToken } from './token';
import type { Env } from './types';

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
const MUX_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

async function muxFetch(env: Env, path: string, init: RequestInit): Promise<Response> {
	const credentials = btoa(`${env.MUX_TOKEN_ID}:${env.MUX_TOKEN_SECRET}`);

	const headers = new Headers(init.headers || {});
	headers.set('Authorization', `Basic ${credentials}`);
	headers.set('Content-Type', 'application/json');

	return fetch(`https://api.mux.com${path}`, {
		...init,
		headers,
	});
}

// Creates a Mux direct upload. The browser PUTs the file to the returned
// GCS-backed resumable URL; status is polled via getMuxUploadStatus.
export async function createMuxUpload(request: Request, env: Env): Promise<Response> {
	const auth = await requireBrokerToken(request, env);
	if (!auth.ok) return corsResponse(auth.response, env);

	const origin = request.headers.get('Origin');
	if (origin !== env.DISCOURSE_ORIGIN) {
		return corsJson({ error: 'Bad origin' }, env, 403);
	}

	const body = (await request.json()) as {
		filename?: string;
		mime_type?: string;
		size?: number;
		title?: string;
		topic_id?: number | null;
	};

	const maxBytes = Number(env.MUX_MAX_FILE_BYTES || String(DEFAULT_MAX_BYTES));

	if (!body.size || body.size > maxBytes) {
		return corsJson({ error: 'File too large' }, env, 413);
	}

	if (!body.mime_type?.startsWith('video/')) {
		return corsJson({ error: 'Only video files are allowed' }, env, 400);
	}

	const overQuota = await enforceUploadQuota(env, auth.user);
	if (overQuota) return overQuota;

	const passthrough = JSON.stringify({
		discourse_user_id: auth.user.id,
		discourse_username: auth.user.username,
		filename: body.filename || null,
		topic_id: body.topic_id || null,
	}).slice(0, 255);

	const muxRes = await muxFetch(env, '/video/v1/uploads', {
		method: 'POST',
		body: JSON.stringify({
			cors_origin: env.DISCOURSE_ORIGIN,
			new_asset_settings: {
				playback_policies: ['public'],
				video_quality: env.MUX_VIDEO_QUALITY || 'basic',
				passthrough,
			},
		}),
	});

	const data = await muxRes.json<any>();

	if (!muxRes.ok) {
		return corsJson({ error: 'Mux error', details: data }, env, 502);
	}

	const uploadId = data.data.id;

	await saveUploadRecord(env, uploadId, {
		provider: 'mux',
		upload_id: uploadId,
		upload_status: data.data.status || 'waiting',
		ready: false,
		asset_id: null,
		asset_status: null,
		playback_id: null,
		iframe_url: null,
		hls_url: null,
		thumbnail_url: null,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		user: {
			id: auth.user.id,
			username: auth.user.username,
		},
		file: {
			filename: body.filename || null,
			mime_type: body.mime_type || null,
			size: body.size || null,
		},
	});

	return corsJson(
		{
			provider: 'mux',
			upload_id: uploadId,
			upload_url: data.data.url,
			status_url: `${brokerOrigin(request, env)}/mux/uploads/${uploadId}`,
		},
		env,
	);
}

export async function getMuxUploadStatus(request: Request, env: Env, uploadId: string): Promise<Response> {
	const auth = await requireBrokerToken(request, env);
	if (!auth.ok) return corsResponse(auth.response, env);

	if (!uploadId) {
		return corsJson({ error: 'Missing upload id' }, env, 400);
	}

	const stored = await getUploadRecord(env, uploadId);

	if (stored?.ready || stored?.asset_status === 'errored') {
		return corsJson(stored, env);
	}

	const uploadRes = await muxFetch(env, `/video/v1/uploads/${uploadId}`, {
		method: 'GET',
	});

	const uploadData = await uploadRes.json<any>();

	if (!uploadRes.ok) {
		return corsJson({ error: 'Mux upload status error', details: uploadData }, env, 502);
	}

	const upload = uploadData.data;

	let record = {
		...(stored || {}),
		provider: 'mux',
		upload_id: upload.id,
		upload_status: upload.status,
		asset_id: upload.asset_id || stored?.asset_id || null,
		ready: false,
		updated_at: new Date().toISOString(),
	};

	if (upload.asset_id) {
		await env.KV.put(`asset:${upload.asset_id}`, upload.id, {
			expirationTtl: UPLOAD_TTL_SECONDS,
		});
	}

	if (!upload.asset_id) {
		await saveUploadRecord(env, upload.id, record);
		return corsJson(record, env);
	}

	const assetRes = await muxFetch(env, `/video/v1/assets/${upload.asset_id}`, {
		method: 'GET',
	});

	const assetData = await assetRes.json<any>();

	if (!assetRes.ok) {
		return corsJson({ error: 'Mux asset status error', details: assetData }, env, 502);
	}

	const asset = assetData.data;
	const playbackId = asset.playback_ids?.[0]?.id || null;

	record = {
		...record,
		asset_id: asset.id,
		asset_status: asset.status,
		ready: asset.status === 'ready' && !!playbackId,
		playback_id: playbackId,
		iframe_url: playbackId ? `https://player.mux.com/${playbackId}` : null,
		hls_url: playbackId ? `https://stream.mux.com/${playbackId}.m3u8` : null,
		thumbnail_url: playbackId ? `https://image.mux.com/${playbackId}/thumbnail.jpg` : null,
		updated_at: new Date().toISOString(),
	};

	if (playbackId) {
		// Reverse index so the Discourse cleanup webhook can map a playback id
		// (all it can read from a post) back to the asset it must delete.
		await env.KV.put(`playback:${playbackId}`, asset.id, {
			expirationTtl: UPLOAD_TTL_SECONDS,
		});
	}

	await saveUploadRecord(env, upload.id, record);

	return corsJson(record, env);
}

export async function muxWebhook(request: Request, env: Env): Promise<Response> {
	const signature = request.headers.get('Mux-Signature');

	if (!signature) {
		return new Response('Missing Mux-Signature', { status: 400 });
	}

	const rawBody = await request.text();

	const valid = await verifyMuxSignature(rawBody, signature, env.MUX_WEBHOOK_SECRET);

	if (!valid) {
		return new Response('Invalid signature', { status: 403 });
	}

	const event = JSON.parse(rawBody);
	const type = event.type;
	const data = event.data;

	if (type === 'video.upload.asset_created') {
		const uploadId = data.id;
		const assetId = data.asset_id;

		const existing = await getUploadRecord(env, uploadId);

		const record = {
			...(existing || {}),
			provider: 'mux',
			upload_id: uploadId,
			upload_status: data.status || 'asset_created',
			ready: false,
			asset_id: assetId || null,
			asset_status: null,
			updated_at: new Date().toISOString(),
		};

		await saveUploadRecord(env, uploadId, record);

		if (assetId) {
			await env.KV.put(`asset:${assetId}`, uploadId, {
				expirationTtl: UPLOAD_TTL_SECONDS,
			});
		}
	}

	if (type === 'video.asset.ready') {
		const assetId = data.id;
		const playbackId = data.playback_ids?.[0]?.id || null;
		const uploadId = await env.KV.get(`asset:${assetId}`);

		if (uploadId) {
			const existing = await getUploadRecord(env, uploadId);

			await saveUploadRecord(env, uploadId, {
				...(existing || {}),
				provider: 'mux',
				upload_id: uploadId,
				asset_id: assetId,
				asset_status: 'ready',
				ready: !!playbackId,
				playback_id: playbackId,
				iframe_url: playbackId ? `https://player.mux.com/${playbackId}` : null,
				hls_url: playbackId ? `https://stream.mux.com/${playbackId}.m3u8` : null,
				thumbnail_url: playbackId ? `https://image.mux.com/${playbackId}/thumbnail.jpg` : null,
				updated_at: new Date().toISOString(),
			});

			if (playbackId) {
				await env.KV.put(`playback:${playbackId}`, assetId, {
					expirationTtl: UPLOAD_TTL_SECONDS,
				});
			}
		}
	}

	if (type === 'video.asset.errored') {
		const assetId = data.id;
		const uploadId = await env.KV.get(`asset:${assetId}`);

		if (uploadId) {
			const existing = await getUploadRecord(env, uploadId);

			await saveUploadRecord(env, uploadId, {
				...(existing || {}),
				provider: 'mux',
				upload_id: uploadId,
				asset_id: assetId,
				asset_status: 'errored',
				ready: false,
				error: data.errors || data.error || 'Mux asset errored',
				updated_at: new Date().toISOString(),
			});
		}
	}

	return new Response('ok', { status: 200 });
}

export async function deleteMuxByPlaybackId(env: Env, playbackId: string): Promise<void> {
	const assetId = await env.KV.get(`playback:${playbackId}`);

	if (!assetId) {
		return;
	}

	await muxFetch(env, `/video/v1/assets/${assetId}`, { method: 'DELETE' }).catch(() => undefined);
}

async function verifyMuxSignature(rawBody: string, signatureHeader: string, secret: string): Promise<boolean> {
	const parts = signatureHeader.split(',').map((part) => part.trim());

	let timestamp: string | null = null;
	const signatures: string[] = [];

	for (const part of parts) {
		const [key, value] = part.split('=');

		if (key === 't') {
			timestamp = value;
		}

		if (key === 'v1') {
			signatures.push(value);
		}
	}

	if (!timestamp || signatures.length === 0) {
		return false;
	}

	const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));

	if (ageSeconds > MUX_SIGNATURE_TOLERANCE_SECONDS) {
		return false;
	}

	const signedPayload = `${timestamp}.${rawBody}`;
	const expected = await hmacHex(signedPayload, secret);

	return signatures.some((signature) => timingSafeEqual(signature, expected));
}
