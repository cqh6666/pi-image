import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import type { ImageContent } from "@earendil-works/pi-ai";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Container,
	getCapabilities,
	getImageDimensions,
	Image,
	matchesKey,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";

const IMAGE_EXT_REGEX = /\.(png|jpe?g|webp|gif)$/i;
const IMAGE_PATH_REGEX = /(?:^|\s)(?:@)?(["']?)([^\s"']+\.(?:png|jpe?g|webp|gif))\1(?=\s|$)/gi;
const REMOTE_URL_REGEX = /https?:\/\/[^\s"']+\.(?:png|jpe?g|webp|gif)(?:\?[^\s"']*)?/gi;

const HISTORY_FILE = resolve(homedir(), ".pi", "agent", "image-history.json");
const REMOTE_CACHE_DIR = resolve(tmpdir(), "pi-remote-cache");

interface SessionHistoryStore {
	[sessionId: string]: string[];
}

function getMimeType(filePath: string): string {
	const ext = filePath.split(".").pop()?.toLowerCase();
	if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
	if (ext === "webp") return "image/webp";
	if (ext === "gif") return "image/gif";
	return "image/png";
}

function expandHome(filePath: string): string {
	if (filePath === "~") return homedir();
	if (filePath.startsWith("~/")) return resolve(homedir(), filePath.slice(2));
	return filePath;
}

function formatFileSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function estimateVisionTokens(width: number, height: number): number {
	let w = width;
	let h = height;
	if (w > 2048 || h > 2048) {
		const scale = 2048 / Math.max(w, h);
		w = Math.round(w * scale);
		h = Math.round(h * scale);
	}
	if (Math.min(w, h) > 768) {
		const scale = 768 / Math.min(w, h);
		w = Math.round(w * scale);
		h = Math.round(h * scale);
	}
	const tilesX = Math.ceil(w / 512);
	const tilesY = Math.ceil(h / 512);
	return tilesX * tilesY * 170 + 85;
}

function getAspectRatio(width: number, height: number): string {
	const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
	const d = gcd(width, height);
	const simpW = Math.round(width / d);
	const simpH = Math.round(height / d);
	if (simpW <= 21 && simpH <= 21 && simpW > 0 && simpH > 0) {
		return `${simpW}:${simpH}`;
	}
	return `${(width / height).toFixed(1)}:1`;
}

function getImageSourceLabel(filePath: string): string {
	const name = basename(filePath);
	if (name.startsWith("pi-clipboard-")) return "剪贴板截图";
	if (filePath.includes("pi-remote-cache")) return "远程下载";
	return "本地文件";
}

function isWsl(): boolean {
	try {
		if (process.platform === "linux" && existsSync("/proc/version")) {
			const version = readFileSync("/proc/version", "utf-8").toLowerCase();
			return version.includes("microsoft") || version.includes("wsl");
		}
	} catch {
		// Ignore check errors
	}
	return false;
}

let activeQuickLookProc: ReturnType<typeof spawn> | null = null;

function quickLookImage(filePath: string): void {
	try {
		if (process.platform === "darwin") {
			if (activeQuickLookProc && !activeQuickLookProc.killed) {
				try {
					activeQuickLookProc.kill();
				} catch {
					// Ignore kill errors
				}
			}
			activeQuickLookProc = spawn("qlmanage", ["-p", filePath], { detached: true, stdio: "ignore" });
		} else if (process.platform === "win32") {
			// On Windows, try native QuickLook.exe if installed
			const child = spawn("quicklook.exe", [filePath], { detached: true, stdio: "ignore" });
			child.on("error", () => {
				openInSystemViewer(filePath);
			});
		} else if (isWsl()) {
			// In WSL, try quicklook.exe via interop, fallback to wslview/open
			const child = spawn("quicklook.exe", [filePath], { detached: true, stdio: "ignore" });
			child.on("error", () => {
				openInSystemViewer(filePath);
			});
		} else {
			openInSystemViewer(filePath);
		}
	} catch {
		openInSystemViewer(filePath);
	}
}

function openInSystemViewer(filePath: string): void {
	try {
		if (process.platform === "darwin") {
			spawn("open", [filePath], { detached: true, stdio: "ignore" });
		} else if (process.platform === "win32") {
			spawn("cmd.exe", ["/c", "start", '""', filePath], { detached: true, stdio: "ignore" });
		} else if (isWsl()) {
			// In WSL, use wslview first, then fallback to powershell.exe
			const child = spawn("wslview", [filePath], { detached: true, stdio: "ignore" });
			child.on("error", () => {
				try {
					spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Start-Process (wslpath -w '${filePath.replace(/'/g, "''")}')`], { detached: true, stdio: "ignore" });
				} catch {
					spawn("xdg-open", [filePath], { detached: true, stdio: "ignore" });
				}
			});
		} else {
			spawn("xdg-open", [filePath], { detached: true, stdio: "ignore" });
		}
	} catch {
		// Ignore launch errors
	}
}

async function fetchRemoteImage(url: string): Promise<string | null> {
	try {
		if (!existsSync(REMOTE_CACHE_DIR)) {
			mkdirSync(REMOTE_CACHE_DIR, { recursive: true });
		}
		const hash = createHash("md5").update(url).digest("hex");
		const cleanUrl = url.split("?")[0] ?? url;
		const extMatch = cleanUrl.match(/\.(png|jpe?g|webp|gif)/i);
		const ext = extMatch ? extMatch[1]?.toLowerCase() : "png";
		const cachePath = resolve(REMOTE_CACHE_DIR, `${hash}.${ext}`);

		if (existsSync(cachePath)) {
			return cachePath;
		}

		const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
		if (!res.ok) return null;
		const buffer = Buffer.from(await res.arrayBuffer());
		// Max 20MB limit
		if (buffer.length > 20 * 1024 * 1024) return null;
		writeFileSync(cachePath, buffer);
		return cachePath;
	} catch {
		return null;
	}
}

function loadHistoryStore(): SessionHistoryStore {
	try {
		if (existsSync(HISTORY_FILE)) {
			const data = JSON.parse(readFileSync(HISTORY_FILE, "utf-8"));
			if (typeof data === "object" && data !== null && !Array.isArray(data)) {
				return data as SessionHistoryStore;
			}
		}
	} catch {
		// Ignore corrupted history
	}
	return {};
}

function saveSessionHistory(sessionId: string, list: string[]): void {
	try {
		const store = loadHistoryStore();
		store[sessionId] = list.slice(-30);
		// Keep at most 20 recent sessions
		const keys = Object.keys(store);
		if (keys.length > 20) {
			for (const oldKey of keys.slice(0, keys.length - 20)) {
				delete store[oldKey];
			}
		}
		writeFileSync(HISTORY_FILE, JSON.stringify(store, null, 2), "utf-8");
	} catch {
		// Ignore write errors
	}
}

function getSessionHistory(sessionId: string): string[] {
	const store = loadHistoryStore();
	const list = store[sessionId] ?? [];
	return list.filter((p) => typeof p === "string" && existsSync(p));
}

function clearSessionHistory(sessionId: string): void {
	try {
		const store = loadHistoryStore();
		delete store[sessionId];
		writeFileSync(HISTORY_FILE, JSON.stringify(store, null, 2), "utf-8");
	} catch {
		// Ignore clear errors
	}
}

// Custom editor that renders image paths/URLs as compact, styled tags
class CompactImageEditor extends CustomEditor {
	private imageMarkers = new Map<string, string>();
	private markerCounter = 0;
	private isInPaste = false;
	private pasteBuffer = "";

	private formatDisplayName(rawPath: string): string {
		const clean = rawPath.split("?")[0] ?? rawPath;
		const name = basename(clean);
		if (name.startsWith("pi-clipboard-")) {
			const ext = name.split(".").pop() ?? "png";
			const shortId = name.replace("pi-clipboard-", "").slice(0, 6);
			return `clipboard-${shortId}.${ext}`;
		}
		if (name.length > 28) {
			const ext = name.split(".").pop() ?? "png";
			return `${name.slice(0, 20)}...${ext}`;
		}
		return name;
	}

	override handleInput(data: string): void {
		// Intercept bracketed paste mode (Cmd+V or right-click paste)
		if (data.includes("\x1b[200~")) {
			this.isInPaste = true;
			this.pasteBuffer = "";
			data = data.replace("\x1b[200~", "");
		}

		if (this.isInPaste) {
			this.pasteBuffer += data;
			const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
			if (endIndex !== -1) {
				const pasteContent = this.pasteBuffer.substring(0, endIndex);
				this.isInPaste = false;
				const remaining = this.pasteBuffer.substring(endIndex + 6);
				this.pasteBuffer = "";

				const cleanPaste = pasteContent.trim().replace(/^["']|["']$/g, "");
				if (
					cleanPaste &&
					(IMAGE_EXT_REGEX.test(cleanPaste) ||
						cleanPaste.includes("pi-clipboard-") ||
						cleanPaste.startsWith("http://") ||
						cleanPaste.startsWith("https://"))
				) {
					this.insertTextAtCursor(cleanPaste);
				} else {
					super.handleInput(`\x1b[200~${pasteContent}\x1b[201~`);
				}

				if (remaining.length > 0) {
					this.handleInput(remaining);
				}
				return;
			}
			return;
		}

		super.handleInput(data);
	}

	override insertTextAtCursor(text: string): void {
		if (
			text &&
			(IMAGE_EXT_REGEX.test(text.trim()) ||
				text.includes("pi-clipboard-") ||
				text.startsWith("http://") ||
				text.startsWith("https://"))
		) {
			const cleanPath = text.trim().replace(/^["']|["']$/g, "");
			const displayName = this.formatDisplayName(cleanPath);
			this.markerCounter++;
			const marker = `[image #${this.markerCounter}: ${displayName}]`;
			this.imageMarkers.set(marker, cleanPath);
			super.insertTextAtCursor(marker);
			return;
		}
		super.insertTextAtCursor(text);
	}

	override getExpandedText(): string {
		let text = super.getExpandedText();
		for (const [marker, realPath] of this.imageMarkers) {
			text = text.replaceAll(marker, realPath);
		}
		return text;
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		return lines.map((line) =>
			line.replace(/\[image #\d+: [^\]]+\]/g, (tag) => `\x1b[1;36m${tag}\x1b[0m`),
		);
	}
}

export default function (pi: ExtensionAPI) {
	let currentSessionImages: string[] = [];

	function getSessionId(ctx: ExtensionContext): string {
		return ctx.sessionManager?.getSessionId() ?? "default";
	}

	function recordImage(filePath: string, ctx: ExtensionContext): void {
		if (!currentSessionImages.includes(filePath)) {
			currentSessionImages.push(filePath);
			if (currentSessionImages.length > 50) {
				currentSessionImages.shift();
			}
			const sid = getSessionId(ctx);
			saveSessionHistory(sid, currentSessionImages);
		}
	}

	function collectCurrentSessionImages(ctx: ExtensionContext): string[] {
		const set = new Set<string>();
		const sid = getSessionId(ctx);
		const cwd = ctx.sessionManager?.getCwd() ?? process.cwd();

		// 1. Current in-memory images tracked in this session
		for (const p of currentSessionImages) {
			if (existsSync(p)) set.add(p);
		}

		// 2. Persisted images specifically for this session ID
		for (const p of getSessionHistory(sid)) {
			if (existsSync(p)) set.add(p);
		}

		// 3. Current text in the input editor
		try {
			const editorText = ctx.ui.getEditorText?.() ?? "";
			if (editorText) {
				IMAGE_PATH_REGEX.lastIndex = 0;
				for (const m of editorText.matchAll(IMAGE_PATH_REGEX)) {
					const rawPath = m[2];
					if (rawPath && !rawPath.startsWith("http://") && !rawPath.startsWith("https://")) {
						const cleanPath = expandHome(rawPath);
						const fullPath = isAbsolute(cleanPath) ? cleanPath : resolve(cwd, cleanPath);
						if (existsSync(fullPath)) {
							set.add(fullPath);
							recordImage(fullPath, ctx);
						}
					}
				}
			}
		} catch {
			// Ignore editor inspection errors
		}

		// 4. Session entries from current session
		if (ctx.sessionManager) {
			try {
				const entries = ctx.sessionManager.getEntries();
				for (const entry of entries) {
					if (entry.type === "message" && entry.message) {
						const content = entry.message.content;
						if (typeof content === "string") {
							IMAGE_PATH_REGEX.lastIndex = 0;
							for (const m of content.matchAll(IMAGE_PATH_REGEX)) {
								const rawPath = m[2];
								if (rawPath && !rawPath.startsWith("http://") && !rawPath.startsWith("https://")) {
									const cleanPath = expandHome(rawPath);
									const fullPath = isAbsolute(cleanPath) ? cleanPath : resolve(cwd, cleanPath);
									if (existsSync(fullPath)) set.add(fullPath);
								}
							}
						} else if (Array.isArray(content)) {
							for (const part of content) {
								if (part.type === "text" && part.text) {
									IMAGE_PATH_REGEX.lastIndex = 0;
									for (const m of part.text.matchAll(IMAGE_PATH_REGEX)) {
										const rawPath = m[2];
										if (rawPath && !rawPath.startsWith("http://") && !rawPath.startsWith("https://")) {
											const cleanPath = expandHome(rawPath);
											const fullPath = isAbsolute(cleanPath) ? cleanPath : resolve(cwd, cleanPath);
											if (existsSync(fullPath)) set.add(fullPath);
										}
									}
								}
							}
						}
					}
				}
			} catch {
				// Ignore session scan errors
			}
		}

		return Array.from(set);
	}

	// Register CompactImageEditor and restore state on session start/reload
	pi.on("session_start", async (event, ctx: ExtensionContext) => {
		const sid = getSessionId(ctx);
		if (event.reason === "new") {
			currentSessionImages = [];
			clearSessionHistory(sid);
		} else {
			currentSessionImages = getSessionHistory(sid);
		}

		// Install compact editor
		ctx.ui.setEditorComponent((tui, theme, kb) => new CompactImageEditor(tui, theme, kb));
	});

	// Interactive Gallery with Prev/Next navigation
	async function showImageGallery(
		initialIndex: number,
		images: string[],
		ctx: ExtensionContext,
	): Promise<void> {
		if (images.length === 0) {
			ctx.ui.notify("暂无图片可预览", "warning");
			return;
		}

		let currentIndex = Math.max(0, Math.min(initialIndex, images.length - 1));
		const caps = getCapabilities();
		let openedAt = Date.now();

		await ctx.ui.custom((tui, theme, keybindings, done) => {
			openedAt = Date.now();
			const container = new Container();

			function renderCurrent(): void {
				container.clear();
				const targetPath = images[currentIndex];
				if (!targetPath || !existsSync(targetPath)) {
					container.addChild(new Text(theme.fg("warning", `图片不存在或已失效: ${targetPath ?? "未知"}`)));
					container.invalidate();
					tui.requestRender();
					return;
				}

				const stats = statSync(targetPath);
				const mimeType = getMimeType(targetPath);
				const buffer = readFileSync(targetPath);
				const base64Data = buffer.toString("base64");
				const dims = getImageDimensions(base64Data, mimeType);
				const sizeText = formatFileSize(stats.size);
				const formatUpper = mimeType.replace("image/", "").toUpperCase();
				const dimInfo = dims
					? `${dims.widthPx}×${dims.heightPx} px (${getAspectRatio(dims.widthPx, dims.heightPx)})`
					: "未知分辨率";
				const tokenEstimate = dims
					? `预估 ~${estimateVisionTokens(dims.widthPx, dims.heightPx)} tokens`
					: "未知 token";
				const source = getImageSourceLabel(targetPath);

				const counter = images.length > 1 ? `[${currentIndex + 1}/${images.length}] ` : "";
				container.addChild(
					new Text(theme.bold(`── ${counter}${basename(targetPath)} ──`)),
				);
				container.addChild(
					new Text(
						`${theme.fg("accent", "信息: ")}${theme.fg("text", formatUpper)} ${theme.fg("dim", "•")} ${theme.fg("text", dimInfo)} ${theme.fg("dim", "•")} ${theme.fg("text", sizeText)} ${theme.fg("dim", "•")} ${theme.fg("success", tokenEstimate)} ${theme.fg("dim", "•")} ${theme.fg("text", source)}`,
					),
				);
				container.addChild(new Text(theme.fg("dim", `路径: ${targetPath}`)));
				container.addChild(new Spacer(1));

				if (caps.images) {
					container.addChild(
						new Image(
							base64Data,
							mimeType,
							{ fallbackColor: (s) => theme.fg("toolOutput", s) },
							{ maxWidthCells: 60 },
							dims ?? undefined,
						),
					);
				} else {
					container.addChild(
						new Text(theme.fg("dim", "终端不支持内联图形，按 [空格] 快速预览，[O] 系统应用打开")),
					);
				}

				container.addChild(new Spacer(1));

				// Navigation & action controls
				const navHint = images.length > 1 ? `${theme.fg("accent", theme.bold("[←/→]"))} 切图  ${theme.fg("dim", "•")}  ` : "";
				container.addChild(
					new Text(
						`${navHint}${theme.fg("accent", theme.bold("[空格]"))} 预览  ${theme.fg("dim", "•")}  ${theme.fg("accent", theme.bold("[O]"))} 打开  ${theme.fg("dim", "•")}  ${theme.fg("accent", theme.bold("[Esc]"))} 关闭`,
					),
				);

				container.invalidate();
				tui.requestRender();
			}

			// Initial render
			renderCurrent();

			return {
				render: (width) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					// Ignore terminal mouse tracking sequences
					if (data.startsWith("\x1b[<") || data.startsWith("\x1b[M")) {
						return;
					}

					// Next image: Right arrow, Down arrow, 'n', 'l', Tab
					if (
						matchesKey(data, "right") ||
						matchesKey(data, "down") ||
						matchesKey(data, "n") ||
						matchesKey(data, "l") ||
						matchesKey(data, "tab")
					) {
						if (images.length > 1) {
							currentIndex = (currentIndex + 1) % images.length;
							renderCurrent();
						}
						return;
					}

					// Previous image: Left arrow, Up arrow, 'p', 'h', Shift+Tab
					if (
						matchesKey(data, "left") ||
						matchesKey(data, "up") ||
						matchesKey(data, "p") ||
						matchesKey(data, "h") ||
						matchesKey(data, "shift+tab")
					) {
						if (images.length > 1) {
							currentIndex = (currentIndex - 1 + images.length) % images.length;
							renderCurrent();
						}
						return;
					}

					// Quick Look preview (macOS qlmanage): Space
					if (matchesKey(data, "space")) {
						const targetPath = images[currentIndex];
						if (targetPath) quickLookImage(targetPath);
						return;
					}

					// Open in system viewer (Preview.app on macOS): O / Shift+O
					if (matchesKey(data, "o") || data === "O" || matchesKey(data, "shift+o")) {
						const targetPath = images[currentIndex];
						if (targetPath) openInSystemViewer(targetPath);
						return;
					}

					// Exit on Escape, 'q', Ctrl+C, or configured cancel keybinding
					if (
						matchesKey(data, "escape") ||
						matchesKey(data, "q") ||
						matchesKey(data, "ctrl+c") ||
						keybindings.matches(data, "tui.select.cancel")
					) {
						done(undefined);
						return;
					}

					// Enter to close (after debounce)
					if (Date.now() - openedAt > 250) {
						if (matchesKey(data, "enter")) {
							done(undefined);
						}
					}
				},
			};
		});
	}

	// 1. Intercept user input: optimize image paths & multimodal direct passing
	pi.on("input", async (event, ctx: ExtensionContext) => {
		if (event.source === "extension") {
			return { action: "continue" };
		}

		const cwd = ctx.sessionManager?.getCwd() ?? process.cwd();
		const resolvedImages: Array<{ rawMatch: string; fullPath: string; fileName: string }> = [];

		// 1a. Match local filesystem paths
		IMAGE_PATH_REGEX.lastIndex = 0;
		const localMatches = Array.from(event.text.matchAll(IMAGE_PATH_REGEX));
		for (const match of localMatches) {
			const rawMatch = match[0].trim();
			const rawPath = match[2];
			if (!rawPath || rawPath.startsWith("http://") || rawPath.startsWith("https://")) continue;

			const cleanPath = expandHome(rawPath);
			const fullPath = isAbsolute(cleanPath) ? cleanPath : resolve(cwd, cleanPath);

			if (existsSync(fullPath) && IMAGE_EXT_REGEX.test(fullPath)) {
				resolvedImages.push({
					rawMatch,
					fullPath,
					fileName: basename(fullPath),
				});
			}
		}

		// 1b. Match remote HTTP/HTTPS image URLs
		REMOTE_URL_REGEX.lastIndex = 0;
		const remoteMatches = Array.from(event.text.matchAll(REMOTE_URL_REGEX));
		for (const match of remoteMatches) {
			const url = match[0];
			ctx.ui.notify("下载远程图片中...", "info");
			const localCached = await fetchRemoteImage(url);
			if (localCached && existsSync(localCached)) {
				resolvedImages.push({
					rawMatch: url,
					fullPath: localCached,
					fileName: basename(url.split("?")[0] ?? url),
				});
			}
		}

		if (resolvedImages.length === 0) {
			return { action: "continue" };
		}

		// Record tracked images for current session
		for (const item of resolvedImages) {
			recordImage(item.fullPath, ctx);
		}

		// Check if the current model supports vision / multimodal images
		const supportsVision = ctx.model?.input?.includes("image") ?? false;
		if (!supportsVision) {
			ctx.ui.notify(
				`当前模型 (${ctx.model?.name ?? "未知"}) 不支持多模态图片输入，已保留路径。可通过 Ctrl+P 切换视觉模型`,
				"warning",
			);
			return { action: "continue" };
		}

		const newImages: ImageContent[] = [];
		let transformedText = event.text;

		for (let i = 0; i < resolvedImages.length; i++) {
			const { rawMatch, fullPath, fileName } = resolvedImages[i]!;
			try {
				const buffer = readFileSync(fullPath);
				const mimeType = getMimeType(fullPath);
				newImages.push({
					type: "image",
					mimeType,
					data: buffer.toString("base64"),
				});

				// Replace raw long path or remote URL with a clean tag
				const tag = `[image #${i + 1}: ${fileName}]`;
				transformedText = transformedText.replace(rawMatch, tag);
			} catch {
				// Keep raw text on read failure
			}
		}

		if (newImages.length > 0) {
			ctx.ui.notify(`已附加 ${newImages.length} 张图片`, "info");
			return {
				action: "transform",
				text: transformedText,
				images: [...(event.images ?? []), ...newImages],
			};
		}

		return { action: "continue" };
	});

	// 2. Register /image command for terminal preview, interactive selection, and gallery browsing
	pi.registerCommand("image", {
		description: "图片画廊与管理 (/image, /image list)",
		handler: async (args: string, ctx: ExtensionContext) => {
			const trimmed = args.trim();
			const sid = getSessionId(ctx);

			// 1. Help & usage
			if (trimmed === "help" || trimmed === "?" || trimmed === "-h" || trimmed === "--help") {
				ctx.ui.notify(
					"用法:\n• /image : 预览最新图片\n• /image <序号> : 查看指定序号图片 (如 /image 1)\n• /image list : 打开图片列表\n• /image <路径|URL> : 预览指定图片\n• /image clear : 清空会话图片记录",
					"info",
				);
				return;
			}

			// 2. Clear history for this session
			if (trimmed === "clear") {
				currentSessionImages = [];
				clearSessionHistory(sid);
				ctx.ui.notify("已清空图片记录", "info");
				return;
			}

			// Gather images strictly scoped to the current session
			const sessionImages = collectCurrentSessionImages(ctx);

			// 2. Support remote URL directly: /image https://...
			if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
				ctx.ui.notify("下载远程图片中...", "info");
				const localPath = await fetchRemoteImage(trimmed);
				if (localPath && existsSync(localPath)) {
					if (!sessionImages.includes(localPath)) {
						sessionImages.push(localPath);
						recordImage(localPath, ctx);
					}
					const idx = sessionImages.indexOf(localPath);
					await showImageGallery(idx >= 0 ? idx : 0, sessionImages, ctx);
				} else {
					ctx.ui.notify(`下载远程图片失败: ${trimmed}`, "error");
				}
				return;
			}

			// 3. Support /image list or /image list <number>
			if (trimmed === "list" || trimmed.startsWith("list ")) {
				const subArg = trimmed.slice(4).trim();
				if (subArg) {
					const num = Number.parseInt(subArg, 10);
					if (!Number.isNaN(num) && num >= 1 && num <= sessionImages.length) {
						await showImageGallery(num - 1, sessionImages, ctx);
						return;
					}
				}

				if (sessionImages.length === 0) {
					ctx.ui.notify("暂无图片", "info");
					return;
				}

				// Build clean options with index and path
				const options = sessionImages.map((p, idx) => `[#${idx + 1}] ${basename(p)}  (${p})`);

				const choice = await ctx.ui.select("选择图片预览 (Esc 关闭):", options);
				if (!choice) return;

				const selectedIdx = options.indexOf(choice);
				if (selectedIdx >= 0 && sessionImages[selectedIdx]) {
					await new Promise((r) => setTimeout(r, 60));
					await showImageGallery(selectedIdx, sessionImages, ctx);
				}
				return;
			}

			// 4. Support /image <number> (e.g. /image 1, /image 2)
			const numIndex = Number.parseInt(trimmed, 10);
			const cwd = ctx.sessionManager?.getCwd() ?? process.cwd();

			if (!Number.isNaN(numIndex) && numIndex >= 1 && numIndex <= sessionImages.length) {
				await showImageGallery(numIndex - 1, sessionImages, ctx);
				return;
			}

			// 5. Support explicit local path: /image <path>
			if (trimmed) {
				const targetPath = isAbsolute(expandHome(trimmed))
					? expandHome(trimmed)
					: resolve(cwd, expandHome(trimmed));

				if (existsSync(targetPath)) {
					if (!sessionImages.includes(targetPath)) {
						sessionImages.push(targetPath);
						recordImage(targetPath, ctx);
					}
					const idx = sessionImages.indexOf(targetPath);
					await showImageGallery(idx >= 0 ? idx : 0, sessionImages, ctx);
					return;
				}

				ctx.ui.notify(`图片不存在: ${basename(targetPath)}`, "warning");
				return;
			}

			// 6. Default: preview the newest image in gallery mode
			if (sessionImages.length === 0) {
				ctx.ui.notify("暂无图片可预览", "warning");
				return;
			}

			await showImageGallery(sessionImages.length - 1, sessionImages, ctx);
		},
	});
}
