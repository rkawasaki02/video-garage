import {
	detectPlatform,
	getThumb,
	getEmbedUrl,
	getPlatformLabel,
	getPlatformColor
} from './platform.js';

// ── 設定 ──
// config.js が window.VG_CONFIG を定義していればそれを優先。
// 無ければ従来のハードコード値にフォールバック（挙動互換のため）。
const COGNITO_CONFIG = window.VG_CONFIG ?? {
	userPoolId: 'ap-northeast-1_HPXDrKY5a',
	clientId: '1ld5act6auc0ongafp3kob4p6r',
	domain: 'https://ap-northeast-1hpxdrky5a.auth.ap-northeast-1.amazoncognito.com',
	redirectUri: 'https://videogarage.jp',
	apiBaseUrl: 'https://6wo64xbz28.execute-api.ap-northeast-1.amazonaws.com'
};

// ── 認証状態 ──
let idToken = null;
let isLoggedIn = false;
let userEmail = '';

function saveToken(token) { localStorage.setItem('vg_id_token', token); }
function loadToken() { return localStorage.getItem('vg_id_token'); }
function clearToken() { localStorage.removeItem('vg_id_token'); }
function saveRefreshToken(t) { localStorage.setItem('vg_refresh_token', t); }
function loadRefreshToken() { return localStorage.getItem('vg_refresh_token'); }
function clearRefreshToken() { localStorage.removeItem('vg_refresh_token'); }

// 進行中のリフレッシュを1本に集約する（init の Promise.all 等で
// 複数の apiFetch が同時に期限切れを踏んでも二重リフレッシュしない）
let refreshPromise = null;

// JWT ペイロードのデコード。
// 修正: JWT は base64url なので、素の atob() は '-' や '_' を含むトークンで例外を投げ、
// 有効なセッションが「期限切れ」と誤判定されてリロードのたびにログアウトしていた。
function decodeJwtPayload(token) {
	try {
		const part = token.split('.')[1];
		const b64 = part
			.replace(/-/g, '+')
			.replace(/_/g, '/')
			.padEnd(Math.ceil(part.length / 4) * 4, '=');
		return JSON.parse(atob(b64));
	} catch {
		return null;
	}
}

function isTokenExpired(token, skewSec = 0) {
	const payload = decodeJwtPayload(token);
	return !payload || (Date.now() / 1000) + skewSec > payload.exp;
}

// リフレッシュトークンで id_token を更新する。成功なら true
function refreshSession() {
	if (refreshPromise) return refreshPromise;
	const refreshToken = loadRefreshToken();
	if (!refreshToken) return Promise.resolve(false);
	refreshPromise = (async () => {
		try {
			const res = await fetch(`${COGNITO_CONFIG.domain}/oauth2/token`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({
					grant_type: 'refresh_token',
					client_id: COGNITO_CONFIG.clientId,
					refresh_token: refreshToken
				})
			});
			if (!res.ok) return false;
			const data = await res.json();
			if (!data.id_token) return false;
			idToken = data.id_token;
			saveToken(data.id_token);
			// リフレッシュトークンローテーション有効時は新しいものが返るので差し替える
			if (data.refresh_token) saveRefreshToken(data.refresh_token);
			return true;
		} catch {
			return false;
		} finally {
			refreshPromise = null;
		}
	})();
	return refreshPromise;
}

// 明示サインアウト時にリフレッシュトークンを失効させる（ベストエフォート、結果は待たない）
function revokeRefreshToken() {
	const refreshToken = loadRefreshToken();
	if (!refreshToken) return;
	fetch(`${COGNITO_CONFIG.domain}/oauth2/revoke`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ token: refreshToken, client_id: COGNITO_CONFIG.clientId })
	}).catch(() => { });
}

// ── API呼び出し ──
async function apiFetch(path, options = {}, isRetry = false) {
	// 期限切れ間近（60秒）なら先にリフレッシュしておく
	if (isLoggedIn && idToken && isTokenExpired(idToken, 60)) {
		await refreshSession();
	}
	const res = await fetch(`${COGNITO_CONFIG.apiBaseUrl}${path}`, {
		...options,
		headers: {
			'Content-Type': 'application/json',
			'Authorization': idToken,
			...(options.headers || {})
		}
	});
	if (res.status === 401) {
		// 一度だけリフレッシュしてリトライ。それでも 401 ならゲストに戻す
		if (!isRetry && await refreshSession()) {
			return apiFetch(path, options, true);
		}
		handleSessionExpired();
		throw new Error('unauthorized');
	}
	if (!res.ok) throw new Error(`API error: ${res.status}`);
	// 修正: DELETE 等でボディが空だと res.json() が例外になり
	// 成功しているのに「失敗」トーストが出ていた
	const text = await res.text();
	return text ? JSON.parse(text) : null;
}

function handleSessionExpired() {
	if (!isLoggedIn) return;
	signOutToGuest();
	showToast('Session expired. Please sign in again', true);
}

// POST を upsert として使う（DynamoDB PutItem 前提）。
// 要検証: Lambda 側が attribute_not_exists 等の条件付き書き込みなら失敗するため、
// その場合は PUT /videos/{id}, PUT /tabs/{id} をバックエンドに追加すること。
function upsertVideoRemote(v) {
	return apiFetch('/videos', {
		method: 'POST',
		body: JSON.stringify({
			videoId: v.uid,
			url: v.url,
			type: v.type,
			tabId: v.tabId,
			title: v.title || '',
			addedAt: v.addedAt || Date.now(),
			order: v.order ?? 0
		})
	});
}

function upsertTabRemote(t) {
	return apiFetch('/tabs', {
		method: 'POST',
		body: JSON.stringify({ tabId: t.id, name: t.name, createdAt: t.createdAt ?? Date.now() })
	});
}

// ── Storage（ゲストモード用localStorage）──
// 注意: キー名は歴史的経緯で 'nvim_' 付きだが、変更すると既存ユーザーの
// ゲストデータが消える（オーファン化する）ため意図的に温存している。
const KEY = 'nvim_vg_v1';
const TABS_KEY = 'nvim_vg_tabs_v1';
const ACTIVE_TAB_KEY = 'nvim_vg_active_tab';

function loadLocal() { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } }
function saveLocal(v) { localStorage.setItem(KEY, JSON.stringify(v)); }
function loadTabsLocal() { try { return JSON.parse(localStorage.getItem(TABS_KEY)) || []; } catch { return []; } }
function saveTabsLocal(t) { localStorage.setItem(TABS_KEY, JSON.stringify(t)); }
function loadActiveTab() { return localStorage.getItem(ACTIVE_TAB_KEY) || null; }
function saveActiveTab(id) { localStorage.setItem(ACTIVE_TAB_KEY, id); }

let videos = [];
let tabs = [];
let activeTabId = null;

function genId() { return Math.random().toString(36).slice(2, 10); }

// ゲスト状態を必ず成立させる（タブ0件・activeTabId 不整合を許さない）。
// 修正: マイグレーション後にサインアウトすると localStorage が空のまま
// デフォルトタブが再作成されず、動画を追加しても表示されない壊れた状態になっていた。
function ensureGuestDefaults() {
	videos = loadLocal();
	tabs = loadTabsLocal();
	activeTabId = loadActiveTab();

	if (tabs.length === 0) {
		const defaultTab = { id: genId(), name: 'My videos', createdAt: Date.now() };
		tabs = [defaultTab];
		saveTabsLocal(tabs);
	}
	if (!tabs.find(t => t.id === activeTabId)) {
		activeTabId = tabs[0].id;
		saveActiveTab(activeTabId);
	}
}

function signOutToGuest() {
	revokeRefreshToken();
	clearToken();
	clearRefreshToken();
	isLoggedIn = false;
	idToken = null;
	userEmail = '';
	ensureGuestDefaults();
	updateAuthUI();
	renderTabs();
	render();
}

// ── サインイン / サインアウト ──
function handleAuth() {
	if (isLoggedIn) {
		signOutToGuest();
		showToast('Signed out');
	} else {
		const url = `${COGNITO_CONFIG.domain}/login?client_id=${COGNITO_CONFIG.clientId}&response_type=code&scope=openid+email&redirect_uri=${encodeURIComponent(COGNITO_CONFIG.redirectUri)}`;
		window.location.href = url;
	}
}

// サインイン後のコールバック処理（URLのcodeをトークンに交換）
async function handleCallback() {
	const params = new URLSearchParams(window.location.search);

	// ユーザーがキャンセルした場合などの error パラメータもURLから掃除する
	if (params.get('error')) {
		window.history.replaceState({}, '', window.location.pathname);
		return false;
	}

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
			if (data.refresh_token) saveRefreshToken(data.refresh_token);
			window.history.replaceState({}, '', window.location.pathname);
			return true;
		}
	} catch (e) {
		console.error('Token exchange failed:', e);
	}
	window.history.replaceState({}, '', window.location.pathname);
	return false;
}

function updateAuthUI() {
	const statusEl = document.getElementById('authStatus');
	const btnEl = document.getElementById('authBtn');
	if (isLoggedIn) {
		statusEl.textContent = userEmail ? `Signed in as ${userEmail}` : 'Signed in';
		statusEl.style.color = 'var(--green)';
		btnEl.textContent = 'Sign out';
	} else {
		statusEl.textContent = 'Guest — saved on this device';
		statusEl.style.color = 'var(--muted)';
		btnEl.textContent = 'Sign in';
	}
}

// ── Video actions ──
async function addVideo() {
	const urlEl = document.getElementById('urlInput');
	const url = urlEl.value.trim();
	if (!url) { showToast('Enter a video URL', true); return; }

	const platform = detectPlatform(url);
	if (!platform) { showToast("This URL isn't supported", true); return; }

	if (videos.find(v => v.id === platform.id && v.type === platform.type && v.tabId === activeTabId)) {
		showToast('Already in this playlist', true); return;
	}

	// 修正: 旧実装は uid に URL 全体を埋め込んでいた（mp4 の場合 platform.id = URL）。
	// それが未エスケープで DOM 属性やインライン onclick に展開され、XSS と
	// 属性破壊の原因になっていたため、uid はランダムIDのみで構成する。
	const uid = `${platform.type}_${genId()}`;

	// 新規追加は先頭に置く。order は「そのタブの最小値 - 1」で他レコードを触らずに先頭を維持する。
	const tabVideos = videos.filter(v => v.tabId === activeTabId);
	const order = tabVideos.length ? Math.min(...tabVideos.map(v => v.order ?? 0)) - 1 : 0;

	const videoData = {
		uid,
		id: platform.id,
		type: platform.type,
		url: platform.url,
		title: '',
		tabId: activeTabId,
		addedAt: Date.now(),
		order
	};

	if (isLoggedIn) {
		try {
			const res = await upsertVideoRemote(videoData);
			videoData.thumbnailUrl = res?.thumbnailUrl || '';
		} catch {
			showToast("Couldn't save the video", true);
			return;
		}
	}

	videos.unshift(videoData);
	if (!isLoggedIn) saveLocal(videos);
	render();
	renderTabs();
	urlEl.value = '';
	showToast('Video added');
}

async function deleteVideo(uid) {
	if (isLoggedIn) {
		try {
			await apiFetch(`/videos/${encodeURIComponent(uid)}`, { method: 'DELETE' });
		} catch {
			showToast("Couldn't remove the video", true);
			return;
		}
	}
	videos = videos.filter(v => v.uid !== uid);
	if (!isLoggedIn) saveLocal(videos);
	render();
	renderTabs();
	showToast('Video removed');
}

// ── Tab actions ──
async function addTab() {
	const name = prompt('Playlist name');
	if (!name || !name.trim()) return;
	const tab = { id: genId(), name: name.trim(), createdAt: Date.now() };

	if (isLoggedIn) {
		try {
			await upsertTabRemote(tab);
		} catch {
			showToast("Couldn't create the playlist", true);
			return;
		}
	}

	tabs.push(tab);
	if (!isLoggedIn) saveTabsLocal(tabs);
	activeTabId = tab.id;
	saveActiveTab(activeTabId);
	renderTabs();
	render();
	showToast(`Playlist "${tab.name}" created`);
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

async function renameTabFromMenu() {
	// 修正: 先に id を退避してメニューを閉じる。旧実装は prompt/confirm を
	// キャンセルするとメニューが開きっぱなしになっていた。
	const targetId = contextTargetId;
	closeContextMenu();
	if (!targetId) return;

	const tab = tabs.find(t => t.id === targetId);
	if (!tab) return;
	const name = prompt('Rename playlist', tab.name);
	if (!name || !name.trim() || name.trim() === tab.name) return;

	const newName = name.trim();

	if (isLoggedIn) {
		// 修正: 旧実装はログイン時にリネームをAPIへ保存しておらず、リロードで元に戻っていた
		try {
			await upsertTabRemote({ ...tab, name: newName });
		} catch {
			showToast("Couldn't rename the playlist", true);
			return;
		}
	}

	tab.name = newName;
	if (!isLoggedIn) saveTabsLocal(tabs);
	renderTabs();
	render();
	showToast(`Renamed to "${tab.name}"`);
}

async function deleteTabFromMenu() {
	const targetId = contextTargetId;
	closeContextMenu();
	if (!targetId) return;
	if (tabs.length === 1) { showToast('Keep at least one playlist', true); return; }

	const tab = tabs.find(t => t.id === targetId);
	if (!tab) return;
	if (!confirm(`Delete "${tab.name}"?\nVideos in this playlist will be deleted too.`)) return;

	const tabVideos = videos.filter(v => v.tabId === targetId);

	if (isLoggedIn) {
		try {
			await apiFetch(`/tabs/${encodeURIComponent(targetId)}`, { method: 'DELETE' });
		} catch {
			showToast("Couldn't delete the playlist", true);
			return;
		}
		// 修正: タブだけ消して中の動画レコードをサーバに残すとオーファンになるため、
		// フロント側でも明示的に削除する（バックエンドがカスケード削除していても
		// DeleteItem は冪等なので二重に叩いて問題ない。要検証: Lambda側の仕様）。
		await Promise.allSettled(
			tabVideos.map(v => apiFetch(`/videos/${encodeURIComponent(v.uid)}`, { method: 'DELETE' }))
		);
	}

	videos = videos.filter(v => v.tabId !== targetId);
	if (!isLoggedIn) saveLocal(videos);
	tabs = tabs.filter(t => t.id !== targetId);
	if (!isLoggedIn) saveTabsLocal(tabs);
	if (activeTabId === targetId) { activeTabId = tabs[0].id; saveActiveTab(activeTabId); }
	renderTabs();
	render();
	showToast('Playlist deleted');
}

// ── Render tabs ──
function renderTabs() {
	const tabList = document.getElementById('tabList');
	tabList.innerHTML = tabs.map(t => {
		const isActive = t.id === activeTabId;
		const count = videos.filter(v => v.tabId === t.id).length;
		return `<div class="drawer-tab-item${isActive ? ' active' : ''}" data-tab-id="${esc(t.id)}">
      <button class="tab-name" aria-label="Open ${esc(t.name)}">
        <span class="tab-icon"></span>
        <span>${esc(t.name)}</span>
      </button>
      <span class="tab-count">${count}</span>
      <button class="tab-edit-btn" aria-label="Playlist options">⋯</button>
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

// ── 表示用ヘルパー ──
function esc(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function formatDate(ts) {
	if (!ts) return '';
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return '';
	const opts = { month: 'short', day: 'numeric' };
	if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
	return d.toLocaleDateString('en-US', opts);
}

function fileNameFromUrl(url) {
	try {
		const seg = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || '');
		return seg || 'Video file';
	} catch {
		return 'Video file';
	}
}

// カード下部のテキスト。生の動画IDは開発ツール的なので出さず、
// 人間が読める情報（タイトル / ファイル名 / チャンネル名 / 追加日）に寄せる。
function cardText(v) {
	const date = formatDate(v.addedAt);
	if (v.title) return { title: v.title, sub: date };
	if (v.type === 'mp4') return { title: fileNameFromUrl(v.url), sub: date };
	if (v.type === 'twitch' || v.type === 'twitch_clip' || v.type === 'twitch_vod') return { title: v.id, sub: date };
	return { title: date ? `Added ${date}` : 'Saved video', sub: '' };
}

// ホバー可能なデバイスかどうか（タッチ端末では hover プレビューを無効化する）
const canHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;

// タッチドラッグ直後の合成 click を握りつぶすためのフラグ
let suppressNextClick = false;

// ── Render gallery ──
function render() {
	const currentVideos = videos.filter(v => v.tabId === activeTabId);
	const n = currentVideos.length;

	const activeTab = tabs.find(t => t.id === activeTabId);
	document.getElementById('playlistTitle').textContent = activeTab ? activeTab.name : 'Videos';
	document.getElementById('videoCount').textContent = `${n} ${n === 1 ? 'video' : 'videos'}`;

	const gallery = document.getElementById('gallery');
	if (n === 0) {
		gallery.innerHTML = `<div class="empty"><div>
      <span class="empty-title">No videos yet</span>
      <span class="empty-copy">Paste a video URL above to add the first one.</span>
    </div></div>`;
		return;
	}

	gallery.innerHTML = currentVideos.map(v => {
		const thumb = getThumb({ type: v.type, id: v.id, thumbnailUrl: v.thumbnailUrl });
		const label = getPlatformLabel(v.type);
		const labelColor = getPlatformColor(v.type);
		const text = cardText(v);

		// 修正: すべての動的値を esc() で属性エスケープする。
		// インライン onclick は廃止（JS文字列コンテキストへの注入経路になるため）。
		return `
    <div class="card" data-uid="${esc(v.uid)}" data-type="${esc(v.type)}" data-id="${esc(v.id)}" draggable="true" style="--platform-color:${labelColor}">
      <div class="card-bar">
        <span class="platform-pill">${esc(label)}</span>
        <div class="card-actions">
          <button class="btn-delete" title="Remove" aria-label="Remove video">×</button>
        </div>
      </div>
      <div class="thumb-wrap">
        ${thumb
				? `<img src="${esc(thumb)}" alt="" loading="lazy">`
				: `<div class="thumb-placeholder"><span>${esc(label)}</span></div>`
			}
        ${v.type === 'mp4'
				? `<video class="card-player" src="${esc(v.url)}" preload="none" muted playsinline controls></video>`
				: `<iframe class="card-player" src="about:blank" title="Video player" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe>`
			}
        <div class="play-btn">
          <svg viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg">
            <circle cx="30" cy="30" r="30" fill="rgba(255,255,255,0.92)"/>
            <circle cx="30" cy="30" r="29" stroke="rgba(20,23,19,0.12)" stroke-width="1"/>
            <polygon points="25,19 45,30 25,41" fill="#141713"/>
          </svg>
        </div>
      </div>
      <div class="card-meta">
        <span class="card-title">${esc(text.title)}</span>
        ${text.sub ? `<span class="card-submeta">${esc(text.sub)}</span>` : ''}
      </div>
    </div>`;
	}).join('');

	document.querySelectorAll('.card').forEach(card => {
		const type = card.dataset.type;
		const id = card.dataset.id;
		// 修正: id="player-xxx" の文字列連結参照をやめ、カード内スコープで取得
		const player = card.querySelector('.card-player');
		const img = card.querySelector('img');
		let pinned = false;
		let shown = false; // プレイヤーが表示中か（ピン留め時のリロード回避に使う）

		function showPlayer(muted) {
			if (type === 'mp4') {
				player.muted = muted;
				player.play().catch(() => { });
			} else {
				// 修正: 旧実装は「if (!player.src)」ガード + 解除時に src='' としていた。
				// iframe.src='' は自分自身のページを再帰読み込みし、かつ .src が
				// 空でなくなるため、2回目以降のホバーで動画が表示されなくなっていた。
				// 表示時は毎回セット、解除時は about:blank に退避する。
				const embedSrc = getEmbedUrl({ type, id }, muted);
				if (embedSrc) player.src = embedSrc;
			}
			shown = true;
			player.style.opacity = '1';
			// プレビュー中は非インタラクティブのまま（クリック＝ピン留めに割り当てる）。
			// ここで auto にすると動画上のクリックが iframe に吸われてピン留めできず、
			// プレイヤー操作後に mouseleave で動画ごと消える罠になる
			player.style.pointerEvents = 'none';
			if (img) img.style.opacity = '0';
			card.querySelector('.play-btn').style.opacity = '0';
		}

		function hidePlayer() {
			if (pinned) return;
			if (type === 'mp4') {
				player.pause();
			} else {
				player.src = 'about:blank';
			}
			shown = false;
			player.style.opacity = '0';
			player.style.pointerEvents = 'none';
			if (img) img.style.opacity = '1';
			card.querySelector('.play-btn').style.opacity = '1';
		}

		function pinPlayer() {
			pinned = true;
			card.classList.add('pinned');
			if (type === 'mp4') {
				player.muted = false;
				player.play().catch(() => { });
			} else if (!shown) {
				// 未表示からのピン留め（タッチ端末のタップ等）だけロードする。
				// プレビュー再生中の src 再代入は iframe リロード＝頭出しになるため、
				// 再生中はそのまま引き継ぐ。音声は埋め込みプレイヤー側の
				// ミュート解除で（play-btn の pointer-events:none 化により操作可能）
				const embedSrc = getEmbedUrl({ type, id }, false);
				if (embedSrc) player.src = embedSrc;
			}
			shown = true;
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
			} else {
				player.src = 'about:blank';
			}
			shown = false;
			player.style.opacity = '0';
			player.style.pointerEvents = 'none';
			if (img) img.style.opacity = '1';
			card.querySelector('.play-btn').style.opacity = '1';
		}

		// 修正: タッチ端末では mouseenter が合成発火して二重ロードになるため、
		// hover プレビューはホバー可能なポインタに限定する
		if (canHover) {
			card.addEventListener('mouseenter', () => { if (!pinned) showPlayer(true); });
			card.addEventListener('mouseleave', () => { if (!pinned) hidePlayer(); });
		}

		card.addEventListener('click', (e) => {
			if (e.target.closest('.card-actions')) return;
			// mp4 の <video controls> はクリックがカードまでバブルするため、
			// コントロール操作がピン解除に化けないよう除外する
			// （iframe 内のクリックは別ドキュメントなので元々ここへは届かない）
			if (e.target.closest('.card-player')) return;
			if (suppressNextClick) { suppressNextClick = false; return; }
			if (pinned) {
				unpinPlayer();
			} else {
				// 複数カードの同時再生（音の混在）を防ぐ
				document.querySelectorAll('.card.pinned').forEach(c => { if (c !== card && c._unpin) c._unpin(); });
				pinPlayer();
			}
		});
		card._unpin = unpinPlayer;
		card._isPinned = () => pinned;
	});

	setupDragAndDrop();
	if (!canHover) setupCenter();
}

// ── Drag & Drop（共通の並べ替え処理）──
// 修正: 旧実装はログイン時に並び順を一切保存せず、order も常に 0 のままで、
// リロードすると DynamoDB の返却順に戻っていた。並べ替え時にタブ内の order を
// 0..n-1 に振り直し、変更分だけ upsert する。
function reorderWithinTab(fromUid, toUid) {
	const fromIdx = videos.findIndex(v => v.uid === fromUid);
	const toIdx = videos.findIndex(v => v.uid === toUid);
	if (fromIdx < 0 || toIdx < 0 || fromIdx === toIdx) return false;

	videos.splice(toIdx, 0, videos.splice(fromIdx, 1)[0]);

	const changed = [];
	let i = 0;
	for (const v of videos) {
		if (v.tabId !== activeTabId) continue;
		if (v.order !== i) { v.order = i; changed.push(v); }
		i++;
	}

	if (!isLoggedIn) {
		saveLocal(videos);
	} else if (changed.length) {
		persistOrders(changed);
	}
	render();
	return true;
}

async function persistOrders(changed) {
	const results = await Promise.allSettled(changed.map(v => upsertVideoRemote(v)));
	if (results.some(r => r.status === 'rejected')) {
		showToast("Couldn't sync the new order", true);
	}
}

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
		card.addEventListener('touchend', onTouchEnd, { passive: false });
		card.addEventListener('touchcancel', onTouchCancel);
		card.addEventListener('contextmenu', e => { if (touchState) e.preventDefault(); });
	});
}

function onDragStart(e) { dragSrc = this; this.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; }
function onDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (this !== dragSrc) this.classList.add('drag-over'); }
function onDragLeave() { this.classList.remove('drag-over'); }

function onDrop(e) {
	e.preventDefault();
	if (!dragSrc || this === dragSrc) return;
	this.classList.remove('drag-over');
	if (reorderWithinTab(dragSrc.dataset.uid, this.dataset.uid)) showToast('Order updated');
}

function onDragEnd() { document.querySelectorAll('.card').forEach(c => c.classList.remove('dragging', 'drag-over')); dragSrc = null; }

// ── タッチの長押しドラッグ ──
// 修正: 旧実装は touchstart した瞬間にドラッグ用クローンを生成し、touchmove を
// 常に preventDefault していたため、カード上で指を動かすとページが一切
// スクロールできなかった（タップにもゴーストが出る）。長押し(350ms)で
// ドラッグ開始し、それまでの移動はスクロールとして素通しする。
const LONG_PRESS_MS = 350;
const MOVE_TOLERANCE = 8;
let touchState = null;

function onTouchStart(e) {
	const card = this;
	if (card._isPinned && card._isPinned()) return; // 再生中カードはドラッグ対象外
	if (touchState) {
		if (touchState.active) return; // ドラッグ中の追加タッチは無視
		cancelTouchPending();          // 保留中タイマーを破棄してから張り直す
	}
	const t = e.touches[0];
	touchState = {
		card,
		uid: card.dataset.uid,
		startX: t.clientX,
		startY: t.clientY,
		active: false,
		clone: null,
		rect: null,
		timer: setTimeout(startTouchDrag, LONG_PRESS_MS)
	};
}

function startTouchDrag() {
	if (!touchState) return;
	const { card } = touchState;
	const rect = card.getBoundingClientRect();
	const clone = card.cloneNode(true);
	clone.style.cssText = `position:fixed;top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;margin:0;opacity:0.75;pointer-events:none;z-index:1000;transform:scale(1.03);transition:none;`;
	document.body.appendChild(clone);
	card.classList.add('dragging');
	touchState.active = true;
	touchState.clone = clone;
	touchState.rect = rect;
	if (navigator.vibrate) navigator.vibrate(10);
}

function onTouchMove(e) {
	if (!touchState) return;
	const t = e.touches[0];

	if (!touchState.active) {
		// 長押し成立前に指が動いた → スクロール意図なのでドラッグ待機を解除
		if (Math.hypot(t.clientX - touchState.startX, t.clientY - touchState.startY) > MOVE_TOLERANCE) {
			cancelTouchPending();
		}
		return;
	}

	e.preventDefault();
	const { clone, rect } = touchState;
	clone.style.top = `${t.clientY - rect.height / 2}px`;
	clone.style.left = `${t.clientX - rect.width / 2}px`;
	document.querySelectorAll('.card.drag-over').forEach(c => c.classList.remove('drag-over'));
	const el = document.elementFromPoint(t.clientX, t.clientY);
	const target = el ? el.closest('.card') : null;
	if (target && target !== touchState.card) target.classList.add('drag-over');
}

function onTouchEnd(e) {
	if (!touchState) return;
	clearTimeout(touchState.timer);

	if (touchState.active) {
		const t = e.changedTouches[0];
		const el = document.elementFromPoint(t.clientX, t.clientY);
		const target = el ? el.closest('.card') : null;
		if (target && target !== touchState.card) {
			if (reorderWithinTab(touchState.uid, target.dataset.uid)) showToast('Order updated');
		}
		touchState.clone.remove();
		document.querySelectorAll('.card').forEach(c => c.classList.remove('dragging', 'drag-over'));
		suppressNextClick = true;
		setTimeout(() => { suppressNextClick = false; }, 400); // clickが来なくても残留させない
		if (e.cancelable) e.preventDefault();
	}
	touchState = null;
}

function onTouchCancel() {
	if (!touchState) return;
	clearTimeout(touchState.timer);
	if (touchState.active) {
		touchState.clone.remove();
		document.querySelectorAll('.card').forEach(c => c.classList.remove('dragging', 'drag-over'));
	}
	touchState = null;
}

function cancelTouchPending() {
	if (!touchState) return;
	clearTimeout(touchState.timer);
	touchState = null;
}

// ── Mobile center highlight ──
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
// 修正: 連続表示時に古いタイマーが新しいトーストを途中で消していた
let toastTimer = null;
function showToast(msg, err = false) {
	const t = document.getElementById('toast');
	clearTimeout(toastTimer);
	t.textContent = msg;
	t.className = 'toast' + (err ? ' err' : '');
	void t.offsetWidth;
	t.classList.add('show');
	toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

// ── ゲストモード→ログイン時のマイグレーション ──
async function migrateGuestData() {
	const guestVideos = loadLocal();
	const guestTabs = loadTabsLocal();
	if (guestTabs.length === 0 && guestVideos.length === 0) return;

	showToast('Moving your videos to your account…');

	for (const tab of guestTabs) {
		try {
			await upsertTabRemote(tab);
		} catch (e) { console.error('tab migration failed:', e); }
	}

	for (const video of guestVideos) {
		try {
			await upsertVideoRemote(video);
		} catch (e) { console.error('video migration failed:', e); }
	}

	localStorage.removeItem(KEY);
	localStorage.removeItem(TABS_KEY);
	showToast('All set — videos synced');
}

// ── 初期化 ──
async function init() {
	const callbackSuccess = await handleCallback();

	// id_token が無い/期限切れでも、リフレッシュトークンが生きていれば静かに復元する
	let token = loadToken();
	if ((!token || isTokenExpired(token)) && loadRefreshToken()) {
		if (await refreshSession()) token = loadToken();
	}

	if (token && !isTokenExpired(token)) {
		idToken = token;
		isLoggedIn = true;
		userEmail = decodeJwtPayload(token)?.email || '';

		const guestVideos = loadLocal();
		const guestTabs = loadTabsLocal();
		if (callbackSuccess && (guestVideos.length > 0 || guestTabs.length > 0)) {
			await migrateGuestData();
		}

		try {
			const [tabsData, videosData] = await Promise.all([
				apiFetch('/tabs'),
				apiFetch('/videos')
			]);

			tabs = tabsData.map(t => ({ id: t.tabId, name: t.name, createdAt: t.createdAt }));
			videos = videosData.map(v => ({
				uid: v.videoId,
				id: extractIdFromUrl(v.url),
				type: v.type,
				url: v.url,
				title: v.title || '',
				tabId: v.tabId,
				addedAt: v.addedAt,
				order: v.order ?? 0,
				thumbnailUrl: v.thumbnailUrl || ''
			}));

			// 修正: サーバ返却順（DynamoDBのスキャン順）に依存せず、
			// order 昇順 → addedAt 降順で並びを確定させる
			videos.sort((a, b) =>
				((a.order ?? 0) - (b.order ?? 0)) || ((b.addedAt ?? 0) - (a.addedAt ?? 0))
			);

			if (tabs.length === 0) {
				const defaultTab = { id: genId(), name: 'My videos', createdAt: Date.now() };
				await upsertTabRemote(defaultTab);
				tabs.push(defaultTab);
			}

			activeTabId = loadActiveTab() || tabs[0].id;
			if (!tabs.find(t => t.id === activeTabId)) activeTabId = tabs[0].id;
			saveActiveTab(activeTabId);

		} catch (e) {
			console.error('API fetch failed:', e);
			if (isLoggedIn) showToast("Couldn't load your videos", true);
		}
	} else {
		isLoggedIn = false;
		idToken = null;
		clearToken();
		ensureGuestDefaults();
	}

	updateAuthUI();
	renderTabs();
	render();
}

// URLからプラットフォーム固有のIDを再取得
function extractIdFromUrl(url) {
	const platform = detectPlatform(url);
	return platform ? platform.id : url;
}

// ── 静的要素のイベント配線 ──
// （type="module" なので実行はDOM構築後。インライン onclick は全廃した）
document.getElementById('hamburgerBtn').addEventListener('click', openDrawer);
document.getElementById('drawerCloseBtn').addEventListener('click', closeDrawer);
document.getElementById('drawerOverlay').addEventListener('click', closeDrawer);
document.getElementById('addTabBtn').addEventListener('click', addTab);
document.getElementById('authBtn').addEventListener('click', handleAuth);
document.getElementById('addVideoBtn').addEventListener('click', addVideo);
document.getElementById('urlInput').addEventListener('keydown', e => { if (e.key === 'Enter') addVideo(); });
document.getElementById('ctxRenameBtn').addEventListener('click', renameTabFromMenu);
document.getElementById('ctxDeleteBtn').addEventListener('click', deleteTabFromMenu);

// ドロワー内タブの操作（イベント委譲）
document.getElementById('tabList').addEventListener('click', e => {
	const editBtn = e.target.closest('.tab-edit-btn');
	if (editBtn) {
		e.stopPropagation();
		openTabMenu(editBtn.closest('[data-tab-id]').dataset.tabId, editBtn);
		return;
	}
	const nameBtn = e.target.closest('.tab-name');
	if (nameBtn) {
		switchTab(nameBtn.closest('[data-tab-id]').dataset.tabId);
		closeDrawer();
	}
});

// ギャラリー内の削除ボタン（イベント委譲）
document.getElementById('gallery').addEventListener('click', e => {
	const btn = e.target.closest('.btn-delete');
	if (!btn) return;
	const card = btn.closest('.card');
	if (card) deleteVideo(card.dataset.uid);
});

// コンテンツ領域のカード外クリックで再生中カードを解除する。
// ピン留め中は動画上のクリックが埋め込みプレイヤーに渡るため、
// 「余白クリックで閉じる」を明示的な解除手段として用意する
// （カードのメタ部分クリックでも解除できる）
document.addEventListener('click', e => {
	if (e.target.closest('.card')) return;
	if (!e.target.closest('.content')) return;
	document.querySelectorAll('.card.pinned').forEach(c => { if (c._unpin) c._unpin(); });
});

// メニュー外クリックで閉じる
document.addEventListener('click', e => {
	if (!e.target.closest('#contextMenu') && !e.target.closest('.tab-edit-btn')) closeContextMenu();
});

// Escape でメニュー → ドロワーの順に閉じる
document.addEventListener('keydown', e => {
	if (e.key !== 'Escape') return;
	if (document.getElementById('contextMenu').classList.contains('open')) {
		closeContextMenu();
		return;
	}
	closeDrawer();
});

init();
