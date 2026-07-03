import { base64UrlDecode, base64UrlEncode, hmacHex, randomHex, timingSafeEqual } from './crypto';
import type { BrokerUser, Env } from './types';

const TOKEN_TTL_SECONDS = 60 * 60; // 1 hour

// Key used by the signing secret in KV. The secret signs both the nonce cookie
// and the broker token; it is internal to the broker and never shared, so we
// generate it once and persist it.
const SIGNING_SECRET_KEY = '_system:signing_secret';
let cachedSigningSecret: string | null = null;

export async function getSigningSecret(env: Env): Promise<string> {
	if (env.COOKIE_SECRET) {
		return env.COOKIE_SECRET;
	}

	if (cachedSigningSecret) {
		return cachedSigningSecret;
	}

	const existing = await env.KV.get(SIGNING_SECRET_KEY);
	if (existing) {
		cachedSigningSecret = existing;
		return existing;
	}

	const generated = randomHex(32);
	await env.KV.put(SIGNING_SECRET_KEY, generated);
	cachedSigningSecret = generated;
	return generated;
}

export async function createBrokerToken(user: BrokerUser, env: Env): Promise<string> {
	const payload = {
		user,
		exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
	};

	const encoded = base64UrlEncode(JSON.stringify(payload));
	const sig = await hmacHex(encoded, await getSigningSecret(env));

	return `${encoded}.${sig}`;
}

type BrokerAuth = { ok: true; user: BrokerUser } | { ok: false; response: Response };

export async function requireBrokerToken(request: Request, env: Env): Promise<BrokerAuth> {
	const header = request.headers.get('Authorization') || '';
	const token = header.replace(/^Bearer\s+/i, '');

	const parts = token.split('.');

	if (parts.length !== 2) {
		return {
			ok: false,
			response: new Response('Missing token', { status: 401 }),
		};
	}

	const [encoded, sig] = parts;
	const expectedSig = await hmacHex(encoded, await getSigningSecret(env));

	if (!timingSafeEqual(sig, expectedSig)) {
		return {
			ok: false,
			response: new Response('Invalid token', { status: 403 }),
		};
	}

	const payload = JSON.parse(base64UrlDecode(encoded));

	if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
		return {
			ok: false,
			response: new Response('Expired token', { status: 401 }),
		};
	}

	return { ok: true, user: payload.user };
}
