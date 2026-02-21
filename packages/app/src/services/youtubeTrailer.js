const INNERTUBE_URL = 'https://www.youtube.com/youtubei/v1/player';

const ANDROID_CLIENT = {
	clientName: 'ANDROID',
	clientVersion: '19.09.37',
	androidSdkVersion: 34,
	hl: 'en',
	gl: 'US'
};

const YT_ID_REGEX = /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;

function extractStreamUrl (data, preferHighQuality) {
	if (!data || !data.streamingData) return null;
	let status = data.playabilityStatus;
	if (!status || status.status !== 'OK') return null;

	let formats = data.streamingData.formats || [];
	if (preferHighQuality) {
		let best = null;
		for (let i = 0; i < formats.length; i++) {
			if (formats[i].url && formats[i].mimeType && formats[i].mimeType.indexOf('video/mp4') !== -1) {
				best = formats[i].url;
			}
		}
		if (best) return best;
	} else {
		for (let i = 0; i < formats.length; i++) {
			if (formats[i].url && formats[i].mimeType && formats[i].mimeType.indexOf('video/mp4') !== -1) {
				return formats[i].url;
			}
		}
	}

	for (let i = 0; i < formats.length; i++) {
		if (formats[i].url) return formats[i].url;
	}
	return null;
}

export function fetchVideoStreamUrl (videoId, preferHighQuality) {
	return new Promise(function (resolve) {
		let timer = setTimeout(function () { resolve(null); }, 10000);

		fetch(INNERTUBE_URL, {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({
				videoId: videoId,
				context: {client: ANDROID_CLIENT}
			})
		})
			.then(function (resp) {
				if (!resp.ok) { clearTimeout(timer); resolve(null); return; }
				return resp.json();
			})
			.then(function (data) {
				clearTimeout(timer);
				if (!data) return;
				let url = extractStreamUrl(data, preferHighQuality);
				resolve(url);
			})
			.catch(function () { clearTimeout(timer); resolve(null); });
	});
}

export function extractYouTubeId (item) {
	let trailers = item && item.RemoteTrailers;
	if (!trailers || trailers.length === 0) return null;
	for (var i = 0; i < trailers.length; i++) {
		let url = trailers[i].Url || trailers[i].url || '';
		let match = url.match(YT_ID_REGEX);
		if (match) return match[1];
	}
	return null;
}

export function extractYouTubeIdFromUrl (url) {
	if (!url) return null;
	let match = url.match(YT_ID_REGEX);
	return match ? match[1] : null;
}

export function fetchSponsorSegments (videoId) {
	return new Promise(function (resolve) {
		let url = 'https://sponsor.ajay.app/api/skipSegments?videoID=' + videoId +
			'&categories=["sponsor","selfpromo","intro","outro","interaction","music_offtopic"]';
		fetch(url)
			.then(function (resp) {
				if (!resp.ok) { resolve([]); return; }
				return resp.json();
			})
			.then(function (data) {
				if (!Array.isArray(data)) { resolve([]); return; }
				let segments = [];
				for (var i = 0; i < data.length; i++) {
					if (data[i].segment && data[i].segment.length === 2) {
						segments.push({start: data[i].segment[0], end: data[i].segment[1]});
					}
				}
				resolve(segments);
			})
			.catch(function () { resolve([]); });
	});
}

export function getTrailerStartTime (segments) {
	let startTime = 0;
	if (!segments || segments.length === 0) return startTime;
	let sorted = segments.slice().sort(function (a, b) { return a.start - b.start; });
	for (var i = 0; i < sorted.length; i++) {
		if (sorted[i].start <= startTime + 1) {
			startTime = Math.max(startTime, sorted[i].end);
		}
	}
	return Math.max(startTime, 5);
}
