import { deleteCloudflareVideo } from './cloudflare';
import { hmacHex, timingSafeEqual } from './crypto';
import { deleteMuxByPlaybackId } from './mux';
import type { Env } from './types';

const DEFAULT_GRACE_DAYS = 14;

type PendingDelete = { provider?: string; id?: string; deleteAt?: number };

export async function discourseWebhook(request: Request, env: Env): Promise<Response> {
	if (!env.DISCOURSE_WEBHOOK_SECRET) {
		return new Response('Webhook secret not configured', { status: 500 });
	}

	const signature = request.headers.get('X-Discourse-Event-Signature');
	const event = request.headers.get('X-Discourse-Event') || '';

	const rawBody = await request.text();

	if (!signature) {
		return new Response('Missing signature', { status: 400 });
	}

	const expected = `sha256=${await hmacHex(rawBody, env.DISCOURSE_WEBHOOK_SECRET)}`;

	if (!timingSafeEqual(signature, expected)) {
		return new Response('Invalid signature', { status: 403 });
	}

	if (event === 'ping') {
		return new Response('pong', { status: 200 });
	}

	if (event !== 'post_destroyed' && event !== 'post_recovered') {
		return new Response('ignored', { status: 200 });
	}

	let payload: any;
	try {
		payload = JSON.parse(rawBody);
	} catch {
		return new Response('Bad JSON', { status: 400 });
	}

	const post = payload.post || {};
	const text = `${post.raw || ''}\n${post.cooked || ''}`;

	const { cloudflareUids, muxPlaybackIds } = extractVideoIds(text);

	if (event === 'post_destroyed') {
		await schedulePendingDeletes(env, cloudflareUids, muxPlaybackIds);
	} else {
		await cancelPendingDeletes(env, cloudflareUids, muxPlaybackIds);
	}

	return new Response('ok', { status: 200 });
}

export function extractVideoIds(text: string): { cloudflareUids: string[]; muxPlaybackIds: string[] } {
	const cloudflareUids = new Set<string>();
	const muxPlaybackIds = new Set<string>();

	// CF Stream uid is a 32-char hex, embedded as iframe.videodelivery.net/<uid>
	// (also videodelivery.net/<uid> and <customer>.cloudflarestream.com/<uid>).
	const cloudflareRe = /(?:iframe\.videodelivery\.net|videodelivery\.net|cloudflarestream\.com)\/([a-f0-9]{32})/gi;
	// Mux playback id, embedded as player.mux.com/<id> or stream.mux.com/<id>.m3u8
	const muxRe = /(?:player\.mux\.com|stream\.mux\.com)\/([A-Za-z0-9]+)/g;

	let match: RegExpExecArray | null;

	while ((match = cloudflareRe.exec(text))) {
		cloudflareUids.add(match[1]);
	}

	while ((match = muxRe.exec(text))) {
		muxPlaybackIds.add(match[1]);
	}

	return { cloudflareUids: [...cloudflareUids], muxPlaybackIds: [...muxPlaybackIds] };
}

function pendingDeleteKey(provider: 'cloudflare' | 'mux', id: string): string {
	return `pending_delete:${provider}:${id}`;
}

async function schedulePendingDeletes(env: Env, cloudflareUids: string[], muxPlaybackIds: string[]): Promise<void> {
	const graceDays = Number(env.CLEANUP_GRACE_DAYS || String(DEFAULT_GRACE_DAYS));
	const deleteAt = Date.now() + graceDays * 86400 * 1000;
	const expirationTtl = Math.max(graceDays + 7, 8) * 86400;
	const writes: Promise<unknown>[] = [];

	for (const uid of cloudflareUids) {
		writes.push(
			env.KV.put(pendingDeleteKey('cloudflare', uid), JSON.stringify({ provider: 'cloudflare', id: uid, deleteAt }), {
				expirationTtl,
			}),
		);
	}

	for (const playbackId of muxPlaybackIds) {
		writes.push(
			env.KV.put(pendingDeleteKey('mux', playbackId), JSON.stringify({ provider: 'mux', id: playbackId, deleteAt }), {
				expirationTtl,
			}),
		);
	}

	await Promise.all(writes);
}

async function cancelPendingDeletes(env: Env, cloudflareUids: string[], muxPlaybackIds: string[]): Promise<void> {
	const deletes: Promise<unknown>[] = [
		...cloudflareUids.map((uid) => env.KV.delete(pendingDeleteKey('cloudflare', uid))),
		...muxPlaybackIds.map((playbackId) => env.KV.delete(pendingDeleteKey('mux', playbackId))),
	];

	await Promise.all(deletes);
}

export async function processPendingDeletes(env: Env): Promise<void> {
	const now = Date.now();
	let cursor: string | undefined;

	do {
		const list = await env.KV.list({ prefix: 'pending_delete:', cursor });

		for (const key of list.keys) {
			const raw = await env.KV.get(key.name);

			if (!raw) {
				continue;
			}

			let entry: PendingDelete;
			try {
				entry = JSON.parse(raw);
			} catch {
				await env.KV.delete(key.name);
				continue;
			}

			if (!entry.deleteAt || entry.deleteAt > now || !entry.id) {
				continue;
			}

			if (entry.provider === 'cloudflare') {
				await deleteCloudflareVideo(env, entry.id);
			} else if (entry.provider === 'mux') {
				await deleteMuxByPlaybackId(env, entry.id);
			}

			await env.KV.delete(key.name);
		}

		cursor = list.list_complete ? undefined : list.cursor;
	} while (cursor);
}
