import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createCanvas, GlobalFonts, loadImage, type SKRSContext2D } from '@napi-rs/canvas'
import { Context, h, Logger, Schema } from 'koishi'

export const name = 'll-rollpig'

const logger = new Logger(name)
const PIGHUB_API_URL = 'https://pighub.top/api/images?sort=2'
const PIGHUB_BASE_URL = 'https://pighub.top'
const ROOT_DIR = path.resolve(__dirname, '..')
const RESOURCE_DIR = path.join(ROOT_DIR, 'resource')
const IMAGE_DIR = path.join(RESOURCE_DIR, 'image')
const FONT_DIR = path.join(RESOURCE_DIR, 'font')
const USER_FONT_DIR = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Windows', 'Fonts')
const PIG_POOL_FILE = path.join(RESOURCE_DIR, 'pig.json')
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'] as const

const CARD_WIDTH = 800
const CARD_HEIGHT = 800
const CARD_AVATAR_SIZE = 280
const CARD_NAME_SIZE = 66
const CARD_DESC_SIZE = 32
const CARD_ANALYSIS_SIZE = 28
const CARD_SPACING_AVATAR_NAME = 20
const CARD_SPACING_NAME_DESC = 25
const CARD_SPACING_DESC_ANALYSIS = 30
const CARD_DESC_LINE_HEIGHT = 42
const CARD_ANALYSIS_LINE_HEIGHT = 45
const CARD_DESC_MAX_WIDTH = 620
const CARD_ANALYSIS_MAX_WIDTH = 680

type MessagePart = string | ReturnType<typeof h.image> | ReturnType<typeof h.at>

interface FontPreference {
  families: string[]
  fileCandidates: string[]
  alias: string
}

interface FontAsset { family: string; source: string }

interface CanvasFonts { nameFont: FontAsset; descFont: FontAsset; analysisFont: FontAsset }

interface MentionTarget { userId: string; name?: string }

const TODAY_PIG_COMMANDS = ['今日小猪', '今天是什么小猪', '本日小猪', '当日小猪'] as const
const SESSION_MENTION_TARGET = '__rollpigMentionTarget__'

const normalizeUserId = (value: unknown) => {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return ''
}

const NAME_FONT_PREFERENCE: FontPreference = {
  families: ['Microsoft YaHei UI', 'Microsoft YaHei', '微软雅黑', 'PingFang SC', 'Noto Sans CJK SC', 'sans-serif'],
  fileCandidates: [path.join(FONT_DIR, '荆南麦圆体.otf'), 'C:\\Windows\\Fonts\\msyhbd.ttc', 'C:\\Windows\\Fonts\\msyh.ttc'],
  alias: 'RollPigNameFallback',
}

const DESC_FONT_PREFERENCE: FontPreference = {
  families: ['Microsoft YaHei UI', 'Microsoft YaHei', '微软雅黑', 'PingFang SC', 'Noto Sans CJK SC', 'sans-serif'],
  fileCandidates: [path.join(FONT_DIR, '可爱字体.ttf'), 'C:\\Windows\\Fonts\\msyh.ttc', 'C:\\Windows\\Fonts\\msyhl.ttc'],
  alias: 'RollPigDescFallback',
}

const ANALYSIS_FONT_PREFERENCE: FontPreference = {
  families: ['华康圆体W7-A', '华康圆体W7', 'DFYuanW7-GB', 'Microsoft YaHei UI', 'Microsoft YaHei', '微软雅黑', 'PingFang SC', 'Noto Sans CJK SC', 'sans-serif'],
  fileCandidates: [path.join(USER_FONT_DIR, '华康圆体W7-A.ttf'), path.join(FONT_DIR, '华康圆体W7.ttf'), path.join(FONT_DIR, '华康圆体W7.ttc'), path.join(FONT_DIR, 'DFYuanW7-GB.ttf'), path.join(FONT_DIR, '荆南麦圆体.otf'), 'C:\\Windows\\Fonts\\DFYuanW7-GB.ttf', 'C:\\Windows\\Fonts\\dfyuanw7-gb.ttf'],
  alias: 'RollPigAnalysisFallback',
}

export interface Config {
  dataDir: string
  maxRandomCount: number
  maxFindResults: number
  remoteCacheHours: number
  startupRefresh: boolean
  timezone: string
  enableTodayPig: boolean
  enableRandomPig: boolean
  enableFindPig: boolean
}

export const Config: Schema<Config> = Schema.object({
  dataDir: Schema.path({ allowCreate: true }).default('data/rollpig').description('插件缓存目录。'),
  maxRandomCount: Schema.natural().default(20).description('"随机小猪"允许抽取的最大数量。'),
  maxFindResults: Schema.natural().default(20).description('"找猪"最多返回的结果数。'),
  remoteCacheHours: Schema.number().default(12).description('PigHub 图片缓存刷新间隔（小时）。'),
  startupRefresh: Schema.boolean().default(true).description('启动后是否后台刷新 PigHub 缓存。'),
  timezone: Schema.string().default('').description('"今日小猪"使用的时区，留空表示跟随宿主环境。'),
  enableTodayPig: Schema.boolean().default(true).description('是否启用"今日小猪"相关指令。'),
  enableRandomPig: Schema.boolean().default(true).description('是否启用"随机小猪"指令。'),
  enableFindPig: Schema.boolean().default(true).description('是否启用"找猪 / 搜猪"指令。'),
})

interface PigInfo {
  id: string; title: string; image_url: string; filename: string
  view_count: number; download_count: number; mtime: number
}

interface Pigsonality { id: string; name: string; description: string; analysis: string }
interface PigRecord { pigId: string; date: string }
interface PigCacheFile { refreshedAt: number; images: PigInfo[] }

class RollPigStore {
  private readonly dataDir: string
  private readonly recordsFile: string
  private readonly remoteCacheFile: string
  private readonly pigPool: Pigsonality[] = []
  private readonly records = new Map<string, PigRecord>()
  private remotePigs: PigInfo[] = []
  private remoteRefreshedAt = 0
  private remoteRefreshTask?: Promise<void>
  private fontsReady = false
  private canvasFonts?: CanvasFonts

  constructor(
    private readonly config: Config,
    private readonly http: Context['http'],
  ) {
    this.dataDir = path.isAbsolute(config.dataDir) ? config.dataDir : path.resolve(process.cwd(), config.dataDir)
    this.recordsFile = path.join(this.dataDir, 'records.json')
    this.remoteCacheFile = path.join(this.dataDir, 'pighub-cache.json')
  }

  async initialize() {
    await mkdir(this.dataDir, { recursive: true })
    await this.loadPigPool()
    await Promise.all([this.loadRecords(), this.loadRemoteCache()])
    if (this.config.startupRefresh && (this.config.enableRandomPig || this.config.enableFindPig)) {
      void this.refreshRemotePigs(true).catch((error) => {
        logger.warn(`启动时刷新 PigHub 缓存失败：${this.formatError(error)}`)
      })
    }
  }

  async getTodayPig(userId: string) {
    const today = this.getTodayString()
    const record = this.records.get(userId)
    if (record?.date === today) {
      const cachedPig = this.getPigsonalityById(record.pigId)
      if (cachedPig) return cachedPig
    }
    const pig = this.pickOne(this.pigPool)
    this.records.set(userId, { pigId: pig.id, date: today })
    await this.saveRecords()
    return pig
  }

  async randomPigs(count: number) {
    await this.ensureRemotePigs()
    return this.sample(this.remotePigs, count)
  }

  async findPigs(keyword?: string, imageId?: string) {
    await this.ensureRemotePigs()
    if (imageId) return this.remotePigs.filter((pig) => pig.id === imageId)
    if (!keyword) return []
    const normalized = keyword.toLowerCase()
    return this.remotePigs.filter((pig) => pig.title.toLowerCase().includes(normalized))
  }

  async renderPigsonalityMessage(pig: Pigsonality, targetUserId?: string, isDirect = false, title = '. 这是你的今日小猪：', fallbackTitle = '【今日小猪】') {
    try {
      const card = await this.renderPigCard(pig)
      const output: MessagePart[] = []
      if (targetUserId && !isDirect) output.push(h.at(targetUserId), ' ')
      output.push(title, h.image(card, 'image/png'))
      return output
    } catch (error) {
      logger.warn(`渲染今日小猪卡片失败：${this.formatError(error)}`)
      return this.renderFallback(pig, targetUserId, isDirect, fallbackTitle)
    }
  }

  async renderPigGallery(pigs: PigInfo[], limit: number) {
    const output: MessagePart[] = []
    const sliced = pigs.slice(0, limit)
    sliced.forEach((pig, index) => {
      if (index > 0) output.push('\n\n')
      output.push(`${pig.title}-${pig.id}\n`, h.image(this.toPigHubImageUrl(pig)))
    })
    if (pigs.length > sliced.length) output.push(`\n\n还有 ${pigs.length - sliced.length} 张结果未展示。`)
    return output
  }

  private renderFallback(pig: Pigsonality, targetUserId?: string, isDirect = false, title = '【今日小猪】') {
    const output: MessagePart[] = []
    if (targetUserId && !isDirect) output.push(h.at(targetUserId), ' ')
    const image = this.getPigsonalityImage(pig.id)
    if (image) output.push(image, '\n')
    output.push(`${title}\n名称：${pig.name}\n描述：${pig.description}\n解析：${pig.analysis}`)
    return output
  }

  private async renderPigCard(pig: Pigsonality) {
    const { nameFont, descFont, analysisFont } = this.ensureCanvasFonts()
    const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT)
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT)
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'

    const descLines = this.wrapText(ctx, pig.description, CARD_DESC_MAX_WIDTH, this.getCanvasFont(CARD_DESC_SIZE, descFont.family))
    const analysisLines = this.wrapText(ctx, pig.analysis, CARD_ANALYSIS_MAX_WIDTH, this.getCanvasFont(CARD_ANALYSIS_SIZE, analysisFont.family))
    const nameHeight = Math.ceil(CARD_NAME_SIZE * 1.15)
    const descHeight = Math.max(1, descLines.length) * CARD_DESC_LINE_HEIGHT
    const analysisHeight = Math.max(1, analysisLines.length) * CARD_ANALYSIS_LINE_HEIGHT
    const totalHeight = CARD_AVATAR_SIZE + CARD_SPACING_AVATAR_NAME + nameHeight + CARD_SPACING_NAME_DESC + descHeight + CARD_SPACING_DESC_ANALYSIS + analysisHeight
    const startY = Math.floor((CARD_HEIGHT - totalHeight) / 2)
    const avatarY = startY
    const nameTop = avatarY + CARD_AVATAR_SIZE + CARD_SPACING_AVATAR_NAME
    const descTop = nameTop + nameHeight + CARD_SPACING_NAME_DESC
    const analysisTop = descTop + descHeight + CARD_SPACING_DESC_ANALYSIS

    await this.drawAvatar(ctx, pig.id, avatarY)
    ctx.fillStyle = '#000000'; ctx.font = this.getCanvasFont(CARD_NAME_SIZE, nameFont.family)
    ctx.fillText(pig.name, CARD_WIDTH / 2, nameTop)
    ctx.fillStyle = '#555555'; ctx.font = this.getCanvasFont(CARD_DESC_SIZE, descFont.family)
    this.drawMultilineText(ctx, descLines, CARD_WIDTH / 2, descTop, CARD_DESC_LINE_HEIGHT)
    ctx.fillStyle = '#333333'; ctx.font = this.getCanvasFont(CARD_ANALYSIS_SIZE, analysisFont.family)
    this.drawMultilineText(ctx, analysisLines, CARD_WIDTH / 2, analysisTop, CARD_ANALYSIS_LINE_HEIGHT)
    return canvas.toBuffer('image/png')
  }

  private wrapText(ctx: SKRSContext2D, text: string, maxWidth: number, font: string) {
    ctx.save(); ctx.font = font
    const lines: string[] = []
    for (const rawLine of text.split(/\r?\n/)) {
      let current = ''
      for (const char of rawLine) {
        const next = current + char
        if (ctx.measureText(next).width <= maxWidth || !current) { current = next; continue }
        lines.push(current); current = char
      }
      lines.push(current || '')
    }
    ctx.restore()
    return lines.filter((line, index, array) => line || index < array.length - 1)
  }

  private drawMultilineText(ctx: SKRSContext2D, lines: string[], centerX: number, top: number, lineHeight: number) {
    lines.forEach((line, index) => { ctx.fillText(line, centerX, top + index * lineHeight) })
  }

  private async drawAvatar(ctx: SKRSContext2D, pigId: string, top: number) {
    const file = this.getPigsonalityImageFile(pigId)
    const left = (CARD_WIDTH - CARD_AVATAR_SIZE) / 2
    if (!file) { this.drawAvatarPlaceholder(ctx, top); return }
    try {
      const avatar = await loadImage(file)
      const side = Math.min(avatar.width, avatar.height)
      const sx = (avatar.width - side) / 2; const sy = (avatar.height - side) / 2
      ctx.drawImage(avatar as any, sx, sy, side, side, left, top, CARD_AVATAR_SIZE, CARD_AVATAR_SIZE)
    } catch (error) {
      logger.warn(`加载小猪头像失败：${this.formatError(error)}`)
      this.drawAvatarPlaceholder(ctx, top)
    }
  }

  private drawAvatarPlaceholder(ctx: SKRSContext2D, top: number) {
    const { descFont } = this.ensureCanvasFonts()
    ctx.fillStyle = '#ff4d4f'; ctx.font = this.getCanvasFont(24, descFont.family)
    ctx.fillText('图片加载失败', CARD_WIDTH / 2, top + CARD_AVATAR_SIZE / 2 - 12)
  }

  private ensureCanvasFonts() {
    if (this.fontsReady && this.canvasFonts) return this.canvasFonts
    const nameFont = this.resolveFontAsset(NAME_FONT_PREFERENCE, '名称字体')
    const descFont = this.resolveFontAsset(DESC_FONT_PREFERENCE, '描述字体')
    const analysisFont = this.resolveFontAsset(ANALYSIS_FONT_PREFERENCE, '解析字体')
    this.canvasFonts = { nameFont, descFont, analysisFont }
    this.fontsReady = true
    return this.canvasFonts
  }

  private getCanvasFont(fontSize: number, family: string) { return `${fontSize}px ${family}` }

  private resolveFontAsset(preference: FontPreference, label: string): FontAsset {
    const fallbackPath = preference.fileCandidates.find((candidate) => existsSync(candidate))
    if (fallbackPath && !GlobalFonts.has(preference.alias)) {
      const registered = GlobalFonts.registerFromPath(fallbackPath, preference.alias)
      if (!registered) throw new Error(`${label}注册失败：${fallbackPath}`)
    }
    const families = [...preference.families]
    let source = 'system fallback'
    if (fallbackPath) { families.unshift(preference.alias); source = `file -> system fallback (${fallbackPath})` }
    logger.info(`${label}优先使用字体族：${families.join(', ')}`)
    return { family: families.map((f) => `"${f}"`).join(', '), source }
  }

  private async loadPigPool() {
    const file = await readFile(PIG_POOL_FILE, 'utf8')
    const pigs = JSON.parse(file) as Pigsonality[]
    this.pigPool.splice(0, this.pigPool.length, ...pigs)
    if (!this.pigPool.length) throw new Error('本地 pig.json 中没有可用的小猪人格数据。')
  }

  private async loadRecords() {
    const payload = await this.readJson<Record<string, PigRecord>>(this.recordsFile, {})
    this.records.clear()
    Object.entries(payload).forEach(([userId, record]) => {
      if (record?.pigId && record?.date) this.records.set(userId, record)
    })
  }

  private async loadRemoteCache() {
    const payload = await this.readJson<PigCacheFile>(this.remoteCacheFile, { refreshedAt: 0, images: [] })
    this.remoteRefreshedAt = payload.refreshedAt || 0
    this.remotePigs = Array.isArray(payload.images) ? payload.images : []
  }

  private async ensureRemotePigs() {
    const expiredAt = this.remoteRefreshedAt + this.config.remoteCacheHours * 60 * 60 * 1000
    if (!this.remotePigs.length || Date.now() >= expiredAt) {
      await this.refreshRemotePigs(!this.remotePigs.length)
    }
    if (!this.remotePigs.length) throw new Error('猪圈空荡荡，暂时没有可用的 PigHub 图片缓存。')
  }

  private async refreshRemotePigs(throwOnFailure: boolean) {
    if (this.remoteRefreshTask) return this.remoteRefreshTask
    this.remoteRefreshTask = (async () => {
      try {
        const data: any = await this.http.get(PIGHUB_API_URL, { responseType: 'json', timeout: 30000 })
        let images = (Array.isArray(data?.data) ? data.data : []).filter(
          (img: any): boolean =>
            (typeof img?.id === 'string' || typeof img?.id === 'number') &&
            typeof img?.title === 'string' &&
            typeof img?.image_url === 'string' && img.image_url.trim() !== '',
        ).map((img: any) => ({ ...img, id: String(img.id) })) as PigInfo[]
        if (!images.length) throw new Error('PigHub 返回了空图片列表。')
        const MAX = 5000
        if (images.length > MAX) { logger.warn(`PigHub 返回 ${images.length} 张，截断至 ${MAX}`); images = images.slice(0, MAX) }
        this.remotePigs = images
        this.remoteRefreshedAt = Date.now()
        await writeFile(this.remoteCacheFile, JSON.stringify({ refreshedAt: this.remoteRefreshedAt, images: this.remotePigs }, null, 2), 'utf8')
      } catch (error) {
        logger.warn(`刷新 PigHub 缓存失败：${this.formatError(error)}`)
        if (throwOnFailure) throw error
      } finally {
        this.remoteRefreshTask = undefined
      }
    })()
    return this.remoteRefreshTask
  }

  private async saveRecords() {
    await writeFile(this.recordsFile, JSON.stringify(Object.fromEntries(this.records.entries()), null, 2), 'utf8')
  }

  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try { const content = await readFile(file, 'utf8'); return JSON.parse(content) as T } catch (error) { const code = (error as NodeJS.ErrnoException)?.code; if (code !== 'ENOENT') logger.warn(`读取 ${path.basename(file)} 失败：${this.formatError(error)}`); return fallback }
  }

  private getPigsonalityById(pigId: string) { return this.pigPool.find((pig) => pig.id === pigId) }

  private getPigsonalityImageFile(pigId: string) {
    if (!/^[\w-]+$/.test(pigId)) return
    for (const extension of IMAGE_EXTENSIONS) { const file = path.join(IMAGE_DIR, `${pigId}${extension}`); if (existsSync(file)) return file }
  }

  private getPigsonalityImage(pigId: string) {
    const file = this.getPigsonalityImageFile(pigId)
    if (!file) return
    return h.image(readFileSync(file), this.getMimeType(path.extname(file).toLowerCase()))
  }

  private getMimeType(ext: string) {
    switch (ext) { case '.jpg': case '.jpeg': return 'image/jpeg'; case '.gif': return 'image/gif'; case '.webp': return 'image/webp'; default: return 'image/png' }
  }

  private toPigHubImageUrl(pig: PigInfo) {
    try {
      const url = new URL(pig.image_url, PIGHUB_BASE_URL)
      if (url.origin !== new URL(PIGHUB_BASE_URL).origin) {
        logger.warn(`PigHub 非法图片来源：${pig.image_url}`)
        return `${PIGHUB_BASE_URL}/images/default.png`
      }
      return url.toString()
    } catch { return `${PIGHUB_BASE_URL}/images/default.png` }
  }

  private getTodayString() {
    try {
      const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: this.config.timezone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' })
      const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]))
      return `${parts.year}-${parts.month}-${parts.day}`
    } catch { return new Date().toISOString().slice(0, 10) }
  }

  private pickOne<T>(items: T[]) { return items[Math.floor(Math.random() * items.length)] }

  private sample<T>(items: T[], count: number) {
    const pool = [...items]; const size = Math.max(0, Math.min(count, pool.length))
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]] }
    return pool.slice(0, size)
  }

  private formatError(error: unknown) { return error instanceof Error ? error.message : String(error) }
}

export function apply(ctx: Context, config: Config) {
  const store = new RollPigStore(config, ctx.http)
  const init = store.initialize()
  void init.catch((error) => {
    logger.error(`初始化失败：${error instanceof Error ? error.stack || error.message : String(error)}`)
  })

  const getIgnoredMentionIds = (session: any) => {
    const ids = new Set<string>()
    for (const c of [session?.selfId, session?.bot?.selfId, session?.bot?.user?.id, session?.event?.selfId]) {
      const n = normalizeUserId(c); if (n) ids.add(n)
    }
    return ids
  }

  const trimLeading = (el: any[]) => { while (el[0]?.type === 'text' && !String(el[0]?.attrs?.content || '').trim()) el.shift() }

  const dropBotMention = (el: any[], session: any, ignored: Set<string>) => {
    if (!session?.stripped?.atSelf) return el
    const c = el.slice(); trimLeading(c)
    const id = normalizeUserId(c[0]?.attrs?.id)
    if (c[0]?.type === 'at' && (!ignored.size || ignored.has(id))) { c.shift(); trimLeading(c) }
    return c
  }

  const extractMention = (el: any[] | undefined, session?: any): MentionTarget | undefined => {
    if (!Array.isArray(el) || !el.length) return
    const ignored = getIgnoredMentionIds(session)
    for (const e of dropBotMention(el, session, ignored)) {
      if (e?.type !== 'at') continue
      const id = normalizeUserId(e?.attrs?.id)
      if (!id || ignored.has(id)) continue
      return { userId: id, name: typeof e?.attrs?.name === 'string' ? e.attrs.name.trim() : '' }
    }
  }

  const rewriteLeadingMention = (session: any) => {
    const el = session?.event?.message?.elements ?? session?.elements
    if (!Array.isArray(el) || !el.length) return
    let i = 0
    while (el[i]?.type === 'text' && !String(el[i]?.attrs?.content || '').trim()) i++
    const m = el[i]
    if (m?.type !== 'at') return
    const id = normalizeUserId(m?.attrs?.id)
    if (!id || id === session?.selfId) return
    const t = el.slice(i + 1)
    if (!t.length || t.some((e) => e?.type !== 'text')) return
    const txt = t.map((e) => String(e?.attrs?.content || '')).join('').trim()
    if (!TODAY_PIG_COMMANDS.find((n) => n === txt)) return
    session.content = `${txt} ${m}`; session._stripped = undefined; session.argv = undefined
  }

  const rewriteTrailingMention = (session: any) => {
    const el = session?.event?.message?.elements ?? session?.elements
    if (!Array.isArray(el) || !el.length) return
    let changed = false
    const rw = el.map((e, i) => {
      if (e?.type !== 'text') return e
      const n = el[i + 1]; if (n?.type !== 'at') return e
      const c = String(e?.attrs?.content || ''); if (!c || /\s$/.test(c)) return e
      const t = c.trim(); if (!TODAY_PIG_COMMANDS.some((x) => x === t)) return e
      changed = true; return h.text(`${c} `)
    })
    if (!changed) return
    session.content = rw.join(''); session._stripped = undefined; session.argv = undefined
  }

  const getMentionTarget = (session: any, argv?: any): MentionTarget | undefined => {
    return session?.[SESSION_MENTION_TARGET]
      ?? extractMention(typeof session?.content === 'string' ? h.parse(session.content) : undefined, session)
      ?? extractMention(session?.elements, session)
      ?? extractMention(session?.event?.message?.elements, session)
      ?? extractMention(typeof argv?.source === 'string' ? h.parse(argv.source) : undefined, session)
      ?? extractMention(Array.isArray(argv?.args) ? argv.args.flatMap((a: unknown) => typeof a === 'string' ? h.parse(a) : []) : undefined, session)
  }

  ctx.on('before-attach', (session: any) => {
    const raw = session?.event?.message?.elements ?? session?.elements
    session[SESSION_MENTION_TARGET] = extractMention(raw, session)
    rewriteTrailingMention(session); rewriteLeadingMention(session)
  }, true)

  ctx.command('今日小猪', '抽取今天属于你的小猪。')
    .alias('今天是什么小猪', '本日小猪', '当日小猪')
    .action(async (argv) => {
      const { session } = argv
      if (!config.enableTodayPig) return '"今日小猪"当前已被禁用。'
      const currentUserId = session?.userId || session?.author?.id || session?.uid
      if (!currentUserId) return '这次没认出你是谁，稍后再试一次吧。'
      const mt = getMentionTarget(session, argv)
      const targetId = mt?.userId || currentUserId
      const targetName = mt?.name || 'TA'
      const self = targetId === currentUserId
      const cardTitle = self ? '. 这是你的今日小猪：' : `. 这是 ${targetName} 的今日小猪：`
      const fb = self ? '【今日小猪】' : `【${targetName} 的今日小猪】`
      try {
        await init
        const pig = await store.getTodayPig(targetId)
        return await store.renderPigsonalityMessage(pig, targetId, session?.isDirect, cardTitle, fb)
      } catch (error) {
        logger.warn(`今日小猪失败：${error instanceof Error ? error.message : String(error)}`)
        return '小猪窝打翻了，稍后再来看看吧。'
      }
    })

  ctx.command('随机小猪 [count:number]', '从 PigHub 随机获取猪猪图片。')
    .action(async (_, count = 1) => {
      if (!config.enableRandomPig) return '"随机小猪"当前已被禁用。'
      if (!Number.isInteger(count) || count < 1) return '数量要填正整数哦。'
      if (count > config.maxRandomCount) return `一次最多只能抽 ${config.maxRandomCount} 只小猪。`
      try {
        await init
        const pigs = await store.randomPigs(count)
        if (!pigs.length) return '猪圈空荡荡...'
        return await store.renderPigGallery(pigs, config.maxRandomCount)
      } catch (error) {
        logger.warn(`随机小猪失败：${error instanceof Error ? error.message : String(error)}`)
        return '今天没从 PigHub 抓到小猪，稍后再试试。'
      }
    })

  ctx.command('找猪 [keyword:text]', '根据关键词或图片 ID 查找 PigHub 猪猪。')
    .alias('搜猪')
    .option('id', '-i, --id <id:string> 指定要查找的图片 ID。')
    .action(async ({ options }, keyword) => {
      if (!config.enableFindPig) return '"找猪"当前已被禁用。'
      const imageId = typeof options?.id === 'string' ? options.id.trim() : ''
      const kw = typeof keyword === 'string' ? keyword.trim() : ''
      if (!imageId && !kw) return '请输入关键词，或者用 -i 指定图片 ID。'
      try {
        await init
        const pigs = await store.findPigs(kw, imageId)
        if (!pigs.length) return '你要找的猪仔离家出走了~'
        return await store.renderPigGallery(pigs, config.maxFindResults)
      } catch (error) {
        logger.warn(`找猪失败：${error instanceof Error ? error.message : String(error)}`)
        return '找猪的时候迷路了，稍后再试试。'
      }
    })
}
