/**
 * SALESQUICKLY_TCTOKEN — minimal Trusted Contact token helpers for Baileys 6.7.x.
 * Backports the essential store/attach path from upstream 7.x without LID/ABProps.
 *
 * 重要（对齐上游 handlePrivacyTokenNotification）：
 * - privacy_token 通知里 token.attrs.jid 是「本端」JID，**绝不能**作为存储 key，
 *   否则对端 token 会落到自己号下（线上曾出现 tctoken-<自己的LID>.json），出站永远 miss → 463。
 * - 对端 = 通知的 sender_lid ?? from；6.7 无 LID mapping，因此 PN/LID 都写一份。
 * - 所有写入口都排除本端 PN/LID（history sync 里的「给自己发消息」会话也带 tcToken）。
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
	/** 我方最近一次向该联系人签发 trusted_contact token 的时间（秒），用于按桶去重 */
	senderTimestamp?: number
}

/** 与上游一致：7 天一桶，4 桶滚动窗口（约 28 天） */
const TC_TOKEN_BUCKET_DURATION = 604800
const TC_TOKEN_NUM_BUCKETS = 4

export function storageJidForTcToken(jid: string): string {
	return jidNormalizedUser(jid)
}

function isStoreableUserJid(jid: string): boolean {
	return !!(isJidUser(jid) || isLidUser(jid))
}

/** 把 creds.me 的 id/lid 等转成归一化的本端 JID 集合（去设备号） */
export function buildSelfJidSet(selfJids?: Array<string | null | undefined>): Set<string> {
	const set = new Set<string>()
	for (const jid of selfJids ?? []) {
		if (jid) set.add(storageJidForTcToken(jid))
	}

	return set
}

/** 对端 token 是否已超出 28 天滚动窗口（过期等同于没有，不能挂载） */
export function isTcTokenExpired(timestamp: number | string | null | undefined): boolean {
	if (timestamp === null || timestamp === undefined) return true
	const ts = typeof timestamp === 'string' ? parseInt(timestamp, 10) : timestamp
	if (isNaN(ts)) return true
	const now = Math.floor(Date.now() / 1000)
	const currentBucket = Math.floor(now / TC_TOKEN_BUCKET_DURATION)
	const cutoffBucket = currentBucket - (TC_TOKEN_NUM_BUCKETS - 1)
	return ts < cutoffBucket * TC_TOKEN_BUCKET_DURATION
}

/** 我方 token 是否需要重新签发（同一 7 天桶内只签一次，与 WA Web 一致） */
export function shouldSendNewTcToken(senderTimestamp: number | undefined): boolean {
	if (senderTimestamp === undefined) return true
	const now = Math.floor(Date.now() / 1000)
	return Math.floor(now / TC_TOKEN_BUCKET_DURATION) > Math.floor(senderTimestamp / TC_TOKEN_BUCKET_DURATION)
}

/**
 * Persist peer tokens from a privacy IQ result or privacy_token notification child list.
 *
 * @param peerJids 对端 JID（可多个：LID + PN），token 会写到每一个下面；**不再**使用 token.attrs.jid
 * @param selfJids 本端 JID（creds.me.id / creds.me.lid），命中则跳过
 */
export async function storeTcTokenNodes(
	keys: SignalKeyStoreWithTransaction,
	tokenNodes: BinaryNode[],
	peerJids: string | Array<string | null | undefined> | undefined,
	selfJids?: Array<string | null | undefined>
): Promise<string[]> {
	const self = buildSelfJidSet(selfJids)
	const targets = new Set<string>()
	for (const jid of Array.isArray(peerJids) ? peerJids : [peerJids]) {
		if (!jid) continue
		const storageJid = storageJidForTcToken(jid)
		if (isStoreableUserJid(storageJid) && !self.has(storageJid)) targets.add(storageJid)
	}

	const stored: string[] = []
	if (!targets.size) return stored

	for (const tokenNode of tokenNodes) {
		const type = tokenNode.attrs.type
		if (type && type !== 'trusted_contact') continue
		const content = tokenNode.content
		if (!(content instanceof Uint8Array) || !content.length) continue

		const incomingTs = tokenNode.attrs.t ? Number(tokenNode.attrs.t) : Math.floor(Date.now() / 1000)
		const entryBase: TcTokenEntry = {
			token: Buffer.from(content),
			timestamp: tokenNode.attrs.t || String(incomingTs)
		}

		for (const storageJid of targets) {
			const existing = (await keys.get('tctoken', [storageJid]))[storageJid]
			const existingTs = existing?.token?.length && existing?.timestamp ? Number(existing.timestamp) : 0
			if (existingTs > 0 && existingTs > incomingTs) continue

			await keys.set({ tctoken: { [storageJid]: { ...(existing || {}), ...entryBase } } })
			stored.push(storageJid)
		}
	}

	return stored
}

export async function storeTcTokensFromIqResult(
	keys: SignalKeyStoreWithTransaction,
	result: BinaryNode,
	peerJids: string | Array<string | null | undefined>,
	selfJids?: Array<string | null | undefined>
): Promise<string[]> {
	const tokensNode = getBinaryNodeChild(result, 'tokens')
	if (!tokensNode) return []
	return storeTcTokenNodes(keys, getBinaryNodeChildren(tokensNode, 'token'), peerJids, selfJids)
}

/** 进程内 PN↔LID 别名：出站按 PN 读时也能命中按 LID 落库的 token（6.7 无官方 LID mapping） */
const tcTokenJidAliases = new Map<string, Set<string>>()

export function linkTcTokenJids(jidA: string, jidB: string): void {
	const a = storageJidForTcToken(jidA)
	const b = storageJidForTcToken(jidB)
	if (!a || !b || a === b) return
	if (!tcTokenJidAliases.has(a)) tcTokenJidAliases.set(a, new Set())
	if (!tcTokenJidAliases.has(b)) tcTokenJidAliases.set(b, new Set())
	tcTokenJidAliases.get(a)!.add(b)
	tcTokenJidAliases.get(b)!.add(a)
}

/** 已知的别名（不含自身） */
export function getTcTokenJidAliases(jid: string): string[] {
	return [...(tcTokenJidAliases.get(storageJidForTcToken(jid)) ?? [])]
}

export type LoadedTcToken = TcTokenEntry & { storageJid: string }

/**
 * 读取对端 token（含 PN↔LID 别名）。
 * 只返回**未过期**的 token；过期/缺失返回 undefined（过期 token 挂上去同样会 463）。
 */
export async function loadTcToken(
	keys: SignalKeyStoreWithTransaction,
	jid: string
): Promise<LoadedTcToken | undefined> {
	const primary = storageJidForTcToken(jid)
	const candidates = new Set<string>([primary])
	for (const alt of tcTokenJidAliases.get(primary) ?? []) candidates.add(alt)

	const data = await keys.get('tctoken', [...candidates])
	for (const storageJid of candidates) {
		const entry = data[storageJid]
		if (entry?.token?.length && !isTcTokenExpired(entry.timestamp)) {
			return { ...entry, storageJid }
		}
	}

	return undefined
}

/** 读取原始记录（不判断过期），用于签发去重与诊断日志 */
export async function loadTcTokenRecord(
	keys: SignalKeyStoreWithTransaction,
	jid: string
): Promise<TcTokenEntry | undefined> {
	const storageJid = storageJidForTcToken(jid)
	return (await keys.get('tctoken', [storageJid]))[storageJid] ?? undefined
}

/** 记录我方签发时间（不改动对端 token 本身） */
export async function markTcTokenIssued(
	keys: SignalKeyStoreWithTransaction,
	jid: string,
	senderTimestamp: number
): Promise<void> {
	const storageJid = storageJidForTcToken(jid)
	const existing = (await keys.get('tctoken', [storageJid]))[storageJid]
	await keys.set({
		tctoken: {
			[storageJid]: {
				token: Buffer.alloc(0),
				...(existing || {}),
				senderTimestamp
			}
		}
	})
}

/** 把已有 tctoken 在两个 JID 间双写（学到 LID↔PN 后立刻镜像，避免出站 miss） */
export async function mirrorTcTokenBetweenJids(
	keys: SignalKeyStoreWithTransaction,
	jidA: string,
	jidB: string
): Promise<boolean> {
	linkTcTokenJids(jidA, jidB)
	const a = storageJidForTcToken(jidA)
	const b = storageJidForTcToken(jidB)
	if (!isStoreableUserJid(a) || !isStoreableUserJid(b) || a === b) return false

	const data = await keys.get('tctoken', [a, b])
	const entryA = data[a]
	const entryB = data[b]
	const tsA = entryA?.token?.length ? Number(entryA.timestamp) || 0 : 0
	const tsB = entryB?.token?.length ? Number(entryB.timestamp) || 0 : 0
	const writes: Record<string, TcTokenEntry> = {}
	// 只复制对端 token 字段；senderTimestamp（我方签发记录）各自保留
	if (tsA > tsB) writes[b] = { ...(entryB || {}), token: entryA!.token, timestamp: entryA!.timestamp }
	if (tsB > tsA) writes[a] = { ...(entryA || {}), token: entryB!.token, timestamp: entryB!.timestamp }
	if (!Object.keys(writes).length) return false
	await keys.set({ tctoken: writes })
	return true
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
 * 本端自聊会话（Message yourself）也带 tcToken，必须跳过。
 */
export async function storeTcTokensFromHistorySync(
	keys: SignalKeyStoreWithTransaction,
	chats: HistoryChatTc[],
	selfJids?: Array<string | null | undefined>
): Promise<number> {
	const self = buildSelfJidSet(selfJids)
	let written = 0
	for (const chat of chats) {
		const token = chat.tcToken
		const ts = toUnixTs(chat.tcTokenTimestamp)
		if (!(token instanceof Uint8Array) || !token.length || ts <= 0) continue

		const storageJids = [chat.id, chat.pnJid, chat.lidJid]
			.filter((j): j is string => typeof j === 'string' && j.length > 0)
			.map(storageJidForTcToken)
		if (storageJids.some(j => self.has(j))) continue

		const senderTs = toUnixTs(chat.tcTokenSenderTimestamp)
		const entryBase: TcTokenEntry = {
			token: Buffer.from(token),
			timestamp: String(ts),
			...(senderTs > 0 ? { senderTimestamp: senderTs } : {})
		}

		for (const storageJid of new Set(storageJids)) {
			if (!isStoreableUserJid(storageJid)) continue
			const existing = (await keys.get('tctoken', [storageJid]))[storageJid]
			const existingTs = existing?.token?.length && existing?.timestamp ? Number(existing.timestamp) : 0
			if (existingTs > 0 && existingTs >= ts) continue
			await keys.set({ tctoken: { [storageJid]: { ...(existing || {}), ...entryBase } } })
			written += 1
		}

		// 同一会话的 PN/LID 互为别名（进程内），出站按 PN 也能命中
		for (let i = 1; i < storageJids.length; i++) linkTcTokenJids(storageJids[0]!, storageJids[i]!)
	}

	return written
}
