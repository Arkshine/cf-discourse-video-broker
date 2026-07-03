import { enforceUploadQuota } from './access';
import { base64Utf8 } from './crypto';
import { brokerOrigin, corsJson, corsResponse } from './http';
import { requireBrokerToken } from './token';
import type { Env } from './types';

const DEFAULT_MAX_BYTES = 30 * 1024 * 1024 * 1024; // 30 GB (Cloudflare Stream ceiling)

export async function createCloudflareUpload(request: Request, env: Env): Promise<Response> {
	const auth = await requireBrokerToken(request, env);
	if (!auth.ok) return corsResponse(auth.response, env);

	const origin = request.headers.get('Origin');
	if (origin !== env.DISCOURSE_ORIGIN) {
		return corsJson({ error: 'Bad origin' }, env, 403);
	}

	if (!env.CLOUDFLARE_ACCOUNT_ID) {
		return corsJson({ error: 'Cloudflare Stream is not configured (missing CLOUDFLARE_ACCOUNT_ID).' }, env, 500);
	}

	const body = (await request.json()) as {
		filename?: string;
		mime_type?: string;
		size?: number;
		title?: string;
	};

	// tus has no 200 MB basic-upload cap, only Cloudflare's 30 GB ceiling.
	const maxBytes = Number(env.CLOUDFLARE_MAX_FILE_BYTES || String(DEFAULT_MAX_BYTES));

	if (!body.size || body.size > maxBytes) {
		return corsJson({ error: 'File too large' }, env, 413);
	}

	if (!body.mime_type?.startsWith('video/')) {
		return corsJson({ error: 'Only video files are allowed' }, env, 400);
	}

	const overQuota = await enforceUploadQuota(env, auth.user);
	if (overQuota) return overQuota;

	const maxDurationSeconds = Number(env.MAX_DURATION_SECONDS || '3600');
	const name = body.title || body.filename || 'video';

	// tus Upload-Metadata: `key <base64(value)>` pairs, comma-separated.
	const uploadMetadata = [
		`maxDurationSeconds ${base64Utf8(String(maxDurationSeconds))}`,
		`name ${base64Utf8(name)}`,
		`discourse_user_id ${base64Utf8(String(auth.user.id ?? ''))}`,
		`discourse_username ${base64Utf8(String(auth.user.username ?? ''))}`,
	].join(',');

	const cfRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream?direct_user=true`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.CLOUDFLARE_STREAM_TOKEN}`,
			'Tus-Resumable': '1.0.0',
			'Upload-Length': String(body.size),
			'Upload-Metadata': uploadMetadata,
		},
	});

	if (cfRes.status !== 201) {
		const details = await cfRes.text();
		return corsJson({ error: 'Cloudflare error', details }, env, 502);
	}

	const uploadUrl = cfRes.headers.get('Location');
	const uid = cfRes.headers.get('stream-media-id');

	if (!uploadUrl || !uid) {
		return corsJson({ error: 'Cloudflare did not return an upload URL' }, env, 502);
	}

	return corsJson(
		{
			provider: 'cloudflare_stream',
			upload_type: 'tus',
			upload_url: uploadUrl,
			uid,
			status_url: `${brokerOrigin(request, env)}/videos/${uid}`,
			iframe_url: `https://iframe.videodelivery.net/${uid}`,
		},
		env,
	);
}

export async function getCloudflareStatus(request: Request, env: Env, uid: string): Promise<Response> {
	const auth = await requireBrokerToken(request, env);
	if (!auth.ok) return corsResponse(auth.response, env);

	if (!uid) {
		return corsJson({ error: 'Missing video id' }, env, 400);
	}

	const cfRes = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/${uid}`, {
		headers: {
			Authorization: `Bearer ${env.CLOUDFLARE_STREAM_TOKEN}`,
		},
	});

	const data = await cfRes.json<any>();

	if (!cfRes.ok || !data.success) {
		return corsJson({ error: 'Cloudflare error', details: data }, env, 502);
	}

	const video = data.result;

	return corsJson(
		{
			uid,
			ready: video.readyToStream === true,
			status: video.status?.state || 'unknown',
			iframe_url: `https://iframe.videodelivery.net/${uid}`,
			thumbnail_url: `https://videodelivery.net/${uid}/thumbnails/thumbnail.jpg`,
		},
		env,
	);
}

export async function deleteCloudflareVideo(env: Env, uid: string): Promise<void> {
	await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/stream/${uid}`, {
		method: 'DELETE',
		headers: {
			Authorization: `Bearer ${env.CLOUDFLARE_STREAM_TOKEN}`,
		},
	}).catch(() => undefined);
}
