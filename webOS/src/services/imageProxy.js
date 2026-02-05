import LS2Request from '@enact/webos/LS2Request';

const SERVICE_URI = 'luna://org.moonfin.webos.service';

// Limit cache size to prevent memory bloat (base64 images can be large)
const MAX_CACHE_SIZE = 50;
const imageCache = new Map();
const pendingRequests = new Map();

// Simple LRU-like cache management
const addToCache = (url, data) => {
	// If at max size, remove oldest entries (first 10)
	if (imageCache.size >= MAX_CACHE_SIZE) {
		const keysToDelete = Array.from(imageCache.keys()).slice(0, 10);
		keysToDelete.forEach(key => imageCache.delete(key));
	}
	imageCache.set(url, data);
};

export const proxyImage = (url) => {
	if (!url) return Promise.resolve(null);

	if (imageCache.has(url)) {
		return Promise.resolve(imageCache.get(url));
	}

	if (pendingRequests.has(url)) {
		return pendingRequests.get(url);
	}

	const promise = new Promise((resolve) => {
		new LS2Request().send({
			service: SERVICE_URI,
			method: 'imageProxy',
			parameters: {url},
			onSuccess: (response) => {
				if (response.success && response.data) {
					const dataUrl = `data:${response.contentType || 'image/jpeg'};base64,${response.data}`;
					addToCache(url, dataUrl);
					pendingRequests.delete(url);
					resolve(dataUrl);
				} else {
					pendingRequests.delete(url);
					resolve(null);
				}
			},
			onFailure: () => {
				pendingRequests.delete(url);
				resolve(null);
			}
		});
	});

	pendingRequests.set(url, promise);
	return promise;
};

export const clearImageCache = () => {
	imageCache.clear();
	pendingRequests.clear();
	console.log('[imageProxy] Cache cleared');
};

export const getCacheStats = () => ({
	size: imageCache.size,
	pending: pendingRequests.size
});

export default {
	proxyImage,
	clearImageCache,
	getCacheStats
};
