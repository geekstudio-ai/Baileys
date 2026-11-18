/**
 * SALESQUICKLY_TCTOKEN — minimal Trusted Contact token helpers for Baileys 6.7.x.
 * Backports the essential store/attach path from upstream 7.x without LID/ABProps.
 *
 * 重要（对齐上游 #2339）：privacy_token 通知里 token.attrs.jid 常常是「本端设备 JID」，
 * 真正的对端要用通知的 from（fallbackJid）。优先 fallback，否则会把 token 存到自己号下，
 * 出站按对方 PN 读取永远 miss → 仍 463。
 */
import type { SignalKeyStoreWithTransaction } from '../Types'
import {
	type BinaryNode,
	getBinaryNodeChild,
	getBinaryNodeChildren,
	isJidUser,
	isLidUser,
	jidNormalizedUser
} from '../WABinary'

export type TcTokenEntry = {
	token: Buffer
	timestamp?: string
	senderTimestamp?: number
}

export function storageJidForTcToken(jid: string): string {
	return jidNormalizedUser(jid)
}

function isStoreableUserJid(jid: string): boolean {
	return !!(isJidUser(jid) || isLidUser(jid))
}

/** Persist tokens from a privacy IQ result or privacy_token notification child list. */
export async function storeTcTokenNodes(
	keys: SignalKeyStoreWithTransaction,
	tokenNodes: BinaryNode[],
	fallbackJid?: string
): Promise<string[]> {
	const stored: string[] = []
	for (const tokenNode of tokenNodes) {
		const type = tokenNode.attrs.type
		if (type && type !== 'trusted_contact') continue
		const content = tokenNode.content
		if (!(content instanceof Uint8Array) || !content.length) continue

		// 与上游一致：fallback（通知 from / 出站目标）优先于 attrs.jid
		const primary = fallbackJid || tokenNode.attrs.jid
		if (!primary) continue

		const candidates = new Set<string>()
		candidates.add(storageJidForTcToken(primary))
		if (tokenNode.attrs.jid) {
			candidates.add(storageJidForTcToken(tokenNode.attrs.jid))
		}

		const incomingTs = tokenNode.attrs.t ? Number(tokenNode.attrs.t) : Math.floor(Date.now() / 1000)
		const entryBase: TcTokenEntry = {
			token: Buffer.from(content),
			timestamp: tokenNode.attrs.t || String(incomingTs)
		}

		for (const storageJid of candidates) {
			if (!isStoreableUserJid(storageJid)) continue
			const existing = (await keys.get('tctoken', [storageJid]))[storageJid]
			const existingTs = existing?.timestamp ? Number(existing.timestamp) : 0
			if (existingTs > 0 && existingTs > incomingTs) continue

			const entry: TcTokenEntry = {
				...(existing || {}),
				...entryBase
			}
			await keys.set({ tctoken: { [storageJid]: entry } })
			stored.push(storageJid)
		}
	}
	return stored
}

export async function storeTcTokensFromIqResult(
	keys: SignalKeyStoreWithTransaction,
	result: BinaryNode,
	fallbackJid: string
): Promise<string[]> {
	const tokensNode = getBinaryNodeChild(result, 'tokens')
	if (!tokensNode) return []
	return storeTcTokenNodes(keys, getBinaryNodeChildren(tokensNode, 'token'), fallbackJid)
}

export async function loadTcToken(
	keys: SignalKeyStoreWithTransaction,
	jid: string
): Promise<TcTokenEntry | undefined> {
	const storageJid = storageJidForTcToken(jid)
	const data = await keys.get('tctoken', [storageJid])
	const entry = data[storageJid]
	if (!entry?.token?.length) return undefined
	return entry
}

type HistoryChatTc = {
	id?: string | null
	pnJid?: string | null
	lidJid?: string | null
	tcToken?: Uint8Array | null
	tcTokenTimestamp?: number | { toNumber?: () => number } | null
	tcTokenSenderTimestamp?: number | { toNumber?: () => number } | null
}

function toUnixTs(value: HistoryChatTc['tcTokenTimestamp']): number {
	if (value == null) return 0
	if (typeof value === 'number') return value
	if (typeof value.toNumber === 'function') return value.toNumber()
	return Number(value) || 0
}

/**
 * 从 history sync 的 Conversation 提取对端 tctoken。
 * 这是出站能挂上 token 的主来源之一；privacy IQ（issuePrivacyTokens）**不会**返回对端 token。
 * 同一 token 写到 id / pnJid / lidJid 多个键，避免发 PN、库里只有 LID 时 miss。
 */
export async function storeTcTokensFromHistorySync(
	keys: SignalKeyStoreWithTransaction,
	chats: HistoryChatTc[]
): Promise<number> {
	let written = 0
	for (const chat of chats) {
		const token = chat.tcToken
		const ts = toUnixTs(chat.tcTokenTimestamp)
		if (!(token instanceof Uint8Array) || !token.length || ts <= 0) continue

		const candidateJids = [chat.id, chat.pnJid, chat.lidJid].filter(
			(j): j is string => typeof j === 'string' && j.length > 0
		)
		const senderTs = toUnixTs(chat.tcTokenSenderTimestamp)
		const entryBase: TcTokenEntry = {
			token: Buffer.from(token),
			timestamp: String(ts),
			...(senderTs > 0 ? { senderTimestamp: senderTs } : {})
		}

		for (const jid of candidateJids) {
			const storageJid = storageJidForTcToken(jid)
			if (!isStoreableUserJid(storageJid)) continue
			const existing = (await keys.get('tctoken', [storageJid]))[storageJid]
			const existingTs = existing?.timestamp ? Number(existing.timestamp) : 0
			if (existingTs > 0 && existingTs >= ts) continue
			await keys.set({
				tctoken: {
					[storageJid]: {
						...(existing || {}),
						...entryBase
					}
				}
			})
			written += 1
		}
	}
	return written
}
