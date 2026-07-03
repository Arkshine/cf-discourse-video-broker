import type { Env } from './types';

export const UPLOAD_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export async function getUploadRecord(env: Env, uploadId: string): Promise<any | null> {
	const raw = await env.KV.get(`upload:${uploadId}`);
	return raw ? JSON.parse(raw) : null;
}

export async function saveUploadRecord(env: Env, uploadId: string, record: Record<string, unknown>): Promise<void> {
	await env.KV.put(`upload:${uploadId}`, JSON.stringify(record), {
		expirationTtl: UPLOAD_TTL_SECONDS,
	});
}
