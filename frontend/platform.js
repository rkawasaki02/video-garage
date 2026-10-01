// ── Platform detection & helpers ──
// main.js から import して使う唯一の実装。main.js 側に複製を持たないこと。

export function detectPlatform(url) {
	url = url.trim().replace(/^["']|["']$/g, '');

	// YouTube（watch / youtu.be / embed / shorts / live）
	const yt = url.match(/(?:youtube\.com\/watch\?.*v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/|youtube\.com\/live\/)([A-Za-z0-9_-]{11})/);
	if (yt) return { type: 'youtube', id: yt[1], url };
	if (/^[A-Za-z0-9_-]{11}$/.test(url)) return { type: 'youtube', id: url, url };

	// Vimeo
	const vimeo = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
	if (vimeo) return { type: 'vimeo', id: vimeo[1], url };

	// Twitch clip（channel 判定より先に評価すること）
	const twitchClip = url.match(/twitch\.tv\/\w+\/clip\/([A-Za-z0-9_-]+)/);
	if (twitchClip) return { type: 'twitch_clip', id: twitchClip[1], url };

	// Twitch VOD（channel 判定より先に評価すること）
	const twitchVod = url.match(/twitch\.tv\/videos\/(\d+)/);
	if (twitchVod) return { type: 'twitch_vod', id: twitchVod[1], url };

	// Twitch channel
	const twitch = url.match(/twitch\.tv\/([A-Za-z0-9_]+)/);
	if (twitch) return { type: 'twitch', id: twitch[1], url };

	// 動画ファイル直リンク / X の動画
	if (/\.(mp4|webm|ogg|mov)(\?.*)?$/i.test(url) || url.includes('video.twimg.com')) {
		return { type: 'mp4', id: url, url };
	}

	return null;
}

export function getThumb(platform) {
	switch (platform.type) {
		case 'youtube': return `https://img.youtube.com/vi/${platform.id}/hqdefault.jpg`;
		case 'vimeo': return `https://vumbnail.com/${platform.id}.jpg`;
		// Twitch はサムネ取得に認証が要るため、動画保存 Lambda が取得した URL を使う
		case 'twitch':
		case 'twitch_clip':
		case 'twitch_vod':
			return platform.thumbnailUrl || '';
		default: return '';
	}
}

export function getEmbedUrl(platform, muted = true) {
	switch (platform.type) {
		case 'youtube':
			return `https://www.youtube.com/embed/${platform.id}?autoplay=1&mute=${muted ? 1 : 0}&controls=1&rel=0&modestbranding=1`;
		case 'vimeo':
			return `https://player.vimeo.com/video/${platform.id}?autoplay=1&muted=${muted ? 1 : 0}`;
		case 'twitch':
			return `https://player.twitch.tv/?channel=${platform.id}&autoplay=true&muted=${muted}&parent=${location.hostname}`;
		case 'twitch_vod':
			return `https://player.twitch.tv/?video=${platform.id}&autoplay=true&muted=${muted}&parent=${location.hostname}`;
		case 'twitch_clip':
			return `https://clips.twitch.tv/embed?clip=${platform.id}&autoplay=true&muted=${muted}&parent=${location.hostname}`;
		default:
			return null;
	}
}

export function getPlatformLabel(type) {
	const map = {
		youtube: 'YouTube',
		vimeo: 'Vimeo',
		twitch: 'Twitch',
		twitch_clip: 'Twitch clip',
		twitch_vod: 'Twitch VOD',
		mp4: 'Video'
	};
	return map[type] || type;
}

export function getPlatformColor(type) {
	const map = {
		youtube: 'var(--red)',
		vimeo: 'var(--blue)',
		twitch: 'var(--purple)',
		twitch_clip: 'var(--purple)',
		twitch_vod: 'var(--purple)',
		mp4: 'var(--green)'
	};
	return map[type] || 'var(--muted)';
}
