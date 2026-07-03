const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function randomHex(bytes: number): string {
	const buffer = new Uint8Array(bytes);
	crypto.getRandomValues(buffer);
	return [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function hmacHex(value: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey('raw', textEncoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

	const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(value));

	return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function signValue(value: string, secret: string): Promise<string> {
	return `${value}.${await hmacHex(value, secret)}`;
}

export async function verifySignedValue(signed: string, secret: string): Promise<string | null> {
	const index = signed.lastIndexOf('.');

	if (index === -1) {
		return null;
	}

	const value = signed.slice(0, index);
	const sig = signed.slice(index + 1);
	const expected = await hmacHex(value, secret);

	return timingSafeEqual(sig, expected) ? value : null;
}

export function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) {
		return false;
	}

	let result = 0;

	for (let i = 0; i < a.length; i++) {
		result |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}

	return result === 0;
}

export function base64Utf8(value: string): string {
	const bytes = textEncoder.encode(value);
	let binary = '';

	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}

	return btoa(binary);
}

export function base64UrlEncode(value: string): string {
	const bytes = textEncoder.encode(value);
	let binary = '';

	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}

	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecode(value: string): string {
	const padded = value
		.replace(/-/g, '+')
		.replace(/_/g, '/')
		.padEnd(Math.ceil(value.length / 4) * 4, '=');

	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);

	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}

	return textDecoder.decode(bytes);
}
