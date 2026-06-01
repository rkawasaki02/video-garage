// ── Platform detection & helpers ──
const ALLOWED_DOMAINS = [
	'youtube.com', 'youtu.be',
	'vimeo.com',
	'twitch.tv',
	'video.twimg.com',
];

function detectPlatform(url) {
	url = url.trim().replace(/^["']|["']$/g, '');
	const yt = url.match(/(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/);
	if (yt) return { type: 'youtube', id: yt[1], url };
	if (/^[A-Za-z0-9_-]{11}$/.test(url)) return { type: 'youtube', id: url, url };
	const vimeo = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
	if (vimeo) return { type: 'vimeo', id: vimeo[1], url };
	const twitchClip = url.match(/twitch\.tv\/\w+\/clip\/([A-Za-z0-9_-]+)/);
	if (twitchClip) return { type: 'twitch_clip', id: twitchClip[1], url };
	const twitch = url.match(/twitch\.tv\/([A-Za-z0-9_]+)/);
	if (twitch) return { type: 'twitch', id: twitch[1], url };
	if (/\.(mp4|webm|ogg|mov)(\?.*)?$/i.test(url) || url.includes('video.twimg.com')) {
		return { type: 'mp4', id: url, url };
	}
	return null;
}

function getThumb(platform) {
	switch (platform.type) {
		case 'youtube': return `https://img.youtube.com/vi/${platform.id}/hqdefault.jpg`;
		case 'vimeo': return `https://vumbnail.com/${platform.id}.jpg`;
		default: return '';
	}
}

function getEmbedUrl(platform, muted = true) {
	switch (platform.type) {
		case 'youtube':
			return `https://www.youtube.com/embed/${platform.id}?autoplay=1&mute=${muted ? 1 : 0}&controls=1&rel=0&modestbranding=1`;
		case 'vimeo':
			return `https://player.vimeo.com/video/${platform.id}?autoplay=1&muted=${muted ? 1 : 0}`;
		case 'twitch':
			return `https://player.twitch.tv/?channel=${platform.id}&autoplay=true&muted=${muted}&parent=${location.hostname}`;
		case 'twitch_clip':
			return `https://clips.twitch.tv/embed?clip=${platform.id}&autoplay=true&muted=${muted}&parent=${location.hostname}`;
		default:
			return null;
	}
}

function getPlatformLabel(type) {
	const map = { youtube: 'yt', vimeo: 'vimeo', twitch: 'twitch', twitch_clip: 'twitch', mp4: 'mp4' };
	return map[type] || type;
}

function getPlatformColor(type) {
	const map = {
		youtube: 'var(--red)', vimeo: 'var(--blue)',
		twitch: 'var(--purple)', twitch_clip: 'var(--purple)', mp4: 'var(--green)'
	};
	return map[type] || 'var(--muted)';
}

// ── Cognito設定 ──
const COGNITO_CONFIG = {
	userPoolId: 'ap-northeast-1_HPXDrKY5a',
	clientId: '1ld5act6auc0ongafp3kob4p6r',
	domain: 'https://ap-northeast-1hpxdrky5a.auth.ap-northeast-1.amazoncognito.com',
	redirectUri: 'https://videogarage.jp',
	apiBaseUrl: 'https://6wo64xbz28.execute-api.ap-northeast-1.amazonaws.com'
};

// ── 認証状態 ──
let idToken = null;
let isLoggedIn = false;

// トークンをlocalStorageに保存・取得
function saveToken(token) { localStorage.setItem('vg_id_token', token); }
function loadToken() { return localStorage.getItem('vg_id_token'); }
function clearToken() { localStorage.removeItem('vg_id_token'); }

// JWTの有効期限チェック
function isTokenExpired(token) {
	try {
		const payload = JSON.parse(atob(token.split('.')[1]));
		return Date.now() / 1000 > payload.exp;
	} catch {
		return true;
	}
}

// サインイン・サインアウトの処理
function handleAuth() {
	if (isLoggedIn) {
		// サインアウト
		clearToken();
		isLoggedIn = false;
		idToken = null;
		updateAuthUI();
		// ゲストモードに戻る
		videos = loadLocal();
		tabs = loadTabsLocal();
		activeTabId = loadActiveTab();
		renderTabs();
		render();
		showToast('-- signed out');
	} else {
		// Cognitoのサインイン画面にリダイレクト
		const url = `${COGNITO_CONFIG.domain}/login?client_id=${COGNITO_CONFIG.clientId}&response_type=code&scope=openid+email&redirect_uri=${encodeURIComponent(COGNITO_CONFIG.redirectUri)}`;
		window.location.href = url;
	}
}

// サインイン後のコールバック処理（URLのcodeをトークンに交換）
async function handleCallback() {
	const params = new URLSearchParams(window.location.search);
	const code = params.get('code');
	if (!code) return false;

	try {
		const res = await fetch(`${COGNITO_CONFIG.domain}/oauth2/token`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				client_id: COGNITO_CONFIG.clientId,
				code,
				redirect_uri: COGNITO_CONFIG.redirectUri
			})
		});
		const data = await res.json();
		if (data.id_token) {
			saveToken(data.id_token);
			// URLからcodeを消す
			window.history.replaceState({}, '', window.location.pathname);
			return true;
		}
	} catch (e) {
		console.error('Token exchange failed:', e);
	}
	return false;
}

function updateAuthUI() {
	const statusEl = document.getElementById('authStatus');
	const btnEl = document.getElementById('authBtn');
	if (isLoggedIn) {
		statusEl.textContent = '-- signed in';
		statusEl.style.color = 'var(--green)';
		btnEl.textContent = 'sign out';
	} else {
		statusEl.textContent = '-- guest mode';
		statusEl.style.color = 'var(--muted)';
		btnEl.textContent = 'sign in';
	}
}

// ── API呼び出し ──
async function apiFetch(path, options = {}) {
	const res = await fetch(`${COGNITO_CONFIG.apiBaseUrl}${path}`, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			'Authorization': idToken,
			...(options.headers || {})
		}
	});
	if (!res.ok) throw new Error(`API error: ${res.status}`);
	return res.json();
}

// ── Storage（ゲストモード用localStorage）──
const KEY = 'nvim_vg_v1';
const TABS_KEY = 'nvim_vg_tabs_v1';
const ACTIVE_TAB_KEY = 'nvim_vg_active_tab';

function loadLocal() { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } }
function saveLocal(v) { localStorage.setItem(KEY, JSON.stringify(v)); }
function loadTabsLocal() { try { return JSON.parse(localStorage.getItem(TABS_KEY)) || []; } catch { return []; } }
function saveTabsLocal(t) { localStorage.setItem(TABS_KEY, JSON.stringify(t)); }
function loadActiveTab() { return localStorage.getItem(ACTIVE_TAB_KEY) || null; }
function saveActiveTab(id) { localStorage.setItem(ACTIVE_TAB_KEY, id); }

let videos = loadLocal();
let tabs = loadTabsLocal();
let activeTabId = loadActiveTab();

function genId() { return Math.random().toString(36).slice(2, 10); }

// URLからプラットフォーム固有のIDを再取得
function extractIdFromUrl(url, type) {
	const platform = detectPlatform(url);
	if (platform) return platform.id;
	return url;
}

// タブが1つもなければデフォルト作成
if (tabs.length === 0) {
	const defaultTab = { id: genId(), name: 'playlist' };
	tabs.push(defaultTab);
	saveTabsLocal(tabs);
	activeTabId = defaultTab.id;
	saveActiveTab(activeTabId);
}

if (!tabs.find(t => t.id === activeTabId)) {
	activeTabId = tabs[0].id;
	saveActiveTab(activeTabId);
}

// ── Video actions ──
async function addVideo() {
	const urlEl = document.getElementById('urlInput');
	const url = urlEl.value.trim();
	if (!url) { showToast('E: url required', true); return; }

	const platform = detectPlatform(url);
	if (!platform) { showToast('E: unsupported URL', true); return; }

	// 同じタブ内に同じURLが既にあるか確認（uidではなくid+tabIdで重複チェック）
	if (videos.find(v => v.id === platform.id && v.type === platform.type && v.tabId === activeTabId)) {
		showToast('W: already exists', true); return;
	}

	// uidはユニークにするためにgenId()を付加
	const uid = platform.type + '_' + platform.id + '_' + genId();

	const videoData = {
		uid,
		id: platform.id,
		type: platform.type,
		url: platform.url,
		title: '',
		tabId: activeTabId,
		addedAt: Date.now(),
		order: 0
	};

	if (isLoggedIn) {
		try {
			await apiFetch('/videos', {
				method: 'POST',
				body: JSON.stringify({
					videoId: uid,
					url: platform.url,
					type: platform.type,
					tabId: activeTabId,
					title: '',
					addedAt: videoData.addedAt,
					order: 0
				})
			});
		} catch (e) {
			showToast('E: failed to save', true);
			return;
		}
	}

	videos.unshift(videoData);
	if (!isLoggedIn) saveLocal(videos);
	render();
	urlEl.value = '';
	showToast(`-- ${getPlatformLabel(platform.type)} added ✓`);
}

document.getElementById('urlInput').addEventListener('keydown', e => { if (e.key === 'Enter') addVideo(); });

async function deleteVideo(uid) {
	if (isLoggedIn) {
		try {
			await apiFetch(`/videos/${encodeURIComponent(uid)}`, { method: 'DELETE' });
		} catch (e) {
			showToast('E: failed to delete', true);
			return;
		}
	}
	videos = videos.filter(v => !(v.uid === uid && v.tabId === activeTabId));
	if (!isLoggedIn) saveLocal(videos);
	render();
	showToast('-- deleted');
}

// ── Tab actions ──
async function addTab() {
	const name = prompt('tab name:');
	if (!name || !name.trim()) return;
	const tab = { id: genId(), name: name.trim(), createdAt: Date.now() };

	if (isLoggedIn) {
		try {
			await apiFetch('/tabs', {
				method: 'POST',
				body: JSON.stringify({ tabId: tab.id, name: tab.name, createdAt: tab.createdAt })
			});
		} catch (e) {
			showToast('E: failed to save tab', true);
			return;
		}
	}

	tabs.push(tab);
	if (!isLoggedIn) saveTabsLocal(tabs);
	activeTabId = tab.id;
	saveActiveTab(activeTabId);
	renderTabs();
	render();
	showToast(`-- tab "${tab.name}" created`);
}

function switchTab(id) {
	activeTabId = id;
	saveActiveTab(activeTabId);
	renderTabs();
	render();
}

// ── Context menu ──
let contextTargetId = null;


function openTabMenu(tabId, btn) {
	contextTargetId = tabId;
	const menu = document.getElementById('contextMenu');
	const rect = btn.getBoundingClientRect();
	menu.style.top = `${rect.bottom + 4}px`;
	menu.style.left = `${rect.left}px`;
	menu.classList.add('open');
}

function closeContextMenu() {
	document.getElementById('contextMenu').classList.remove('open');
	contextTargetId = null;
}

document.addEventListener('click', e => { if (!e.target.closest('#contextMenu')) closeContextMenu(); });

function renameTabFromMenu() {
	if (!contextTargetId) return;
	const tab = tabs.find(t => t.id === contextTargetId);
	if (!tab) return;
	const name = prompt('new name:', tab.name);
	if (!name || !name.trim()) return;
	tab.name = name.trim();
	if (!isLoggedIn) saveTabsLocal(tabs);
	renderTabs();
	render();
	showToast(`-- renamed to "${tab.name}"`);
	closeContextMenu();
}

async function deleteTabFromMenu() {
	if (!contextTargetId) return;
	if (tabs.length === 1) { showToast('E: cannot delete last tab', true); closeContextMenu(); return; }
	const tab = tabs.find(t => t.id === contextTargetId);
	if (!confirm(`delete tab "${tab.name}"?\nVideos in this tab will also be deleted.`)) return;

	if (isLoggedIn) {
		try {
			await apiFetch(`/tabs/${encodeURIComponent(contextTargetId)}`, { method: 'DELETE' });
		} catch (e) {
			showToast('E: failed to delete tab', true);
			return;
		}
	}

	videos = videos.filter(v => v.tabId !== contextTargetId);
	if (!isLoggedIn) saveLocal(videos);
	tabs = tabs.filter(t => t.id !== contextTargetId);
	if (!isLoggedIn) saveTabsLocal(tabs);
	if (activeTabId === contextTargetId) { activeTabId = tabs[0].id; saveActiveTab(activeTabId); }
	closeContextMenu();
	renderTabs();
	render();
	showToast('-- tab deleted');
}

// ── Render tabs ──
function renderTabs() {
	const tabList = document.getElementById('tabList');
	const slFile = document.getElementById('sl-file');
	const activeTab = tabs.find(t => t.id === activeTabId);
	if (slFile && activeTab) slFile.textContent = `${activeTab.name}.lua`;

	tabList.innerHTML = tabs.map(t => {
		const isActive = t.id === activeTabId;
		const count = videos.filter(v => v.tabId === t.id).length;
		return `<div class="drawer-tab-item${isActive ? ' active' : ''}" data-tab-id="${t.id}" id="drawer-tab-${t.id}">
      <span class="tab-icon">${isActive ? '▸' : '○'}</span>
      <span class="tab-name" onclick="switchTab('${t.id}'); closeDrawer();">${esc(t.name)}</span>
      <span class="tab-count">${count}</span>
      <button class="tab-edit-btn" onclick="event.stopPropagation(); openTabMenu('${t.id}', this)">⋯</button>
    </div>`;
	}).join('');
}

// ── Drawer ──
function openDrawer() {
	document.getElementById('drawer').classList.add('open');
	document.getElementById('drawerOverlay').classList.add('open');
}

function closeDrawer() {
	document.getElementById('drawer').classList.remove('open');
	document.getElementById('drawerOverlay').classList.remove('open');
}

// ── Render gallery ──
function render() {
	const currentVideos = videos.filter(v => v.tabId === activeTabId);
	const n = currentVideos.length;
	document.getElementById('sl-count').textContent = `${n}:1`;

	const gallery = document.getElementById('gallery');
	if (n === 0) {
		gallery.innerHTML = `<div class="empty">-- no videos yet<br>-- add a URL above</div>`;
		return;
	}

	gallery.innerHTML = currentVideos.map(v => {
		const thumb = getThumb({ type: v.type, id: v.id });
		const label = getPlatformLabel(v.type);
		const labelColor = getPlatformColor(v.type);

		return `
    <div class="card" id="card-${v.uid}" data-uid="${v.uid}" data-type="${v.type}" data-id="${v.id}" data-url="${esc(v.url)}" draggable="true">
      <div class="card-bar">
        <div class="dot dot-r"></div>
        <div class="dot dot-y"></div>
        <div class="dot dot-g"></div>
        <span style="color:${labelColor};font-size:10px;">${label}</span>
        <span style="flex:1"></span>
        <button class="btn-delete" onclick="event.stopPropagation();deleteVideo('${v.uid}')" title=":bd">✕</button>
      </div>
      <div class="thumb-wrap">
        ${thumb
				? `<img src="${thumb}" alt="" loading="lazy">`
				: `<div class="thumb-placeholder"><span>${label}</span></div>`
			}
        ${v.type === 'mp4'
				? `<video id="player-${v.uid}" src="${esc(v.url)}" muted playsinline controls style="position:absolute;inset:0;width:100%;height:100%;opacity:0;transition:opacity 0.3s;pointer-events:none"></video>`
				: `<iframe id="player-${v.uid}" src="" allow="autoplay; encrypted-media" allowfullscreen style="position:absolute;inset:0;width:100%;height:100%;border:none;opacity:0;transition:opacity 0.4s;pointer-events:none"></iframe>`
			}
        <div class="play-btn">
          <svg viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="30" cy="30" r="30" fill="rgba(26,27,38,0.75)"/>
            <circle cx="30" cy="30" r="29" stroke="rgba(122,162,247,0.5)" stroke-width="1"/>
            <polygon points="24,18 46,30 24,42" fill="#7aa2f7"/>
          </svg>
        </div>
      </div>
    </div>`;
	}).join('');

	document.querySelectorAll('.card').forEach(card => {
		const uid = card.dataset.uid;
		const type = card.dataset.type;
		const id = card.dataset.id;
		const player = card.querySelector(`#player-${uid}`);
		const img = card.querySelector('img');
		let pinned = false;

		function showPlayer(muted) {
			if (type === 'mp4') {
				player.muted = muted;
				player.style.opacity = '1';
				player.style.pointerEvents = 'auto';
				player.play().catch(() => { });
				if (img) img.style.opacity = '0';
			} else {
				if (!player.src) {
					const embedSrc = getEmbedUrl({ type, id }, muted);
					if (embedSrc) player.src = embedSrc;
				}
				player.style.opacity = '1';
				player.style.pointerEvents = 'auto';
				if (img) img.style.opacity = '0';
			}
			card.querySelector('.play-btn').style.opacity = '0';
		}

		function hidePlayer() {
			if (pinned) return;
			if (type === 'mp4') {
				player.pause();
				player.style.opacity = '0';
				player.style.pointerEvents = 'none';
			} else {
				player.src = '';
				player.style.opacity = '0';
				player.style.pointerEvents = 'none';
			}
			if (img) img.style.opacity = '1';
			card.querySelector('.play-btn').style.opacity = '1';
		}

		function pinPlayer() {
			pinned = true;
			card.classList.add('pinned');
			if (type === 'mp4') {
				player.muted = false;
			} else {
				const embedSrc = getEmbedUrl({ type, id }, false);
				if (embedSrc) player.src = embedSrc;
			}
			player.style.opacity = '1';
			player.style.pointerEvents = 'auto';
			if (img) img.style.opacity = '0';
			card.querySelector('.play-btn').style.opacity = '0';
		}

		function unpinPlayer() {
			pinned = false;
			card.classList.remove('pinned');
			if (type === 'mp4') {
				player.pause();
				player.style.opacity = '0';
				player.style.pointerEvents = 'none';
			} else {
				player.src = '';
				player.style.opacity = '0';
				player.style.pointerEvents = 'none';
			}
			if (img) img.style.opacity = '1';
			card.querySelector('.play-btn').style.opacity = '1';
		}

		card.addEventListener('mouseenter', () => { if (!pinned) showPlayer(true); });
		card.addEventListener('mouseleave', () => { if (!pinned) hidePlayer(); });
		card.addEventListener('click', () => {
			if (window.innerWidth > 640) {
				if (pinned) unpinPlayer(); else pinPlayer();
			} else {
				if (pinned) {
					unpinPlayer();
				} else {
					document.querySelectorAll('.card.pinned').forEach(c => { c._unpinPlayer && c._unpinPlayer(); });
					pinPlayer();
				}
			}
		});
		card._unpinPlayer = unpinPlayer;
	});

	setupDragAndDrop();
	if (window.innerWidth <= 640) setupCenter();
}

// ── Drag & Drop ──
let dragSrc = null;

function setupDragAndDrop() {
	document.querySelectorAll('.card').forEach(card => {
		card.addEventListener('dragstart', onDragStart);
		card.addEventListener('dragover', onDragOver);
		card.addEventListener('dragleave', onDragLeave);
		card.addEventListener('drop', onDrop);
		card.addEventListener('dragend', onDragEnd);
		card.addEventListener('touchstart', onTouchStart, { passive: true });
		card.addEventListener('touchmove', onTouchMove, { passive: false });
		card.addEventListener('touchend', onTouchEnd);
	});
}

function onDragStart(e) { dragSrc = this; this.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; }
function onDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (this !== dragSrc) this.classList.add('drag-over'); }
function onDragLeave() { this.classList.remove('drag-over'); }

function onDrop(e) {
	e.preventDefault();
	if (this === dragSrc) return;
	this.classList.remove('drag-over');
	const fromUid = dragSrc.dataset.uid;
	const toUid = this.dataset.uid;
	const fromIdx = videos.findIndex(v => v.uid === fromUid && v.tabId === activeTabId);
	const toIdx = videos.findIndex(v => v.uid === toUid && v.tabId === activeTabId);
	videos.splice(toIdx, 0, videos.splice(fromIdx, 1)[0]);
	if (!isLoggedIn) saveLocal(videos);
	render();
	showToast('-- reordered');
}

function onDragEnd() { document.querySelectorAll('.card').forEach(c => c.classList.remove('dragging', 'drag-over')); dragSrc = null; }

let touchDragEl = null, touchClone = null, touchFromUid = null;

function onTouchStart(e) {
	touchDragEl = this; touchFromUid = this.dataset.uid;
	const rect = this.getBoundingClientRect();
	touchClone = this.cloneNode(true);
	touchClone.style.cssText = `position:fixed;top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;opacity:0.7;pointer-events:none;z-index:1000;transform:scale(1.03);transition:none;`;
	document.body.appendChild(touchClone);
	this.classList.add('dragging');
}

function onTouchMove(e) {
	if (!touchClone) return;
	e.preventDefault();
	const touch = e.touches[0];
	const rect = touchDragEl.getBoundingClientRect();
	touchClone.style.top = `${touch.clientY - rect.height / 2}px`;
	touchClone.style.left = `${touch.clientX - rect.width / 2}px`;
	document.querySelectorAll('.card').forEach(c => c.classList.remove('drag-over'));
	const el = document.elementFromPoint(touch.clientX, touch.clientY);
	const target = el ? el.closest('.card') : null;
	if (target && target !== touchDragEl) target.classList.add('drag-over');
}

function onTouchEnd(e) {
	if (!touchClone) return;
	const touch = e.changedTouches[0];
	const el = document.elementFromPoint(touch.clientX, touch.clientY);
	const target = el ? el.closest('.card') : null;
	if (target && target !== touchDragEl) {
		const toUid = target.dataset.uid;
		const fromIdx = videos.findIndex(v => v.uid === touchFromUid && v.tabId === activeTabId);
		const toIdx = videos.findIndex(v => v.uid === toUid && v.tabId === activeTabId);
		videos.splice(toIdx, 0, videos.splice(fromIdx, 1)[0]);
		if (!isLoggedIn) saveLocal(videos);
		render();
		showToast('-- reordered');
	}
	touchClone.remove(); touchClone = null; touchDragEl = null; touchFromUid = null;
	document.querySelectorAll('.card').forEach(c => c.classList.remove('dragging', 'drag-over'));
}

// ── Mobile center ──
let st = null;
function setupCenter() {
	window.removeEventListener('scroll', onScroll);
	window.addEventListener('scroll', onScroll, { passive: true });
}
function onScroll() {
	clearTimeout(st);
	st = setTimeout(() => {
		const cy = window.innerHeight / 2;
		let best = null, dist = Infinity;
		document.querySelectorAll('.card').forEach(c => {
			const r = c.getBoundingClientRect();
			const d = Math.abs(r.top + r.height / 2 - cy);
			if (d < dist) { dist = d; best = c; }
		});
		document.querySelectorAll('.card').forEach(c => c.classList.remove('center-active'));
		if (best) best.classList.add('center-active');
	}, 150);
}

// ── Toast ──
function showToast(msg, err = false) {
	const t = document.getElementById('toast');
	t.textContent = msg;
	t.className = 'toast' + (err ? ' err' : '');
	void t.offsetWidth;
	t.classList.add('show');
	setTimeout(() => t.classList.remove('show'), 2500);
}

function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// ── 保留4: ゲストモード→ログイン時のマイグレーション ──
async function migrateGuestData() {
	const guestVideos = loadLocal();
	const guestTabs = loadTabsLocal();
	if (guestTabs.length === 0 && guestVideos.length === 0) return;

	showToast('-- migrating guest data...');

	// タブをAPIに保存
	for (const tab of guestTabs) {
		try {
			await apiFetch('/tabs', {
				method: 'POST',
				body: JSON.stringify({ tabId: tab.id, name: tab.name, createdAt: tab.createdAt || Date.now() })
			});
		} catch (e) { console.error('tab migration failed:', e); }
	}

	// 動画をAPIに保存
	for (const video of guestVideos) {
		try {
			await apiFetch('/videos', {
				method: 'POST',
				body: JSON.stringify({
					videoId: video.uid,
					url: video.url,
					type: video.type,
					tabId: video.tabId,
					title: video.title || '',
					addedAt: video.addedAt || Date.now(),
					order: video.order || 0
				})
			});
		} catch (e) { console.error('video migration failed:', e); }
	}

	// localStorageをクリア
	localStorage.removeItem(KEY);
	localStorage.removeItem(TABS_KEY);
	showToast('-- migration complete ✓');
}

// ── 初期化 ──
async function init() {
	// コールバック処理（Cognitoからのリダイレクト）
	const callbackSuccess = await handleCallback();

	// トークンの確認
	const token = loadToken();
	if (token && !isTokenExpired(token)) {
		idToken = token;
		isLoggedIn = true;

		// ゲストデータのマイグレーション（初回ログイン時のみ）
		if (callbackSuccess && (loadLocal().length > 0 || loadTabsLocal().length > 0)) {
			await migrateGuestData();
		}

		// APIからデータ取得
		try {
			const [tabsData, videosData] = await Promise.all([
				apiFetch('/tabs'),
				apiFetch('/videos')
			]);

			// APIレスポンスをフロントの形式に変換
			tabs = tabsData.map(t => ({ id: t.tabId, name: t.name, createdAt: t.createdAt }));
			videos = videosData.map(v => ({
				uid: v.videoId,
				id: extractIdFromUrl(v.url, v.type),
				type: v.type,
				url: v.url,
				title: v.title || '',
				tabId: v.tabId,
				addedAt: v.addedAt,
				order: v.order || 0
			}));

			if (tabs.length === 0) {
				const defaultTab = { id: genId(), name: 'playlist', createdAt: Date.now() };
				await apiFetch('/tabs', {
					method: 'POST',
					body: JSON.stringify({ tabId: defaultTab.id, name: defaultTab.name, createdAt: defaultTab.createdAt })
				});
				tabs.push(defaultTab);
			}

			activeTabId = loadActiveTab() || tabs[0].id;
			if (!tabs.find(t => t.id === activeTabId)) activeTabId = tabs[0].id;
			saveActiveTab(activeTabId);

		} catch (e) {
			console.error('API fetch failed:', e);
			showToast('E: failed to load data', true);
		}
	} else {
		// ゲストモード
		isLoggedIn = false;
		idToken = null;
		clearToken();

		if (tabs.length === 0) {
			const defaultTab = { id: genId(), name: 'playlist' };
			tabs.push(defaultTab);
			saveTabsLocal(tabs);
			activeTabId = defaultTab.id;
			saveActiveTab(activeTabId);
		}
		if (!tabs.find(t => t.id === activeTabId)) {
			activeTabId = tabs[0].id;
			saveActiveTab(activeTabId);
		}
	}

	updateAuthUI();
	renderTabs();
	render();
}

init();
