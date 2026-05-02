// ── Platform detection & helpers ──

const ALLOWED_DOMAINS = [
	'youtube.com', 'youtu.be',
	'vimeo.com',
	'twitch.tv',
	'video.twimg.com',
];

function detectPlatform(url) {
	url = url.trim().replace(/^["']|["']$/g, '');

	// YouTube
	const yt = url.match(/(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/);
	if (yt) return { type: 'youtube', id: yt[1], url };
	if (/^[A-Za-z0-9_-]{11}$/.test(url)) return { type: 'youtube', id: url, url };

	// Vimeo
	const vimeo = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
	if (vimeo) return { type: 'vimeo', id: vimeo[1], url };

	// Twitch clip
	const twitchClip = url.match(/twitch\.tv\/\w+\/clip\/([A-Za-z0-9_-]+)/);
	if (twitchClip) return { type: 'twitch_clip', id: twitchClip[1], url };

	// Twitch channel
	const twitch = url.match(/twitch\.tv\/([A-Za-z0-9_]+)/);
	if (twitch) return { type: 'twitch', id: twitch[1], url };

	// mp4直リンク / X動画
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
		youtube: 'var(--red)',
		vimeo: 'var(--blue)',
		twitch: 'var(--purple)',
		twitch_clip: 'var(--purple)',
		mp4: 'var(--green)'
	};
	return map[type] || 'var(--muted)';
}


// ── Storage ──
const KEY = 'nvim_vg_v1';
const TABS_KEY = 'nvim_vg_tabs_v1';
const ACTIVE_TAB_KEY = 'nvim_vg_active_tab';

function load() { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } }
function save(v) { localStorage.setItem(KEY, JSON.stringify(v)); }
function loadTabs() { try { return JSON.parse(localStorage.getItem(TABS_KEY)) || []; } catch { return []; } }
function saveTabs(t) { localStorage.setItem(TABS_KEY, JSON.stringify(t)); }
function loadActiveTab() { return localStorage.getItem(ACTIVE_TAB_KEY) || null; }
function saveActiveTab(id) { localStorage.setItem(ACTIVE_TAB_KEY, id); }

let videos = load();
let tabs = loadTabs();
let activeTabId = loadActiveTab();

if (tabs.length === 0) {
	const defaultTab = { id: genId(), name: 'playlist' };
	tabs.push(defaultTab);
	saveTabs(tabs);
	activeTabId = defaultTab.id;
	saveActiveTab(activeTabId);
}

if (!tabs.find(t => t.id === activeTabId)) {
	activeTabId = tabs[0].id;
	saveActiveTab(activeTabId);
}

function genId() { return Math.random().toString(36).slice(2, 10); }



// ── Video actions ──
function addVideo() {
	const urlEl = document.getElementById('urlInput');
	const url = urlEl.value.trim();
	const title = '';
	if (!url) { showToast('E: url required', true); return; }

	const platform = detectPlatform(url);
	if (!platform) { showToast('E: unsupported URL', true); return; }

	const uid = platform.type + '_' + platform.id;
	if (videos.find(v => v.uid === uid && v.tabId === activeTabId)) { showToast('W: already exists', true); return; }

	videos.unshift({
		uid,
		id: platform.id,
		type: platform.type,
		url: platform.url,
		title: title || platform.id.slice(0, 30),
		tabId: activeTabId,
		addedAt: Date.now()
	});
	save(videos);
	render();
	urlEl.value = '';
	showToast(`-- ${getPlatformLabel(platform.type)} added ✓`);
}

document.getElementById('urlInput').addEventListener('keydown', e => { if (e.key === 'Enter') addVideo(); });

function deleteVideo(uid) {
	videos = videos.filter(v => !(v.uid === uid && v.tabId === activeTabId));
	save(videos);
	render();
	showToast('-- deleted');
}

// ── Tab actions ──
function addTab() {
	const name = prompt('tab name:');
	if (!name || !name.trim()) return;
	const tab = { id: genId(), name: name.trim() };
	tabs.push(tab);
	saveTabs(tabs);
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
let longPressTimer = null;

function setupTabLongPress(el, tabId) {
	el.addEventListener('mousedown', () => { longPressTimer = setTimeout(() => openContextMenu(tabId, el), 600); });
	el.addEventListener('mouseup', () => clearTimeout(longPressTimer));
	el.addEventListener('mouseleave', () => clearTimeout(longPressTimer));
	el.addEventListener('touchstart', () => { longPressTimer = setTimeout(() => openContextMenu(tabId, el), 600); }, { passive: true });
	el.addEventListener('touchend', () => clearTimeout(longPressTimer));
	el.addEventListener('touchmove', () => clearTimeout(longPressTimer), { passive: true });
}

function openContextMenu(tabId, el) {
	contextTargetId = tabId;
	const menu = document.getElementById('contextMenu');
	const rect = el.getBoundingClientRect();
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
	saveTabs(tabs);
	renderTabs();
	render();
	showToast(`-- renamed to "${tab.name}"`);
	closeContextMenu();
}

function deleteTabFromMenu() {
	if (!contextTargetId) return;
	if (tabs.length === 1) { showToast('E: cannot delete last tab', true); closeContextMenu(); return; }
	const tab = tabs.find(t => t.id === contextTargetId);
	if (!confirm(`delete tab "${tab.name}"?\nVideos in this tab will also be deleted.`)) return;
	videos = videos.filter(v => v.tabId !== contextTargetId);
	save(videos);
	tabs = tabs.filter(t => t.id !== contextTargetId);
	saveTabs(tabs);
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
      <span>${esc(t.name)}</span>
      <span class="tab-count">${count}</span>
    </div>`;
	}).join('');

	tabs.forEach(t => {
		const drawerEl = document.getElementById(`drawer-tab-${t.id}`);
		if (!drawerEl) return;
		drawerEl.addEventListener('click', () => { switchTab(t.id); closeDrawer(); });
		setupTabLongPress(drawerEl, t.id);
	});
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
	// count-display removed
	document.getElementById('sl-count').textContent = `${n}:1`;

	const gallery = document.getElementById('gallery');
	if (n === 0) {
		gallery.innerHTML = `<div class="empty">-- no videos yet<br>-- add a URL above</div>`;
		return;
	}

	gallery.innerHTML = currentVideos.map(v => {
		const thumb = getThumb({ type: v.type, id: v.id });
		const label = getPlatformLabel(v.type);
		const labelColor = { youtube: 'var(--red)', vimeo: 'var(--blue)', twitch: 'var(--purple)', twitch_clip: 'var(--purple)', mp4: 'var(--green)' }[v.type] || 'var(--muted)';

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
				? `<img src="${thumb}" alt="${esc(v.title)}" loading="lazy">`
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
		const url = card.dataset.url;
		const player = card.querySelector(`#player-${uid}`);
		const img = card.querySelector('img');

		// 固定再生中かどうか
		let pinned = false;

		function showPlayer(muted) {
			if (type === 'mp4') {
				player.muted = muted;
				player.style.opacity = '1';
				player.style.pointerEvents = 'auto';
				player.play().catch(() => { });
				if (img) img.style.opacity = '0';
			} else {
				// すでにsrcがセットされていれば再セットしない（固定再生中のミュート解除を守る）
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
			if (pinned) return; // 固定再生中は止めない
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
			// 音ありで再セット（iframeの場合srcを音ありURLで更新）
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

		// PC: ホバーでプレビュー、クリックで固定
		card.addEventListener('mouseenter', () => {
			if (!pinned) showPlayer(true);
		});
		card.addEventListener('mouseleave', () => {
			if (!pinned) hidePlayer();
		});
		card.addEventListener('click', () => {
			if (window.innerWidth > 640) {
				if (pinned) {
					unpinPlayer();
				} else {
					pinPlayer();
				}
			} else {
				// スマホ: タップで固定再生トグル
				if (pinned) {
					unpinPlayer();
				} else {
					// 他の固定再生を解除
					document.querySelectorAll('.card.pinned').forEach(c => {
						c._unpinPlayer && c._unpinPlayer();
					});
					pinPlayer();
				}
			}
		});

		// unpinPlayer参照をcard要素に持たせる（他カードから呼べるように）
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
	save(videos);
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
		save(videos); render(); showToast('-- reordered');
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

// ── Auto-hide form ──


function showToast(msg, err = false) {
	const t = document.getElementById('toast');
	t.textContent = msg;
	t.className = 'toast' + (err ? ' err' : '');
	void t.offsetWidth;
	t.classList.add('show');
	setTimeout(() => t.classList.remove('show'), 2500);
}

function esc(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// ── Init ──
renderTabs();
render();
resetIdleTimer();
